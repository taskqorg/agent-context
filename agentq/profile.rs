//! Profiling (agentq.md § 6 Profiling): always-on samples of named operations from the existing stats records and queue
//! state, a bounded trace switch and one report ranked against the budgets. Names, numbers and class codes only.

use coreq::write_atomic;
use serde_json::{Map, Value, json};
use std::io::Write as _;
use std::path::Path;
use std::time::Duration;

/// Operation, p95 budget in ms (none: the sample includes work agentq does not own), failure budget.
const OPS: [(&str, Option<u64>, f64); 5] = [
    ("compress.run", None, 0.01),
    ("compress.hook", Some(1000), 0.01),
    ("compress.provider", Some(1000), 0.01),
    ("export.langfuse", Some(10_000), 0.05),
    ("export.dashq", Some(10_000), 0.05),
];
const PROXY: &str = "headroom proxy serves model requests; agentq records none";
const WINDOW: u64 = 7 * 86400;
/// Export samples kept per operation in `state.json`.
const KEEP: usize = 256;
const UNSTABLE_CV: f64 = 1.0;
const TRACE_DEFAULT: u64 = 15;
const TRACE_MAX: u64 = 60;
const TRACE_DAY_BYTES: u64 = 1 << 20;

fn ms(d: Duration) -> u64 {
    d.as_millis() as u64
}

/// Stable class code for a Langfuse send error; the message itself is never stored.
pub fn class(e: &str) -> &'static str {
    if e.contains("error: 401") || e.contains("error: 403") {
        "auth"
    } else if e.contains("(28)") {
        "timeout"
    } else if e.contains("(22)") {
        "http"
    } else if e.starts_with("Langfuse:") || e.starts_with("curl:") {
        "network"
    } else {
        "queue"
    }
}

/// One export sample into a `state.json` value: `[time, duration_ms, class]`, class null on success; oldest go first.
pub fn sample(st: &mut Value, op: &str, at: u64, took: Duration, class: Option<&str>) {
    if !st["profile"].is_object() {
        st["profile"] = json!({});
    }
    if !st["profile"][op].is_array() {
        st["profile"][op] = json!([]);
    }
    let v = st["profile"][op].as_array_mut().expect("array");
    v.push(json!([at, ms(took), class]));
    let over = v.len().saturating_sub(KEEP);
    v.drain(..over);
}

/// `profile.trace_until` from `config.json`, None when absent; an unreadable config or invalid value is the reason
/// the switch is unknown.
fn trace_until(data: &Path) -> Result<Option<u64>, String> {
    let s = match std::fs::read_to_string(data.join("config.json")) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("trace switch unknown: config.json: {e}")),
    };
    let c: Value = serde_json::from_str(&s).map_err(|_| "trace switch unknown: unreadable config.json")?;
    let p = match c.as_object().ok_or("trace switch unknown: config.json is not a JSON object")?.get("profile") {
        None => return Ok(None),
        Some(Value::Object(p)) => p,
        Some(_) => return Err("trace switch unknown: malformed profile".into()),
    };
    p.get("trace_until").map_or(Ok(None), |t| t.as_u64().map(Some).ok_or("trace switch unknown: invalid trace_until".into()))
}

/// While the switch is on, one trace line per step; best effort, never fails the caller. An unknown switch writes
/// nothing; the report names it.
pub fn trace(data: &Path, op: &str, step: &str, took: Duration, class: Option<&str>) {
    let now = crate::now();
    if !trace_until(data).is_ok_and(|t| t.is_some_and(|t| now < t)) {
        return;
    }
    let dir = data.join("traces");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let oldest = crate::date(now.saturating_sub(WINDOW));
    for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        if e.file_name().to_string_lossy().strip_suffix(".jsonl").is_some_and(|d| d < oldest.as_str()) {
            let _ = std::fs::remove_file(e.path());
        }
    }
    let file = dir.join(format!("{}.jsonl", crate::date(now)));
    if std::fs::metadata(&file).is_ok_and(|m| m.len() >= TRACE_DAY_BYTES) {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(f, "{}", json!({"time": now, "op": op, "step": step, "duration_ms": ms(took), "class": class}));
    }
}

