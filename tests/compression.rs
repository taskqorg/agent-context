//! §3 / VERIFICATION A2,A4: native execution once -> bounded RTK -> original recovery -> one stats record.
use serde_json::{Value, json};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

fn cli(
    root: &Path,
    args: &[&str],
    input: Option<&str>,
    extra: &[(&str, &str)],
) -> std::process::Output {
    let mut c = Command::new(env!("CARGO_BIN_EXE_agentq"));
    c.args(args)
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("LOCALAPPDATA", root)
        .env("APPDATA", root)
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("CALLS", root.join("calls"))
        .env("AGENTQ_AGENT", "claude")
        .envs(extra.iter().copied())
        .env(
            "PATH",
            std::env::join_paths(
                std::iter::once(root.join("bin")).chain(std::env::split_paths(
                    &std::env::var_os("PATH").unwrap_or_default(),
                )),
            )
            .unwrap(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut p = c.spawn().unwrap();
    if let Some(s) = input {
        p.stdin.take().unwrap().write_all(s.as_bytes()).unwrap();
    }
    drop(p.stdin.take());
    p.wait_with_output().unwrap()
}
fn install(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join("agentq")
    } else {
        root.join(".local/share/agentq")
    }
}
fn records(root: &Path) -> Vec<Value> {
    let mut v = vec![];
    for e in std::fs::read_dir(install(root).join("data/stats")).unwrap() {
        for line in std::fs::read_to_string(e.unwrap().path()).unwrap().lines() {
            v.push(serde_json::from_str(line).unwrap());
        }
    }
    v
}
#[test]
fn execution_recovery_stats_chain() {
    let root = std::env::temp_dir().join(format!(
        "agentq-cli-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(root.join("bin")).unwrap();
    assert!(!cli(&root, &["stats", "--json"], None, &[]).status.success());
    assert!(
        !cli(&root, &["compress", "hermes"], Some("{"), &[])
            .status
            .success()
    );
    let native = root
        .join("bin")
        .join(format!("cargo{}", std::env::consts::EXE_SUFFIX));
    assert!(
        Command::new("rustc")
            .args([
                "--edition=2024",
                "tests/fixtures/compression-runner.rs",
                "-o"
            ])
            .arg(&native)
            .status()
            .unwrap()
            .success()
    );
    let engine = install(&root).join("engines/headroom-unused");
    std::fs::create_dir_all(engine.parent().unwrap().join("rtk-0.51.0")).unwrap();
    let rtk = engine
        .parent()
        .unwrap()
        .join("rtk-0.51.0")
        .join(format!("rtk{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(&native, &rtk).unwrap();
    let raw = "test result with preserved details\n".repeat(100);
    let data = install(&root).join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(
        data.join("config.json"),
        r#"{"compression":{"stats":"off"}}"#,
    )
    .unwrap();
    for (mode, why) in [
        ("ok", "compressed"),
        ("not_smaller", "not_smaller"),
        ("error", "error"),
        ("timeout", "timeout"),
        ("changed_args", "error"),
    ] {
        let before = records_or_empty(&root).len();
        let o = cli(
            &root,
            &["run", "--", "cargo", "test"],
            None,
            &[("FILTER", mode), ("EXIT", "3")],
        );
        assert_eq!(o.status.code(), Some(3));
        assert_eq!(o.stderr, b"native stderr\n");
        let rs = records(&root);
        assert_eq!(rs.len(), before + 1);
        let r = rs.last().unwrap();
        assert_eq!(r["reason"], why, "{o:?}");
        assert_eq!(r["exit_code"], 3);
        assert_eq!(r["bytes_in"], raw.len());
        assert_eq!(r["bytes_out"], o.stdout.len());
        if mode == "ok" {
            let reference = r["ref"].as_str().unwrap();
            assert!(String::from_utf8_lossy(&o.stdout).contains(reference));
            let request=json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_original","arguments":{"ref":reference}}}).to_string()+"\n";
            let recovered = cli(&root, &["mcp", "claude"], Some(&request), &[]);
            let reply: Value = serde_json::from_slice(&recovered.stdout).unwrap();
            let content: Value =
                serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap())
                    .unwrap();
            assert_eq!(content["content"], raw);
        } else {
            assert_eq!(o.stdout, raw.as_bytes());
            assert!(r["ref"].is_null());
        }
    }
    assert_eq!(
        std::fs::read_to_string(root.join("calls"))
            .unwrap()
            .lines()
            .count(),
        5,
        "filter and retrieval never re-execute native work"
    );
    for (text, why) in [
        ("short", "short"),
        ("{\"complete\":true}", "json"),
        ("fn example() {}", "code"),
    ] {
        std::fs::write(
            data.join("config.json"),
            r#"{"compression":{"stats":"off","min_bytes":0}}"#,
        )
        .unwrap();
        if why == "short" {
            std::fs::write(
                data.join("config.json"),
                r#"{"compression":{"stats":"off"}}"#,
            )
            .unwrap();
        }
        let o = cli(
            &root,
            &["run", "--", "cargo", "test"],
            None,
            &[("TEXT", text)],
        );
        assert_eq!(o.stdout, text.as_bytes());
        assert_eq!(records(&root).last().unwrap()["reason"], why);
    }
    std::fs::write(
        data.join("config.json"),
        r#"{"compression":{"stats":"off","enabled":false}}"#,
    )
    .unwrap();
    assert_eq!(
        cli(&root, &["run", "--", "cargo", "test"], None, &[]).stdout,
        raw.as_bytes()
    );
    assert_eq!(records(&root).last().unwrap()["reason"], "disabled");
    assert!(
        records(&root).last().unwrap()["bytes_in"].is_null(),
        "disabled runs stay native; never invent byte measurements"
    );
    let s = cli(&root, &["stats", "--json"], None, &[]);
    assert!(s.status.success());
    let stats: Value = serde_json::from_slice(&s.stdout).unwrap();
    assert_eq!(
        stats["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["calls"].as_u64().unwrap())
            .sum::<u64>(),
        9
    );
    std::fs::remove_dir_all(root).unwrap();
}
fn records_or_empty(root: &Path) -> Vec<Value> {
    if install(root).join("data/stats").exists() {
        records(root)
    } else {
        vec![]
    }
}
