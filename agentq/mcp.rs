//! Stdio MCP server `agent_context` (agentq.md § 2): index_document, search_document, get_original.

use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_DOC: u64 = 1024 * 1024;
const KEEP: usize = 100;
const KEEP_AGE: Duration = Duration::from_secs(7 * 86400);
const KEEP_BYTES: u64 = 256 * 1024 * 1024;
const PAGE: usize = 64000;
const CHUNK: usize = 1500;
const TOP: usize = 3;

/// Names, schemas and descriptions are the Node package's text, so registrations and trust survive (PRODUCT R2).
pub fn tools() -> Value {
    let schema = |p: Value| json!({"type": "object", "properties": p, "required": p.as_object().unwrap().keys().collect::<Vec<_>>(), "additionalProperties": false});
    json!([
        {"name": "index_document", "description": "Index a large reference document. Returns a recovery ref; original stays available. Read code, short results and complete JSON normally.", "inputSchema": schema(json!({"path": {"type": "string"}}))},
        {"name": "search_document", "description": "Find exact passages in an indexed reference. Search results are excerpts; retrieve original when more detail is needed.", "inputSchema": schema(json!({"ref": {"type": "string"}, "queries": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 8}})), "annotations": {"readOnlyHint": true}},
        {"name": "get_original", "description": "Recover retained original without rerunning a command. Legacy RTK refs require the hash shown in its recovery hint; captured run refs need only the ref. Returns at most 64k characters; use next_offset to continue.", "inputSchema": {"type": "object", "properties": {"ref": {"type": "string"}, "hash": {"type": "string"}, "offset": {"type": "integer", "minimum": 0}}, "required": ["ref"], "additionalProperties": false}, "annotations": {"readOnlyHint": true}}
    ])
}

// ponytail: names `agentq run`/`agentq doctor` (agentq.md § 4) once those commands ship (#53, #54)
const INSTRUCTIONS: &str = "<!-- agent-context:start -->\n# Agent Context\nUse agent_context index_document/search_document for large reference documents when selected passages suffice; get_original recovers retained bytes without rerunning commands. Read code, complete JSON and short results normally. Proxy routes traffic and telemetry; it does not shorten history, user requests or tool schemas. Never recompress results. Keep normal login, model, sandbox and approval policy.\n<!-- agent-context:end -->";

/// Newline-delimited JSON-RPC on stdin/stdout until EOF.
// ponytail: no Content-Length framing; Codex and Claude Code send newline JSON
pub fn serve(dir: &Path) -> i32 {
    let stdout = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(m) if m["method"] == "tools/call" => {
                let t0 = std::time::Instant::now();
                let r = handle(dir, &m);
                // `<install>/data/originals`; the tool name only from the known list (agentq.md § 6)
                let tool = tools().as_array().into_iter().flatten().find(|t| t["name"] == m["params"]["name"]).map_or(json!("unknown"), |t| t["name"].clone());
                let ok = r.as_ref().is_some_and(|r| r["result"]["isError"] != true);
                crate::telemetry::emit(dir.parent().unwrap_or(dir), "agentq.retrieval", "end", json!({"agentq.tool": tool, "agentq.ok": ok, "agentq.duration_ms": t0.elapsed().as_millis() as u64, "agentq.ids_unknown": "MCP calls carry no native IDs"}));
                r
            }
            Ok(m) => handle(dir, &m),
            Err(_) => Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "Invalid JSON"}})),
        };
        if let Some(r) = reply {
            let mut o = stdout.lock();
            if writeln!(o, "{r}").and_then(|_| o.flush()).is_err() {
                break;
            }
        }
    }
    0
}

/// One request; notifications (no id) get no reply.
pub fn handle(dir: &Path, m: &Value) -> Option<Value> {
    let id = m.get("id")?.clone();
    let p = &m["params"];
    let result = match m["method"].as_str().unwrap_or("") {
        "initialize" => json!({
            "protocolVersion": p["protocolVersion"].as_str().unwrap_or("2024-11-05"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "agent-context", "version": env!("CARGO_PKG_VERSION")},
            "instructions": INSTRUCTIONS,
        }),
        "ping" => json!({}),
        "tools/list" => json!({"tools": tools()}),
        "tools/call" => {
            let args = if p["arguments"].is_object() { &p["arguments"] } else { &Value::Null };
            match call(dir, p["name"].as_str().unwrap_or(""), args) {
                Ok(v) => json!({"content": [{"type": "text", "text": v.to_string()}]}),
                Err(e) => json!({"content": [{"type": "text", "text": e}], "isError": true}),
            }
        }
        _ => return Some(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}})),
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

