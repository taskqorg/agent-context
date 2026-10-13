//! Owned config edits for Codex, Claude Code and Hermes with the ownership journal (agentq.md § 4, § 8, § 9).
//!
//! ponytail: MCP registration and hooks only. Routing, telemetry env, the Hermes plugin and the instruction block
//! join when the service owns the loopback ports (§ 5); writing them earlier points agents at a dead port.

use coreq::write_atomic;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

pub const AGENTS: [&str; 3] = ["codex", "claude", "hermes"];

/// One owned edit. `.json`: `value` at `key`, or appended to the array there. `.toml`, `.yaml`: a rendered
/// `mcp_servers.agent_context` block.
pub struct Want {
    file: PathBuf,
    key: Vec<String>,
    value: Value,
    append: bool,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default())
}

/// The client's own env, else the default home folder (§ 4).
pub fn root(agent: &str) -> PathBuf {
    let (var, dir) = match agent {
        "codex" => ("CODEX_HOME", ".codex"),
        "claude" => ("CLAUDE_CONFIG_DIR", ".claude"),
        _ => ("HERMES_HOME", ".hermes"),
    };
    std::env::var_os(var).map(PathBuf::from).unwrap_or_else(|| home().join(dir))
}

/// Claude Code keeps `.claude.json` in `CLAUDE_CONFIG_DIR` when set, else in the home folder.
pub fn claude_json() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(|d| PathBuf::from(d).join(".claude.json")).unwrap_or_else(|| home().join(".claude.json"))
}

pub fn wants(agent: &str, root: &Path, claude_json: &Path, exe: &Path) -> Vec<Want> {
    let exe = exe.display().to_string();
    let hook = |event: &str| json!({"type": "command", "command": format!("\"{exe}\" hook {agent} {event}"), "timeout": 5});
    let tools: Vec<Value> = crate::mcp::tools().as_array().into_iter().flatten().map(|t| t["name"].clone()).collect();
    let w = |file: PathBuf, key: &[&str], value: Value, append: bool| Want { file, key: key.iter().map(|k| k.to_string()).collect(), value, append };
    match agent {
        "codex" => vec![
            w(root.join("config.toml"), &["mcp_servers", "agent_context"], json!({"command": exe, "args": ["mcp", "codex"], "enabled_tools": tools}), false),
            w(root.join("hooks.json"), &["hooks", "SessionStart"], json!({"hooks": [hook("SessionStart")]}), true),
            w(root.join("hooks.json"), &["hooks", "Stop"], json!({"hooks": [hook("Stop")]}), true),
        ],
        "claude" => vec![
            w(root.join("settings.json"), &["hooks", "SessionStart"], json!({"hooks": [hook("SessionStart")]}), true),
            w(root.join("settings.json"), &["hooks", "PreToolUse"], json!({"matcher": "Bash", "hooks": [hook("PreToolUse")]}), true),
            w(claude_json.into(), &["mcpServers", "agent_context"], json!({"type": "stdio", "command": exe, "args": ["mcp", "claude"]}), false),
        ],
        _ => vec![w(root.join("config.yaml"), &["mcp_servers", "agent_context"], json!({"command": exe, "args": ["mcp", "hermes"]}), false)],
    }
}

