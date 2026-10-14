//! Tool result -> protected output -> retained original -> local record (agentq.md §3).
use serde_json::{Value, json};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Private runner replay: native execution already finished; RTK receives the same streams and exit status.
pub fn replay() -> Option<i32> {
    let dir = std::env::var_os("AGENTQ_RUN_REPLAY")?;
    let dir = Path::new(&dir);
    let exe = std::env::current_exe().ok()?;
    if exe.parent()? != dir.join("bin") {
        return None;
    }
    let replay = || -> Result<i32, std::io::Error> {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join("replay-started"))?;
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        if std::env::var("AGENTQ_RUN_DIGEST").ok().as_deref()
            != Some(crate::configure::digest(&json!(args)).as_str())
        {
            return Err(std::io::Error::other("recipe changed native arguments"));
        }
        let stdout = std::fs::read(dir.join("stdout"))?;
        let stderr = std::fs::read(dir.join("stderr"))?;
        let code = std::fs::read_to_string(dir.join("exit"))?
            .parse()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::io::stdout().write_all(&stdout)?;
        std::io::stderr().write_all(&stderr)?;
        std::fs::write(dir.join("replayed"), b"")?;
        Ok(code)
    };
    Some(replay().unwrap_or_else(|_| {
        let _ = std::fs::write(dir.join("replay-error"), b"");
        127
    }))
}

fn exit(s: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    if let Some(sig) = std::os::unix::process::ExitStatusExt::signal(&s) {
        return 128 + sig;
    }
    s.code().unwrap_or(1)
}

/// A bounded RTK recipe over an already executed native capture; never re-executes the user's command.
fn filter(
    install: &Path,
    cmd: &[String],
    raw: &[u8],
    stderr: &[u8],
    code: i32,
    id: &str,
) -> Result<Vec<u8>, &'static str> {
    let start = Instant::now();
    let rtk = crate::engines::rtk_path(install);
    if !rtk.is_file() {
        return Err("no_engine");
    }
    let dir = install.join("data/runs").join(id);
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).map_err(|_| "error")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for p in [install.join("data/runs"), dir.clone()] {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "error")?;
        }
    }
    let setup = || -> Result<(), std::io::Error> {
        std::fs::write(dir.join("stdout"), raw)?;
        std::fs::write(dir.join("stderr"), stderr)?;
        std::fs::write(dir.join("exit"), code.to_string())?;
        // RTK's databases store command arguments. A file parent makes either database unavailable.
        std::fs::write(dir.join("no-engine-db"), b"")?;
        let exe = std::env::current_exe()?;
        std::fs::copy(
            exe,
            bin.join(format!("{}{}", cmd[0], std::env::consts::EXE_SUFFIX)),
        )?;
        Ok(())
    };
    setup().map_err(|_| "error")?;
    let stdout = std::fs::File::create(dir.join("filtered")).map_err(|_| "error")?;
    let mut c = Command::new(rtk);
    // Only the private replay can resolve on PATH; the engine cannot find a native runner to execute again.
    c.args(cmd)
        .current_dir(&bin)
        .env("PATH", &bin)
        .env("AGENTQ_RUN_REPLAY", &dir)
        .env(
            "AGENTQ_RUN_DIGEST",
            crate::configure::digest(&json!(&cmd[1..])),
        )
        .env("RTK_DB_PATH", dir.join("no-engine-db/gain.db"))
        .env("RTK_RECALL_DB", dir.join("no-engine-db/recall.db"))
        .env("RTK_TELEMETRY_DISABLED", "1")
        .env("RTK_SUPPRESS_HOOK_WARNING", "1")
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    if start.elapsed() >= Duration::from_secs(3) {
        return Err("timeout");
    }
    let mut child = coreq::quiet(&mut c).spawn().map_err(|_| "error")?;
    loop {
        match child.try_wait() {
            Ok(Some(s)) => {
                if exit(s) != code {
                    return Err("error");
                }
                // Require proof that only the captured invocation was replayed.
                if !dir.join("replayed").is_file() || dir.join("replay-error").exists() {
                    return Err("error");
                }
                let output = std::fs::read(dir.join("filtered")).map_err(|_| "error")?;
                return if start.elapsed() < Duration::from_secs(3) {
                    Ok(output)
                } else {
                    Err("timeout")
                };
            }
            Ok(None) if start.elapsed() < Duration::from_secs(3) => {
                std::thread::sleep(Duration::from_millis(10))
            }
            _ => {
                #[cfg(windows)]
                {
                    let _ = coreq::quiet(
                        Command::new("taskkill")
                            .args(["/PID", &child.id().to_string(), "/T", "/F"])
                            .stdout(Stdio::null())
                            .stderr(Stdio::null()),
                    )
                    .status();
                }
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err("timeout");
            }
        }
    }
}