pub fn call(dir: &Path, name: &str, a: &Value) -> Result<Value, String> {
    match name {
        "index_document" => index(dir, a["path"].as_str().ok_or("Invalid path")?),
        "search_document" => {
            let q: Vec<&str> = a["queries"].as_array().map(|q| q.iter().filter_map(Value::as_str).filter(|s| !s.trim().is_empty() && s.len() <= 1000).collect()).unwrap_or_default();
            if q.is_empty() || q.len() > 8 || q.len() != a["queries"].as_array().map_or(0, Vec::len) {
                return Err("Invalid queries: 1-8 non-empty strings".into());
            }
            let r = a["ref"].as_str().unwrap_or("");
            let (_, content) = read(dir, r)?;
            Ok(json!({"ref": r, "results": q.iter().map(|q| json!({"query": q, "passages": search(&content, q)})).collect::<Vec<_>>()}))
        }
        "get_original" => {
            let r = a["ref"].as_str().unwrap_or("");
            let offset = match &a["offset"] {
                Value::Null => 0,
                v => v.as_u64().ok_or("Invalid offset")? as usize,
            };
            let content = if r.starts_with("rtk:") {
                // `<install>/data/originals`
                crate::engines::recall(dir.parent().and_then(Path::parent).unwrap_or(dir), r, a["hash"].as_str().unwrap_or(""))?
            } else {
                read(dir, r)?.1
            };
            let chars = content.chars().count();
            let page: String = content.chars().skip(offset).take(PAGE).collect();
            Ok(json!({"ref": r, "original_chars": chars, "offset": offset, "content": page, "next_offset": if offset + PAGE < chars { json!(offset + PAGE) } else { Value::Null }}))
        }
        _ => Err("Unknown tool".into()),
    }
}

fn index(dir: &Path, path: &str) -> Result<Value, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("Cannot read {path}: {e}; read source normally"))?;
    if !f.metadata().is_ok_and(|m| m.is_file()) {
        return Err("Reference must be a regular text file".into());
    }
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(f, MAX_DOC + 1), &mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_DOC {
        return Err("Reference must be under 1 MiB".into());
    }
    let content = String::from_utf8(bytes).map_err(|_| "Reference must be UTF-8 text")?;
    let id = new_id();
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    let _ = std::fs::set_permissions(dir, std::os::unix::fs::PermissionsExt::from_mode(0o700));
    let source = std::fs::canonicalize(path).map_or(path.to_string(), |p| p.display().to_string());
    coreq::write_atomic(&dir.join(format!("{id}.json")), &json!({"source": source, "content": content}).to_string())?;
    prune(dir);
    Ok(json!({"ref": format!("doc:{id}"), "original_chars": content.chars().count(), "chunks": chunks(&content).len(), "retention": "7 days; latest 100 documents"}))
}

/// `(source, content)` of a retained original; age past 7 days is `expired` and names the source.
fn read(dir: &Path, r: &str) -> Result<(String, String), String> {
    let id = r.strip_prefix("doc:").filter(|id| id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')).ok_or(format!("Invalid reference {r}"))?;
    let f = dir.join(format!("{id}.json"));
    let raw = std::fs::read_to_string(&f).map_err(|_| format!("expired: {r} is missing; read the source normally"))?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let source = v["source"].as_str().unwrap_or("").to_string();
    if age(&f) > KEEP_AGE {
        return Err(format!("expired: {r}; read {source} normally"));
    }
    Ok((source, v["content"].as_str().unwrap_or("").to_string()))
}

fn age(f: &Path) -> Duration {
    f.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).unwrap_or(Duration::MAX)
}

/// Keep at most 100 originals, 7 days and 256 MiB; oldest go first.
fn prune(dir: &Path) {
    let mut files: Vec<(Duration, u64, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| (age(&p), p.metadata().map_or(0, |m| m.len()), p))
        .collect();
    files.sort();
    let mut bytes = 0;
    for (i, (a, len, p)) in files.iter().enumerate() {
        bytes += len;
        if i >= KEEP || *a > KEEP_AGE || bytes > KEEP_BYTES {
            let _ = std::fs::remove_file(p);
        }
    }
}

