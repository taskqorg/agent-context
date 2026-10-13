//! agentq: update, service, status, MCP, engines, onboarding, hooks, telemetry and uninstall on coreq (agentq.md § 1-§ 6, § 9, § 10).

mod engines;
mod legacy;
mod mcp;
mod onboard;
mod telemetry;

use coreq::{Tool, service, status, update, write_atomic};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// One unit per host and runtime (agentq.md § 5): `com.agentq.host`, `AgentQ-host`, `agentq-host.service`.
const PROJECT: &str = "host";
const PASS: u64 = 30;
const UPDATE_EVERY: u64 = 3600;
const USAGE: &str = "agentq run -- <cmd> [args..] | onboard [--yes] [codex|claude|hermes..] | hook <agent> <event> | update [--check] | selftest | mcp codex|claude|hermes | service install|run|restart|stop|uninstall|status | doctor | langfuse | telemetry status|verify | uninstall [--legacy] [--dry-run] | --version";

fn tool() -> Tool {
    Tool::new("agentq", "AgentQ", "taskqorg/agentq", VERSION)
}

fn fail(problem: &str, next: &str) -> ! {
    eprintln!("Error: {problem}\nNext: {next}");
    std::process::exit(1);
}

fn main() {
    let t = tool();
    let args: Vec<String> = std::env::args().skip(1).collect();
    // the launcher copy only picks a release (coreq.md § Launcher)
    if std::env::current_exe().ok() == Some(t.install.join(t.exe_name())) && t.current().is_some() {
        coreq::launcher::launch(&t, &args);
    }
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let code = match a.as_slice() {
        ["--version"] => {
            println!("agentq {VERSION}");
            0
        }
        ["update"] | ["update", "--check"] => match update::update(&t, a.len() == 2) {
            Ok(Some(v)) if a.len() == 2 => println_code(&format!("update: {v} available")),
            Ok(Some(v)) => println_code(&format!("update: {v} installed")),
            Ok(None) => println_code(&format!("update: {} is the latest", t.current().unwrap_or(VERSION.into()))),
            Err(e) => fail(&format!("update: {e}"), "check the network and run `agentq update` again"),
        },
        ["selftest"] => selftest(&t),
        ["run", "--", cmd @ ..] if !cmd.is_empty() => engines::run(&t.install, &args[2..]),
        ["mcp", "codex" | "claude" | "hermes"] => mcp::serve(&t.install.join("data").join("originals")),
        ["service", cmd] => service_cmd(&t, cmd),
        ["onboard", rest @ ..] => onboard(&t, rest),
        // ponytail: no-op `{}` until RTK qualifies commands (§ 3) and the service reports routing (§ 4)
        ["hook", "codex" | "claude" | "hermes", _] => {
            let _ = std::io::read_to_string(std::io::stdin());
            println_code("{}")
        }
        ["langfuse"] => match telemetry::read_keys().and_then(|k| telemetry::save(&t.install.join("data"), &k)) {
            Ok(store) => println_code(&format!("langfuse: keys saved in {store}; the service sends on its next pass")),
            Err(e) => fail(&format!("langfuse: {e}"), "run `agentq langfuse` and enter the host, public key and secret key"),
        },
        ["telemetry", "status", ..] => println_code(&telemetry_line(&t)),
        ["telemetry", "verify", ..] => match telemetry::load(&t.install.join("data")) {
            None => fail("telemetry verify: no Langfuse keys", "run `agentq langfuse`"),
            Some(k) => match telemetry::verify(&t.install.join("data"), &k, 20, Duration::from_secs(3)) {
                Ok(id) => println_code(&format!("telemetry: verified trace {id}")),
                Err(e) => fail(&format!("telemetry verify: {e}"), "404: Langfuse has not ingested it yet, retry later; 401: run `agentq langfuse`"),
            },
        },
        ["doctor"] => doctor(&t),
        ["uninstall"] => uninstall(&t, false),
        ["uninstall", "--dry-run"] => uninstall(&t, true),
        ["uninstall", "--legacy"] => legacy(&legacy_dir(), false),
        ["uninstall", "--legacy", "--dry-run"] | ["uninstall", "--dry-run", "--legacy"] => legacy(&legacy_dir(), true),
        _ => fail(&format!("unknown command `{}`", args.join(" ")), &format!("usage: {USAGE}")),
    };
    std::process::exit(code);
}