fn load(journal: &Path) -> Vec<Value> {
    std::fs::read_to_string(journal).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn entry(key: &[String], kind: &str, after: Value) -> Value {
    json!({"key": key, "kind": kind, "before": null, "after": after})
}

/// File by file: a conflict leaves that file untouched; every edit is journaled before the write. Repeat is safe.
pub fn apply(wants: &[Want], journal: &Path) -> Result<Vec<String>, String> {
    let mut out = vec![];
    let mut files: Vec<&Path> = wants.iter().map(|w| w.file.as_path()).collect();
    files.dedup();
    for f in files {
        let old = std::fs::read_to_string(f).ok();
        let mut text = old.clone().unwrap_or_default();
        let mut entries = vec![];
        let placed = wants.iter().filter(|w| w.file == f).try_for_each(|w| {
            let (t, e) = place(&text, w)?;
            entries.extend(e);
            text = t;
            Ok::<(), String>(())
        });
        match placed {
            Err(e) => out.push(format!("conflict: {} {e}; file unchanged", f.display())),
            Ok(()) if entries.is_empty() => out.push(format!("kept: {}", f.display())),
            Ok(()) => {
                for e in &mut entries {
                    e["file"] = f.display().to_string().into();
                }
                match &old {
                    None => entries[0]["created"] = true.into(),
                    // restore writes these bytes back once the doc matches them again
                    Some(o) if entries[0]["kind"] != "text" => entries[0]["orig"] = o.as_str().into(),
                    Some(_) => {}
                }
                let n = entries.len();
                let mut j = load(journal);
                j.extend(entries);
                if let Some(d) = journal.parent() {
                    std::fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
                }
                write_atomic(journal, &serde_json::to_string_pretty(&j).unwrap_or_default())?;
                // `orig` copies configs that may hold env secrets: owner-only, gone with the install folder on uninstall
                #[cfg(unix)]
                std::fs::set_permissions(journal, std::os::unix::fs::PermissionsExt::from_mode(0o600)).map_err(|e| format!("{}: {e}", journal.display()))?;
                write_atomic(f, &text)?;
                let bom = if old.as_deref().is_some_and(|o| o.starts_with(BOM) && !text.starts_with(BOM)) { "; UTF-8 BOM stripped" } else { "" };
                out.push(format!("edited: {} ({n} owned keys{bom})", f.display()));
            }
        }
    }
    Ok(out)
}

/// Restores journaled edits newest first when the current value is still ours; later foreign edits stay.
pub fn restore(journal: &Path, dry: bool) -> Result<Vec<String>, String> {
    let mut out = vec![];
    // a dry run restores in memory, so later entries of one file see the earlier ones
    let mut seen: std::collections::HashMap<PathBuf, String> = Default::default();
    for e in load(journal).iter().rev() {
        let f = PathBuf::from(e["file"].as_str().unwrap_or_default());
        let what = format!("{} {}", f.display(), e["key"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join("."));
        let current = seen.get(&f).cloned().or_else(|| std::fs::read_to_string(&f).ok());
        let Some(mut text) = current.and_then(|t| unplace(&t, e)) else {
            out.push(format!("conflict: {what} changed since onboard; kept"));
            continue;
        };
        if let Some(o) = e["orig"].as_str().filter(|o| serde_json::from_str::<Value>(no_bom(o)).ok() == serde_json::from_str(&text).ok()) {
            text = o.into();
        }
        seen.insert(f.clone(), text.clone());
        if !dry {
            if e["created"] == true && matches!(text.trim(), "" | "{}") {
                std::fs::remove_file(&f).map_err(|e| format!("{}: {e}", f.display()))?;
            } else {
                write_atomic(&f, &text)?;
            }
        }
        out.push(format!("{}: {what}", if dry { "would restore" } else { "restored" }));
    }
    Ok(out)
}

fn place(text: &str, w: &Want) -> Result<(String, Option<Value>), String> {
    match w.file.extension().and_then(|e| e.to_str()) {
        Some("json") => place_json(text, w),
        Some("toml") => place_toml(text, w),
        _ => place_yaml(text, w),
    }
}

fn unplace(text: &str, e: &Value) -> Option<String> {
    let after = &e["after"];
    if e["kind"] == "text" {
        let a = after.as_str()?;
        return text.contains(a).then(|| text.replacen(a, "", 1));
    }
    let mut doc: Value = serde_json::from_str(no_bom(text)).ok()?;
    let key: Vec<&str> = e["key"].as_array()?.iter().filter_map(Value::as_str).collect();
    let (last, path) = key.split_last()?;
    let parent = path.iter().try_fold(&mut doc, |v, k| v.get_mut(*k))?.as_object_mut()?;
    if e["kind"] == "append" {
        let a = parent.get_mut(*last)?.as_array_mut()?;
        let i = a.iter().position(|v| v == after)?;
        a.remove(i);
    } else if parent.get(*last) == Some(after) {
        parent.shift_remove(*last);
    } else {
        return None;
    }
    Some(dump(&doc, no_bom(text)))
}

const BOM: char = '\u{feff}';

/// Windows editors may save JSON with a UTF-8 BOM, which serde_json rejects as `expected value at line 1 column 1`.
fn no_bom(text: &str) -> &str {
    text.strip_prefix(BOM).unwrap_or(text)
}

/// Pretty JSON with the original's indent (2 spaces for a new file); a trailing newline only when the original had one.
/// ponytail: indent only; other foreign layout (compact arrays, spacing) is re-pretty while onboarded, restore brings its bytes back.
pub(crate) fn dump(doc: &Value, orig: &str) -> String {
    let indent = orig.lines().nth(1).map(|l| &l[..l.len() - l.trim_start().len()]).filter(|i| !i.is_empty()).unwrap_or("  ");
    // JSON strings hold no raw newline, so each line's leading spaces are indent only
    let s = serde_json::to_string_pretty(doc).unwrap_or_default().lines().map(|l| {
        let t = l.trim_start();
        indent.repeat((l.len() - t.len()) / 2) + t
    }).collect::<Vec<_>>().join("\n");
    if orig.is_empty() || orig.ends_with('\n') { s + "\n" } else { s }
}

/// The first missing key gets the whole remaining subtree, so restore removes exactly what onboard created.
fn place_json(text: &str, w: &Want) -> Result<(String, Option<Value>), String> {
    let text = no_bom(text);
    let mut doc: Value = if text.trim().is_empty() { json!({}) } else { serde_json::from_str(text).map_err(|e| format!("is not JSON: {e}"))? };
    let mut cur = &mut doc;
    for (i, k) in w.key.iter().enumerate() {
        let obj = cur.as_object_mut().ok_or(format!("{} is not an object", w.key[..i].join(".")))?;
        if !obj.contains_key(k) {
            let mut v = if w.append { json!([w.value]) } else { w.value.clone() };
            for k2 in w.key[i + 1..].iter().rev() {
                v = Value::Object(Map::from_iter([(k2.clone(), v)]));
            }
            obj.insert(k.clone(), v.clone());
            return Ok((dump(&doc, text), Some(entry(&w.key[..=i], "set", v))));
        }
        cur = obj.get_mut(k).unwrap();
    }
    if w.append {
        let a = cur.as_array_mut().ok_or(format!("{} is not an array", w.key.join(".")))?;
        if a.contains(&w.value) {
            return Ok((text.into(), None));
        }
        a.push(w.value.clone());
        return Ok((dump(&doc, text), Some(entry(&w.key, "append", w.value.clone()))));
    }
    if *cur == w.value { Ok((text.into(), None)) } else { Err(format!("{} has a foreign value", w.key.join("."))) }
}

fn fields(w: &Want) -> impl Iterator<Item = (&String, &Value)> {
    w.value.as_object().into_iter().flatten()
}

fn sep(text: &str) -> &'static str {
    if text.is_empty() {
        ""
    } else if text.ends_with('\n') {
        "\n"
    } else {
        "\n\n"
    }
}

/// Appends `[mcp_servers.agent_context]`; JSON strings and arrays are valid TOML values.
fn place_toml(text: &str, w: &Want) -> Result<(String, Option<Value>), String> {
    let name = w.key.join(".");
    let block = format!("[{name}]\n{}", fields(w).map(|(k, v)| format!("{k} = {v}\n")).collect::<String>());
    if text.contains(&block) {
        return Ok((text.into(), None));
    }
    // ponytail: substring check; an inline `agent_context = {..}` under `[mcp_servers]` slips through
    if text.contains(&name) {
        return Err(format!("{name} exists"));
    }
    let after = format!("{}{block}", sep(text));
    Ok((format!("{text}{after}"), Some(entry(&w.key, "text", after.into()))))
}

/// Inserts `agent_context` under a block `mcp_servers:` with its indent, else appends both; JSON scalars are YAML.
fn place_yaml(text: &str, w: &Want) -> Result<(String, Option<Value>), String> {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let head = lines.iter().position(|l| l.starts_with(&format!("{}:", w.key[0])));
    let indent = head
        .and_then(|h| lines[h + 1..].iter().find(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#')))
        .map(|l| l.len() - l.trim_start().len())
        .filter(|n| *n > 0)
        .unwrap_or(2);
    let i = " ".repeat(indent);
    let block = format!("{i}{}:\n{}", w.key[1], fields(w).map(|(k, v)| format!("{i}{i}{k}: {v}\n")).collect::<String>());
    if text.contains(&block) {
        return Ok((text.into(), None));
    }
    if lines.iter().any(|l| l.trim_start().starts_with(&format!("{}:", w.key[1]))) {
        return Err(format!("{} exists", w.key.join(".")));
    }
    let (text, after) = match head {
        None => {
            let after = format!("{}{}:\n{block}", sep(text), w.key[0]);
            (format!("{text}{after}"), after)
        }
        Some(h) if lines[h].trim_end() == format!("{}:", w.key[0]) && lines[h].ends_with('\n') => {
            let at: usize = lines[..=h].iter().map(|l| l.len()).sum();
            (format!("{}{block}{}", &text[..at], &text[at..]), block)
        }
        Some(_) => return Err(format!("{} is not a block mapping", w.key[0])),
    };
    Ok((text, Some(entry(&w.key, "text", after.into()))))
}

/// Built-in fixture for `selftest`: a Claude settings file saved with a BOM gets the hook and loses the BOM.
pub fn selftest() -> bool {
    let w = &wants("claude", Path::new("s"), Path::new("c.json"), Path::new("agentq"))[0];
    place_json("\u{feff}{}", w).is_ok_and(|(t, e)| t.starts_with("{\n  \"hooks\"") && e.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(files: &[PathBuf]) -> Vec<Option<String>> {
        files.iter().map(|f| std::fs::read_to_string(f).ok()).collect()
    }

    /// A1: onboard edits only owned keys, records each edit, and uninstall restores every file byte for byte.
    #[test]
    fn onboard_then_restore_leaves_no_diff() {
        let d = std::env::temp_dir().join(format!("agentq-onboard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let (codex, claude, hermes) = (d.join("codex"), d.join("claude"), d.join("hermes"));
        for r in [&codex, &claude, &hermes] {
            std::fs::create_dir_all(r).unwrap();
        }
        std::fs::write(codex.join("config.toml"), "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"x\"").unwrap();
        // 4-space indent and a compact array: onboard keeps the indent, uninstall brings back every byte
        std::fs::write(claude.join("settings.json"), "{\n    \"model\": \"opus\",\n    \"allow\": [\"a\", \"b\"],\n    \"hooks\": {\n        \"SessionStart\": [\n            {\n                \"hooks\": []\n            }\n        ]\n    }\n}").unwrap();
        std::fs::write(claude.join(".claude.json"), "{\n  \"mcpServers\": {\n    \"other\": {}\n  },\n  \"tips\": 3\n}\n").unwrap();
        std::fs::write(hermes.join("config.yaml"), "model: x\nmcp_servers:\n    other:\n        command: y\nplugins: {}\n").unwrap();
        let exe = d.join("install").join("agentq");
        let journal = d.join("install").join("data").join("owned.json");
        let all = || -> Vec<Want> {
            let mut w = wants("codex", &codex, &claude.join(".claude.json"), &exe);
            w.extend(wants("claude", &claude, &claude.join(".claude.json"), &exe));
            w.extend(wants("hermes", &hermes, &claude.join(".claude.json"), &exe));
            w
        };
        let files: Vec<PathBuf> = {
            let mut f: Vec<PathBuf> = all().into_iter().map(|w| w.file).collect();
            f.dedup();
            f
        };
        let before = snapshot(&files);

        let out = apply(&all(), &journal).unwrap();
        assert!(out.iter().all(|l| l.starts_with("edited:")), "{out:?}");
        assert_eq!(load(&journal).len(), 7, "one journal entry per edit");
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&journal).unwrap().permissions()) & 0o777, 0o600);
        let toml = std::fs::read_to_string(codex.join("config.toml")).unwrap();
        assert!(toml.starts_with("model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"x\"\n\n[mcp_servers.agent_context]\n"), "{toml}");
        let yaml = std::fs::read_to_string(hermes.join("config.yaml")).unwrap();
        assert!(yaml.starts_with("model: x\nmcp_servers:\n    agent_context:\n        command: "), "{yaml}");
        let settings = std::fs::read_to_string(claude.join("settings.json")).unwrap();
        assert!(settings.starts_with("{\n    \"model\": \"opus\",\n    \"allow\": [\n        \"a\","), "{settings}");
        let settings: Value = serde_json::from_str(&settings).unwrap();
        assert_eq!(settings["hooks"]["SessionStart"].as_array().unwrap().len(), 2, "foreign hook kept");
        assert_eq!(settings["hooks"]["PreToolUse"][0]["matcher"], "Bash");
        let hooks: Value = serde_json::from_str(&std::fs::read_to_string(codex.join("hooks.json")).unwrap()).unwrap();
        assert!(hooks["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap().ends_with(" hook codex Stop"));

        let edited = snapshot(&files);
        assert!(apply(&all(), &journal).unwrap().iter().all(|l| l.starts_with("kept:")), "repeat is safe");
        assert_eq!(load(&journal).len(), 7);
        assert_eq!(snapshot(&files), edited);

        assert!(restore(&journal, true).unwrap().iter().all(|l| l.starts_with("would restore:")));
        assert_eq!(snapshot(&files), edited, "dry run writes nothing");
        assert!(restore(&journal, false).unwrap().iter().all(|l| l.starts_with("restored:")));
        assert_eq!(snapshot(&files), before, "uninstall leaves no diff");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// #71 A2: a BOM is reported and stripped, not `is not JSON`; uninstall brings the original bytes back.
    #[test]
    fn json_bom_is_stripped_and_restored() {
        let d = std::env::temp_dir().join(format!("agentq-bom-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let orig = "\u{feff}{\n  \"model\": \"opus\"\n}\n";
        std::fs::write(d.join("settings.json"), orig).unwrap();
        let journal = d.join("owned.json");
        let w: Vec<Want> = wants("claude", &d, &d.join(".claude.json"), Path::new("/x/agentq")).into_iter().take(2).collect();
        let out = apply(&w, &journal).unwrap();
        assert!(out[0].starts_with("edited:") && out[0].ends_with("; UTF-8 BOM stripped)"), "{out:?}");
        let edited = std::fs::read_to_string(d.join("settings.json")).unwrap();
        assert!(edited.starts_with("{\n  \"model\""), "{edited}");
        assert!(selftest());
        restore(&journal, false).unwrap();
        assert_eq!(std::fs::read_to_string(d.join("settings.json")).unwrap(), orig);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn foreign_values_stop_the_file_and_survive_restore() {
        let d = std::env::temp_dir().join(format!("agentq-conflict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let cj = d.join(".claude.json");
        let foreign = "{\n  \"mcpServers\": {\n    \"agent_context\": {\n      \"command\": \"node\"\n    }\n  }\n}\n";
        std::fs::write(&cj, foreign).unwrap();
        std::fs::write(d.join("config.yaml"), "mcp_servers: {}\n").unwrap();
        let journal = d.join("owned.json");
        let mut w = wants("claude", &d, &cj, Path::new("/x/agentq"));
        w.extend(wants("hermes", &d, &cj, Path::new("/x/agentq")));
        let out = apply(&w, &journal).unwrap();
        assert!(out.iter().any(|l| l.starts_with("conflict:") && l.contains("mcpServers.agent_context has a foreign value")), "{out:?}");
        assert!(out.iter().any(|l| l.starts_with("conflict:") && l.contains("not a block mapping")), "{out:?}");
        assert_eq!(std::fs::read_to_string(&cj).unwrap(), foreign);

        // a later foreign edit of an owned key is kept and reported
        let s = d.join("settings.json");
        let edited = std::fs::read_to_string(&s).unwrap().replace("hook claude PreToolUse", "my-hook");
        std::fs::write(&s, &edited).unwrap();
        let out = restore(&journal, false).unwrap();
        assert!(out.iter().any(|l| l.starts_with("conflict:") && l.contains("hooks.PreToolUse")), "{out:?}");
        assert!(std::fs::read_to_string(&s).unwrap().contains("my-hook"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