// ponytail: time+pid+counter ids, unique per host; add a random source if refs ever cross hosts
pub fn new_id() -> String {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let h = format!("{:020x}{:08x}{:04x}", t & ((1 << 80) - 1), std::process::id(), n & 0xffff);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// Paragraph chunks of at most ~1500 characters; a longer paragraph splits on lines.
fn chunks(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in s.lines() {
        let blank = line.trim().is_empty();
        if !cur.is_empty() && (cur.len() + line.len() > CHUNK || (blank && cur.len() > CHUNK / 3)) {
            out.push(std::mem::take(&mut cur));
        }
        if !(blank && cur.is_empty()) {
            cur.push_str(line);
            cur.push('\n');
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

fn terms(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric() && c != '_').filter(|w| !w.is_empty()).map(str::to_lowercase).collect()
}

/// Term-match ranking: distinct query terms hit first, then total hits; top 3 chunks.
// ponytail: plain term scoring (agentq.md § 2); swap in an engine when a paired task test shows a gain
fn search(content: &str, query: &str) -> Vec<Value> {
    let q = terms(query);
    let mut hits: Vec<(usize, usize, usize, String)> = chunks(content)
        .into_iter()
        .enumerate()
        .filter_map(|(i, c)| {
            let words = terms(&c);
            let counts: Vec<usize> = q.iter().map(|t| words.iter().filter(|w| *w == t).count()).collect();
            let distinct = counts.iter().filter(|n| **n > 0).count();
            (distinct > 0).then(|| (distinct, counts.iter().sum(), i, c))
        })
        .collect();
    hits.sort_by(|a, b| (b.0, b.1).cmp(&(a.0, a.1)).then(a.2.cmp(&b.2)));
    hits.into_iter().take(TOP).map(|(d, n, i, c)| json!({"chunk": i, "terms": d, "hits": n, "text": c})).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(v: &Value) -> Value {
        serde_json::from_str(v["result"]["content"][0]["text"].as_str().unwrap()).unwrap_or(json!(v["result"]["content"][0]["text"]))
    }

    #[test]
    fn three_tools_over_json_rpc() {
        let d = std::env::temp_dir().join(format!("agentq-mcp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let rpc = |m: Value| handle(&d.join("originals"), &m).unwrap();
        let init = rpc(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}));
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert!(handle(&d, &json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).is_none());
        let names: Vec<_> = rpc(json!({"id": 2, "method": "tools/list"}))["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].clone()).collect();
        assert_eq!(names, ["index_document", "search_document", "get_original"]);

        std::fs::create_dir_all(&d).unwrap();
        let doc = d.join("doc.md");
        let body = format!("# Intro\nhello world\n\n{}\n\n## Rollback\nThe rollback keeps previous release.\n", "filler line\n".repeat(400));
        std::fs::write(&doc, &body).unwrap();
        let r = text(&rpc(json!({"id": 3, "method": "tools/call", "params": {"name": "index_document", "arguments": {"path": doc}}})));
        let rf = r["ref"].as_str().unwrap().to_string();
        assert!(rf.starts_with("doc:") && rf.len() == 40, "{r}");

        let s = text(&rpc(json!({"id": 4, "method": "tools/call", "params": {"name": "search_document", "arguments": {"ref": rf, "queries": ["rollback release"]}}})));
        let top = &s["results"][0]["passages"][0];
        assert!(top["text"].as_str().unwrap().contains("The rollback keeps previous release."), "{s}");
        assert_eq!(top["terms"], 2);

        let g = text(&rpc(json!({"id": 5, "method": "tools/call", "params": {"name": "get_original", "arguments": {"ref": rf}}})));
        assert_eq!(g["content"], body.as_str(), "original bytes unchanged");
        assert_eq!(g["next_offset"], Value::Null);

        let bad = rpc(json!({"id": 6, "method": "tools/call", "params": {"name": "get_original", "arguments": {"ref": "doc:00000000-0000-0000-0000-000000000000"}}}));
        assert_eq!(bad["result"]["isError"], true);
        assert!(bad["result"]["content"][0]["text"].as_str().unwrap().starts_with("expired"));
        assert_eq!(rpc(json!({"id": 7, "method": "nope"}))["error"]["code"], -32601);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn paging_and_limits() {
        let d = std::env::temp_dir().join(format!("agentq-mcp-page-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let big = d.join("big.txt");
        std::fs::write(&big, "é".repeat(PAGE + 10)).unwrap();
        let store = d.join("originals");
        let rf = index(&store, big.to_str().unwrap()).unwrap()["ref"].as_str().unwrap().to_string();
        let p = call(&store, "get_original", &json!({"ref": rf, "offset": PAGE})).unwrap();
        assert_eq!(p["content"].as_str().unwrap().chars().count(), 10, "offsets count characters");
        assert_eq!(call(&store, "get_original", &json!({"ref": rf})).unwrap()["next_offset"], PAGE);

        std::fs::write(&big, vec![b'a'; MAX_DOC as usize + 1]).unwrap();
        assert!(index(&store, big.to_str().unwrap()).is_err(), "over 1 MiB");
        std::fs::write(&big, [0xff, 0xfe]).unwrap();
        assert!(index(&store, big.to_str().unwrap()).is_err(), "not UTF-8");

        std::fs::write(&big, "x").unwrap();
        for _ in 0..KEEP + 5 {
            index(&store, big.to_str().unwrap()).unwrap();
        }
        assert_eq!(std::fs::read_dir(&store).unwrap().count(), KEEP, "oldest go first");
        let _ = std::fs::remove_dir_all(&d);
    }
}