fn telemetry_line(t: &Tool) -> String {
    let q = telemetry::status(&t.install.join("data"), now());
    let keys = if telemetry::load(&t.install.join("data")).is_some() { "set" } else { "missing" };
    let oldest = q["oldest_age"].as_u64().map_or("none".into(), |s| format!("{s} s"));
    let last = q["last_delivery"].as_u64().map_or("never".into(), |t| format!("{} s ago", now().saturating_sub(t)));
    format!("telemetry: pending {}, oldest {oldest}, last delivery {last}, dropped {}, keys {keys}, error: {}", q["pending"], q["dropped"], q["error"].as_str().unwrap_or("none"))
}

/// agentq.md § 1: read-only install, service, engines, owned edits, telemetry and legacy state; exit 1 on a problem.
fn doctor(t: &Tool) -> i32 {
    let mut ok = true;
    let mut line = |good: bool, l: String| {
        ok &= good;
        println!("{l}");
    };
    match t.current() {
        Some(v) => line(true, format!("install: {} current {v}", t.install.display())),
        None => line(false, format!("install: none at {}; run `agentq onboard --yes`", t.install.display())),
    }
    match read_status(t, 3 * PASS) {
        Some(s) => line(true, format!("service: running {} pid {}", s["version"].as_str().unwrap_or("?"), s["pid"])),
        None => line(false, format!("service: unknown (no status.json newer than {} s); run `agentq service install`", 3 * PASS)),
    }
    for l in engines::check(&t.install) {
        line(!l.contains("unavailable"), l);
    }
    let owned = std::fs::read_to_string(journal(t)).ok().and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok()).map_or(0, |j| j.len());
    line(true, format!("owned edits: {owned}"));
    let tel = telemetry_line(t);
    line(tel.contains("keys set"), tel);
    let old = legacy_dir();
    let pids = legacy_pids(&old);
    let installed = old.join("launcher.mjs").exists();
    line(!installed && pids.is_empty(), format!("legacy: {}{}", if installed { "installed; run `agentq uninstall --legacy`" } else { "removed" }, running(&pids)));
    if ok { 0 } else { 1 }
}

