//! agentq: update, service, status, MCP, engines, onboarding, hooks, telemetry and uninstall on coreq (agentq.md § 1-§ 6, § 9, § 10).

mod accounting;
mod configure;
mod compression;
mod connect;
mod engines;
mod executor;
mod legacy;
mod mcp;
mod onboard;
mod profile;
mod profiles;
mod resource;
mod routing;
mod snapshot;
mod telemetry;

use coreq::{Tool, service, status, update, write_atomic};
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// One unit per host and runtime (agentq.md § 5): `com.agentq.host`, `AgentQ-host`, `agentq-host.service`.
const PROJECT: &str = "host";
const PASS: u64 = 30;
const UPDATE_EVERY: u64 = 3600;
const DRAIN: u64 = 900;
/// `onboard --yes` waits this long for a started proxy to answer, before and after one restart (#137).
const PROXY_START: Duration = Duration::from_secs(60);
const USAGE: &str = "agentq run -- <cmd> [args..] | compress <agent> | stats [--json] | stats --accounting [--from <unix>] [--to <unix>] [--bucket <s>] [--events <path>] | profile [--json] | profile trace on [<minutes>]|off | onboard [--yes] [codex|claude|hermes..] | direct [codex|claude|hermes..] | configure [<profile> <field>=<value>.. [--yes]] | hook <agent> <event> | update [--check] | selftest | mcp codex|claude|hermes | service install|run|restart|stop|uninstall|status | doctor | langfuse | telemetry status|verify | enroll <https-url> [--headless] | connection status [--json] | disconnect | uninstall [--legacy] [--dry-run] | --version";

fn tool() -> Tool {
    Tool::new("agentq", "AgentQ", "taskqorg/agentq", VERSION)
}

fn fail(problem: &str, next: &str) -> ! {
    eprintln!("Error: {problem}\nNext: {next}");
    std::process::exit(1);
}