/// `profile trace on [<minutes>]` (Some) or `off` (None): `profile.trace_until` in `config.json`, other keys kept.
pub fn set_trace(data: &Path, minutes: Option<u64>, now: u64) -> Result<Value, String> {
    let _lock = crate::compression::lock(data)?;
    let mut c = match std::fs::read_to_string(data.join("config.json")) {
        Ok(s) => serde_json::from_str::<Value>(&s).ok().filter(Value::is_object).ok_or("config.json is not a JSON object")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("config.json: {e}")),
    };
    let c_map = c.as_object_mut().expect("object");
    match minutes {
        Some(m) => {
            c_map.insert("profile".into(), json!({"trace_until": now + m.clamp(1, TRACE_MAX) * 60}));
        }
        None => {
            c_map.shift_remove("profile");
        }
    }
    write_atomic(&data.join("config.json"), &serde_json::to_string_pretty(&c).map_err(|e| e.to_string())?)?;
    Ok(trace_state(data, now))
}

pub fn trace_minutes(arg: Option<&str>) -> Result<u64, String> {
    match arg {
        None => Ok(TRACE_DEFAULT),
        Some(s) => s.parse().ok().filter(|m| (1..=TRACE_MAX).contains(m)).ok_or(format!("minutes must be 1 to {TRACE_MAX}")),
    }
}

fn trace_state(data: &Path, now: u64) -> Value {
    match trace_until(data) {
        Ok(Some(t)) if t > now => json!({"state": "on", "until": t}),
        Ok(_) => json!({"state": "off", "until": null}),
        Err(e) => json!({"state": "unknown", "until": null, "reason": e}),
    }
}

fn round(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// Nearest rank over sorted durations.
fn rank(sorted: &[u64], q: f64) -> u64 {
    sorted[((q * sorted.len() as f64).ceil() as usize).max(1) - 1]
}

/// Calls, failures and their classes, p50/p95/max, mean, standard deviation, cv and the over-budget verdict.
fn summary(op: &str, samples: &[(u64, Option<String>)], p95_budget: Option<u64>, fail_budget: f64) -> Value {
    let mut d: Vec<u64> = samples.iter().map(|s| s.0).collect();
    d.sort_unstable();
    let n = d.len() as f64;
    let mean = d.iter().map(|&x| x as f64).sum::<f64>() / n;
    let sd = (d.iter().map(|&x| (x as f64 - mean).powi(2)).sum::<f64>() / n).sqrt();
    let cv = if mean > 0.0 { sd / mean } else { 0.0 };
    let mut classes = Map::new();
    for c in samples.iter().filter_map(|s| s.1.as_deref()) {
        let k = classes.entry(c).or_insert(json!(0));
        *k = json!(k.as_u64().unwrap_or(0) + 1);
    }
    let failed: u64 = classes.values().filter_map(Value::as_u64).sum();
    let rate = failed as f64 / n;
    let p95 = rank(&d, 0.95);
    let ratios = [("time", p95_budget.map(|b| p95 as f64 / b.max(1) as f64)), ("failures", Some(rate / fail_budget)), ("unstable", Some(cv / UNSTABLE_CV))];
    let over: Vec<&str> = ratios.iter().filter(|r| r.1.is_some_and(|x| x > 1.0)).map(|r| r.0).collect();
    let score = ratios.iter().filter_map(|r| r.1).fold(0.0, f64::max);
    json!({"op": op, "state": "measured", "calls": d.len(), "failed": failed, "failure_rate": round(rate), "classes": classes,
        "p50_ms": rank(&d, 0.5), "p95_ms": p95, "max_ms": d[d.len() - 1], "mean_ms": round(mean), "stddev_ms": round(sd), "cv": round(cv),
        "budget": {"p95_ms": p95_budget, "failure_rate": fail_budget}, "over": over, "score": round(score)})
}

fn unknown(op: &str, reason: &str) -> Value {
    json!({"op": op, "state": "unknown", "reason": reason})
}

/// Export samples per operation from `queue/state.json`; an unreadable file or sample is the reason it is unknown.
fn export_state(data: &Path) -> Result<Map<String, Value>, String> {
    let s = match std::fs::read_to_string(data.join("queue/state.json")) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(format!("export state unknown: {e}")),
    };
    let v: Value = serde_json::from_str(&s).map_err(|_| "export state unknown: unreadable state.json")?;
    match v.as_object().ok_or("export state unknown: state.json is not a JSON object")?.get("profile") {
        None => Ok(Map::new()),
        Some(Value::Object(m)) => Ok(m.clone()),
        Some(_) => Err("export state unknown: malformed profile".into()),
    }
}