pub fn run(install: &Path, cmd: &[String]) -> i32 {
    let start = Instant::now();
    let data = install.join("data");
    let agent = std::env::var("AGENTQ_AGENT").unwrap_or_else(|_| "unknown".into());
    let ids = json!({"session":std::env::var("AGENTQ_SESSION").ok(),"turn":std::env::var("AGENTQ_TURN").ok(),"tool_call":std::env::var("AGENTQ_TOOL_CALL").ok()});
    let qualified = crate::engines::qualified(cmd);
    let c = config(&data);
    let id = crate::mcp::new_id();
    let run_dir = install.join("data/runs").join(&id);
    let mut bypass = match &c {
        Err(_) => Some("error"),
        Ok(c) if c["enabled"] == false || c["agents"][&agent] == false => Some("disabled"),
        _ if !qualified => Some("not_qualified"),
        _ if !crate::engines::rtk_path(install).is_file() => Some("no_engine"),
        _ => None,
    };
    if bypass.is_none() && std::fs::create_dir_all(&run_dir).is_err() {
        bypass = Some("error");
    }
    if let Some(reason) = bypass {
        let status = Command::new(&cmd[0])
            .args(&cmd[1..])
            .env_remove("AGENTQ_RUN_REPLAY")
            .status();
        let code = match &status {
            Ok(s) => exit(*s),
            Err(e) => {
                eprintln!("agentq: {}: {e}", cmd[0]);
                127
            }
        };
        let mut r = record(&agent, "run", "shell", &ids, 0, crate::now());
        if qualified {
            r["runner"] = json!(if cmd[0] == "pytest" {
                "pytest".into()
            } else {
                cmd[..2].join(" ")
            });
        }
        r["reason"] = json!(if status.is_err() { "error" } else { reason });
        r["outcome"] = json!(
            if status.is_err() || ["error", "no_engine"].contains(&reason) {
                "failed"
            } else {
                "passed"
            }
        );
        for k in ["bytes_in", "bytes_out", "est_tokens_in", "est_tokens_out"] {
            r[k] = Value::Null;
        }
        r["exit_code"] = json!(code);
        r["duration_ms"] = json!(start.elapsed().as_millis() as u64);
        if let Err(e) = save(&data, &c.unwrap_or(Value::Null), &r) {
            eprintln!("agentq: stats unknown: {e}");
        }
        return code;
    }
    let step = Instant::now();
    let native = Command::new(&cmd[0])
        .args(&cmd[1..])
        .stdin(Stdio::inherit())
        .env_remove("AGENTQ_RUN_REPLAY")
        .output();
    crate::profile::trace(
        &data,
        "compress.run",
        "native",
        step.elapsed(),
        native.as_ref().err().map(|_| "error"),
    );
    let native = match native {
        Ok(o) => o,
        Err(e) => {
            eprintln!("agentq: {}: {e}", cmd[0]);
            let _ = std::fs::remove_dir(&run_dir);
            let mut r = record(&agent, "run", "shell", &ids, 0, crate::now());
            r["outcome"] = json!("failed");
            r["reason"] = json!("error");
            r["exit_code"] = json!(127);
            if crate::engines::qualified(cmd) {
                r["runner"] = json!(if cmd[0] == "pytest" {
                    "pytest".into()
                } else {
                    cmd[..2].join(" ")
                });
            }
            r["duration_ms"] = json!(start.elapsed().as_millis() as u64);
            if let Err(e) = save(&data, &c.unwrap_or(Value::Null), &r) {
                eprintln!("agentq: stats unknown: {e}");
            }
            return 127;
        }
    };
    let code = exit(native.status);
    let mut r = record(
        &agent,
        "run",
        "shell",
        &ids,
        native.stdout.len(),
        crate::now(),
    );
    r["exit_code"] = json!(code);
    if qualified {
        r["runner"] = json!(if cmd[0] == "pytest" {
            "pytest".into()
        } else {
            cmd[..2].join(" ")
        });
    }
    let reason = match &c {
        Ok(c) => guard(c, &agent, &native.stdout),
        Err(_) => Some("error"),
    };
    let mut text = native.stdout.clone();
    let mut reason = reason.unwrap_or(if qualified {
        "no_engine"
    } else {
        "not_qualified"
    });
    if reason == "no_engine" && qualified {
        let rtk = crate::engines::rtk_path(install).is_file();
        r["engine"] = json!(if rtk { "rtk" } else { "none" });
        r["engine_version"] = json!(rtk.then_some(crate::engines::RTK));
        let step = Instant::now();
        let filtered = filter(install, cmd, &native.stdout, &native.stderr, code, &id);
        crate::profile::trace(
            &data,
            "compress.run",
            "filter",
            step.elapsed(),
            filtered.as_ref().err().copied(),
        );
        match filtered {
            Ok(mut candidate) => {
                let reference = format!("rtk:{id}");
                candidate.extend_from_slice(
                    format!("\n[Agent Context original ref: {reference}; use get_original.]\n")
                        .as_bytes(),
                );
                if candidate.len() < native.stdout.len()
                    && std::str::from_utf8(&native.stdout).is_ok()
                    && std::str::from_utf8(&candidate).is_ok()
                {
                    text = candidate;
                    reason = "compressed";
                    r["ref"] = json!(reference);
                } else {
                    reason = "not_smaller";
                }
            }
            Err(why) => reason = why,
        }
        // Replays are executable scratch, never retained with user originals.
        let bin = install.join("data/runs").join(&id).join("bin");
        let _ = std::fs::remove_dir_all(bin);
    }
    if run_dir.exists() {
        crate::engines::prune(&install.join("data/runs"));
    }
    if reason == "compressed" && !run_dir.join("stdout").is_file() {
        text = native.stdout.clone();
        reason = "error";
        r["ref"] = Value::Null;
    }
    r["reason"] = json!(reason);
    r["outcome"] = json!(if reason == "compressed" {
        "compressed"
    } else if ["error", "timeout", "no_engine"].contains(&reason) {
        "failed"
    } else {
        "passed"
    });
    r["bytes_out"] = json!(text.len());
    r["est_tokens_out"] = json!(text.len().div_ceil(4));
    r["duration_ms"] = json!(start.elapsed().as_millis() as u64);
    if let Err(e) = save(&data, &c.unwrap_or(Value::Null), &r) {
        text = native.stdout.clone();
        eprintln!("agentq: stats unknown: {e}; native output preserved");
    }
    let _ = std::io::stdout().write_all(&text);
    let _ = std::io::stderr().write_all(&native.stderr);
    code
}