fn main() {
    if let Some(code) = compression::replay() { std::process::exit(code); }
    let t = tool();
    let args: Vec<String> = std::env::args().skip(1).collect();
    // the launcher copy only picks a release (coreq.md § Launcher); hooks run in place, so a release mid-update or a
    // failed start never fails the client's hook (#132)
    if std::env::current_exe().ok() == Some(t.install.join(t.exe_name())) && t.current().is_some() && args.first().map(String::as_str) != Some("hook") {
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
        ["compress", agent] => match std::io::read_to_string(std::io::stdin()).map_err(|e|e.to_string()).and_then(|s|compression::compress(&t.install.join("data"),agent,&s)) {
            Ok(v)=>println_code(&v.to_string()),
            Err(e)=>fail(&e,"send one JSON object with adapter, tool and text; preserve the native result on failure"),
        },
        ["stats", "--accounting", rest @ ..] => accounting_cmd(&t, rest),
        ["stats"] | ["stats","--json"] =>match compression::stats(&t.install.join("data")) {
            Ok(v) if a.len()==2=>println_code(&v.to_string()),
            Ok(v)=>{
                for g in v["groups"].as_array().unwrap() {
                    let bytes=match (g["bytes_in"].as_u64(),g["bytes_out"].as_u64()) {
                        (Some(a),Some(b))=>format!("{a} bytes in, {b} bytes out"),
                        _=>format!("bytes unknown: {}",g["bytes_unknown"].as_str().unwrap()),
                    };
                    println!("{} · {}: {} calls, {} compressed, {} passed, {} failed, {bytes}",g["agent"].as_str().unwrap(),g["engine"].as_str().unwrap(),g["calls"],g["compressed"],g["passed"],g["failed"]);
                }
                0
            },
            Err(e) if a.len()==2=>{println!("{}",serde_json::json!({"schema":1,"state":"unknown","reason":e,"groups":null}));1},
            Err(e)=>fail(&e,"run a tool through agentq; inspect data/stats if records are unreadable"),
        },
        ["profile"] => {
            for l in profile::lines(&profile::report(&t.install.join("data"), now())) {
                println!("{l}");
            }
            0
        }
        ["profile", "--json"] => println_code(&profile::report(&t.install.join("data"), now()).to_string()),
        ["profile", "trace", "on", rest @ ..] if rest.len() <= 1 => match profile::trace_minutes(rest.first().copied()).and_then(|m| profile::set_trace(&t.install.join("data"), Some(m), now())) {
            Ok(s) => println_code(&format!("profile: trace on until {}", s["until"])),
            Err(e) => fail(&format!("profile trace: {e}"), "run `agentq profile trace on [1-60]`"),
        },
        ["profile", "trace", "off"] => match profile::set_trace(&t.install.join("data"), None, now()) {
            Ok(_) => println_code("profile: trace off"),
            Err(e) => fail(&format!("profile trace: {e}"), "fix data/config.json, then run `agentq profile trace off` again"),
        },
        ["mcp", "codex" | "claude" | "hermes"] => mcp::serve(&t.install.join("data").join("originals")),
        ["service", cmd] => service_cmd(&t, cmd),
        ["onboard", rest @ ..] => onboard(&t, rest),
        ["direct", rest @ ..] => direct(&t, rest),
        ["configure", rest @ ..] => configure_cmd(&t, rest),
        // ponytail: no-op `{}` until RTK qualifies commands (§ 3) and the service reports routing (§ 4)
        ["hook", agent @ ("codex" | "claude" | "hermes"), event] => {
            let data = t.install.join("data");
            // println! panics on a closed stdout (exit 101); a hook always answers `{}` and exits 0, even after a
            // stdin failure, and records every failure of the run
            let read = std::io::read_to_string(std::io::stdin()).err().map(|e| format!("stdin: {e}"));
            let wrote = writeln!(std::io::stdout(), "{{}}").err().map(|e| format!("stdout: {e}"));
            let errors: Vec<String> = read.into_iter().chain(wrote).collect();
            if errors.is_empty() {
                executor::stamp(&data, agent, event, now());
            } else {
                executor::hook_failed(&data, agent, event, now(), &errors.join("; "));
            }
            0
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
                Err(e) => fail(&format!("telemetry verify: {e}"), "no observation: Langfuse has not ingested it yet, retry later; 401: run `agentq langfuse`"),
            },
        },
        ["enroll", url] | ["enroll", url, "--headless"] | ["enroll", "--headless", url] => match connect::enroll(&t.install.join("data"), url, !a.contains(&"--headless")) {
            Ok(id) => println_code(&format!("enroll: Connected to {url}; snapshot {id} projected")),
            Err(e) => fail(&format!("enroll: {e}"), "run `agentq connection status`, then `agentq enroll <https-url>` again"),
        },
        ["connection", "status"] => println_code(&connection_line(&connect::status(&t.install.join("data")))),
        ["connection", "status", "--json"] => println_code(&connect::status(&t.install.join("data")).to_string()),
        ["disconnect"] => match connect::disconnect(&t.install.join("data")) {
            Ok(m) => println_code(&format!("disconnect: {m}")),
            Err(e) => fail(&format!("disconnect: {e}"), "run `agentq disconnect` again"),
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

fn connection_line(s: &Value) -> String {
    let e = &s["export"];
    let last = e["last_delivery"].as_u64().map_or("never".into(), |t| format!("{} s ago", now().saturating_sub(t)));
    let mut l = format!("connection: {}", s["state"].as_str().unwrap_or("unknown"));
    if let Some(d) = s["destination"].as_str() {
        l += &format!(" {d}");
    }
    if !e.is_null() {
        l += &format!(", export pending {}, last delivery {last}, error: {}", e["pending"], e["error"].as_str().unwrap_or("none"));
    }
    if s["revocation_pending"].as_u64().unwrap_or(0) > 0 {
        l += &format!(", revocation pending {}", s["revocation_pending"]);
    }
    match s["next"].as_str() {
        Some(n) => format!("{l}\nNext: {n}"),
        None => l,
    }
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
    let agents = routing::agents(&t.install.join("data"));
    for (a, r) in agents.as_object().into_iter().flatten() {
        let want = r["intended"].as_str().unwrap_or("unknown");
        let fix = if want == "routed" && r["routing"] != "routed" { "; run `agentq onboard --yes`" } else { "" };
        line(r["routing"] != "unknown" && want != "unknown" && fix.is_empty(), format!("routing: {a} {} ({}), intended {want} ({}){fix}", r["routing"].as_str().unwrap_or("unknown"), r["reason"].as_str().unwrap_or(""), r["intended_reason"].as_str().unwrap_or("")));
    }
    for f in executor::hook_failures(&t.install.join("data")) {
        line(false, format!("hooks: {f} failed; its next successful run clears it"));
    }
    for d in routing::drift(&journal(t)) {
        line(false, format!("routing: drift: {d} changed since onboard; run `agentq onboard --yes`"));
    }
    let owned = std::fs::read_to_string(journal(t)).ok().and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok()).map_or(0, |j| j.len());
    line(true, format!("owned edits: {owned}"));
    let tel = telemetry_line(t);
    line(tel.contains("keys set"), tel);
    let old = legacy_dir();
    let pids = legacy_pids(&old);
    let installed = legacy::installed(&old);
    let locked = legacy::locked(&old);
    line(!installed && pids.is_empty() && locked.is_empty(), format!("legacy: {}{}", if installed { "installed; run `agentq uninstall --legacy`" } else { "removed" }, running(&pids)));
    for f in &locked {
        println!("legacy: locked {}; stop the legacy processes, then delete {}", f.display(), old.display());
    }
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
        "install" => install_release(t).and_then(|_| start_unit(&u)),
        // the task first: its launcher would restart a killed service run (agentq.md § 5)
        "restart" => service::run_all(&u.stop, true).and_then(|_| {
            end_tree(t);
            service::run_all(&u.load, false)
        }).and_then(|_| if cfg!(windows) { one_service_run(t) } else { Ok(()) }),
        "stop" => {
            end_tree(t);
            service::run_all(&u.stop, false)
        }
        "uninstall" => {
            end_tree(t);
            service::run_all(&u.unload, true).and_then(|_| std::fs::remove_file(&u.path).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }).map_err(|e| e.to_string()))
        }
        "status" => {
            let code = match read_status(t, 3 * PASS) {
                Some(s) => println_code(&format!("service: running {} pid {}, error: {}", s["version"].as_str().unwrap_or("?"), s["pid"], s["error"].as_str().unwrap_or("none"))),
                None => {
                    println!("service: unknown (no status.json newer than {} s)", 3 * PASS);
                    1
                }
            };
            let runs = service_runs(t);
            if runs.len() > 1 {
                println!("service: error: {} service run processes, pids {}; run `agentq service restart`", runs.len(), pids(&runs));
                return 1;
            }
            return code;
        }
        _ => fail(&format!("unknown service command `{cmd}`"), &format!("usage: {USAGE}")),
    };
    match res {
        Ok(()) => println_code(&format!("service: {cmd} done")),
        Err(e) => fail(&format!("service {cmd}: {e}"), "run `agentq service status`"),
    }
}

