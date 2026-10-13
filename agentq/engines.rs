//! Managed engines: pinned RTK and the headroom venv; `agentq run` (agentq.md § 3).

use coreq::update::{download, target, verify};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

pub const RTK: &str = "0.51.0";
pub const HEADROOM: &str = "0.40.0";
/// `rtk-ai/rtk` v0.51.0 release assets per `coreq::update::target()`.
const RTK_ASSETS: [(&str, &str, &str); 5] = [
    ("macos-aarch64", "rtk-aarch64-apple-darwin.tar.gz", "8817d8b71afc02ac8bf06eb24bcc41c306592ab735b68e8fee9db1ba0de7cb59"),
    ("macos-x86_64", "rtk-x86_64-apple-darwin.tar.gz", "bd39c8153f4147358360c7dc51665a8131cc9ee16f81f69a9402ffa500be3cc2"),
    ("linux-x86_64", "rtk-x86_64-unknown-linux-musl.tar.gz", "5028d3b19a8f0990d30fec9fbb07e32782bc5698e618fb1861aad8a9ccba4eb5"),
    ("linux-aarch64", "rtk-aarch64-unknown-linux-gnu.tar.gz", "8d6d1aad9e69b42481eda7039507d1f7ee93698f87713cecd873d287c1931632"),
    ("windows-x86_64", "rtk-x86_64-pc-windows-msvc.zip", "1623e9b45d28b15122d69e7314776e1123a804224885ce07e7182fb40080f05c"),
];
pub const HEADROOM_LOCK: &str = include_str!("headroom.lock");
const KEEP: usize = 500;
const KEEP_AGE: Duration = Duration::from_secs(7 * 86400);
const KEEP_BYTES: u64 = 512 * 1024 * 1024;

pub fn rtk_asset() -> Option<(&'static str, &'static str)> {
    RTK_ASSETS.iter().find(|a| a.0 == target()).map(|a| (a.1, a.2))
}

fn engine_dir(install: &Path, name: &str, ver: &str) -> PathBuf {
    install.join("engines").join(format!("{name}-{ver}"))
}

pub fn rtk_path(install: &Path) -> PathBuf {
    engine_dir(install, "rtk", RTK).join(format!("rtk{}", std::env::consts::EXE_SUFFIX))
}

fn venv_bin(dir: &Path, name: &str) -> PathBuf {
    dir.join(if cfg!(windows) { "Scripts" } else { "bin" }).join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
}