fn config(data: &Path) -> Result<Value, String> {
    match std::fs::read(data.join("config.json")) {
        Ok(b) => {
            let v: Value = serde_json::from_slice(&b).map_err(|e| e.to_string())?;
            if !v.is_object() {
                return Err("config requires object".into());
            }
            let Some(c) = v.get("compression") else {
                return Ok(Value::Null);
            };
            let m = c.as_object().ok_or("compression config requires object")?;
            if m.get("enabled").is_some_and(|v| !v.is_boolean())
                || m.get("min_bytes").is_some_and(|v| v.as_u64().is_none())
                || m.get("stats")
                    .is_some_and(|v| !matches!(v.as_str(), Some("off" | "queue")))
            {
                return Err("invalid compression defaults".into());
            }
            if let Some(agents) = m.get("agents") {
                if !agents
                    .as_object()
                    .is_some_and(|a| a.values().all(Value::is_boolean))
                {
                    return Err("compression agents requires boolean preferences".into());
                }
            }
            Ok(c.clone())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}

fn guard(c: &Value, agent: &str, text: &[u8]) -> Option<&'static str> {
    if c["enabled"] == false || c["agents"][agent] == false {
        return Some("disabled");
    }
    if text.len() < c["min_bytes"].as_u64().unwrap_or(2048) as usize {
        return Some("short");
    }
    if serde_json::from_slice::<Value>(text).is_ok() {
        return Some("json");
    }
    let s = String::from_utf8_lossy(text);
    // Fail closed on code markers; no qualified recipe operates on source text.
    if s.contains("```")
        || s.lines().any(|l| {
            [
                "fn ",
                "pub ",
                "def ",
                "class ",
                "function ",
                "import ",
                "#include",
                "const ",
                "let ",
            ]
            .iter()
            .any(|p| l.trim_start().starts_with(p))
        })
        || [
            " must ", " MUST ", " never ", " NEVER ", " shall ", " SHALL ",
        ]
        .iter()
        .any(|p| s.contains(p))
    {
        return Some("code");
    }
    None
}

fn record(agent: &str, adapter: &str, tool: &str, input: &Value, bytes: usize, at: u64) -> Value {
    json!({"schema":1,"event_id":crate::mcp::new_id().replace('-',""),"time":at,
        "agent":agent,"adapter":adapter,"tool":tool,"runner":null,"engine":"none",
        "outcome":"passed","reason":"not_qualified","bytes_in":bytes,"bytes_out":bytes,
        "est_tokens_in":bytes.div_ceil(4),"est_tokens_out":bytes.div_ceil(4),"duration_ms":0,"ref":null,
        "session":input["session"],"turn":input["turn"],"tool_call":input["tool_call"],
        "version":env!("CARGO_PKG_VERSION"),"engine_version":null})
}

fn stats_date(name: &str) -> Option<&str> {
    let d = name.strip_suffix(".jsonl")?;
    (d.len() == 10
        && d.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        }))
    .then_some(d)
}