/// `service install` before the unit: the release, then its engines.
fn install_release(t: &Tool) -> Result<(), String> {
    install_self(t).map(|_| engines::ensure(&t.install).iter().for_each(|l| println!("{l}")))
}

/// Writes the unit and (re)starts it.
fn start_unit(u: &service::Unit) -> Result<(), String> {
    service::write_unit(u).and_then(|_| service::run_all(&u.unload, true)).and_then(|_| service::run_all(&u.load, false))
}

/// coreq `install_self` that skips copies already in place (agentq.md § 5): Windows refuses to overwrite a running exe.
fn install_self(t: &Tool) -> Result<(), String> {
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    copy_unless_same(&me, &t.release_exe(VERSION))?;
    let launcher = t.install.join(t.exe_name());
    match copy_unless_same(&me, &launcher) {
        // the launcher only reads `current`: an older running one keeps working
        Err(e) if launcher.exists() => println!("launcher: kept the running one ({e})"),
        r => r.map(|_| ())?,
    }
    match t.current() {
        Some(c) if !update::newer(VERSION, &c) => {}
        old => {
            if let Some(c) = old {
                write_atomic(&t.install.join("previous"), &c)?;
            }
            write_atomic(&t.install.join("current"), VERSION)?;
        }
    }
    Ok(())
}

/// Copies `me` to `dst` unless `dst` already holds the same bytes; true when it copied.
fn copy_unless_same(me: &Path, dst: &Path) -> Result<bool, String> {
    let bytes = std::fs::read(me).map_err(|e| format!("{}: {e}", me.display()))?;
    if std::fs::read(dst).is_ok_and(|d| d == bytes) {
        return Ok(false);
    }
    if let Some(d) = dst.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
    }
    std::fs::copy(me, dst).map(|_| true).map_err(|e| format!("{}: {e}", dst.display()))
}

