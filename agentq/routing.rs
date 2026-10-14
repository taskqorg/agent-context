//! Loopback routing (agentq.md § 4, § 5): fixed ports in `data/config.json`, headroom workers owned by the service,
//! per-agent routing state and drift.
//!
//! ponytail: Codex only. Claude Code and Hermes stay direct until their routing and the OTLP intake land.
//! ponytail: one worker per port, respawned each pass; the § 5 engine-pin worker swap joins with the next pin change.

use coreq::write_atomic;
use serde_json::{Value, json};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

pub const ROUTED: [&str; 1] = ["codex"];

fn config(data: &Path) -> Value {
    std::fs::read_to_string(data.join("config.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}))
}

/// The agent's loopback port, if one was fixed at install.
pub fn port(data: &Path, agent: &str) -> Option<u16> {
    config(data)["ports"][agent].as_u64().and_then(|p| u16::try_from(p).ok())
}

/// The agent's port, picked from a free one on first install and kept across updates (§ 4).
pub fn fix_port(data: &Path, agent: &str) -> Result<u16, String> {
    if let Some(p) = port(data, agent) {
        return Ok(p);
    }
    let p = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).and_then(|l| l.local_addr()).map_err(|e| format!("no free loopback port: {e}"))?.port();
    let mut c = config(data);
    c["ports"][agent] = p.into();
    std::fs::create_dir_all(data).map_err(|e| format!("{}: {e}", data.display()))?;
    write_atomic(&data.join("config.json"), &serde_json::to_string_pretty(&c).unwrap_or_default())?;
    Ok(p)
}

pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/v1")
}

fn answers(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), Duration::from_secs(1)).is_ok()
}

/// Service side: keep one passthrough headroom worker per fixed port; a dead or missing one is started again.
pub fn supervise(install: &Path, workers: &mut Vec<(u16, Child)>) {
    workers.retain_mut(|(_, c)| matches!(c.try_wait(), Ok(None)));
    let Some(exe) = crate::engines::headroom_exe(install) else { return };
    for agent in ROUTED {
        let Some(p) = port(&install.join("data"), agent) else { continue };
        if workers.iter().any(|w| w.0 == p) {
            continue;
        }
        // compression stays off (§ 3): routing and usage observation only; no beacon upload or quota polling
        let args = ["proxy", "--host", "127.0.0.1", "--port", &p.to_string(), "--no-optimize", "--no-cache", "--no-rate-limit", "--no-ccr", "--no-subscription-tracking"];
        let started = coreq::quiet(Command::new(&exe).args(args))
            .env("HEADROOM_BEACON", "off")
            .env("DO_NOT_TRACK", "1")
            .env("HEADROOM_TELEMETRY", "off")
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn();
        match started {
            Ok(c) => workers.push((p, c)),
            Err(e) => eprintln!("agentq: headroom on port {p}: {e}"),
        }
    }
}

pub fn stop(workers: &mut Vec<(u16, Child)>) {
    for (_, c) in workers.iter_mut() {
        let _ = c.kill();
        let _ = c.wait();
    }
    workers.clear();
}

/// Established TCP connections with an end on one of `ports` (§ 5 restart drain): Linux `/proc/net/tcp{,6}`, macOS `lsof`
/// (its `netstat` lists no TCP sockets on recent releases), Windows `netstat -an`.
pub fn open_connections(ports: &[u16]) -> Result<usize, String> {
    if ports.is_empty() {
        return Ok(0);
    }
    let list = if cfg!(target_os = "linux") {
        ["/proc/net/tcp", "/proc/net/tcp6"].iter().filter_map(|p| std::fs::read_to_string(p).ok()).collect::<String>()
    } else {
        let (cmd, args) = if cfg!(target_os = "macos") { ("lsof", &["-nP", "-iTCP", "-sTCP:ESTABLISHED"][..]) } else { ("netstat", &["-an"][..]) };
        let o = coreq::quiet(Command::new(cmd).args(args)).output().map_err(|e| format!("{cmd}: {e}"))?;
        // lsof exits 1 with no output when nothing matches
        if o.stdout.is_empty() && o.stderr.is_empty() && cmd == "lsof" {
            return Ok(0);
        }
        String::from_utf8_lossy(&o.stdout).into_owned()
    };
    if list.is_empty() {
        return Err("no connection list".into());
    }
    Ok(established_in(&list, ports))
}

/// Counts `netstat -an` lines (`127.0.0.1.8787`, `127.0.0.1:8787`), `lsof` names (`127.0.0.1:8787->127.0.0.1:54321`)
/// and `/proc/net/tcp` rows (`0100007F:2253 .. 01`).
fn established_in(list: &str, ports: &[u16]) -> usize {
    let hit = |a: &str, sep: char, hex: bool| {
        a.rsplit_once(sep).and_then(|(_, p)| if hex { u16::from_str_radix(p, 16).ok() } else { p.parse().ok() }).is_some_and(|p| ports.contains(&p))
    };
    list.lines()
        .filter(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if l.contains("ESTABLISHED") {
                f.iter().flat_map(|a| a.split("->")).any(|a| hit(a, ':', false) || hit(a, '.', false))
            } else {
                f.len() > 3 && f[3] == "01" && f[0].ends_with(':') && (hit(f[1], ':', true) || hit(f[2], ':', true))
            }
        })
        .count()
}