/// The producer's coverage journal in `data/stats/` (ACCOUNTING O3).
pub const COVERAGE: &str = "coverage.json";

/// Coverage proven by this store: `since` is its first record; every later call wrote a record unless `gaps` holds its
/// second; `counts` holds the records each day file must still contain, so a lost or truncated file is detectable. A missing journal over held records, or an unreadable one, restarts `since` here and adds a reset: the
/// older records stay countable but unproven.
fn coverage(journal: Option<&[u8]>, held: bool, at: u64) -> Value {
    let fresh = |resets: Vec<u64>| json!({"schema":1,"since":at,"resets":resets,"gaps":[],"counts":{}});
    match journal {
        None if !held => fresh(vec![]),
        None => fresh(vec![at]),
        Some(b) => match serde_json::from_slice::<Value>(b) {
            Ok(v) if journal_valid(&v) => v,
            _ => fresh(vec![at]),
        },
    }
}

/// The whole journal shape, as the producer writes it; anything else proves no coverage.
pub fn journal_valid(v: &Value) -> bool {
    v["schema"] == 1
        && v["since"].is_u64()
        && v["resets"]
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_u64))
        && v["gaps"].as_array().is_some_and(|a| {
            a.iter().all(|g| {
                g.as_array().is_some_and(|p| p.len() == 2)
                    && g[0].as_u64().zip(g[1].as_u64()).is_some_and(|(x, y)| x < y)
            })
        })
        && v["counts"]
            .as_object()
            .is_some_and(|m| m.iter().all(|(k, n)| stats_date(&format!("{k}.jsonl")).is_some() && n.is_u64()))
}

