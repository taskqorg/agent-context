//! DashQ connection (docs/spec/ENROLLMENT.md): coreq `enroll` owns pairing, the protected grant and revocation in
//! `data/connection/`; allowlisted snapshots travel as grant-bound records in the existing telemetry queue.

use crate::telemetry::{RECORD, entries, prune, queue, update_state};
use coreq::enroll::{self, Backoff, Delivery, Request, Wire};
use coreq::write_atomic;
use serde_json::{Value, json};
use std::io::Write as _;
use std::path::{Path, PathBuf};

pub const SCHEMA: &str = "agentq-snapshot/1";
/// DashQ C5: a snapshot every 60 s while connected; first connection completes within 60 s, receipt polled at 2 s.
const HEARTBEAT: u64 = 60;
const COMPLETE: u64 = 60;
const POLL: u64 = 2;

fn dir(data: &Path) -> PathBuf {
    data.join("connection")
}

fn read(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

/// coreq makes a random installation on first use; AgentQ keeps `data/installation` as the identity.
fn seed(data: &Path) -> Result<PathBuf, String> {
    let d = dir(data);
    let file = d.join("connection.json");
    if !file.exists() {
        // coreq protects the folder first, so the seed is born inside it
        enroll::active(&d)?;
        let s = json!({"installation": crate::telemetry::installation(data), "pending": null, "active": null, "revoke": []});
        let tmp = d.join("connection.json.seed");
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
        o.open(&tmp).and_then(|mut f| f.write_all(s.to_string().as_bytes()).and_then(|_| f.sync_all())).and_then(|_| std::fs::rename(&tmp, &file)).map_err(|e| format!("{}: {e}", file.display()))?;
    }
    Ok(d)
}

/// One allowlisted snapshot of `status.json` and the newest resource sample, bound to the active grant and queued.
/// An unsent snapshot of the same grant and resource sample adds no history: the new one replaces it.
fn queue_snapshot(data: &Path, now: u64) -> Result<(Value, PathBuf), String> {
    let status = data.parent().and_then(|i| read(&i.join("status.json")));
    let payload = crate::snapshot::project(&crate::telemetry::installation(data), crate::telemetry::runtime(), status.as_ref(), read(&data.join("resource.json")).as_ref(), now);
    let id = crate::mcp::new_id().replace('-', "");
    let rec = enroll::stamp(&dir(data), SCHEMA, &id, now, payload)?;
    let q = queue(data);
    std::fs::create_dir_all(&q).map_err(|e| format!("{}: {e}", q.display()))?;
    for (_, p, _) in entries(&q).into_iter().filter(|e| e.1.to_string_lossy().ends_with(RECORD)) {
        if read(&p).is_some_and(|r| r["grant"] == rec["grant"] && r["payload"]["resource"]["event_id"] == rec["payload"]["resource"]["event_id"]) {
            let _ = std::fs::remove_file(p);
        }
    }
    let file = q.join(format!("{now}-{id}{RECORD}"));
    write_atomic(&file, &rec.to_string())?;
    Ok((rec, file))
}

/// The service sender's connection state.
#[derive(Default)]
pub struct Sender {
    backoff: Backoff,
    wait_until: u64,
    snapshot_at: u64,
}

/// One service pass over HTTPS.
pub fn pass(data: &Path, now: u64, s: &mut Sender) {
    pass_with(data, now, s, &mut enroll::Https { browser: false });
}

/// Retry queued revokes, queue a snapshot every 60 s while connected, deliver grant-bound records. Never enrolled:
/// nothing.
// ponytail: offline revokes take one 10 s try each per pass, at most 16; skip them for a while if passes run late
fn pass_with(data: &Path, now: u64, s: &mut Sender, wire: &mut dyn Wire) {
    let d = dir(data);
    if !d.join("connection.json").exists() {
        return;
    }
    let _ = enroll::retry_revokes(&d, wire);
    if now >= s.snapshot_at + HEARTBEAT && queue_snapshot(data, now).is_ok() {
        s.snapshot_at = now;
    }
    if now >= s.wait_until {
        deliver(data, now, s, wire);
    }
}

/// Up to 100 records, oldest first. A durable `accepted` deletes a record; `rejected` (scope, replay, another grant)
/// deletes and counts it in `dropped`; no reply keeps every record for a retry with the same event ID.
fn deliver(data: &Path, now: u64, s: &mut Sender, wire: &mut dyn Wire) {
    let q = queue(data);
    let files: Vec<PathBuf> = prune(&q, now).into_iter().map(|e| e.1).filter(|p| p.to_string_lossy().ends_with(RECORD)).take(enroll::MAX_RECORDS).collect();
    if files.is_empty() {
        return;
    }
    // an unreadable record is null: no grant, so coreq rejects it unsent
    let recs: Vec<Value> = files.iter().map(|p| read(p).unwrap_or_default()).collect();
    let (mut accepted, mut rejected) = (0, 0);
    let error = match enroll::deliver(&dir(data), &recs, &mut s.backoff, wire) {
        Ok(receipts) => {
            for (p, r) in files.iter().zip(&receipts) {
                match r["state"].as_str() {
                    Some("accepted" | "projected") => accepted += 1,
                    Some("rejected") => rejected += 1,
                    _ => continue,
                }
                let _ = std::fs::remove_file(p);
            }
            (rejected > 0).then(|| format!("{rejected} records rejected"))
        }
        Err(Delivery::Retry(secs)) => {
            s.wait_until = now + secs;
            Some(format!("no reply; retry in {secs} s"))
        }
        Err(Delivery::Stopped(e)) => Some(e),
    };
    update_state(&q, |st| {
        st["dropped"] = json!(st["dropped"].as_u64().unwrap_or(0) + rejected);
        if accepted > 0 {
            st["connection"]["last_delivery"] = json!(now);
        }
        st["connection"]["error"] = json!(error);
    });
}

/// `agentq enroll`: pair, then deliver one real snapshot and read its projection back. `Ok` only on a `projected`
/// receipt that matches this installation, generation, schema and event.
pub fn enroll_with(data: &Path, destination: &str, wire: &mut dyn Wire) -> Result<String, String> {
    if !destination.starts_with("https://") {
        return Err("destination must be https".into());
    }
    let d = seed(data)?;
    let host = crate::host();
    enroll::pair(&d, destination, &Request { product: "agentq", host_label: &host, schemas: &[SCHEMA] }, wire)?;
    let (rec, file) = queue_snapshot(data, wire.now())?;
    let id = rec["event_id"].as_str().unwrap_or_default().to_string();
    let (until, mut backoff, mut stage) = (wire.now() + COMPLETE, Backoff::default(), "delivery");
    while wire.now() < until {
        if stage == "delivery" {
            match enroll::deliver(&d, std::slice::from_ref(&rec), &mut backoff, wire) {
                Ok(r) if r[0]["state"] == "rejected" => return Err(format!("snapshot rejected: {}", r[0]["reason"].as_str().unwrap_or("unknown"))),
                Ok(_) => {
                    let _ = std::fs::remove_file(&file);
                    stage = "projection";
                }
                Err(Delivery::Stopped(e)) => return Err(e),
                Err(Delivery::Retry(_)) => {}
            }
        }
        if stage == "projection" {
            match enroll::receipt(&d, &rec, wire) {
                Ok("projected") => {
                    let a = enroll::active(&d)?.unwrap_or_default();
                    write_atomic(&d.join("verified.json"), &json!({"destination": a["destination"], "generation": a["generation"], "event_id": id, "at": wire.now()}).to_string())?;
                    return Ok(id);
                }
                Err(e) if e.contains("mismatch") => return Err(e),
                _ => {}
            }
        }
        wire.sleep(POLL);
    }
    Err(format!("not verified: snapshot {stage} unconfirmed after {COMPLETE} s; the service keeps sending"))
}

/// `agentq disconnect`: stop sending at once; the revoke retries until DashQ confirms it.
pub fn disconnect_with(data: &Path, wire: &mut dyn Wire) -> Result<&'static str, String> {
    let d = dir(data);
    let s = read(&d.join("connection.json")).unwrap_or_default();
    if !s["active"].is_object() && !s["pending"].is_object() && s["revoke"].as_array().is_none_or(Vec::is_empty) {
        return Ok("not connected");
    }
    let _ = std::fs::remove_file(d.join("verified.json"));
    if s["pending"].is_object() {
        let _ = enroll::cancel(&d, wire);
    }
    match enroll::disconnect(&d, wire) {
        Ok(()) => Ok("disconnected; revoked"),
        Err(e) if e.ends_with("revoke pending") => Ok("Disconnected locally; revocation pending"),
        Err(e) => Err(e),
    }
}