/// `routing` (routed, direct, bypassed, unknown) and its reason for one agent (§ 5).
pub fn state(agent: &str, root: &Path, port: Option<u16>) -> (&'static str, String) {
    match agent {
        "codex" => {
            let toml = std::fs::read_to_string(root.join("config.toml")).unwrap_or_default();
            if !toml.lines().take_while(|l| !l.trim_start().starts_with('[')).any(|l| l.trim() == "model_provider = \"agent_context\"") {
                return ("direct", "config.toml selects no agent_context provider".into());
            }
            match port {
                Some(p) if toml.contains(&format!("base_url = \"{}\"", base_url(p))) && answers(p) => ("routed", format!("127.0.0.1:{p}")),
                Some(p) if toml.contains(&format!("base_url = \"{}\"", base_url(p))) => ("unknown", format!("proxy on 127.0.0.1:{p} not answering")),
                _ => ("bypassed", "agent_context provider is not the fixed loopback port".into()),
            }
        }
        "claude" => match std::fs::read_to_string(root.join("settings.json")).ok().and_then(|s| serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).ok()) {
            Some(s) if s["env"]["ANTHROPIC_BASE_URL"].is_string() => ("bypassed", "settings.json env.ANTHROPIC_BASE_URL is foreign".into()),
            _ => ("direct", "not routed yet".into()),
        },
        _ => ("direct", "not routed yet".into()),
    }
}

/// status.json `agents`: the routing of each agent whose config root exists.
pub fn agents(data: &Path) -> Value {
    let mut out = serde_json::Map::new();
    for a in crate::onboard::AGENTS {
        let root = crate::onboard::root(a);
        if root.exists() {
            let (routing, reason) = state(a, &root, port(data, a));
            out.insert(a.into(), json!({"routing": routing, "reason": reason}));
        }
    }
    out.into()
}

/// Routing edits in the journal that are no longer in their file.
pub fn drift(journal: &Path) -> Vec<String> {
    let j: Vec<Value> = std::fs::read_to_string(journal).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    j.iter()
        .filter(|e| e["routing"].is_string() && e["kind"] == "text")
        .filter(|e| {
            let after = e["after"].as_str().unwrap_or_default();
            !std::fs::read_to_string(e["file"].as_str().unwrap_or_default()).is_ok_and(|t| t.contains(after.trim()))
        })
        .map(|e| format!("{} {}", e["file"].as_str().unwrap_or_default(), e["key"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join(".")))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_is_fixed_once() {
        let d = std::env::temp_dir().join(format!("agentq-port-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        assert_eq!(port(&d, "codex"), None);
        let p = fix_port(&d, "codex").unwrap();
        assert_eq!(fix_port(&d, "codex").unwrap(), p, "kept across installs");
        assert_eq!(port(&d, "codex"), Some(p));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// #111 A2: the restart drain counts live proxied connections on macOS, Windows and Linux; listeners and other ports are not.
    #[test]
    fn established_on_proxy_ports() {
        let mac = "tcp4  0  0  127.0.0.1.8787   127.0.0.1.54321  ESTABLISHED\n\
                   tcp4  0  0  127.0.0.1.54321  127.0.0.1.8787   ESTABLISHED\n\
                   tcp4  0  0  127.0.0.1.8787   *.*              LISTEN\n\
                   tcp4  0  0  10.0.0.2.18787   1.2.3.4.443      ESTABLISHED\n";
        assert_eq!(established_in(mac, &[8787]), 2);
        let win = "  TCP    127.0.0.1:8787   127.0.0.1:54321   ESTABLISHED\r\n  TCP    0.0.0.0:8787   0.0.0.0:0   LISTENING\r\n";
        assert_eq!(established_in(win, &[8787]), 1);
        let lsof = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n\
                    headroom 7 u 9u IPv4 0x1 0t0 TCP 127.0.0.1:8787->127.0.0.1:54321 (ESTABLISHED)\n\
                    Python 8 u 13u IPv6 0x2 0t0 TCP [2405::1]:58635->[2606::9bd1]:443 (ESTABLISHED)\n";
        assert_eq!(established_in(lsof, &[8787]), 1);
        let proc = "  sl  local_address rem_address   st tx_queue\n\
                    0: 0100007F:2253 00000000:0000 0A 00000000\n\
                    1: 0100007F:2253 0100007F:D431 01 00000000\n\
                    2: 0200000A:D431 04030201:01BB 01 00000000\n";
        assert_eq!(established_in(proc, &[0x2253]), 1);
        assert_eq!(established_in(mac, &[9999]), 0);
        assert_eq!(open_connections(&[]), Ok(0));
        // this host's own list: a live loopback connection counts
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let p = l.local_addr().unwrap().port();
        let _c = TcpStream::connect((Ipv4Addr::LOCALHOST, p)).unwrap();
        let _s = l.accept().unwrap();
        assert!(open_connections(&[p]).unwrap() >= 1);
    }

    /// #76 A1: status.json routing follows config.toml and whether the loopback port answers.
    #[test]
    fn codex_routing_state() {
        let d = std::env::temp_dir().join(format!("agentq-route-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(state("codex", &d, None).0, "direct");
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let p = l.local_addr().unwrap().port();
        let cfg = format!("model_provider = \"agent_context\"\n\n[model_providers.agent_context]\nbase_url = \"{}\"\n", base_url(p));
        std::fs::write(d.join("config.toml"), &cfg).unwrap();
        assert_eq!(state("codex", &d, Some(p)).0, "routed");
        assert_eq!(state("codex", &d, Some(p.wrapping_add(1))).0, "bypassed");
        drop(l);
        // a freed ephemeral port may serve a parallel test: port 1 refuses
        std::fs::write(d.join("config.toml"), cfg.replace(&base_url(p), &base_url(1))).unwrap();
        assert_eq!(state("codex", &d, Some(1)).0, "unknown");
        std::fs::write(d.join("config.toml"), format!("[profiles.x]\n{cfg}")).unwrap();
        assert_eq!(state("codex", &d, Some(p)).0, "direct", "a profile key is not the top-level provider");
        let _ = std::fs::remove_dir_all(&d);
    }
}