fn println_code(line: &str) -> i32 {
    println!("{line}");
    0
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn host() -> String {
    Command::new("hostname").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

/// agentq.md § 5: `<install>/status.json`, not coreq's `<root>/.<name>/`.
fn status_path(t: &Tool) -> PathBuf {
    t.install.join("status.json")
}

fn read_status(t: &Tool, max_age: u64) -> Option<Value> {
    let p = status_path(t);
    status::age(&p).filter(|a| *a <= max_age)?;
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

fn service_cmd(t: &Tool, cmd: &str) -> i32 {
    let u = service::unit(t, &t.install, PROJECT);
    let res = match cmd {
        "run" => serve(t),
        "install" => update::install_self(t)
            .map(|_| engines::ensure(&t.install).iter().for_each(|l| println!("{l}")))
            .and_then(|_| service::write_unit(&u)).and_then(|_| service::run_all(&u.unload, true)).and_then(|_| service::run_all(&u.load, false)),
        "restart" => {
            end_tree(t);
            service::run_all(&u.stop, true).and_then(|_| service::run_all(&u.load, false))
        }
        "stop" => {
            end_tree(t);
            service::run_all(&u.stop, false)
        }
        "uninstall" => {
            end_tree(t);
            service::run_all(&u.unload, true).and_then(|_| std::fs::remove_file(&u.path).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }).map_err(|e| e.to_string()))
        }
        "status" => {
            return match read_status(t, 3 * PASS) {
                Some(s) => println_code(&format!("service: running {} pid {}, error: {}", s["version"].as_str().unwrap_or("?"), s["pid"], s["error"].as_str().unwrap_or("none"))),
                None => {
                    println!("service: unknown (no status.json newer than {} s)", 3 * PASS);
                    1
                }
            };
        }
        _ => fail(&format!("unknown service command `{cmd}`"), &format!("usage: {USAGE}")),
    };
    match res {
        Ok(()) => println_code(&format!("service: {cmd} done")),
        Err(e) => fail(&format!("service {cmd}: {e}"), "run `agentq service status`"),
    }
}

/// `schtasks /End` ends only the launcher; end the service tree too (coreq.md § Service units).
fn end_tree(t: &Tool) {
    if cfg!(windows)
        && let Some(pid) = read_status(t, u64::MAX).and_then(|s| s["pid"].as_u64())
    {
        let _ = coreq::quiet(Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"])).output();
    }
}

/// One status pass every 30 s, update check hourly; a new release exits 75 so the unit restarts into it.
fn serve(t: &Tool) -> ! {
    // a release with a new engine pin installs it here; status keeps its 30 s pace meanwhile
    let install = t.install.clone();
    std::thread::spawn(move || engines::ensure(&install).iter().for_each(|l| eprintln!("agentq: {l}")));
    let install = t.install.clone();
    std::thread::spawn(move || telemetry::sender(&install, PASS));
    let mut checked = 0;
    let mut error = None;
    loop {
        if now() >= checked + UPDATE_EVERY {
            checked = now();
            error = match update::update(t, false) {
                Ok(Some(v)) => {
                    eprintln!("agentq: updated to {v}; restarting");
                    std::process::exit(75);
                }
                Ok(None) => None,
                Err(e) => Some(format!("update: {e}")),
            };
        }
        let mut s = status::common(t, &host(), PROJECT, now(), error.clone(), None);
        s["queue"] = telemetry::status(&t.install.join("data"), now());
        match write_atomic(&status_path(t), &serde_json::to_string_pretty(&s).unwrap_or_default()) {
            // ponytail: healthy after the first written status; add real checks when the service owns ports (§ 5)
            Ok(()) => {
                let healthy = t.install.join("releases").join(VERSION).join("healthy");
                if healthy.parent().is_some_and(Path::exists) && !healthy.exists() {
                    let _ = std::fs::write(healthy, "");
                }
            }
            Err(e) => eprintln!("agentq: status: {e}"),
        }
        std::thread::sleep(Duration::from_secs(PASS));
    }
}

/// Built-in fixtures only; writes nothing (coreq.md § Selftest harness).
fn selftest(t: &Tool) -> i32 {
    let u = service::unit(t, &t.install, PROJECT);
    let checks = [
        ("version", !update::newer("0.0.0-dev", VERSION)),
        ("unit", u.path.file_name().is_some_and(|f| f.to_string_lossy().contains(PROJECT))),
        ("unit commands", !u.load.is_empty() && !u.unload.is_empty() && !u.stop.is_empty()),
        ("status", status::common(t, "h", PROJECT, 1, None, None)["version"] == VERSION),
        ("mcp tools", mcp::tools().as_array().is_some_and(|a| a.len() == 3)),
        ("telemetry event", telemetry::span("agentq.verify", "selftest", Value::Null, 1, "i", "h")["attributes"].as_array().is_some_and(|a| a.len() == 7)),
        ("legacy strip", legacy::selftest()),
        ("engine pins", engines::rtk_asset().is_some() && engines::HEADROOM_LOCK.contains(&format!("headroom-ai=={}", engines::HEADROOM))),
    ];
    let bad: Vec<&str> = checks.iter().filter(|c| !c.1).map(|c| c.0).collect();
    if bad.is_empty() {
        println_code(&format!("selftest: ok {VERSION} {}", update::target()))
    } else {
        fail(&format!("selftest failed: {}", bad.join(", ")), "report the release as broken")
    }
}

fn journal(t: &Tool) -> PathBuf {
    t.install.join("data").join("owned.json")
}

/// agentq.md § 1: discovery without `--yes`; with it, legacy removal (§ 10), § 4 edits, service install.
fn onboard(t: &Tool, args: &[&str]) -> i32 {
    let yes = args.contains(&"--yes");
    let picked: Vec<&str> = args.iter().copied().filter(|a| *a != "--yes").collect();
    if let Some(a) = picked.iter().find(|a| !onboard::AGENTS.contains(a)) {
        fail(&format!("unknown agent `{a}`"), &format!("usage: {USAGE}"));
    }
    let ready: Vec<&str> = onboard::AGENTS.into_iter().filter(|a| onboard::root(a).exists()).collect();
    for a in onboard::AGENTS {
        println!("{a}: {} {}", if ready.contains(&a) { "ready" } else { "not found" }, onboard::root(a).display());
    }
    let old = legacy_dir();
    // a still-running legacy process recreates the folder with incidents/ and machine-id.json only: not an install
    let installed = old.join("launcher.mjs").exists();
    let pids = running(&legacy_pids(&old));
    if installed {
        println!("legacy: {} found{pids}", old.display());
    } else if !pids.is_empty() {
        println!("legacy: removed{pids}");
    }
    if !yes {
        return 0;
    }
    // `--yes` is the consent (§ 10)
    if installed {
        legacy(&old, false);
    }
    let agents: Vec<&str> = if picked.is_empty() { ready } else { picked.into_iter().filter(|a| ready.contains(a)).collect() };
    let exe = t.install.join(t.exe_name());
    let wants: Vec<_> = agents.iter().flat_map(|a| onboard::wants(a, &onboard::root(a), &onboard::claude_json(), &exe)).collect();
    match onboard::apply(&wants, &journal(t)) {
        Ok(lines) => lines.iter().for_each(|l| println!("{l}")),
        Err(e) => fail(&format!("onboard: {e}"), "fix the file, then run `agentq onboard --yes` again"),
    }
    service_cmd(t, "install");
    doctor(t);
    println_code(&format!("verify: start a new {} session and call agent_context search_document", agents.join(", ")))
}

/// agentq.md § 9: restore owned edits, remove the service unit and the install folder.
fn uninstall(t: &Tool, dry: bool) -> i32 {
    if !t.install.exists() {
        return println_code("uninstall: already removed");
    }
    onboard::restore(&journal(t), dry).unwrap_or_else(|e| fail(&format!("uninstall: {e}"), "fix the file, then run `agentq uninstall` again")).iter().for_each(|l| println!("{l}"));
    if dry {
        return println_code(&format!("would remove: service unit, {}", t.install.display()));
    }
    service_cmd(t, "uninstall");
    match std::fs::remove_dir_all(&t.install) {
        Ok(()) => println_code(&format!("removed: {}", t.install.display())),
        Err(e) => fail(&format!("remove {}: {e}", t.install.display()), "close agentq processes and run `agentq uninstall` again"),
    }
}

/// `AGENT_CONTEXT_HOME` (or home)/.agent-context, as the Node package resolves it.
fn legacy_dir() -> PathBuf {
    let home = std::env::var_os("AGENT_CONTEXT_HOME").or_else(|| std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })).unwrap_or_default();
    PathBuf::from(home).join(".agent-context")
}