/// Local writes serialize with the existing lifecycle lock; sink errors never change returned tool bytes.
fn save(data: &Path, c: &Value, r: &Value) -> Result<(), String> {
    let _lock = crate::executor::lock(data)?;
    let dir = data.join("stats");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let at = r["time"].as_u64().ok_or("missing time")?;
    let cutoff = at.saturating_sub(7 * 86400);
    let oldest = crate::date(cutoff);
    let mut held = false;
    let mut trimmed = None;
    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let name = e.file_name().to_string_lossy().into_owned();
        held |= stats_date(&name).is_some_and(|d| d >= oldest.as_str());
        if stats_date(&name).is_some_and(|d| d < oldest.as_str()) {
            std::fs::remove_file(e.path()).map_err(|e| e.to_string())?;
        } else if stats_date(&name) == Some(oldest.as_str()) {
            let s = std::fs::read_to_string(e.path()).map_err(|e| e.to_string())?;
            let mut kept = String::new();
            for line in s.lines() {
                let v: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
                if v["time"].as_u64().ok_or("stats unknown: missing time")? >= cutoff {
                    kept.push_str(line);
                    kept.push('\n');
                }
            }
            if kept.len() != s.len() {
                coreq::write_atomic(&e.path(), &kept)?;
                trimmed = Some(kept.lines().count());
            }
        }
    }
    let journal = dir.join(COVERAGE);
    let before = std::fs::read(&journal).ok();
    let mut cov = coverage(before.as_deref(), held, at);
    let appended = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{}.jsonl", crate::date(at))))
        .and_then(|mut f| writeln!(f, "{r}"))
        .map_err(|e| e.to_string());
    let counts = cov["counts"].as_object_mut().unwrap();
    counts.retain(|d, _| d.as_str() >= oldest.as_str());
    if let Some(n) = trimmed {
        counts.insert(oldest.clone(), json!(n));
    }
    if appended.is_ok() {
        let day = crate::date(at);
        let n = counts.get(&day).and_then(Value::as_u64).unwrap_or(0);
        counts.insert(day, json!(n + 1));
    } else {
        cov["gaps"].as_array_mut().unwrap().push(json!([at, at + 1]));
    }
    for k in ["resets", "gaps"] {
        cov[k].as_array_mut().unwrap().retain(|v| {
            v.as_u64().or_else(|| v[1].as_u64()).is_some_and(|t| t > cutoff)
        });
    }
    let after = cov.to_string();
    // A lost journal write keeps the previous, still true journal; the next record then reads a reset.
    if before.as_deref() != Some(after.as_bytes()) {
        if let Err(e) = coreq::write_atomic(&journal, &after) {
            eprintln!("agentq: stats coverage unknown: {e}");
        }
    }
    appended?;
    if c["stats"] != "off" {
        let mut a = serde_json::Map::new();
        for (k, v) in r.as_object().ok_or("invalid record")? {
            a.insert(format!("agentq.{k}"), v.clone());
        }
        a.insert("agentq.est_tokens_kind".into(), json!("estimate"));
        if ["session", "turn", "tool_call"]
            .iter()
            .any(|k| r[k].is_null())
        {
            a.insert(
                "agentq.ids_unknown".into(),
                json!("native IDs not supplied"),
            );
        }
        if crate::telemetry::emit_at(
            data,
            "agentq.compress",
            "end",
            Value::Object(a),
            at as u128 * 1_000_000_000,
        )
        .is_none()
        {
            eprintln!("agentq: compression queue unavailable; local record retained");
        }
    }
    Ok(())
}

