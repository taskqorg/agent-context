//! One-time owned namespace cutover; retired names are removal inputs, never runtime aliases (agentq.md § 4).
use crate::{control, executor, onboard};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::{Path, PathBuf}};

const OLD: &str = "agent_context";
const NEW: &str = "agentq";
const OLD_DIRECT: &str = "# agentq: direct Codex provider compatibility\n[model_providers.agent_context]\nname = \"OpenAI\"\nwire_api = \"responses\"\nrequires_openai_auth = true\nsupports_websockets = true\n";

fn text(s: &str) -> String {
    let mut s = s.to_string();
    for (old, new) in [
        ("[model_providers.agent_context]", "[model_providers.agentq]"),
        ("[model_providers.agent_context.", "[model_providers.agentq."),
        ("[mcp_servers.agent_context]", "[mcp_servers.agentq]"),
        ("[mcp_servers.agent_context.", "[mcp_servers.agentq."),
        ("model_provider = \"agent_context\"", "model_provider = \"agentq\""),
        ("agent_context:\n", "agentq:\n"),
        ("name = \"Agent Context\"", "name = \"AgentQ\""),
        ("name: agent-context\n", "name: agentq\n"),
        ("- agent-context\n", "- agentq\n"),
        ("<!-- agent-context:start -->", "<!-- agentq:start -->"),
        ("<!-- agent-context:end -->", "<!-- agentq:end -->"),
        ("# Agent Context\n", "# AgentQ\n"),
        ("Use agent_context ", "Use agentq "),
        ("# agentq: direct Codex provider compatibility", "# agentq: direct OpenAI for saved conversations"),
    ] { s = s.replace(old, new); }
    s
}

fn value(v: &Value) -> Value {
    match v {
        Value::String(s) if s == OLD || s == "agent-context" => NEW.into(),
        Value::String(s) => text(s).into(),
        Value::Array(a) => a.iter().map(value).collect(),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (if k == OLD { NEW.into() } else { k.clone() }, value(v))).collect()),
        _ => v.clone(),
    }
}

fn entry(e: &Value) -> Value {
    let mut n = e.clone();
    for k in ["key", "after", "before"] { if let Some(v) = e.get(k) { n[k] = value(v); } }
    if let Some(file) = e["file"].as_str() {
        let p = Path::new(file);
        if p.parent().is_some_and(|p| p.file_name().is_some_and(|n| n == "agent-context") && p.parent().is_some_and(|p| p.file_name().is_some_and(|n| n == "plugins"))) {
            n["file"] = p.parent().unwrap().parent().unwrap().join(NEW).join(p.file_name().unwrap()).display().to_string().into();
        }
    }
    n
}

fn state(s: &Value) -> Result<Value, String> {
    if s.is_null() { return Ok(Value::Null); }
    let mut n = s.clone();
    for p in n["profiles"].as_object_mut().into_iter().flat_map(|p| p.values_mut()) {
        if let Some(entries) = p["entries"].as_array_mut() { entries.iter_mut().for_each(|e| *e = entry(e)); }
    }
    Ok(n)
}