fn export_samples(samples: &Value, cutoff: u64, now: u64) -> Result<Vec<(u64, Option<String>)>, String> {
    let mut out = vec![];
    for s in samples.as_array().ok_or("export state unknown: malformed samples")? {
        let (Some(at), Some(d), Some(c)) = (s[0].as_u64(), s[1].as_u64(), s.get(2)) else {
            return Err("export state unknown: malformed sample".into());
        };
        if !c.is_null() && !c.is_string() || s.as_array().is_some_and(|a| a.len() != 3) {
            return Err("export state unknown: malformed sample".into());
        }
        if at >= cutoff && at <= now {
            out.push((d, c.as_str().map(String::from)));
        }
    }
    Ok(out)
}

/// Trace lines in the window grouped per operation and step; a malformed line makes the traces unknown.
fn steps(data: &Path, cutoff: u64, now: u64) -> Result<Map<String, Value>, String> {
    let mut g = std::collections::BTreeMap::<(String, String), Vec<(u64, Option<String>)>>::new();
    let oldest = crate::date(cutoff);
    let entries = match std::fs::read_dir(data.join("traces")) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(format!("traces unknown: {e}")),
    };
    for e in entries {
        let e = e.map_err(|e| format!("traces unknown: {e}"))?;
        if !e.file_name().to_string_lossy().strip_suffix(".jsonl").is_some_and(|d| d >= oldest.as_str()) {
            continue;
        }
        let s = std::fs::read_to_string(e.path()).map_err(|e| format!("traces unknown: {e}"))?;
        for line in s.lines() {
            let v: Value = serde_json::from_str(line).map_err(|_| "traces unknown: malformed line")?;
            let (Some(at), Some(op), Some(step), Some(d)) = (v["time"].as_u64(), v["op"].as_str(), v["step"].as_str(), v["duration_ms"].as_u64()) else {
                return Err("traces unknown: malformed line".into());
            };
            if !v["class"].is_null() && !v["class"].is_string() {
                return Err("traces unknown: malformed line".into());
            }
            if at >= cutoff && at <= now {
                g.entry((op.into(), step.into())).or_default().push((d, v["class"].as_str().map(String::from)));
            }
        }
    }
    let mut out = Map::new();
    for ((op, step), mut s) in g {
        let failed = s.iter().filter(|x| x.1.is_some()).count();
        s.sort_unstable_by_key(|x| x.0);
        let d: Vec<u64> = s.iter().map(|x| x.0).collect();
        let e = out.entry(op).or_insert(json!([]));
        e.as_array_mut().expect("array").push(json!({"step": step, "calls": d.len(), "failed": failed, "p95_ms": rank(&d, 0.95)}));
    }
    Ok(out)
}