/// Hook/provider recipes have no paired qualification yet. No command in JSON is ever executed.
pub fn compress(data: &Path, agent: &str, input: &str) -> Result<Value, String> {
    let start = Instant::now();
    if agent.is_empty() {
        return Err("compression requires agent".into());
    }
    let v: Value =
        serde_json::from_str(input).map_err(|e| format!("invalid compression input: {e}"))?;
    let text = v["text"]
        .as_str()
        .ok_or("compression input requires text string")?;
    let adapter = v["adapter"]
        .as_str()
        .ok_or("compression input requires adapter")?;
    if !["hook", "provider"].contains(&adapter) {
        return Err("result compression requires hook or provider; run uses agentq run".into());
    }
    let tool = v["tool"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("compression input requires tool")?;
    if !v["command"].is_null() && !v["command"].is_string() {
        return Err("command requires string or null".into());
    }
    for key in ["session", "turn", "tool_call"] {
        if !v[key].is_null() && !v[key].is_string() {
            return Err(format!("{key} requires string or null"));
        }
    }
    let mut r = record(agent, adapter, tool, &v, text.len(), crate::now());
    if ["terminal", "shell", "exec_command"].contains(&tool) {
        let words: Vec<String> = v["command"]
            .as_str()
            .unwrap_or("")
            .split_ascii_whitespace()
            .map(String::from)
            .collect();
        if crate::engines::qualified(&words) {
            r["runner"] = json!(if words[0] == "pytest" {
                "pytest".into()
            } else {
                words[..2].join(" ")
            });
        }
    }
    let c = config(data);
    match &c {
        Ok(c) => r["reason"] = json!(guard(c, agent, text.as_bytes()).unwrap_or("not_qualified")),
        Err(_) => {
            r["outcome"] = json!("failed");
            r["reason"] = json!("error");
        }
    }
    r["duration_ms"] = json!(start.elapsed().as_millis() as u64);
    if let Err(e) = save(data, &c.unwrap_or(Value::Null), &r) {
        eprintln!("agentq: stats unknown: {e}");
    }
    Ok(json!({"text":text,"ref":null}))
}

/// Valid stats records with `time >= cutoff`; one unreadable record makes the whole set unknown.
pub fn records(data: &Path, cutoff: u64) -> Result<Vec<Value>, String> {
    let dir = data.join("stats");
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("stats unknown: no stats file".into());
        }
        Err(e) => return Err(format!("stats unknown: {e}")),
    };
    let mut out = vec![];
    let oldest = crate::date(cutoff);
    let mut files = 0;
    for e in entries {
        let e = e.map_err(|e| format!("stats unknown: {e}"))?;
        let n = e.file_name().to_string_lossy().into_owned();
        if !stats_date(&n).is_some_and(|d| d >= oldest.as_str()) {
            continue;
        }
        files += 1;
        let s = std::fs::read_to_string(e.path()).map_err(|e| format!("stats unknown: {e}"))?;
        for line in s.lines() {
            let v: Value = serde_json::from_str(line)
                .map_err(|e| format!("stats unknown: malformed record: {e}"))?;
            if v["time"].as_u64().ok_or("stats unknown: missing time")? < cutoff {
                continue;
            }
            v["agent"].as_str().ok_or("stats unknown: missing agent")?;
            v["engine"]
                .as_str()
                .filter(|e| ["none", "rtk", "headroom"].contains(e))
                .ok_or("stats unknown: invalid engine")?;
            v["outcome"]
                .as_str()
                .filter(|o| ["compressed", "passed", "failed"].contains(o))
                .ok_or("stats unknown: invalid outcome")?;
            if v["schema"] != 1 {
                return Err("stats unknown: unsupported schema".into());
            }
            if !v["event_id"]
                .as_str()
                .is_some_and(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                || ["time", "duration_ms"]
                    .iter()
                    .any(|k| v[k].as_u64().is_none())
                || ["bytes_in", "bytes_out", "est_tokens_in", "est_tokens_out"]
                    .iter()
                    .any(|k| {
                        v.get(k).is_none()
                            || (v[k].as_u64().is_none()
                                && !(v["adapter"] == "run"
                                    && v[k].is_null()
                                    && v["outcome"] != "compressed"))
                    })
                || !v["adapter"]
                    .as_str()
                    .is_some_and(|s| ["run", "hook", "provider"].contains(&s))
                || v["tool"].as_str().is_none()
                || !v["reason"]
                    .as_str()
                    .and_then(crate::accounting::outcome_of)
                    .is_some_and(|o| v["outcome"] == o)
                || ["runner", "ref", "session", "turn", "tool_call"]
                    .iter()
                    .any(|k| v.get(k).is_none() || (!v[k].is_null() && !v[k].is_string()))
                || (v["adapter"] == "run" && v["exit_code"].as_i64().is_none())
            {
                return Err("stats unknown: malformed record shape".into());
            }
            out.push(v);
        }
    }
    if files == 0 {
        return Err("stats unknown: no current stats file".into());
    }
    Ok(out)
}

