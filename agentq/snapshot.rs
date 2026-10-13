//! Enrollment snapshot (docs/spec/ENROLLMENT.md): a pure, versioned projection of `status.json` and the newest
//! `agentq.resource` span. Only allowlisted keys and enumerated values cross; paths, prompts, raw status text, raw
//! OTLP attributes and secrets never do. Unknown stays unknown with a reason, never zero.

use serde_json::{Map, Value, json};

pub const SCHEMA: u64 = 1;
/// `status.json` is unknown after 90 s (agentq.md § 5).
const STALE: u64 = 90;
const ROUTING: [&str; 4] = ["routed", "direct", "bypassed", "unknown"];
const ENGINES: [&str; 2] = ["rtk", "headroom"];
/// Resource reasons that pass as written; any other probe error becomes `probe failed`, so no probe path or OS text
/// crosses.
const REASONS: [&str; 5] = ["warmup", "counter reset", "wsl1 mirrors the Windows host", "no sampler on this OS", "no local filesystem"];
const NUMBERS: [&str; 6] = ["cpu_percent", "cpu_interval_ms", "memory_total_bytes", "memory_available_bytes", "memory_used_bytes", "clock_step_ms"];

fn reason(v: &Value) -> Value {
    json!(v.as_str().filter(|r| REASONS.contains(r)).unwrap_or("probe failed"))
}

fn pick<'a>(v: Option<&'a str>, allowed: &[&'a str]) -> &'a str {
    v.filter(|v| allowed.contains(v)).unwrap_or("unknown")
}

/// `installation`, `runtime`: `data/installation` and `telemetry::runtime()`; `status`: parsed `status.json` when
/// readable; `resource`: the newest queued `agentq.resource` span; `now`: unix seconds.
pub fn project(installation: &str, runtime: &str, status: Option<&Value>, resource: Option<&Value>, now: u64) -> Value {
    let at = status.and_then(|s| s["at"].as_u64());
    let service = match (status, at) {
        (None, _) => json!({"state": "unknown", "reason": "no status"}),
        (_, None) => json!({"state": "unknown", "reason": "status without time"}),
        (_, Some(a)) if now.saturating_sub(a) > STALE => json!({"state": "unknown", "reason": "stale status"}),
        _ => json!({"state": "running"}),
    };
    let s = status.cloned().unwrap_or(Value::Null);
    let agents: Map<String, Value> = s["agents"].as_object().into_iter().flatten().filter(|(a, _)| crate::onboard::AGENTS.contains(&a.as_str())).map(|(a, r)| (a.clone(), json!(pick(r["routing"].as_str(), &ROUTING)))).collect();
    let engines: Map<String, Value> = ENGINES
        .iter()
        .map(|e| {
            let x = &s["engines"][e];
            let v = match (x["state"].as_str(), x["version"].as_str()) {
                (Some(st @ ("ready" | "unavailable")), Some(ver)) if ver.chars().all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c)) => json!({"state": st, "version": ver}),
                _ => json!({"state": "unknown"}),
            };
            (e.to_string(), v)
        })
        .collect();
    let q = &s["queue"];
    let queue = json!({"pending": q["pending"].as_u64(), "oldest_age": q["oldest_age"].as_u64(), "last_delivery": q["last_delivery"].as_u64(), "dropped": q["dropped"].as_u64(), "send_error": q["error"].is_string()});
    json!({
        "schema": SCHEMA,
        "installation": installation,
        "runtime": runtime,
        "version": s["version"].as_str(),
        "status_at": at,
        "service": service,
        "update": {"available": s["update"].as_str(), "error": s["error"].is_string()},
        "routing": agents,
        "engines": engines,
        "queue": queue,
        "resource": resource.map_or_else(|| json!({"unknown": "no sample yet"}), project_resource),
    })
}