/// `agentq profile`: every named operation over the last 7 days, worst first; unknown last with its reason.
pub fn report(data: &Path, now: u64) -> Value {
    let cutoff = now.saturating_sub(WINDOW);
    let compress = crate::compression::records(data, cutoff);
    let export = export_state(data);
    let (steps, trace_unknown) = match steps(data, cutoff, now) {
        Ok(s) => (s, None),
        Err(e) => (Map::new(), Some(e)),
    };
    let mut known = vec![];
    let mut unknowns = vec![];
    for (op, p95, fail) in OPS {
        let samples: Result<Vec<_>, String> = if let Some(adapter) = op.strip_prefix("compress.") {
            compress.as_ref().map_err(Clone::clone).map(|r| {
                r.iter().filter(|v| v["adapter"] == adapter && v["time"].as_u64().is_some_and(|t| t <= now))
                    .map(|v| (v["duration_ms"].as_u64().unwrap_or(0), (v["outcome"] == "failed").then(|| v["reason"].as_str().unwrap_or("error").to_string())))
                    .collect()
            })
        } else {
            export.as_ref().map_err(Clone::clone).and_then(|m| m.get(op).map_or(Ok(vec![]), |s| export_samples(s, cutoff, now)))
        };
        match samples {
            Ok(s) if s.is_empty() => unknowns.push(unknown(op, "no samples in window")),
            Ok(s) => {
                let mut v = summary(op, &s, p95, fail);
                if let Some(st) = steps.get(op) {
                    v["steps"] = st.clone();
                }
                known.push(v);
            }
            Err(e) => unknowns.push(unknown(op, &e)),
        }
    }
    unknowns.push(unknown("proxy.request", PROXY));
    known.sort_by(|a, b| b["score"].as_f64().partial_cmp(&a["score"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
    known.extend(unknowns);
    let mut trace = trace_state(data, now);
    if let Some(e) = trace_unknown {
        trace["unknown"] = json!(e);
    }
    json!({"schema": 1, "window": {"start": cutoff, "end": now}, "trace": trace, "operations": known})
}

/// One line per operation for `agentq profile`.
pub fn lines(r: &Value) -> Vec<String> {
    let t = &r["trace"];
    let mut out = vec![format!(
        "profile: {} to {} UTC, trace {}{}",
        crate::date(r["window"]["start"].as_u64().unwrap_or(0)),
        crate::date(r["window"]["end"].as_u64().unwrap_or(0)),
        t["state"].as_str().unwrap_or("unknown"),
        t["until"].as_u64().map_or(String::new(), |u| format!(" until {u}")),
    )];
    for e in [&t["reason"], &t["unknown"]].into_iter().filter_map(Value::as_str) {
        out.push(format!("trace: {e}"));
    }
    for o in r["operations"].as_array().into_iter().flatten() {
        let op = o["op"].as_str().unwrap_or("?");
        if o["state"] != "measured" {
            out.push(format!("{op}: unknown: {}", o["reason"].as_str().unwrap_or("no reason")));
            continue;
        }
        let classes: Vec<String> = o["classes"].as_object().into_iter().flatten().map(|(k, v)| format!("{k} {v}")).collect();
        let classes = if classes.is_empty() { String::new() } else { format!(" ({})", classes.join(", ")) };
        let b = &o["budget"];
        let budget = format!("{}failed ≤ {}%", b["p95_ms"].as_u64().map_or(String::new(), |p| format!("p95 ≤ {p} ms, ")), b["failure_rate"].as_f64().unwrap_or(0.0) * 100.0);
        let over: Vec<&str> = o["over"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let verdict = if over.is_empty() { "within budget".to_string() } else { format!("over budget: {}", over.join(", ")) };
        out.push(format!(
            "{op}: {} calls, {:.1}% failed{classes}, p50 {} ms, p95 {} ms, max {} ms, cv {}; {verdict} ({budget})",
            o["calls"], o["failure_rate"].as_f64().unwrap_or(0.0) * 100.0, o["p50_ms"], o["p95_ms"], o["max_ms"], o["cv"]
        ));
        for s in o["steps"].as_array().into_iter().flatten() {
            out.push(format!("  {op} {}: {} calls, {} failed, p95 {} ms", s["step"].as_str().unwrap_or("?"), s["calls"], s["failed"], s["p95_ms"]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("agentq-profile-{}", crate::mcp::new_id()));
        std::fs::create_dir_all(d.join("queue")).unwrap();
        d
    }

    fn op<'a>(r: &'a Value, name: &str) -> &'a Value {
        r["operations"].as_array().unwrap().iter().find(|o| o["op"] == name).unwrap()
    }

    /// § 6 Profiling: empty store -> every operation unknown with a reason, none zero or ok.
    #[test]
    fn empty_store_is_unknown() {
        let d = dir();
        let r = report(&d, crate::now());
        let ops = r["operations"].as_array().unwrap();
        assert_eq!(ops.len(), 6);
        assert!(ops.iter().all(|o| o["state"] == "unknown" && o["reason"].as_str().is_some_and(|s| !s.is_empty()) && o.get("calls").is_none()));
        assert!(op(&r, "compress.run")["reason"].as_str().unwrap().contains("no stats file"));
        assert_eq!(op(&r, "export.langfuse")["reason"], "no samples in window");
        assert_eq!(op(&r, "proxy.request")["reason"], PROXY);
        assert_eq!(r["trace"]["state"], "off");
        assert!(lines(&r).iter().skip(1).all(|l| l.contains(": unknown: ")));
        std::fs::remove_dir_all(d).unwrap();
    }

    /// § 6 Profiling: samples -> ranked report (failures, time, instability) -> corrupt record or state keeps only its
    /// own operations unknown; the trace switch is bounded and leaves other config keys.
    #[test]
    fn ranked_report_and_corrupt_records() {
        let d = dir();
        let now = crate::now();
        let mut st = json!({"last_delivery": 1});
        for (i, ms_) in [100u64, 120, 110, 90].iter().enumerate() {
            sample(&mut st, "export.dashq", now - 10, Duration::from_millis(*ms_), (i == 0).then_some("no_reply"));
        }
        for _ in 0..KEEP + 5 {
            sample(&mut st, "export.langfuse", now - 5, Duration::from_millis(50), None);
        }
        sample(&mut st, "export.langfuse", now - WINDOW - 1, Duration::from_millis(1), Some("auth"));
        assert_eq!(st["profile"]["export.langfuse"].as_array().unwrap().len(), KEEP);
        std::fs::write(d.join("queue/state.json"), st.to_string()).unwrap();
        std::fs::create_dir_all(d.join("stats")).unwrap();
        let rec = |adapter: &str, ms_: u64, outcome: &str, reason: &str| {
            let mut r = json!({"schema":1,"event_id":"0".repeat(32),"time":now - 1,"agent":"claude","adapter":adapter,"tool":"shell","runner":null,"engine":"none",
                "outcome":outcome,"reason":reason,"bytes_in":10,"bytes_out":10,"est_tokens_in":3,"est_tokens_out":3,"duration_ms":ms_,"ref":null,"session":null,"turn":null,"tool_call":null});
            if adapter == "run" {
                r["exit_code"] = json!(0);
            }
            r.to_string()
        };
        let lines_ = [rec("hook", 2500, "passed", "short"), rec("hook", 2400, "passed", "json"), rec("run", 10, "passed", "not_qualified"), rec("run", 5000, "failed", "timeout")];
        let stats = d.join("stats").join(format!("{}.jsonl", crate::date(now)));
        std::fs::write(&stats, lines_.join("\n") + "\n").unwrap();
        let r = report(&d, now);
        let names: Vec<&str> = r["operations"].as_array().unwrap().iter().map(|o| o["op"].as_str().unwrap()).collect();
        // run: 50 % failed of a 1 % budget; dashq: 25 % of 5 %; hook: p95 2500 of 1000 ms; langfuse within budget
        assert_eq!(&names[..4], ["compress.run", "export.dashq", "compress.hook", "export.langfuse"]);
        let run = op(&r, "compress.run");
        assert_eq!((run["calls"].as_u64(), run["failed"].as_u64(), run["classes"]["timeout"].as_u64()), (Some(2), Some(1), Some(1)));
        assert_eq!(run["budget"]["p95_ms"], Value::Null);
        assert!(run["over"].as_array().unwrap().contains(&json!("failures")));
        let hook = op(&r, "compress.hook");
        assert_eq!((hook["p50_ms"].as_u64(), hook["p95_ms"].as_u64(), hook["max_ms"].as_u64()), (Some(2400), Some(2500), Some(2500)));
        assert_eq!(hook["over"], json!(["time"]));
        let lf = op(&r, "export.langfuse");
        assert_eq!((lf["calls"].as_u64(), lf["failed"].as_u64(), lf["cv"].as_f64()), (Some(KEEP as u64 - 1), Some(0), Some(0.0)));
        assert_eq!(lf["over"], json!([]));
        assert_eq!(op(&r, "compress.provider")["state"], "unknown");
        let text = lines(&r).join("\n");
        assert!(text.contains("compress.hook: 2 calls, 0.0% failed, p50 2400 ms, p95 2500 ms, max 2500 ms") && text.contains("over budget: time"), "{text}");
        assert!(!text.contains("claude") && !text.contains("shell"));

        // a corrupt stats record: all compress.* unknown, exports still measured
        std::fs::write(&stats, lines_.join("\n") + "\n{bad\n").unwrap();
        let r = report(&d, now);
        for o in ["compress.run", "compress.hook", "compress.provider"] {
            assert_eq!(op(&r, o)["state"], "unknown");
            assert!(op(&r, o)["reason"].as_str().unwrap().contains("malformed"));
        }
        assert_eq!(op(&r, "export.langfuse")["state"], "measured");
        // a corrupt export sample: only that operation unknown, the other export and compression measured
        std::fs::write(&stats, lines_.join("\n") + "\n").unwrap();
        let bad = format!(r#"{{"profile":{{"export.langfuse":[[1,"x",null]],"export.dashq":[[{},20,null]]}}}}"#, now - 1);
        std::fs::write(d.join("queue/state.json"), bad).unwrap();
        let r = report(&d, now);
        assert!(op(&r, "export.langfuse")["reason"].as_str().unwrap().contains("malformed sample"));
        assert_eq!(op(&r, "export.dashq")["state"], "measured");
        assert_eq!(op(&r, "compress.hook")["state"], "measured");
        // unreadable state: every export unknown
        std::fs::write(d.join("queue/state.json"), "{").unwrap();
        let r = report(&d, now);
        for o in ["export.langfuse", "export.dashq"] {
            assert!(op(&r, o)["reason"].as_str().unwrap().contains("unreadable"), "{o}");
        }

        // trace switch: bounded, keeps other config, steps join the report; off stops writing
        std::fs::write(d.join("config.json"), r#"{"ports":{"codex":1}}"#).unwrap();
        trace(&d, "compress.run", "native", Duration::from_millis(7), None);
        assert!(!d.join("traces").exists());
        assert!(trace_minutes(Some("61")).is_err() && trace_minutes(Some("0")).is_err());
        let t = set_trace(&d, Some(trace_minutes(None).unwrap()), now).unwrap();
        assert_eq!(t, json!({"state": "on", "until": now + TRACE_DEFAULT * 60}));
        trace(&d, "compress.run", "native", Duration::from_millis(7), None);
        trace(&d, "compress.run", "filter", Duration::from_millis(9), Some("timeout"));
        let step = op(&report(&d, crate::now()), "compress.run")["steps"].clone();
        assert_eq!(step, json!([{"step": "filter", "calls": 1, "failed": 1, "p95_ms": 9}, {"step": "native", "calls": 1, "failed": 0, "p95_ms": 7}]));
        assert_eq!(set_trace(&d, None, now).unwrap()["state"], "off");
        let c: Value = serde_json::from_str(&std::fs::read_to_string(d.join("config.json")).unwrap()).unwrap();
        assert_eq!(c, json!({"ports": {"codex": 1}}));
        std::fs::write(d.join("traces").join(format!("{}.jsonl", crate::date(now))), "bad\n").unwrap();
        assert!(report(&d, now)["trace"]["unknown"].as_str().unwrap().contains("malformed"));
        std::fs::remove_dir_all(d).unwrap();
    }

    /// § 6 Profiling: a corrupt config, export state or trace store reads unknown with its reason, never trace off or
    /// no samples; an unknown switch writes no trace.
    #[test]
    fn corrupt_switch_state_and_traces_are_unknown() {
        let d = dir();
        let now = crate::now();
        for (config, reason) in [
            ("{", "unreadable config.json"),
            ("[]", "not a JSON object"),
            (r#"{"profile":1}"#, "malformed profile"),
            (r#"{"profile":{"trace_until":"soon"}}"#, "invalid trace_until"),
            (r#"{"profile":{"trace_until":-1}}"#, "invalid trace_until"),
        ] {
            std::fs::write(d.join("config.json"), config).unwrap();
            let t = &report(&d, now)["trace"];
            assert_eq!(t["state"], "unknown", "{config}");
            assert!(t["reason"].as_str().unwrap().contains(reason), "{config}: {t}");
            assert!(lines(&report(&d, now))[0].contains("trace unknown"));
            trace(&d, "compress.run", "native", Duration::from_millis(1), None);
            assert!(!d.join("traces").exists());
        }
        for (state, reason) in [
            ("[]", "not a JSON object"),
            ("1", "not a JSON object"),
            (r#"{"profile":null}"#, "malformed profile"),
            (r#"{"profile":{"export.dashq":{}}}"#, "malformed samples"),
        ] {
            std::fs::write(d.join("queue/state.json"), state).unwrap();
            let r = report(&d, now);
            assert!(op(&r, "export.dashq")["reason"].as_str().unwrap().contains(reason), "{state}");
        }
        std::fs::write(d.join("traces"), "not a directory").unwrap();
        assert!(report(&d, now)["trace"]["unknown"].as_str().unwrap().starts_with("traces unknown: "));
        std::fs::remove_file(d.join("traces")).unwrap();
        std::fs::create_dir(d.join("traces")).unwrap();
        let line = json!({"time": now, "op": "compress.run", "step": "native", "duration_ms": 1, "class": 5});
        std::fs::write(d.join("traces").join(format!("{}.jsonl", crate::date(now))), format!("{line}\n")).unwrap();
        assert!(report(&d, now)["trace"]["unknown"].as_str().unwrap().contains("malformed line"));
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn langfuse_errors_have_stable_classes() {
        for (e, c) in [
            ("Langfuse: curl: (22) The requested URL returned error: 401", "auth"),
            ("Langfuse: curl: (22) The requested URL returned error: 500", "http"),
            ("Langfuse: curl: (28) Operation timed out after 30001 milliseconds", "timeout"),
            ("Langfuse: curl: (6) Could not resolve host: example", "network"),
            ("queue: cannot delete sent events", "queue"),
        ] {
            assert_eq!(class(e), c, "{e}");
        }
    }
}