pub fn stats(data: &Path) -> Result<Value, String> {
    let mut groups = std::collections::BTreeMap::<(String, String), Value>::new();
    for v in records(data, crate::now().saturating_sub(7 * 86400))? {
        // records() checked these strings
        let (agent, engine, outcome) = (
            v["agent"].as_str().unwrap_or_default(),
            v["engine"].as_str().unwrap_or_default(),
            v["outcome"].as_str().unwrap_or_default(),
        );
        let g=groups.entry((agent.into(),engine.into())).or_insert_with(||json!({"agent":agent,"engine":engine,"calls":0,"compressed":0,"passed":0,"failed":0,"bytes_in":0,"bytes_out":0}));
        for (k, add) in [("calls", 1), (outcome, 1)] {
            g[k] = json!(
                g[k].as_u64()
                    .unwrap()
                    .checked_add(add)
                    .ok_or("stats unknown: count overflow")?
            );
        }
        for k in ["bytes_in", "bytes_out"] {
            g[k] = match (g[k].as_u64(), v[k].as_u64()) {
                (Some(a), Some(b)) => {
                    json!(a.checked_add(b).ok_or("stats unknown: byte overflow")?)
                }
                _ => Value::Null,
            };
            if g[k].is_null() {
                g["bytes_unknown"] = json!("native output passed through without capture");
            }
        }
    }
    Ok(json!({"schema":1,"groups":groups.into_values().collect::<Vec<_>>()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    /// §3 / VERIFICATION A2,A4: result -> protected bytes -> one metadata-only record -> aggregate; corrupt/missing is unknown.
    #[test]
    fn result_stats_chain() {
        let d = std::env::temp_dir().join(format!("agentq-compression-{}", crate::mcp::new_id()));
        assert!(stats(&d).unwrap_err().contains("unknown"));
        for bad in [
            "{",
            r#"{"text":3}"#,
            r#"{"text":"x","adapter":"run","tool":"shell"}"#,
        ] {
            assert!(compress(&d, "hermes", bad).is_err());
        }
        assert!(!d.exists());
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join("config.json"),
            r#"{"compression":{"min_bytes":0,"stats":"off"}}"#,
        )
        .unwrap();
        for (text, why) in [
            ("{}", "json"),
            ("fn f() {}", "code"),
            ("a long tool result", "not_qualified"),
        ] {
            let input = json!({"text":text,"adapter":"hook","tool":"terminal","command":"secret argument","session":"s"});
            assert_eq!(
                compress(&d, "hermes", &input.to_string()).unwrap(),
                json!({"text":text,"ref":null})
            );
            let s = std::fs::read_to_string(
                d.join("stats")
                    .join(format!("{}.jsonl", crate::date(crate::now()))),
            )
            .unwrap();
            let r: Value = serde_json::from_str(s.lines().last().unwrap()).unwrap();
            assert_eq!(r["reason"], why);
            assert_eq!(r.as_object().unwrap().len(), 21);
            assert!(!s.contains("secret") && !s.contains(text));
        }
        assert_eq!(stats(&d).unwrap()["groups"][0]["calls"], 3);
        let at = crate::now();
        let mut expired = record(
            "hermes",
            "hook",
            "terminal",
            &Value::Null,
            10,
            at - 7 * 86400 - 120,
        );
        let boundary = d
            .join("stats")
            .join(format!("{}.jsonl", crate::date(at - 7 * 86400)));
        let ancient = d
            .join("stats")
            .join(format!("{}.jsonl", crate::date(at - 8 * 86400)));
        // Align expired data to the boundary partition even when UTC is within two minutes of midnight.
        expired["time"] = json!(at - 7 * 86400 - 120);
        std::fs::write(&boundary, format!("{expired}\n")).unwrap();
        std::fs::write(&ancient, "expired data\n").unwrap();
        assert_eq!(stats(&d).unwrap()["groups"][0]["calls"], 3);
        let input = json!({"text":"result","adapter":"provider","tool":"shell","command":"cargo test --private-arg"});
        std::fs::write(
            d.join("config.json"),
            r#"{"compression":{"min_bytes":0,"stats":"queue","agents":{"codex":false}}}"#,
        )
        .unwrap();
        assert_eq!(
            compress(&d, "codex", &input.to_string()).unwrap()["text"],
            "result"
        );
        assert!(!ancient.exists());
        assert!(std::fs::read_to_string(&boundary).unwrap().is_empty());
        let q: Vec<_> = std::fs::read_dir(d.join("queue"))
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|s| s == "json"))
            .collect();
        assert_eq!(q.len(), 1);
        let span = std::fs::read_to_string(q[0].path()).unwrap();
        assert!(
            span.contains("agentq.compress")
                && span.contains("estimate")
                && span.contains("disabled")
        );
        assert!(!span.contains("private-arg"));
        let p = d
            .join("stats")
            .join(format!("{}.jsonl", crate::date(crate::now())));
        std::fs::write(p, "bad\n").unwrap();
        assert!(stats(&d).unwrap_err().contains("malformed"));
        std::fs::remove_dir_all(d).unwrap();
    }
}