/// The `agentq.resource.*` allowlist of one OTLP span, with its source timestamp and event ID.
fn project_resource(span: &Value) -> Value {
    let attrs: Map<String, Value> = span["attributes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| {
            let v = a["value"].as_object()?.values().next()?.clone();
            Some((a["key"].as_str()?.strip_prefix("agentq.resource.")?.to_string(), v))
        })
        .collect();
    let mut out = Map::new();
    out.insert("event_id".into(), json!(span["traceId"].as_str()));
    // OTLP int64 travels as a decimal string
    out.insert("at_ns".into(), json!(span["startTimeUnixNano"].as_str().filter(|t| t.bytes().all(|b| b.is_ascii_digit()))));
    for k in NUMBERS {
        let v = &attrs.get(k).cloned().unwrap_or(Value::Null);
        let n = v.as_str().and_then(|s| s.parse::<f64>().ok()).map(Value::from).or_else(|| v.is_number().then(|| v.clone()));
        if let Some(n) = n {
            out.insert(k.into(), n);
        }
    }
    for (probe, has) in [("cpu", "cpu_percent"), ("memory", "memory_total_bytes"), ("disk", "disks")] {
        match attrs.get(&format!("{probe}_unknown")) {
            Some(r) => drop(out.insert(format!("{probe}_unknown"), reason(r))),
            None if !attrs.contains_key(has) => drop(out.insert(format!("{probe}_unknown"), json!("missing"))),
            None => {}
        }
    }
    if let Some(d) = attrs.get("disks").and_then(Value::as_str).and_then(|s| serde_json::from_str::<Vec<Value>>(s).ok()) {
        let disks: Vec<Value> = d
            .iter()
            .map(|d| {
                let mut x = json!({"id": d["id"].as_str(), "role": pick(d["role"].as_str(), &["root", "other"]), "fstype": d["fstype"].as_str().filter(|f| f.len() <= 16 && f.bytes().all(|b| b.is_ascii_alphanumeric()))});
                match (d["total_bytes"].as_u64(), d["free_bytes"].as_u64(), d["used_bytes"].as_u64()) {
                    (Some(t), Some(f), Some(u)) => {
                        x["total_bytes"] = json!(t);
                        x["free_bytes"] = json!(f);
                        x["used_bytes"] = json!(u);
                    }
                    _ => x["unknown"] = if d["unknown"].is_null() { json!("missing") } else { reason(&d["unknown"]) },
                }
                x
            })
            .collect();
        out.insert("disks".into(), json!(disks));
    }
    out.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource::tests::{dir, reading, sampler};
    use std::time::{Duration, Instant};

    fn status() -> Value {
        json!({"host": "alice-mbp", "version": "1.2.3", "pid": 42, "at": 1000, "project": "host", "error": "update: GET /Users/alice/x: 404", "update": null,
            "queue": {"pending": 3, "oldest_age": 60, "last_delivery": 990, "dropped": 0, "error": "curl https://lf.example: secret sk-lf-1"},
            "agents": {"codex": {"routing": "routed", "reason": "127.0.0.1:4100"}, "claude": {"routing": "weird", "reason": "/Users/alice/.claude"}, "/tmp/x": {"routing": "routed"}},
            "engines": {"rtk": {"state": "ready", "version": "0.51.0"}, "headroom": {"state": "unavailable", "version": "0.40.0"}}})
    }

    /// A span from the real sampler and span builder on the existing resource fixtures.
    fn sample(cpu: Result<(u64, u64), String>, prev: Result<(u64, u64), String>, after: Duration) -> Value {
        let d = dir("snapshot");
        let t0 = Instant::now();
        let a = sampler(&d, prev, t0).sample(reading(cpu), t0 + after, 1_000_000_000_000 + after.as_nanos());
        let _ = std::fs::remove_dir_all(d);
        crate::telemetry::span("agentq.resource", "sample", Value::Object(a), 1_300_000_000_000, "inst", "alice-mbp")
    }

    /// A1, A2: identity, version, health, queue and source timestamp; no paths, hosts, prompts or secret text.
    #[test]
    fn allowlisted_projection() {
        let r = sample(Ok((350, 2000)), Ok((100, 1000)), Duration::from_secs(300));
        let p = project("inst", "macos", Some(&status()), Some(&r), 1030);
        assert_eq!((p["schema"].clone(), p["installation"].clone(), p["runtime"].clone(), p["version"].clone(), p["status_at"].clone()), (json!(1), json!("inst"), json!("macos"), json!("1.2.3"), json!(1000)));
        assert_eq!(p["service"], json!({"state": "running"}));
        assert_eq!(p["routing"], json!({"codex": "routed", "claude": "unknown"}), "enumerated values and known agents only");
        assert_eq!(p["engines"]["headroom"], json!({"state": "unavailable", "version": "0.40.0"}));
        assert_eq!(p["queue"], json!({"pending": 3, "oldest_age": 60, "last_delivery": 990, "dropped": 0, "send_error": true}));
        assert_eq!(p["update"], json!({"available": null, "error": true}));
        let res = &p["resource"];
        assert_eq!((res["at_ns"].clone(), res["cpu_percent"].clone(), res["memory_used_bytes"].clone()), (json!("1300000000000"), json!(25.0), json!(5u64 << 30)));
        assert_eq!(res["event_id"], r["traceId"]);
        assert_eq!(res["disks"][0]["total_bytes"], json!(100));
        assert_eq!(res["disks"][1]["unknown"], "probe failed", "a stat error names no probe path");
        let text = p.to_string();
        for leak in ["alice", "/Users", "/tmp", "/proc", "127.0.0.1", "lf.example", "sk-lf", "pid", "host"] {
            assert!(!text.contains(leak), "{leak} in {text}");
        }
    }

    /// A2, A3: missing status and fields, a stale status, counter reset, warmup and an unsupported probe stay explicit.
    #[test]
    fn unknown_stays_explicit() {
        let p = project("inst", "linux", None, None, 1000);
        assert_eq!(p["service"], json!({"state": "unknown", "reason": "no status"}));
        assert_eq!(p["resource"], json!({"unknown": "no sample yet"}));
        assert_eq!(p["engines"]["rtk"], json!({"state": "unknown"}));
        assert!(p["queue"]["pending"].is_null() && p["version"].is_null(), "missing is null, never zero");
        assert_eq!(project("inst", "linux", Some(&status()), None, 2000)["service"]["reason"], "stale status");
        assert_eq!(project("inst", "linux", Some(&json!({})), None, 2000)["service"]["reason"], "status without time");

        let reset = project("inst", "linux", None, Some(&sample(Ok((10, 3100)), Ok((400, 3000)), Duration::from_secs(300))), 0);
        assert_eq!(reset["resource"]["cpu_unknown"], "counter reset");
        assert!(reset["resource"]["cpu_percent"].is_null());
        let warm = project("inst", "linux", None, Some(&sample(Ok((50, 200)), Ok((0, 100)), Duration::from_secs(5))), 0);
        assert_eq!(warm["resource"]["cpu_unknown"], "warmup");
        let no = project("inst", "linux", None, Some(&sample(Err("no sampler on this OS".into()), Ok((0, 1)), Duration::from_secs(300))), 0);
        assert_eq!(no["resource"]["cpu_unknown"], "no sampler on this OS");

        let bare = json!({"traceId": "ab", "startTimeUnixNano": "5", "attributes": [{"key": "agentq.resource.cpu_unknown", "value": {"stringValue": "/proc/stat: permission denied"}}, {"key": "agentq.resource.secret", "value": {"stringValue": "x"}}]});
        let res = project("inst", "linux", None, Some(&bare), 0)["resource"].clone();
        assert_eq!(res, json!({"event_id": "ab", "at_ns": "5", "cpu_unknown": "probe failed", "memory_unknown": "missing", "disk_unknown": "missing"}));
    }
}