pub fn enroll(data: &Path, destination: &str, browser: bool) -> Result<String, String> {
    enroll_with(data, destination, &mut enroll::Https { browser })
}

pub fn disconnect(data: &Path) -> Result<&'static str, String> {
    disconnect_with(data, &mut enroll::Https { browser: false })
}

/// `agentq connection status`: destination, connection, projection, export and revocation; never a credential.
pub fn status(data: &Path) -> Value {
    let d = dir(data);
    let Some(s) = read(&d.join("connection.json")) else {
        let state = if d.join("connection.json").exists() { "unreadable" } else { "not enrolled" };
        return json!({"state": state, "next": "run `agentq enroll <https-url>`"});
    };
    let (a, v) = (&s["active"], read(&d.join("verified.json")).unwrap_or_default());
    let verified = a.is_object() && v["destination"] == a["destination"] && v["generation"] == a["generation"];
    let (state, next) = match () {
        _ if verified => ("connected", None),
        _ if a.is_object() => ("unverified", Some("run `agentq enroll <https-url>` again to verify")),
        _ if s["pending"].is_object() => ("pending approval", Some("run `agentq enroll <https-url>` again and approve in the browser")),
        _ => ("disconnected", Some("run `agentq enroll <https-url>` to connect")),
    };
    let q = queue(data);
    let records = entries(&q).iter().filter(|e| e.1.to_string_lossy().ends_with(RECORD)).count();
    let c = &crate::telemetry::state(&q)["connection"];
    json!({
        "state": state,
        "destination": a["destination"].as_str().or(s["pending"]["destination"].as_str()),
        "generation": a["generation"],
        "projected": verified.then(|| v["event_id"].clone()),
        "export": {"pending": records, "last_delivery": c["last_delivery"], "error": c["error"]},
        "revocation_pending": s["revoke"].as_array().map_or(0, Vec::len),
        "next": next,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn data(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("agentq-conn-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let data = d.join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("installation"), "inst-1").unwrap();
        data
    }

    /// In-memory DashQ under wire v1: auto-approves the shown code, projects on acceptance unless told otherwise.
    #[derive(Default)]
    struct Dash {
        now: u64,
        offline: bool,
        /// Process the next request on this route, then lose its reply.
        lose: Option<&'static str>,
        /// Schemas outside the grant.
        refuse: Vec<String>,
        approved: bool,
        generation: u64,
        staged: Option<(String, u64)>,
        creds: HashMap<String, (u64, bool)>,
        events: HashMap<(u64, String), Value>,
        sent: Vec<(String, Value)>,
    }

    impl Dash {
        fn handle(&mut self, route: &str, auth: Option<&str>, b: &Value) -> (u16, Value) {
            let live = auth.and_then(|c| self.creds.get(c)).filter(|c| !c.1).map(|c| c.0);
            match route {
                "/connect/device" => (200, json!({"protocol": 1, "device_code": "dc", "user_code": "ABCD-1234", "verification_uri": "https://dash.example/connect", "expires_in": 600, "interval": 5})),
                "/connect/token" if !self.approved && self.staged.is_none() => (400, json!({"protocol": 1, "error": "authorization_pending"})),
                "/connect/token" => {
                    let (cred, g) = self.staged.get_or_insert_with(|| {
                        self.generation += 1;
                        (format!("cred{}", self.generation), self.generation)
                    }).clone();
                    self.approved = false;
                    (200, json!({"protocol": 1, "credential": cred, "installation": "inst-1", "generation": g, "product": "agentq", "workspace": "ws", "schemas": [SCHEMA]}))
                }
                "/connect/ack" => {
                    if let Some((c, g)) = self.staged.take() {
                        self.creds.insert(c, (g, false));
                    }
                    let g = live.or_else(|| auth.and_then(|c| self.creds.get(c)).map(|c| c.0));
                    (200, json!({"protocol": 1, "state": "active", "generation": g}))
                }
                "/connection/revoke" => {
                    let c = self.creds.get_mut(auth.unwrap_or_default()).unwrap();
                    c.1 = true;
                    (200, json!({"protocol": 1, "state": "revoked", "generation": c.0}))
                }
                _ if live.is_none() => (401, json!({"protocol": 1, "error": "revoked"})),
                "/ingest" => {
                    let g = live.unwrap();
                    let receipts: Vec<Value> = b["records"].as_array().unwrap().iter().map(|r| {
                        let id = r["event_id"].as_str().unwrap().to_string();
                        if self.refuse.contains(&r["schema"].as_str().unwrap().to_string()) {
                            return json!({"event_id": id, "state": "rejected", "reason": "scope"});
                        }
                        match self.events.entry((g, id.clone())).or_insert_with(|| r.clone()) {
                            old if *old != *r => json!({"event_id": id, "state": "rejected", "reason": "replay_mismatch"}),
                            _ => json!({"event_id": id, "state": "accepted"}),
                        }
                    }).collect();
                    (200, json!({"protocol": 1, "receipts": receipts}))
                }
                "/connection/receipt" => {
                    let g = live.unwrap();
                    match self.events.get(&(g, b["event_id"].as_str().unwrap().to_string())) {
                        Some(r) => (200, json!({"protocol": 1, "installation": "inst-1", "generation": g, "schema": r["schema"], "event_id": r["event_id"], "state": "projected"})),
                        None => (404, json!({"protocol": 1, "error": "unknown_event"})),
                    }
                }
                _ => (404, json!({"protocol": 1, "error": "not_found"})),
            }
        }

        fn ingested(&self) -> Vec<String> {
            self.sent.iter().filter(|s| s.0.ends_with("/ingest")).flat_map(|s| s.1["records"].as_array().unwrap().iter().map(|r| r["event_id"].as_str().unwrap().to_string()).collect::<Vec<_>>()).collect()
        }
    }

    impl Wire for Dash {
        fn post(&mut self, destination: &str, route: &str, auth: Option<&str>, body: &Value) -> Result<(u16, Value), String> {
            if self.offline {
                return Err("no reply".into());
            }
            self.sent.push((format!("{destination}{route}"), body.clone()));
            let r = self.handle(route, auth, body);
            if self.lose == Some(route) {
                self.lose = None;
                return Err("no reply".into());
            }
            Ok(r)
        }
        fn now(&self) -> u64 {
            self.now
        }
        fn sleep(&mut self, secs: u64) {
            self.now += secs;
        }
        fn show(&mut self, _: &str, _: &str) {
            self.approved = true;
        }
    }

    fn records(data: &Path) -> usize {
        entries(&queue(data)).iter().filter(|e| e.1.to_string_lossy().ends_with(RECORD)).count()
    }

    /// A1, A2: one approval keeps `data/installation` and owned edits; a real snapshot is projected, then deleted.
    #[test]
    fn enroll_keeps_identity_and_verifies() {
        let d = data("enroll");
        std::fs::write(d.join("owned.json"), "[1]").unwrap();
        std::fs::write(d.join("resource.json"), crate::telemetry::span("agentq.resource", "sample", json!({"agentq.resource.cpu_unknown": "warmup"}), 5, "inst-1", "h").to_string()).unwrap();
        let mut w = Dash { now: 1000, ..Dash::default() };
        let id = enroll_with(&d, "https://dash.example", &mut w).unwrap();
        assert_eq!(w.sent[0].1["installation"], "inst-1", "existing identity");
        assert_eq!(w.sent[0].1["schemas"], json!([SCHEMA]));
        let rec = &w.events[&(1, id.clone())];
        assert_eq!((rec["payload"]["schema"].clone(), rec["payload"]["installation"].clone()), (json!(1), json!("inst-1")));
        assert_eq!(rec["payload"]["resource"]["cpu_unknown"], "warmup", "the newest sample, not a fake one");
        assert_eq!(records(&d), 0, "deleted after durable acceptance");
        let s = status(&d);
        assert_eq!((s["state"].clone(), s["destination"].clone(), s["projected"].clone()), (json!("connected"), json!("https://dash.example"), json!(id)));
        assert!(!s.to_string().contains("cred"), "no credential in status");
        assert_eq!(std::fs::read_to_string(d.join("owned.json")).unwrap(), "[1]");
        assert_eq!(std::fs::read_to_string(d.join("installation")).unwrap(), "inst-1");
        // a repeat to the same destination reuses the grant and verifies a new snapshot
        enroll_with(&d, "https://dash.example", &mut w).unwrap();
        assert_eq!(w.generation, 1);
        let _ = std::fs::remove_dir_all(d.parent().unwrap());
    }

    /// A3, A4: lost ack and ingest replies; a crash after queueing. One grant; the same event ID is retried and the
    /// record lives until a durable receipt.
    #[test]
    fn lost_replies_and_crash_recover() {
        let d = data("lost");
        let mut w = Dash { now: 1000, lose: Some("/connect/ack"), ..Dash::default() };
        assert!(enroll_with(&d, "https://dash.example", &mut w).is_err());
        assert_eq!(status(&d)["state"], "pending approval");
        enroll_with(&d, "https://dash.example", &mut w).unwrap();
        assert_eq!(w.generation, 1, "no second grant");

        // crash after the record was queued: the next service pass sends it
        let mut s = Sender { snapshot_at: u64::MAX / 2, ..Sender::default() };
        let (rec, file) = queue_snapshot(&d, w.now).unwrap();
        w.lose = Some("/ingest");
        pass_with(&d, w.now, &mut s, &mut w);
        assert!(file.exists(), "no reply: kept");
        assert!(status(&d)["export"]["error"].as_str().unwrap().starts_with("no reply"));
        pass_with(&d, s.wait_until, &mut s, &mut w);
        assert!(!file.exists(), "accepted: deleted");
        let id = rec["event_id"].as_str().unwrap();
        assert_eq!(w.ingested().iter().filter(|e| *e == id).count(), 2, "retried with the same event ID");
        assert!(status(&d)["export"]["error"].is_null());
        let _ = std::fs::remove_dir_all(d.parent().unwrap());
    }

    /// A3, A4: offline disconnect stops sending at once and retries the revoke; a server revoke stops the sender.
    #[test]
    fn offline_revoke() {
        let d = data("revoke");
        let mut w = Dash { now: 1000, ..Dash::default() };
        enroll_with(&d, "https://dash.example", &mut w).unwrap();
        w.offline = true;
        assert_eq!(disconnect_with(&d, &mut w), Ok("Disconnected locally; revocation pending"));
        let s = status(&d);
        assert_eq!((s["state"].clone(), s["revocation_pending"].clone()), (json!("disconnected"), json!(1)));
        w.offline = false;
        let before = w.ingested().len();
        pass_with(&d, w.now, &mut Sender::default(), &mut w);
        assert_eq!(w.ingested().len(), before, "no snapshot after disconnect");
        assert_eq!(status(&d)["revocation_pending"], 0);
        assert!(w.creds["cred1"].1, "revoked on the server");

        // reconnect needs a new approval and generation; a DashQ-side revoke ends sending
        enroll_with(&d, "https://dash.example", &mut w).unwrap();
        w.creds.get_mut("cred2").unwrap().1 = true;
        let mut s = Sender::default();
        pass_with(&d, w.now, &mut s, &mut w);
        assert_eq!(status(&d)["state"], "disconnected");
        assert_eq!(status(&d)["export"]["error"], "revoked");
        assert_eq!(records(&d), 1, "kept: never sent elsewhere, pruned by the queue caps");
        let _ = std::fs::remove_dir_all(d.parent().unwrap());
    }

    /// A3, A4: a schema outside the grant is rejected and counted; old backlog keeps its grant across a destination
    /// switch and never reaches the new one; standalone sending skips grant-bound records.
    #[test]
    fn wrong_scope_and_old_grant() {
        let d = data("scope");
        let mut w = Dash { now: 1000, ..Dash::default() };
        enroll_with(&d, "https://dash.example", &mut w).unwrap();
        w.refuse = vec![SCHEMA.into()];
        pass_with(&d, w.now, &mut Sender::default(), &mut w);
        assert_eq!(records(&d), 0);
        assert_eq!(crate::telemetry::status(&d, w.now)["dropped"], 1);
        assert_eq!(status(&d)["export"]["error"], "1 records rejected");
        w.refuse.clear();

        w.offline = true;
        let (old, _) = queue_snapshot(&d, w.now).unwrap();
        let down = crate::telemetry::Keys::parse("http://127.0.0.1:1 pk sk").unwrap();
        assert_eq!(crate::telemetry::send(&d, &down, w.now), Ok(0), "standalone never sends a record");
        w.offline = false;
        enroll_with(&d, "https://other.example", &mut w).unwrap();
        assert!(status(&d)["state"] == "connected" && w.generation == 2);
        pass_with(&d, w.now, &mut Sender::default(), &mut w);
        let id = old["event_id"].as_str().unwrap();
        assert!(!w.sent.iter().any(|s| s.0.starts_with("https://other.example") && s.1.to_string().contains(id)), "old record never reaches the new destination");
        assert_eq!(records(&d), 0, "rejected locally by grant");
        let _ = std::fs::remove_dir_all(d.parent().unwrap());
    }
}
