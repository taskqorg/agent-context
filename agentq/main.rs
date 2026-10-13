//! agentq: update, service, status, MCP, onboarding, hooks and uninstall on coreq (agentq.md § 1, § 2, § 4, § 5, § 9, § 10).

mod mcp;
mod onboard;

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
const USAGE: &str = "agentq onboard [--yes] [codex|claude|hermes..] | hook <agent> <event> | update [--check] | selftest | mcp codex|claude|hermes | service install|run|restart|stop|uninstall|status | uninstall [--legacy] [--dry-run] | --version";

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
        ["mcp", "codex" | "claude" | "hermes"] => mcp::serve(&t.install.join("data").join("originals")),
        ["service", cmd] => service_cmd(&t, cmd),
        ["onboard", rest @ ..] => onboard(&t, rest),
        // ponytail: no-op `{}` until RTK qualifies commands (§ 3) and the service reports routing (§ 4)
        ["hook", "codex" | "claude" | "hermes", _] => {
            let _ = std::io::read_to_string(std::io::stdin());
            println_code("{}")
        }
        ["uninstall"] => uninstall(&t, false),
        ["uninstall", "--dry-run"] => uninstall(&t, true),
        ["uninstall", "--legacy"] => legacy(&legacy_dir(), false).unwrap_or_else(|e| fail(&e.0, &e.1)),
        ["uninstall", "--legacy", "--dry-run"] | ["uninstall", "--dry-run", "--legacy"] => legacy(&legacy_dir(), true).unwrap_or_else(|e| fail(&e.0, &e.1)),
        _ => fail(&format!("unknown command `{}`", args.join(" ")), &format!("usage: {USAGE}")),
    };
    std::process::exit(code);
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
        "install" => update::install_self(t).and_then(|_| service::write_unit(&u)).and_then(|_| service::run_all(&u.unload, true)).and_then(|_| service::run_all(&u.load, false)),
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
        let s = status::common(t, &host(), PROJECT, now(), error.clone(), None);
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

/// agentq.md § 1: discovery without `--yes`; with it, legacy removal on consent (§ 10), § 4 edits, service install.
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
    if old.exists() {
        println!("legacy: {} found", old.display());
    }
    if !yes {
        return 0;
    }
    if old.exists() {
        legacy(&old, true).unwrap_or_else(|e| fail(&e.0, &e.1));
        eprint!("Remove the legacy install shown above? [y/N] ");
        let mut answer = String::new();
        let _ = std::io::stdin().read_line(&mut answer);
        if answer.trim() != "y" || legacy(&old, false) != Ok(0) {
            fail("legacy install still present", "run `agentq uninstall --legacy`, then `agentq onboard --yes`");
        }
    }
    let agents: Vec<&str> = if picked.is_empty() { ready } else { picked.into_iter().filter(|a| ready.contains(a)).collect() };
    let exe = t.install.join(t.exe_name());
    let wants: Vec<_> = agents.iter().flat_map(|a| onboard::wants(a, &onboard::root(a), &onboard::claude_json(), &exe)).collect();
    match onboard::apply(&wants, &journal(t)) {
        Ok(lines) => lines.iter().for_each(|l| println!("{l}")),
        Err(e) => fail(&format!("onboard: {e}"), "fix the file, then run `agentq onboard --yes` again"),
    }
    service_cmd(t, "install");
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

/// agentq.md § 10: the legacy install removes itself (npm package, launcher, services, journaled edits); agentq never
/// deletes its files.
fn legacy(dir: &Path, dry: bool) -> Result<i32, (String, String)> {
    if !dir.exists() {
        // ponytail: a global npm package left without ~/.agent-context stays; `npm uninstall -g @alexkirs/agent-context` removes it
        println!("legacy: already removed");
        return Ok(0);
    }
    let launcher = dir.join("launcher.mjs");
    let mut c = Command::new("node");
    c.arg(&launcher).arg("uninstall");
    if dry {
        c.arg("--dry-run");
    }
    let s = c.status().map_err(|e| (format!("legacy uninstall needs Node: {e}"), format!("install Node, then run `node {} uninstall`", launcher.display())))?;
    Ok(s.code().unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_delegates_to_its_own_uninstall() {
        let d = std::env::temp_dir().join(format!("agentq-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        assert_eq!(legacy(&d, false), Ok(0), "no legacy install: no-op");
        std::fs::create_dir_all(&d).unwrap();
        // the fake launcher records its args and removes the install, as the Node uninstall does
        std::fs::write(d.join("launcher.mjs"), "import fs from 'node:fs';import p from 'node:path';const d=import.meta.dirname;fs.writeFileSync(p.join(d,'..','agentq-legacy-args-'+process.ppid),process.argv.slice(2).join(' '));if(!process.argv.includes('--dry-run'))fs.rmSync(d,{recursive:true});").unwrap();
        let args = d.parent().unwrap().join(format!("agentq-legacy-args-{}", std::process::id()));
        assert_eq!(legacy(&d, true), Ok(0));
        assert_eq!(std::fs::read_to_string(&args).unwrap(), "uninstall --dry-run");
        assert!(d.exists(), "dry run keeps the install");
        assert_eq!(legacy(&d, false), Ok(0));
        assert_eq!(std::fs::read_to_string(&args).unwrap(), "uninstall");
        assert!(!d.exists());
        assert_eq!(legacy(&d, false), Ok(0), "second run: no-op");
        let _ = std::fs::remove_file(args);
    }
}