fn read(p: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(p) {
        Ok(s) if s.len() <= 1024 * 1024 => Ok(Some(s)),
        Ok(_) => Err("native configuration exceeds the 1 MiB migration limit".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("native configuration unreadable".into()),
    }
}

fn subset(actual: &Value, expected: &Value) -> bool {
    expected.as_object().map_or(actual == expected, |o| o.iter().all(|(k, v)| actual.get(k).is_some_and(|a| subset(a, v))))
}

/// Only the MCP namespace key moves; later options and unrelated native settings stay.
fn json_name(s: &str, a: &Value, b: &Value) -> Result<String, String> {
    let mut doc: Value = serde_json::from_str(s).map_err(|_| "native JSON unreadable")?;
    let keys: Vec<_> = a["key"].as_array().ok_or("invalid owned key")?.iter().filter_map(Value::as_str).collect();
    let new_keys: Vec<_> = b["key"].as_array().ok_or("invalid owned key")?.iter().filter_map(Value::as_str).collect();
    let (parent, from, to, expected, new_expected) = if let Some(i) = keys.iter().zip(&new_keys).position(|(a, b)| a != b) {
        let mut v = &doc;
        for k in &keys { v = v.get(*k).unwrap_or(&Value::Null); }
        let mut nv = &doc;
        for k in &new_keys { nv = nv.get(*k).unwrap_or(&Value::Null); }
        if !subset(v, &a["after"]) && !subset(nv, &b["after"]) { return Err("owned MCP value changed; kept".into()); }
        (&keys[..i], keys[i], new_keys[i], None, None)
    } else {
        let from = if a["after"].get(OLD).is_some() { OLD } else { NEW };
        let to = if from == OLD { NEW } else { OLD };
        (&keys[..], from, to, Some(&a["after"][from]), Some(&b["after"][to]))
    };
    let mut p = &mut doc;
    for k in parent { p = p.get_mut(*k).ok_or("owned MCP parent missing")?; }
    let p = p.as_object_mut().ok_or("owned MCP parent changed")?;
    match (p.get(from), p.get(to)) {
        (Some(v), None) if expected.is_none_or(|e| subset(v, e)) => {
            let v = p.shift_remove(from).unwrap();
            p.insert(to.into(), v);
        }
        (None, Some(v)) if new_expected.is_none_or(|e| subset(v, e)) => return Ok(s.into()),
        _ => return Err("MCP target-name collision or foreign edit; kept".into()),
    }
    Ok(onboard::dump(&doc, s))
}

type Edits = BTreeMap<PathBuf, (Option<String>, Option<String>)>;

fn current(edits: &mut Edits, p: &Path) -> Result<Option<String>, String> {
    if !edits.contains_key(p) { let s = read(p)?; edits.insert(p.into(), (s.clone(), s)); }
    Ok(edits[p].1.clone())
}

fn scope(h: &executor::Host, p: &Path) -> bool {
    h.clients.iter().any(|c| c.files.iter().any(|f| f == p)
        || ["AGENTS.md", "CLAUDE.md"].iter().any(|f| c.root.join(f) == p)
        || (c.agent == "hermes" && ["agent-context", NEW].iter().any(|name| ["__init__.py", "plugin.yaml"].iter().any(|f| c.root.join("plugins").join(name).join(f) == p))))
}

fn plan(h: &executor::Host, edits: &mut Edits, a: &Value, b: &Value) -> Result<(), String> {
    if a == b { return Ok(()); }
    let src = Path::new(a["file"].as_str().ok_or("invalid owned file")?);
    let dst = Path::new(b["file"].as_str().ok_or("invalid owned file")?);
    if !scope(h, src) || !scope(h, dst) { return Err("owned migration scope is not a known native file".into()); }
    let s = current(edits, src)?;
    if src != dst {
        let target = current(edits, dst)?;
        if !((s.as_deref() == a["after"].as_str() || s.is_none()) && (target.is_none() || target.as_deref() == b["after"].as_str())) || (s.is_none() && target.is_none()) {
            return Err("owned plugin file changed or target exists; kept".into());
        }
        edits.get_mut(dst).unwrap().1 = Some(b["after"].as_str().ok_or("invalid plugin content")?.into());
        edits.get_mut(src).unwrap().1 = None;
        return Ok(());
    }
    let s = s.ok_or("owned native configuration missing")?;
    let mut next = if src.extension().is_some_and(|e| e == "json") { json_name(&s, a, b)? } else {
        let old = a["after"].as_str().ok_or("invalid owned text")?;
        let new = b["after"].as_str().ok_or("invalid owned text")?;
        if s.contains(old) {
            let target = new.lines().find(|l| l.starts_with('[') || l.trim() == "agentq:" || l.trim() == "agent_context:");
            if s.contains(new) || target.is_some_and(|t| s.lines().any(|l| l.trim() == t.trim() || (t.ends_with(']') && l.trim_start().starts_with(&format!("{}.", &t.trim()[..t.trim().len()-1]))))) { return Err("native target-name collision; kept".into()); }
            s.replacen(old, new, 1)
        } else if s.contains(new) { s }
        else { return Err("owned native block changed; kept".into()); }
    };
    if src.extension().is_some_and(|e| e == "toml") && a["key"].as_array().is_some_and(|k| k.len() == 2 && matches!(k[0].as_str(), Some("mcp_servers" | "model_providers"))) {
        let from = format!("[{}.{}.", a["key"][0].as_str().unwrap(), a["key"][1].as_str().unwrap());
        let to = format!("[{}.{}.", b["key"][0].as_str().unwrap(), b["key"][1].as_str().unwrap());
        next = next.split_inclusive('\n').map(|l| if l.trim_start().starts_with(&from) { l.replacen(&from, &to, 1) } else { l.into() }).collect();
    }
    edits.get_mut(src).unwrap().1 = Some(next);
    Ok(())
}

fn write(p: &Path, s: &str) -> Result<(), String> {
    use std::io::Write;
    let tmp = p.with_extension(format!("names-{}.tmp", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    std::fs::create_dir_all(p.parent().ok_or("native parent missing")?).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut f = options.open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(s.as_bytes()).map_err(|e| e.to_string())?;
        if let Ok(meta) = std::fs::metadata(p) { f.set_permissions(meta.permissions()).map_err(|e| e.to_string())?; }
        f.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, p).map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_file(tmp);
    result
}

pub fn migrate(h: &executor::Host, rollback: bool, dry: bool) -> Result<Value, String> {
    let _lock = if dry { None } else { Some(executor::lock(&h.data)?) };
    let journal = read(&h.data.join("owned.json"))?.map(|s| serde_json::from_str::<Value>(&s).map_err(|_| "ownership journal unreadable")).transpose()?.unwrap_or(json!([]));
    let control = read(&h.data.join("integration.json"))?.map(|s| serde_json::from_str::<Value>(&s).map_err(|_| "control state unreadable")).transpose()?.unwrap_or(Value::Null);
    if !control.is_null() { control::state(&h.data)?; }
    let mapped: Value = journal.as_array().ok_or("ownership journal is not a list")?.iter().map(entry).collect();
    let mapped_control = state(&control)?;
    let mut aliases = vec![];
    for c in h.clients.iter().filter(|c| c.agent == "codex") {
        let p = c.root.join("config.toml");
        if read(&p)?.is_some_and(|s| s.contains(OLD_DIRECT)) {
            aliases.push(json!({"file":p,"key":["model_providers",OLD],"kind":"text","after":OLD_DIRECT}));
        }
    }
    if !rollback && mapped == journal && mapped_control == control && aliases.is_empty() { return Ok(json!({"outcome":"unchanged"})); }
    if control["service"]["state"] == "stopping" || control["profiles"].as_object().is_some_and(|p| p.values().any(|p| p["phase"] != "detached")) {
        return Err("finish the pending integration/service transition before renaming".into());
    }
    let backup = h.data.join("name-migration.json");
    let saved = read(&backup)?.map(|s| serde_json::from_str::<Value>(&s).map_err(|_| "name migration record unreadable")).transpose()?;
    if rollback && saved.is_none() { return Err("no name migration is recorded".into()); }
    let record = saved.unwrap_or_else(|| json!({"schema":1,"owned":journal,"control":control,"aliases":aliases}));
    if record["schema"] != 1 || !record["owned"].is_array() || !record["aliases"].is_array() { return Err("invalid name migration record".into()); }
    let old = &record["owned"];
    let new: Value = old.as_array().unwrap().iter().map(entry).collect();
    let old_control = &record["control"];
    let new_control = state(old_control)?;
    if (journal != *old && journal != new) || (control != *old_control && control != new_control) { return Err("configuration metadata changed after cutover; rollback/retry kept".into()); }
    let mut edits = Edits::new();
    for a in old.as_array().unwrap().iter().chain(record["aliases"].as_array().unwrap()) {
        let b = entry(a);
        if rollback { plan(h, &mut edits, &b, a)?; } else { plan(h, &mut edits, a, &b)?; }
    }
    for c in h.clients.iter().filter(|c| c.agent == "codex") {
        if let Some(s) = current(&mut edits, &c.root.join("config.toml"))? {
            let retired = if rollback { NEW } else { OLD };
            if s.lines().any(|l| l.split_once('=').is_some_and(|(k,v)| k.trim() == "model_provider" && [format!("\"{retired}\""), format!("'{retired}'")].iter().any(|id| v.trim_start().starts_with(id)))) {
                return Err("unowned retired provider selector remains; update the native profile explicitly".into());
            }
        }
    }
    if dry { return Ok(json!({"outcome":"planned","files":edits.iter().filter(|(_, (a,b))|a!=b).count(),"rollback":rollback,"old_chats":"not_migrated","reload":true})); }
    if !backup.exists() { control::save(&h.data, "name-migration.json", &record)?; }
    // Plugin targets must exist before activation; old files are removed after native registrations change.
    let mut edits: Vec<_> = edits.into_iter().filter(|(_, (a, b))| a != b).collect();
    edits.sort_by_key(|(p, (_, after))| (after.is_none(), !p.components().any(|c| c.as_os_str() == "plugins")));
    for (p, (before, after)) in &edits {
        if read(p)? != *before { return Err("native configuration changed during migration; retry".into()); }
        match after { Some(s) => write(p, s)?, None => { std::fs::remove_file(p).map_err(|e| e.to_string())?; let _ = std::fs::remove_dir(p.parent().unwrap()); } }
    }
    control::save(&h.data, "owned.json", if rollback { old } else { &new })?;
    let next_control = if rollback { old_control } else { &new_control };
    if !next_control.is_null() { control::save(&h.data, "integration.json", next_control)?; }
    Ok(json!({"outcome":"applied","files":edits.len(),"rollback":rollback,"old_chats":"not_migrated","reload":true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The actual cutover preserves foreign/native values, recovers partial writes, moves plugins, and rolls back.
    #[test]
    fn owned_cutover_retry_conflict_and_rollback() {
        let root = std::env::temp_dir().join(format!("agentq-names-{}", crate::mcp::new_id()));
        let data = root.join("install/data");
        std::fs::create_dir_all(&data).unwrap();
        let clients: Vec<_> = [("codex", "config.toml"), ("claude", ".claude.json"), ("hermes", "config.yaml")].into_iter().map(|(agent, file)| {
            let r = root.join(agent); std::fs::create_dir_all(&r).unwrap();
            crate::profiles::Client {kind: if agent == "claude" { "claude-code" } else {agent}, agent, root:r.clone(), files:vec![r.join(file)]}
        }).collect();
        let h = executor::Host {data, exe:root.join("install/agentq"), clients, installation:"fixture".into(), generation:0, grant:Value::Null};
        assert!(migrate(&h,true,false).is_err(), "rollback needs a recorded cutover");
        let codex = &h.clients[0].files[0];
        let claude = &h.clients[1].files[0];
        let hermes = &h.clients[2].files[0];
        let plugin = h.clients[2].root.join("plugins/agent-context/plugin.yaml");
        std::fs::create_dir_all(plugin.parent().unwrap()).unwrap();
        let selector = "model_provider = \"agent_context\"\n";
        let provider = "\n[model_providers.agent_context]\nname = \"Agent Context\"\nbase_url = \"http://127.0.0.1:12345/v1\"\n";
        std::fs::write(codex, format!("{selector}model = \"native-model\"\n{provider}")).unwrap();
        std::fs::write(claude, json!({"mcpServers":{OLD:{"command":"/custom/agent_context/agentq", "args":["mcp","claude"],"env":{"KEEP":"native"}},"foreign":{"command":"foreign"}},"model":"native-model"}).to_string()).unwrap();
        let yaml = "plugins:\n  enabled:\n    - other\n    - agent-context\nmcp_servers:\n  agent_context:\n    command: /custom/agent_context/agentq\n";
        std::fs::write(hermes, yaml).unwrap();
        std::fs::write(&plugin, "name: agent-context\n").unwrap();
        let e = |file:&Path, key:Value, kind:&str, after:Value| json!({"file":file,"key":key,"kind":kind,"after":after,"before":null});
        let mut journal = json!([
            e(codex,json!(["model_provider"]),"text",selector.into()),
            e(codex,json!(["model_providers",OLD]),"text",provider.into()),
            e(claude,json!(["mcpServers"]),"set",json!({OLD:{"command":"/custom/agent_context/agentq","args":["mcp","claude"]}})),
            e(hermes,json!(["plugins","enabled"]),"text","    - agent-context\n".into()),
            e(hermes,json!(["mcp_servers",OLD]),"text","  agent_context:\n    command: /custom/agent_context/agentq\n".into()),
            e(&plugin,json!(["$file"]),"file","name: agent-context\n".into())
        ]);
        let mcp = "\n[mcp_servers.agent_context]\ncommand = \"/custom/agent_context/agentq\"\nargs = [\"mcp\", \"codex\"]\n";
        let mut native = std::fs::read_to_string(codex).unwrap();
        native.push_str(mcp);
        native.push_str("[mcp_servers.agent_context.tools.index_document]\napproval_mode = \"approve\"\n");
        std::fs::write(codex, native).unwrap();
        journal.as_array_mut().unwrap().push(e(codex,json!(["mcp_servers",OLD]),"text",mcp.into()));
        control::save(&h.data,"owned.json",&journal).unwrap();
        let originals: Vec<_> = [codex,claude,hermes,&plugin].iter().map(|p|std::fs::read_to_string(p).unwrap()).collect();
        // A target collision must stop the whole plan before any native or journal writes.
        let mut collision:Value=serde_json::from_str(&originals[1]).unwrap();
        collision["mcpServers"][NEW]=json!({"command":"foreign-target"});
        std::fs::write(claude,collision.to_string()).unwrap();
        assert!(migrate(&h,false,false).is_err());
        assert_eq!(std::fs::read_to_string(codex).unwrap(),originals[0]);
        assert!(!h.data.join("name-migration.json").exists());
        std::fs::write(claude,&originals[1]).unwrap();
        std::fs::write(codex, format!("{}\n[model_providers.agentq.http_headers]\nx = \"foreign\"\n", originals[0])).unwrap();
        assert!(migrate(&h,false,false).is_err(), "target child table must not be merged");
        std::fs::write(codex, &originals[0]).unwrap();
        std::fs::write(codex, format!("{}\n[profiles.work]\nmodel_provider = \"agent_context\"\n", originals[0])).unwrap();
        assert!(migrate(&h,false,false).is_err(), "native profile overrides require explicit repair");
        std::fs::write(codex, &originals[0]).unwrap();
        assert_eq!(migrate(&h,false,false).unwrap()["outcome"],"applied");
        let renamed = std::fs::read_to_string(codex).unwrap();
        assert!(renamed.contains("[mcp_servers.agentq.tools.index_document]\napproval_mode = \"approve\""));
        assert!(!renamed.contains("agent_context]"));
        let c:Value=serde_json::from_str(&std::fs::read_to_string(claude).unwrap()).unwrap();
        assert_eq!(c["mcpServers"][NEW]["command"],"/custom/agent_context/agentq","paths are never renamed");
        assert_eq!(c["mcpServers"][NEW]["env"]["KEEP"],"native");
        assert!(c["mcpServers"].get(OLD).is_none());
        assert_eq!(c["mcpServers"]["foreign"]["command"],"foreign");
        assert!(!plugin.exists());
        assert_eq!(std::fs::read_to_string(h.clients[2].root.join("plugins/agentq/plugin.yaml")).unwrap(),"name: agentq\n");
        // Crash after native writes, before metadata activation: retry must recognize the new state.
        control::save(&h.data,"owned.json",&journal).unwrap();
        assert_eq!(migrate(&h,false,false).unwrap()["outcome"],"applied");
        assert_eq!(migrate(&h,false,false).unwrap()["outcome"],"unchanged");
        assert_eq!(migrate(&h,true,false).unwrap()["outcome"],"applied");
        for (p,old) in [codex,claude,hermes,&plugin].iter().zip(&originals) {
            let now=std::fs::read_to_string(p).unwrap();
            if p.extension().is_some_and(|e|e=="json") { assert_eq!(serde_json::from_str::<Value>(&now).unwrap(),serde_json::from_str::<Value>(old).unwrap()); }
            else { assert_eq!(&now,old); }
        }
        assert_eq!(serde_json::from_str::<Value>(&std::fs::read_to_string(h.data.join("owned.json")).unwrap()).unwrap(),journal);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Suspended provider receipts and the old direct definition rename without activating a disabled profile.
    #[test]
    fn detached_state_keeps_intent_without_aliases_or_conversation_edits() {
        let root=std::env::temp_dir().join(format!("agentq-names-off-{}",crate::mcp::new_id()));
        let data=root.join("install/data");let native=root.join("codex");std::fs::create_dir_all(&native).unwrap();std::fs::create_dir_all(&data).unwrap();
        let file=native.join("config.toml");std::fs::write(&file,OLD_DIRECT).unwrap();
        let e=json!({"file":file,"key":["model_providers",OLD],"kind":"text","before":null,"after":"\n[model_providers.agent_context]\nname = \"Agent Context\"\n","field":"routing","source":"a".repeat(64)});
        let before=json!({"schema":1,"generation":3,"host_disabled":true,"profiles":{"codex":{"root":native,"phase":"detached","at":1,"direct":false,"runtime":"pending_reload","entries":[e]}}});
        control::save(&data,"integration.json",&before).unwrap();
        let h=executor::Host{data,exe:root.join("install/agentq"),clients:vec![crate::profiles::Client{kind:"codex",agent:"codex",root:native,files:vec![file.clone()]}],installation:"fixture".into(),generation:0,grant:Value::Null};
        assert_eq!(migrate(&h,false,false).unwrap()["outcome"],"applied");
        assert_eq!(std::fs::read_to_string(&file).unwrap(),onboard::CODEX_DIRECT_PROVIDER);
        let after=control::state(&h.data).unwrap();
        assert_eq!(after["profiles"]["codex"]["entries"][0]["key"],json!(["model_providers",NEW]));
        assert_eq!(after["generation"],3);assert_eq!(after["host_disabled"],true);assert_eq!(after["profiles"]["codex"]["phase"],"detached");
        assert_eq!(migrate(&h,true,false).unwrap()["outcome"],"applied");
        assert_eq!(control::state(&h.data).unwrap(),before);
        assert_eq!(std::fs::read_to_string(file).unwrap(),OLD_DIRECT);
        std::fs::remove_dir_all(root).unwrap();
    }
    /// Current-namespace recovery is not a name migration; old pending transitions remain guarded.
    #[test]
    fn pending_control_only_blocks_an_actual_cutover() {
        let root=std::env::temp_dir().join(format!("agentq-names-pending-{}",crate::mcp::new_id()));
        let h=executor::Host{data:root.join("data"),exe:root.join("agentq"),clients:vec![],installation:"fixture".into(),generation:0,grant:Value::Null};
        let e=json!({"file":root.join("config.toml"),"key":["mcp_servers",NEW],"kind":"text","before":null,"after":"[mcp_servers.agentq]\n","field":"mcp","source":"a".repeat(64)});
        let mut s=json!({"schema":1,"generation":3,"host_disabled":true,"profiles":{"codex":{"root":root,"phase":"enabling","at":1,"direct":false,"entries":[e]}}});
        for phase in ["enabling", "conflict", "detaching"] {
            s["profiles"]["codex"]["phase"]=phase.into();
            control::save(&h.data,"integration.json",&s).unwrap();
            assert_eq!(migrate(&h,false,false).unwrap()["outcome"],"unchanged");
        }
        s["profiles"]["codex"]["entries"][0]["key"][1]=OLD.into();
        control::save(&h.data,"integration.json",&s).unwrap();
        assert!(migrate(&h,false,false).is_err());
        assert!(!h.data.join("name-migration.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

}