/// stdout of a command that must succeed.
fn output(c: &mut Command) -> Result<String, String> {
    let o = coreq::quiet(c).output().map_err(|e| format!("{}: {e}", c.get_program().to_string_lossy()))?;
    if o.status.success() {
        Ok(String::from_utf8_lossy(&o.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&o.stderr);
        Err(format!("{} failed: {}", c.get_program().to_string_lossy(), err.trim().lines().last().unwrap_or("")))
    }
}

fn check_version(exe: &Path, want: &str) -> Result<(), String> {
    let got = output(Command::new(exe).arg("--version"))?.trim().to_string();
    if got == want { Ok(()) } else { Err(format!("{} --version: {got:?}, want {want:?}", exe.display())) }
}

/// One line per engine; a failure names its reason and never fails the caller (agentq.md § 3).
pub fn ensure(install: &Path) -> Vec<String> {
    let line = |name: &str, ver: &str, r: Result<PathBuf, String>| match r {
        Ok(_) => format!("engine {name}: {ver} ready"),
        Err(e) => format!("engine {name}: unavailable: {e}"),
    };
    vec![line("rtk", RTK, install_rtk(install)), line("headroom", HEADROOM, install_headroom(install))]
}

/// Read-only `doctor` lines: each engine's checked version, else why not.
pub fn check(install: &Path) -> Vec<String> {
    let hr = engine_dir(install, "headroom", HEADROOM);
    let hr = if hr.join("ready").exists() { check_version(&venv_bin(&hr, "headroom"), &format!("headroom, version {HEADROOM}")) } else { Err("not installed".into()) };
    [("rtk", RTK, check_version(&rtk_path(install), &format!("rtk {RTK}"))), ("headroom", HEADROOM, hr)]
        .into_iter()
        .map(|(name, ver, r)| match r {
            Ok(()) => format!("engine {name}: {ver} ok"),
            Err(e) => format!("engine {name}: unavailable: {e}"),
        })
        .collect()
}

/// Download, sha256, unpack into a temporary folder, `--version`, then rename into place.
pub fn install_rtk(install: &Path) -> Result<PathBuf, String> {
    let exe = rtk_path(install);
    let want = format!("rtk {RTK}");
    if check_version(&exe, &want).is_ok() {
        return Ok(exe);
    }
    let (name, sha) = rtk_asset().ok_or(format!("no RTK build for {}", target()))?;
    let dir = exe.parent().unwrap();
    let tmp = dir.with_extension(format!("tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let res = (|| {
        let archive = tmp.join(name);
        download(&format!("https://github.com/rtk-ai/rtk/releases/download/v{RTK}/{name}"), &archive)?;
        verify(format!("{sha}  {name}").as_bytes(), name, &std::fs::read(&archive).map_err(|e| e.to_string())?)?;
        // bsdtar on Windows 10+ also reads zip
        output(Command::new("tar").arg("-xf").arg(&archive).arg("-C").arg(&tmp))?;
        std::fs::remove_file(&archive).map_err(|e| e.to_string())?;
        check_version(&tmp.join(exe.file_name().unwrap()), &want)?;
        let _ = std::fs::remove_dir_all(dir);
        std::fs::rename(&tmp, dir).map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    res?;
    check_version(&exe, &want).map(|_| exe)
}

/// Python 3.11-3.13 with venv: `AGENTQ_PYTHON`, else the first one found on PATH.
fn python() -> Result<Vec<String>, String> {
    let probe = "import sys, venv, ensurepip; assert (3, 11) <= sys.version_info[:2] < (3, 14)";
    let found: Vec<Vec<String>> = match std::env::var("AGENTQ_PYTHON") {
        Ok(p) => vec![vec![p]],
        Err(_) => {
            let py = if cfg!(windows) { vec!["py -3.13", "py -3.12", "py -3.11"] } else { vec![] };
            py.into_iter().chain(["python3.13", "python3.12", "python3.11", "python3", "python"]).map(|c| c.split(' ').map(String::from).collect()).collect()
        }
    };
    found
        .into_iter()
        .find(|c| output(py(c).args(["-c", probe])).is_ok())
        .ok_or("no Python 3.11-3.13 with venv; install one or set AGENTQ_PYTHON".into())
}

/// Isolated mode (`-I`) from a fixed folder: no PYTHON* env, user site or planted module from the caller's folder.
fn py<S: AsRef<std::ffi::OsStr>>(c: &[S]) -> Command {
    let mut cmd = Command::new(&c[0]);
    cmd.args(&c[1..]).arg("-I").current_dir(std::env::temp_dir());
    cmd
}

/// Private venv from the hashed lock, wheels only; `ready` marks a checked install.
pub fn install_headroom(install: &Path) -> Result<PathBuf, String> {
    let dir = engine_dir(install, "headroom", HEADROOM);
    let exe = venv_bin(&dir, "headroom");
    let want = format!("headroom, version {HEADROOM}");
    if dir.join("ready").exists() && check_version(&exe, &want).is_ok() {
        return Ok(exe);
    }
    if target() == "macos-x86_64" {
        return Err(format!("headroom {HEADROOM} has no macOS x64 wheels"));
    }
    let python = python()?;
    // a venv is not relocatable: build in place, `ready` last
    let _ = std::fs::remove_dir_all(&dir);
    output(py(&python).args(["-m", "venv"]).arg(&dir))?;
    let lock = dir.join("headroom.lock");
    std::fs::write(&lock, HEADROOM_LOCK).map_err(|e| e.to_string())?;
    let pip = ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--require-hashes", "--only-binary", ":all:", "--no-deps", "-r"];
    output(py(&[venv_bin(&dir, "python")]).args(pip).arg(&lock))?;
    check_version(&exe, &want)?;
    std::fs::write(dir.join("ready"), HEADROOM).map_err(|e| e.to_string())?;
    Ok(exe)
}

/// Test and build runners RTK filters without changing their semantics.
pub fn qualified(cmd: &[String]) -> bool {
    let c: Vec<&str> = cmd.iter().take(2).map(String::as_str).collect();
    matches!(c.as_slice(), ["pytest", ..] | ["cargo", "test" | "build" | "check"] | ["go", "test"])
}

/// `agentq run -- <cmd>`: qualified commands through RTK with retained output, others native; exit code kept. A
/// qualified command queues one `agentq.run` event naming only its runner (agentq.md § 6).
pub fn run(install: &Path, cmd: &[String]) -> i32 {
    let t0 = std::time::Instant::now();
    let (code, engine) = exec(install, cmd);
    if qualified(cmd) {
        let runner = if cmd[0] == "pytest" { "pytest".into() } else { cmd[..2].join(" ") };
        let ms = t0.elapsed().as_millis() as u64;
        crate::telemetry::emit(&install.join("data"), "agentq.run", "end", serde_json::json!({"agentq.command": runner, "agentq.engine": engine, "agentq.rtk_version": RTK, "agentq.exit_code": code, "agentq.duration_ms": ms, "agentq.ids_unknown": "the hook passes no native IDs yet"}));
    }
    code
}

/// Exit code and the engine that ran the command, or why it ran natively.
fn exec(install: &Path, cmd: &[String]) -> (i32, &'static str) {
    let rtk = rtk_path(install);
    let mut why = if rtk.exists() { "native" } else { "native: no checked rtk" };
    if qualified(cmd) && rtk.exists() {
        let runs = install.join("data").join("runs");
        let id = crate::mcp::new_id();
        let dir = runs.join(&id);
        match std::fs::create_dir_all(&dir) {
            Ok(()) => {
                #[cfg(unix)]
                let _ = std::fs::set_permissions(&runs, std::os::unix::fs::PermissionsExt::from_mode(0o700));
                let s = Command::new(&rtk)
                    .args(cmd)
                    .env("RTK_DB_PATH", dir.join("gain.db"))
                    .env("RTK_RECALL_DB", dir.join("recall.db"))
                    .env("RTK_TELEMETRY_DISABLED", "1")
                    .env("RTK_SUPPRESS_HOOK_WARNING", "1")
                    .status();
                if let Ok(s) = s {
                    if dir.join("recall.db").exists() {
                        println!("\n[Agent Context original ref: rtk:{id}; use get_original with the hash from RTK's recovery hint. Retention: latest {KEEP} runs, 7 days, 512 MiB.]");
                    }
                    prune(&runs);
                    return (code(s), "rtk");
                }
                eprintln!("agentq: rtk did not start; native command preserved");
                let _ = std::fs::remove_dir_all(&dir);
                why = "native: rtk did not start";
            }
            Err(_) => {
                eprintln!("agentq: sandbox cannot store recovery; native command preserved");
                why = "native: no writable storage";
            }
        }
    }
    let c = match Command::new(&cmd[0]).args(&cmd[1..]).status() {
        Ok(s) => code(s),
        Err(e) => {
            eprintln!("agentq: {}: {e}", cmd[0]);
            127
        }
    };
    (c, why)
}

fn code(s: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    if let Some(sig) = std::os::unix::process::ExitStatusExt::signal(&s) {
        return 128 + sig;
    }
    s.code().unwrap_or(1)
}

/// `get_original` for `rtk:<id>`: RTK's own recall from that run's database.
pub fn recall(install: &Path, r: &str, hash: &str) -> Result<String, String> {
    let id = r.strip_prefix("rtk:").filter(|id| id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')).ok_or(format!("Invalid reference {r}"))?;
    if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("RTK refs require the hash shown in its recovery hint".into());
    }
    let db = install.join("data").join("runs").join(id).join("recall.db");
    if !db.exists() || age(db.parent().unwrap()) > KEEP_AGE {
        return Err(format!("expired: {r} is not retained; rerun the command"));
    }
    output(Command::new(rtk_path(install)).args(["recall", "--full", hash]).env("RTK_RECALL_DB", db))
}

fn age(p: &Path) -> Duration {
    p.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).unwrap_or(Duration::MAX)
}

fn size(p: &Path) -> u64 {
    std::fs::read_dir(p).into_iter().flatten().flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()
}

/// Keep at most 500 runs, 7 days and 512 MiB; oldest go first.
fn prune(runs: &Path) {
    let mut dirs: Vec<(Duration, PathBuf)> = std::fs::read_dir(runs).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).map(|p| (age(&p), p)).collect();
    dirs.sort();
    let mut bytes = 0;
    for (i, (a, p)) in dirs.iter().enumerate() {
        bytes += size(p);
        if i >= KEEP || *a > KEEP_AGE || bytes > KEEP_BYTES {
            let _ = std::fs::remove_dir_all(p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn qualified_list() {
        for c in [&["pytest"][..], &["pytest", "-q"], &["cargo", "test"], &["cargo", "build", "--release"], &["go", "test", "./..."]] {
            assert!(qualified(&s(c)), "{c:?}");
        }
        for c in [&["cargo"][..], &["cargo", "run"], &["go", "build"], &["npm", "test"], &["ls"], &[]] {
            assert!(!qualified(&s(c)), "{c:?}");
        }
    }

    #[test]
    fn pins() {
        assert!(rtk_asset().is_some(), "an RTK asset for {}", target());
        assert!(HEADROOM_LOCK.contains(&format!("\nheadroom-ai=={HEADROOM} \\")));
        assert!(HEADROOM_LOCK.lines().filter(|l| !l.starts_with('#') && l.contains("==")).all(|l| l.ends_with('\\')), "every pin carries hashes");
    }

    #[test]
    fn native_without_rtk_keeps_exit_code() {
        let d = std::env::temp_dir().join(format!("agentq-run-{}", std::process::id()));
        let sh = if cfg!(windows) { s(&["cmd", "/c", "exit 3"]) } else { s(&["sh", "-c", "exit 3"]) };
        assert_eq!(run(&d, &sh), 3);
        assert_eq!(run(&d, &s(&["agentq-no-such-command"])), 127);
        assert!(!d.exists(), "native runs write nothing");
    }

    /// agentq.md § 6: a qualified command without RTK still runs and queues one event without its arguments.
    #[test]
    fn qualified_run_queues_event() {
        let d = std::env::temp_dir().join(format!("agentq-runev-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        // missing pytest exits 127, an installed one rejects the flag; either way nonzero and recorded
        let c = run(&d, &s(&["pytest", "--agentq-secret-arg"]));
        assert_ne!(c, 0);
        let q: Vec<_> = std::fs::read_dir(d.join("data").join("queue")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".json")).collect();
        assert_eq!(q.len(), 1);
        let ev = std::fs::read_to_string(q[0].path()).unwrap();
        assert!(ev.contains("\"agentq.run\"") && ev.contains("native: no checked rtk") && ev.contains("\"pytest\""));
        assert!(ev.contains(&format!("{{\"intValue\":{c}}}")), "exit code recorded");
        assert!(!ev.contains("secret-arg"), "no arguments");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn recall_checks_refs() {
        let d = std::env::temp_dir().join(format!("agentq-recall-{}", std::process::id()));
        assert!(recall(&d, "rtk:bad", "abc").unwrap_err().starts_with("Invalid"));
        assert!(recall(&d, "rtk:00000000-0000-0000-0000-000000000000", "").unwrap_err().contains("hash"));
        assert!(recall(&d, "rtk:00000000-0000-0000-0000-000000000000", "abc").unwrap_err().starts_with("expired"));
    }

    /// Network: AGENTQ_ENGINE_TEST=1 installs both engines into a temporary install and runs cargo through RTK.
    #[test]
    fn engines_install_and_run() {
        if std::env::var("AGENTQ_ENGINE_TEST").is_err() {
            return;
        }
        let d = std::env::temp_dir().join(format!("agentq-engines-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        install_rtk(&d).unwrap();
        assert_eq!(install_rtk(&d).unwrap(), rtk_path(&d), "second install reuses the checked engine");
        assert_eq!(run(&d, &s(&["cargo", "build", "--help"])), 0);
        assert_eq!(std::fs::read_dir(d.join("data").join("runs")).unwrap().count(), 1, "the run is retained");
        if target() != "macos-x86_64" {
            install_headroom(&d).unwrap();
            assert!(d.join("engines").join(format!("headroom-{HEADROOM}")).join("ready").exists());
        }
        let _ = std::fs::remove_dir_all(&d);
    }
}
