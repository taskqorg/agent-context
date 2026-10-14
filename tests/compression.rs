//! §3 / VERIFICATION A2,A4: native execution once -> bounded RTK -> original recovery -> one stats record.
//! ACCOUNTING O4: the same records read locally and from their exported spans give one accounting.
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
        let p = e.unwrap().path();
        if p.extension().is_none_or(|x| x != "jsonl") {
            continue;
        }
        for line in std::fs::read_to_string(p).unwrap().lines() {
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
    let none = cli(&root, &["stats", "--accounting"], None, &[]);
    let none: Value = serde_json::from_slice(&none.stdout).unwrap();
    assert_eq!((&none["state"], &none["calls"]), (&json!("unknown"), &Value::Null), "an empty store is unknown, never zero");
    assert_eq!(none["coverage"]["sources"][0]["reasons"][0]["detail"], "no stats recorded");
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
        r#"{"compression":{"stats":"queue"}}"#,
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
            r#"{"compression":{"stats":"queue","min_bytes":0}}"#,
        )
        .unwrap();
        if why == "short" {
            std::fs::write(
                data.join("config.json"),
                r#"{"compression":{"stats":"queue"}}"#,
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
        r#"{"compression":{"stats":"queue","enabled":false}}"#,
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
    let accounting = |extra: &[&str]| -> Value {
        let mut args = vec!["stats", "--accounting"];
        args.extend(extra);
        let o = cli(&root, &args, None, &[]);
        assert!(o.status.success(), "{o:?}");
        serde_json::from_slice(&o.stdout).unwrap()
    };
    // Coverage is what the producer proved: from its first record, never the retention period it has not seen.
    let journal = data.join("stats/coverage.json");
    let since = serde_json::from_slice::<Value>(&std::fs::read(&journal).unwrap()).unwrap()["since"].as_u64().unwrap();
    let from = since.to_string();
    let week = accounting(&[]);
    assert_eq!((&week["state"], &week["calls"]), (&json!("partial"), &json!(9)), "a new store never covers the week before it");
    assert_eq!(week["coverage"]["sources"][0]["reasons"][1], json!({"reason": "gap"}));
    let local = accounting(&["--from", &from]);
    let queue = data.join("queue");
    let exported = accounting(&["--events", queue.to_str().unwrap(), "--from", &from]);
    // A call that wrote no evidence is undetectable: local totals are lower bounds, never complete.
    assert_eq!((&local["state"], &local["calls"]), (&json!("partial"), &json!(9)));
    assert_eq!(local["coverage"]["sources"][0]["reasons"][0]["reason"], "unproven");
    assert_eq!(exported["state"], "partial", "export carries no coverage: lower bounds");
    assert_eq!(exported["coverage"]["sources"][0]["reasons"][0]["detail"], "exported events carry no coverage");
    for k in ["calls", "outcomes", "reasons", "volume", "cohorts"] {
        assert_eq!(local[k], exported[k], "{k}");
    }
    assert_eq!(local["volume"][0]["paired"], 1);
    assert_eq!(local["volume"][0]["bytes_in"], raw.len());
    assert!(!local.to_string().contains("agentq-cli-") && !exported.to_string().contains("agentq-cli-"), "no host paths");

    // A failed append is a gap in the journal; the call keeps its native bytes.
    let day = std::fs::read_dir(data.join("stats")).unwrap().flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "jsonl")).unwrap();
    let kept = day.with_extension("kept");
    std::fs::rename(&day, &kept).unwrap();
    std::fs::create_dir(&day).unwrap();
    assert_eq!(cli(&root, &["run", "--", "cargo", "test"], None, &[]).stdout, raw.as_bytes());
    std::fs::remove_dir(&day).unwrap();
    std::fs::rename(&kept, &day).unwrap();
    let j: Value = serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
    assert_eq!((j["since"].as_u64(), j["gaps"].as_array().unwrap().len()), (Some(since), 1));
    let gap = accounting(&["--from", &from]);
    assert_eq!((&gap["state"], &gap["calls"]), (&json!("partial"), &json!(9)));
    assert_eq!(gap["coverage"]["sources"][0]["gaps"][0], j["gaps"][0]);

    // A lost journal over held records is a reset: older records count but are unproven.
    std::fs::remove_file(&journal).unwrap();
    let lost = cli(&root, &["stats", "--accounting"], None, &[]);
    let lost: Value = serde_json::from_slice(&lost.stdout).unwrap();
    assert_eq!((&lost["state"], &lost["calls"]), (&json!("partial"), &json!(9)));
    assert_eq!(lost["coverage"]["sources"][0]["reasons"][0]["detail"], "no coverage journal");
    cli(&root, &["run", "--", "cargo", "test"], None, &[]);
    let j: Value = serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
    assert_eq!(j["resets"], json!([j["since"].as_u64().unwrap() - 1]), "the reset second stays unproven");
    let reset = accounting(&["--from", &from]);
    assert_eq!((&reset["state"], &reset["calls"]), (&json!("partial"), &json!(10)));
    assert_eq!(reset["coverage"]["sources"][0]["resets"], 1);
    assert!(reset["coverage"]["sources"][0]["reasons"].as_array().unwrap().contains(&json!({"reason": "reset"})));
    std::fs::write(&journal, "{").unwrap();
    let corrupt: Value = serde_json::from_slice(&cli(&root, &["stats", "--accounting"], None, &[]).stdout).unwrap();
    assert_eq!(corrupt["coverage"]["sources"][0]["reasons"][0]["detail"], "coverage journal unreadable");
    // Parseable but corrupt gaps or resets prove no coverage either: never complete, never zero.
    for bad in [
        json!({"schema": 1, "since": since, "resets": [], "gaps": [[since, "x"]]}),
        json!({"schema": 1, "since": since, "resets": [], "gaps": [[since + 5, since]]}),
        json!({"schema": 1, "since": since, "resets": [], "gaps": "none"}),
        json!({"schema": 1, "since": since, "resets": ["x"], "gaps": []}),
        json!({"schema": 1, "since": since, "resets": 0, "gaps": []}),
        json!({"schema": 1, "since": since, "gaps": []}),
        json!({"schema": 1, "since": since, "resets": [], "gaps": [], "counts": {"x": 1}}),
    ] {
        std::fs::write(&journal, bad.to_string()).unwrap();
        let got = accounting(&["--from", &from]);
        assert_eq!((&got["state"], &got["calls"]), (&json!("partial"), &json!(10)), "{bad}");
        assert_eq!(got["coverage"]["sources"][0]["reasons"][0]["detail"], "coverage journal unreadable", "{bad}");
    }
    // The producer replaces a corrupt journal with a fresh one and a reset.
    cli(&root, &["run", "--", "cargo", "test"], None, &[]);
    let j: Value = serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
    assert_eq!((j["gaps"].clone(), j["resets"].clone()), (json!([]), json!([j["since"].as_u64().unwrap() - 1])));
    // A deleted day file under an intact journal is lost records: unknown with a reason, never complete or zero.
    let held = accounting(&["--from", &from]);
    assert_eq!((&held["state"], &held["calls"]), (&json!("partial"), &json!(11)));
    std::fs::remove_file(&day).unwrap();
    let gone: Value = serde_json::from_slice(&cli(&root, &["stats", "--accounting"], None, &[]).stdout).unwrap();
    assert_eq!((&gone["state"], &gone["calls"]), (&json!("unknown"), &Value::Null), "{gone}");
    assert_eq!(gone["coverage"]["sources"][0]["reasons"][0]["detail"], "stats records lost", "{gone}");
    // A reset rebuilds counts from the records held then: a later truncation reads lost records, never complete.
    for _ in 0..3 {
        cli(&root, &["run", "--", "cargo", "test"], None, &[]);
    }
    std::fs::remove_file(&journal).unwrap();
    cli(&root, &["run", "--", "cargo", "test"], None, &[]);
    let j: Value = serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
    assert_eq!(j["counts"][day.file_stem().unwrap().to_str().unwrap()], 4, "{j}");
    let first = std::fs::read_to_string(&day).unwrap().lines().next().unwrap().to_string();
    std::fs::write(&day, first + "\n").unwrap();
    let cut: Value = serde_json::from_slice(&cli(&root, &["stats", "--accounting"], None, &[]).stdout).unwrap();
    assert_eq!((&cut["state"], &cut["calls"], &cut["lower_bound"]), (&json!("partial"), &json!(1), &json!(true)), "{cut}");
    assert_eq!(cut["coverage"]["sources"][0]["reasons"][0]["detail"], "stats records lost", "{cut}");
    std::fs::remove_dir_all(root).unwrap();
}
fn records_or_empty(root: &Path) -> Vec<Value> {
    if install(root).join("data/stats").exists() {
        records(root)
    } else {
        vec![]
    }
}