/// agentq.md § 10: back up and strip legacy config entries, unload the monitor, remove the npm package, move the
/// folder aside.
fn legacy(dir: &Path, dry: bool) -> i32 {
    if !dir.join("launcher.mjs").exists() {
        println!("legacy: already removed{}", running(&legacy_pids(dir)));
        return 0;
    }
    let run = |cmd: &str, args: &[&str]| coreq::quiet(Command::new(cmd).args(args)).output().is_ok_and(|o| o.status.success());
    match legacy::remove(dir, dry, &date(now()), &run) {
        Ok(lines) => {
            lines.iter().for_each(|l| println!("{l}"));
            0
        }
        Err(e) => fail(&format!("legacy uninstall: {e}"), "close programs using the legacy folder, then run `agentq uninstall --legacy` again"),
    }
}

/// `YYYY-MM-DD` in UTC (days-to-civil, H. Hinnant).
fn date(secs: u64) -> String {
    let z = (secs / 86400) as i64 + 719468;
    let (era, doe) = (z.div_euclid(146097), z.rem_euclid(146097));
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    format!("{:04}-{m:02}-{d:02}", yoe + era * 400 + i64::from(m <= 2))
}

/// Pids of processes whose command line holds `<legacy>/`, as the legacy launcher, proxies and MCP servers do.
/// ponytail: `pgrep` only; Windows reports none until a host needs it there.
fn legacy_pids(dir: &Path) -> Vec<String> {
    let o = Command::new("pgrep").arg("-f").arg(format!("{}/", dir.display())).output();
    o.map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().map(String::from).collect()).unwrap_or_default()
}

fn running(pids: &[String]) -> String {
    if pids.is_empty() { String::new() } else { format!("; legacy processes still running: pids {}", pids.join(" ")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_is_utc_civil() {
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(1_791_849_600), "2026-10-13");
        assert_eq!(date(951_782_400), "2000-02-29");
    }

    /// #64 A3: a running legacy process recreated the folder with leftovers only: removed, and its pid is named.
    #[cfg(unix)]
    #[test]
    fn legacy_leftovers_name_running_pids() {
        let d = std::env::temp_dir().join(format!("agentq-leftover-{}", std::process::id()));
        std::fs::create_dir_all(d.join("incidents")).unwrap();
        std::fs::write(d.join("machine-id.json"), "{}").unwrap();
        let mut p = Command::new("sh").args(["-c", "sleep 30; true"]).arg(d.join("launcher.mjs")).spawn().unwrap();
        assert_eq!(legacy_pids(&d), vec![p.id().to_string()]);
        assert_eq!(legacy(&d, false), 0, "no launcher: nothing to uninstall");
        let _ = p.kill();
        let _ = p.wait();
        assert!(legacy_pids(&d).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }
}