/// `schtasks /End` ends only the launcher; end every service run tree too, orphans included (agentq.md § 5).
fn end_tree(t: &Tool) {
    if cfg!(windows) {
        for pid in service_runs(t) {
            let _ = coreq::quiet(Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"])).output();
        }
    }
}

/// Windows restart: wait until exactly one service run is live and `status.json` names it (agentq.md § 5).
fn one_service_run(t: &Tool) -> Result<(), String> {
    let mut runs = vec![];
    for _ in 0..3 * PASS {
        std::thread::sleep(Duration::from_secs(1));
        runs = service_runs(t);
        if let [pid] = runs[..]
            && read_status(t, 3 * PASS).and_then(|s| s["pid"].as_u64()) == Some(pid.into())
        {
            return Ok(());
        }
    }
    Err(format!("expected one service run named by status.json after {} s, found pids [{}]", 3 * PASS, pids(&runs)))
}

/// Live `service run` processes of this install (agentq.md § 5).
fn service_runs(t: &Tool) -> Vec<u32> {
    let out = if cfg!(windows) {
        let ps = format!("Get-CimInstance Win32_Process -Filter \"Name='{}'\" | ForEach-Object {{ \"$($_.ProcessId) $($_.CommandLine)\" }}", t.exe_name());
        coreq::quiet(Command::new("powershell").args(["-NoProfile", "-Command", &ps])).output()
    } else {
        Command::new("ps").args(["-axo", "pid=,args="]).output()
    };
    out.map(|o| service_runs_in(&String::from_utf8_lossy(&o.stdout), &t.install.join("releases"))).unwrap_or_default()
}

/// Pids from `<pid> <command line>` lines that run a binary under `releases` with `service run`; the launcher is not one.
fn service_runs_in(list: &str, releases: &Path) -> Vec<u32> {
    let dir = releases.display().to_string().to_lowercase();
    list.lines()
        .filter_map(|l| {
            let (pid, cmd) = l.trim().split_once(' ')?;
            let cmd = cmd.trim().to_lowercase();
            if cmd.contains(&dir) && cmd.ends_with("service run") { pid.parse().ok() } else { None }
        })
        .collect()
}

fn pids(p: &[u32]) -> String {
    p.iter().map(u32::to_string).collect::<Vec<_>>().join(", ")
}

/// Built-in Windows process list: the launcher and other commands are not service runs (agentq.md § 5).
fn single_instance_selftest() -> bool {
    let list = "4120 \"C:\\Users\\u\\AppData\\Local\\agentq\\agentq.exe\" service run\r\n\
                4188 \"C:\\Users\\u\\AppData\\Local\\agentq\\releases\\0.5.3\\agentq.exe\" service run\r\n\
                5230 C:\\Users\\u\\AppData\\Local\\agentq\\releases\\0.5.3\\agentq.exe service run\r\n\
                6001 \"C:\\Users\\u\\AppData\\Local\\agentq\\releases\\0.5.3\\agentq.exe\" service status\r\n";
    service_runs_in(list, Path::new(r"C:\Users\u\AppData\Local\agentq\releases")) == [4188, 5230]
}

/// One status pass every 30 s, update check hourly; a new release exits 75 so the unit restarts into it.
fn serve(t: &Tool) -> ! {
    // a release with a new engine pin installs it here; status keeps its 30 s pace meanwhile
    let install = t.install.clone();
    std::thread::spawn(move || engines::ensure(&install).iter().for_each(|l| eprintln!("agentq: {l}")));
    let install = t.install.clone();
    std::thread::spawn(move || telemetry::sender(&install, PASS));
    // CONFIGURATION "Host executor": an operation interrupted by the last stop resolves before anything else
    if let Ok(_lock) = executor::lock(&t.install.join("data")) {
        executor::reconcile(&executor::Host::local(&t.install, t.install.join(t.exe_name()), now()));
    }
    let mut checked = 0;
    let mut error = None;
    let mut workers = vec![];
    let launched = std::env::current_exe().ok() == Some(t.release_exe(VERSION));
    let mut seen: Option<(u64, String)> = None;
    loop {
        routing::supervise(&t.install, &mut workers);
        if now() >= checked + UPDATE_EVERY {
            checked = now();
            error = match update::update(t, false) {
                Ok(Some(v)) => {
                    eprintln!("agentq: updated to {v}");
                    None
                }
                Ok(None) => None,
                Err(e) => Some(format!("update: {e}")),
            };
        }
        // agentq.md § 5: the CLI `agentq update` moves `current` too; restart into it once the proxy drains
        match t.current().filter(|c| launched && c != VERSION) {
            None => seen = None,
            Some(c) => {
                let since = seen.as_ref().map_or(now(), |s| s.0);
                let ports: Vec<u16> = workers.iter().map(|w| w.0).collect();
                match drain(routing::open_connections(&ports), now().saturating_sub(since)) {
                    Ok(why) => {
                        eprintln!("agentq: restarting into {c} ({why})");
                        routing::stop(&mut workers);
                        std::process::exit(75);
                    }
                    Err(why) => {
                        if seen.as_ref().is_none_or(|s| s.1 != why) {
                            eprintln!("agentq: restart into {c} deferred: {why}");
                        }
                        seen = Some((since, why));
                    }
                }
            }
        }
        let mut s = status::common(t, &host(), PROJECT, now(), error.clone(), None);
        s["queue"] = telemetry::status(&t.install.join("data"), now());
        s["agents"] = routing::agents(&t.install.join("data"));
        s["engines"] = engines::status(&t.install);
        s["configuration"] = profiles::status(&t.install.join("data"), now());
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

/// Restart into a new `current` (agentq.md § 5): Ok once no proxied connection is open or 15 min passed, else the deferral.
fn drain(open: Result<usize, String>, waited: u64) -> Result<String, String> {
    match open {
        Ok(0) => Ok("no open proxied connection".into()),
        _ if waited >= DRAIN => Ok(format!("drain ended after {} min", DRAIN / 60)),
        Ok(n) => Err(format!("{n} open proxied connections")),
        Err(e) => Err(format!("proxied connections unknown: {e}")),
    }
}

/// Built-in fixtures only; writes nothing outside the OS temp dir (coreq.md § Selftest harness).
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
        ("legacy locked", legacy::selftest_locked()),
        // the running binary is locked on Windows: the installed copy that equals it is read, never overwritten
        ("self copy skip", std::env::current_exe().is_ok_and(|me| copy_unless_same(&me, &me) == Ok(false))),
        ("json bom", onboard::selftest()),
        ("single service run", single_instance_selftest()),
        ("configuration fixtures", configure::selftest()),
        ("snapshot", snapshot::project("i", "linux", None, None, 0)["resource"]["unknown"] == "no sample yet"),
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
    let installed = legacy::installed(&old);
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
    // engines first: routing points an agent at the loopback port only when headroom can serve it
    if let Err(e) = install_release(t) {
        fail(&format!("service install: {e}"), "run `agentq service status`");
    }
    let exe = t.install.join(t.exe_name());
    let mut wants: Vec<_> = agents.iter().flat_map(|a| onboard::wants(a, &onboard::root(a), &onboard::claude_json(), &exe)).collect();
    let mut ports = vec![];
    for a in agents.iter().filter(|a| routing::ROUTED.contains(a)) {
        match engines::headroom_exe(&t.install).ok_or("headroom unavailable".to_string()).and_then(|_| routing::fix_port(&t.install.join("data"), a)) {
            Ok(port) => {
                wants.extend(onboard::routing_wants(a, &onboard::root(a), port));
                ports.push((*a, port));
            }
            Err(e) => println!("routing: {a} direct: {e}"),
        }
    }
    {
        let _lock = executor::lock(&t.install.join("data")).unwrap_or_else(|e| fail(&format!("onboard: {e}"), "wait for it to finish, then run `agentq onboard --yes` again"));
        if let Err(e) = routing::set_direct(&t.install.join("data"), &agents, false) {
            fail(&format!("onboard: {e}"), "fix the file, then run `agentq onboard --yes` again");
        }
        match onboard::apply(&wants, &journal(t)) {
            Ok(lines) => lines.iter().for_each(|l| println!("{l}")),
            Err(e) => fail(&format!("onboard: {e}"), "fix the file, then run `agentq onboard --yes` again"),
        }
    }
    // the unit after the ports and edits (#137): its first pass starts the proxy on each fixed port
    match start_unit(&service::unit(t, &t.install, PROJECT)) {
        Ok(()) => println!("service: install done"),
        Err(e) => fail(&format!("service install: {e}"), "run `agentq service status`"),
    }
    let silent = routing::await_proxies(&ports.iter().map(|p| p.1).collect::<Vec<_>>(), PROXY_START, &mut || {
        println!("routing: proxy not answering after {} s; restarting the service", PROXY_START.as_secs());
        service_cmd(t, "restart");
    });
    for (a, p) in ports {
        let state = if silent.contains(&p) { "not answering; run `agentq service restart`" } else { "answers" };
        println!("routing: {a} proxy on 127.0.0.1:{p} {state}");
    }
    doctor(t);
    println_code(&format!("verify: start a new {} session and call agent_context search_document", agents.join(", ")))
}

/// agentq.md § 1: remove routing edits only; MCP, hooks and telemetry stay. Files only, so it works without the service.
fn direct(t: &Tool, args: &[&str]) -> i32 {
    if let Some(a) = args.iter().find(|a| !onboard::AGENTS.contains(a)) {
        fail(&format!("unknown agent `{a}`"), &format!("usage: {USAGE}"));
    }
    let agents = if args.is_empty() { &onboard::AGENTS[..] } else { args };
    let _lock = executor::lock(&t.install.join("data")).unwrap_or_else(|e| fail(&format!("direct: {e}"), "wait for it to finish, then run `agentq direct` again"));
    if let Err(e) = routing::set_direct(&t.install.join("data"), agents, true) {
        fail(&format!("direct: {e}"), "fix the file, then run `agentq direct` again");
    }
    match onboard::restore(&journal(t), false, Some(agents)) {
        Ok(lines) if lines.is_empty() => println_code(&format!("direct: {} already direct", agents.join(", "))),
        Ok(lines) => {
            lines.iter().for_each(|l| println!("{l}"));
            println_code("direct: done; `agentq onboard --yes` routes again")
        }
        Err(e) => fail(&format!("direct: {e}"), "fix the file, then run `agentq direct` again"),
    }
}

/// ACCOUNTING O1-O3 over local stats or exported events; default window the last 7 days through this second. Unknown
/// exits 1.
fn accounting_cmd(t: &Tool, args: &[&str]) -> i32 {
    let at = now();
    let data = t.install.join("data");
    let mut input = serde_json::json!({"window": {"start": at.saturating_sub(7 * 86400), "end": at + 1}, "now": at});
    let mut source = None;
    for pair in args.chunks(2) {
        let n = || pair.get(1).and_then(|v| v.parse::<u64>().ok()).unwrap_or_else(|| fail(&format!("stats: {} requires unix seconds", pair[0]), "pass a whole number"));
        match pair {
            ["--from", _] => input["window"]["start"] = n().into(),
            ["--to", _] => input["window"]["end"] = n().into(),
            ["--bucket", _] => input["bucket"] = n().into(),
            ["--events", p] => source = Some(accounting::exported(Path::new(p)).unwrap_or_else(|e| fail(&format!("stats: {e}"), "pass a queue folder or an exported events file"))),
            _ => fail(&format!("stats: unknown option {}", pair.join(" ")), "agentq stats --accounting [--from <unix>] [--to <unix>] [--bucket <s>] [--events <path>]"),
        }
    }
    input["sources"] = serde_json::json!([source.unwrap_or_else(|| accounting::local(&data, at))]);
    match accounting::aggregate(&input) {
        Ok(v) => {
            println!("{v}");
            i32::from(v["state"] == "unknown")
        }
        Err(e) => fail(&format!("stats: {e}"), "pass --from before --to"),
    }
}

/// CONFIGURATION "Host executor": no change prints the profiles; changes print the plan; `--yes` applies that plan.
fn configure_cmd(t: &Tool, args: &[&str]) -> i32 {
    let exe = t.install.join(t.exe_name());
    let at = now();
    let host = executor::Host::local(&t.install, exe, at);
    let (profile, rest) = match args.iter().filter(|a| **a != "--yes").collect::<Vec<_>>().split_first() {
        None => return println_code(&serde_json::to_string_pretty(&profiles::status_with(&host.clients, &host.data, at)).unwrap_or_default()),
        Some((p, rest)) => (p.to_string(), rest.iter().map(|a| a.to_string()).collect::<Vec<_>>()),
    };
    let changes: Vec<Value> = rest.iter().map(|c| c.split_once('=').map_or(serde_json::json!({}), |(f, v)| serde_json::json!({"profile": profile, "field": f, "value": v}))).collect();
    let mut op = [0u8; 16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut op).unwrap_or_else(|_| fail("configure: no random source", "run `agentq configure` again"));
    let mut req = serde_json::json!({"schema": configure::SCHEMA, "operation": resource::hex(&op), "kind": "plan", "actor": "local", "workspace": "local", "installation": host.installation,
        "generation": host.generation, "issued_at": at, "expires_at": at + configure::EXPIRY, "changes": changes});
    let plan = executor::execute(&host, &req.to_string(), at);
    println!("{}", serde_json::to_string_pretty(&plan).unwrap_or_default());
    if plan["kind"] != "plan" || plan["writable"] != true {
        fail("configure: no writable plan", "fix the reason above, then run `agentq configure` again");
    }
    if !args.contains(&"--yes") {
        return println_code("Next: run the same command with --yes to apply this plan");
    }
    req["kind"] = "apply".into();
    req["plan"] = serde_json::json!({"revision": plan["revision"], "digest": plan["digest"]});
    let r = executor::execute(&host, &req.to_string(), now());
    println!("{}", serde_json::to_string_pretty(&r).unwrap_or_default());
    match r["outcome"].as_str() {
        Some("applied") => println_code("Next: configured, not verified; start a new client session to verify"),
        _ => fail("configure: not applied", "read the reason above; `agentq configure` shows the current state"),
    }
}

/// agentq.md § 9: restore owned edits, remove the service unit and the install folder.
fn uninstall(t: &Tool, dry: bool) -> i32 {
    if !t.install.exists() {
        return println_code("uninstall: already removed");
    }
    onboard::restore(&journal(t), dry, None).unwrap_or_else(|e| fail(&format!("uninstall: {e}"), "fix the file, then run `agentq uninstall` again")).iter().for_each(|l| println!("{l}"));
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
    if !legacy::installed(dir) {
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
/// Windows: PowerShell `Win32_Process`, case-insensitive. ponytail: pids per folder, not per file; Restart Manager
/// (`RmGetList`) names the holder of each file if a host needs it.
fn legacy_pids(dir: &Path) -> Vec<String> {
    let needle = format!("{}{}", dir.display(), std::path::MAIN_SEPARATOR);
    let o = if cfg!(windows) {
        let ps = format!("Get-CimInstance Win32_Process | ? {{ $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.ToLower().Contains('{}') }} | % ProcessId", needle.to_lowercase().replace('\'', "''"));
        coreq::quiet(Command::new("powershell").args(["-NoProfile", "-Command", &ps])).output()
    } else {
        Command::new("pgrep").arg("-f").arg(needle).output()
    };
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

    /// #71 A1: an installed copy equal to the running binary is not rewritten; a differing one is replaced.
    #[test]
    fn self_copy_skips_equal_bytes() {
        let d = std::env::temp_dir().join(format!("agentq-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let (me, dst) = (d.join("me"), d.join("releases").join("agentq"));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(&me, "v1").unwrap();
        assert_eq!(copy_unless_same(&me, &dst), Ok(true));
        assert_eq!(copy_unless_same(&me, &dst), Ok(false));
        assert_eq!(copy_unless_same(&me, &me), Ok(false));
        std::fs::write(&me, "v2").unwrap();
        assert_eq!(copy_unless_same(&me, &dst), Ok(true));
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "v2");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// #111 A2/A3: a new `current` restarts at once when idle, defers on open or unknown connections, at most 15 min.
    #[test]
    fn restart_waits_for_drain() {
        assert!(drain(Ok(0), 0).is_ok());
        assert_eq!(drain(Ok(2), DRAIN - 1), Err("2 open proxied connections".into()));
        assert!(drain(Err("netstat: not found".into()), 0).unwrap_err().contains("unknown"));
        assert!(drain(Ok(2), DRAIN).is_ok());
    }

    /// #74 A2/A3: two release service runs are counted, the Windows launcher is not.
    #[test]
    fn service_runs_skip_launcher() {
        assert!(single_instance_selftest());
        assert_eq!(service_runs_in("  77 /h/.local/share/agentq/releases/0.5.3/agentq service run\n", Path::new("/h/.local/share/agentq/releases")), [77]);
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
