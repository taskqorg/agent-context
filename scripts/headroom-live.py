"""Run a bounded subscription test with temporary Codex routing overrides."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import re
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--protocol", choices=["ws", "http"], default="ws")
parser.add_argument("--port", type=int, default=18787)
parser.add_argument("--cwd")
parser.add_argument("--source", choices=["shell", "mcp", "retrieval"], default="shell")
parser.add_argument("--fixture", choices=["routine", "error", "code"], default="routine")
parser.add_argument("--headroom", help="Headroom executable for native retrieval MCP")
parser.add_argument("--approve-fixture-test-tool", action="store_true")
parser.add_argument("--approve-retrieval-test-tool", action="store_true",
                    help="Explicit owner authorization required; trust only retrieval for this process")
args = parser.parse_args()
work = Path(args.cwd or tempfile.mkdtemp(prefix="agent-context-codex-"))
work.mkdir(parents=True, exist_ok=True)
rules = "Synthetic integration test. Read only fixture.txt; do not inspect unrelated files, secrets or network.\n"
if work.joinpath("AGENTS.md").exists() and work.joinpath("AGENTS.md").read_text(encoding="utf-8") != rules:
    raise RuntimeError("Refusing to overwrite existing project instructions; choose a disposable test directory")
work.joinpath("AGENTS.md").write_text(rules, encoding="utf-8")
fixture = "\n".join(f"Record {i}: Successful routine deployment completed; no action required." for i in range(160))
work.joinpath("fixture.txt").write_text(
    fixture + ("\nERROR release amber-47 uses port 6543 and has retry limit 2.\n" if args.fixture == "error" else "\nImportant finding: release amber-47 uses port 6543 and has retry limit 2.\n"), encoding="utf-8",
)
if args.fixture == 'code':
    if args.source != 'shell':
        parser.error('code qualification requires shell')
    work.joinpath('fixture.txt').write_text((Path(__file__).parent.parent / 'src/update.js').read_text(encoding='utf-8'), encoding='utf-8')
config = {
    "model_provider": "agent_context_test",
    "model_providers.agent_context_test.name": "Agent Context Test",
    "model_providers.agent_context_test.base_url": f"http://127.0.0.1:{args.port}/v1",
    "model_providers.agent_context_test.wire_api": "responses",
    "model_providers.agent_context_test.requires_openai_auth": True,
    "model_providers.agent_context_test.supports_websockets": args.protocol == "ws",
    "model_reasoning_effort": "low",
}
command = ["codex", "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "-C", str(work), "-s", "read-only", "--json"]
for key, value in config.items():
    command += ["-c", key + "=" + json.dumps(value)]
if args.headroom:
    command += ["-c", "mcp_servers.headroom.command=" + json.dumps(args.headroom), "-c",
                "mcp_servers.headroom.args=" + json.dumps(["mcp", "serve", "--proxy-url", f"http://127.0.0.1:{args.port}"])]
    command += ["-c", 'mcp_servers.headroom.enabled_tools=["headroom_retrieve"]']
    command += ["-c", 'mcp_servers.headroom.env.HEADROOM_STATELESS="true"',
                "-c", 'mcp_servers.headroom.env.HEADROOM_OFFLINE="1"']
    if args.approve_retrieval_test_tool:
        command += ["-c", 'mcp_servers.headroom.default_tools_approval_mode="prompt"', "-c",
                    'mcp_servers.headroom.tools.headroom_retrieve.approval_mode="approve"']
seed = None
if args.source == "retrieval":
    if not args.headroom:
        parser.error("retrieval requires --headroom")
    original = work.joinpath("fixture.txt").read_text(encoding="utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{args.port}/v1/compress",
        data=json.dumps({"model": "gpt-6.1-sol", "messages": [{"role": "user", "content": "Report the important release name, port and retry limit."}, {"role": "tool", "content": original}]}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        compressed = json.load(response)
    text = compressed["messages"][-1]["content"]
    hashes = re.findall(r"<<ccr:([a-f0-9]{12,24})", text)
    if not hashes:
        raise RuntimeError("SC seed did not yield a recoverable marker; not qualified")
    with urllib.request.urlopen(f"http://127.0.0.1:{args.port}/v1/retrieve/{hashes[0]}", timeout=5) as response:
        recovered = json.load(response)
    if recovered.get("original_content") != original:
        raise RuntimeError("Seed recovery did not return the exact original")
    seed = {"input_chars": len(original), "output_chars": len(text), "retrieval_exact": True,
            "transforms": compressed.get("transforms_applied")}
    command += [f"Use only the headroom_retrieve MCP tool to fetch hash {hashes[0]}. Report the important release name, port and retry limit. Do not use shell or other tools; do not alter files."]
elif args.source == "mcp":
    command += ["-c", "mcp_servers.fixture.command=" + json.dumps(shutil.which("node")), "-c",
                "mcp_servers.fixture.args=" + json.dumps([str(Path(__file__).with_name("headroom-fixture.js").resolve())])]
    command += ["-c", 'mcp_servers.fixture.enabled_tools=["read_fixture"]']
    if args.approve_fixture_test_tool:
        command += ["-c", 'mcp_servers.fixture.default_tools_approval_mode="prompt"', "-c", 'mcp_servers.fixture.tools.read_fixture.approval_mode="approve"']
    command += ["Use the fixture MCP read_fixture tool once. Report the important release name, port and retry limit. Do not use shell or alter files. If compressed data omits needed details, use the headroom retrieval MCP tool."]
else:
    command += ["Use the shell tool once to read the complete fixture.txt. " +
                ("This is real update.js source. Report its GitHub repository constant, the automatic update interval in milliseconds, and whether package integrity is checked before loading runtime code." if args.fixture == 'code' else "Report the important release name, port and retry limit.") +
                " Do not alter files. If compressed data omits needed details, use the headroom retrieval MCP tool."]
events_file = work / f"events-{args.protocol}.jsonl"
import time
started = time.monotonic()
with events_file.open("w", encoding="utf-8") as out, work.joinpath(f"stderr-{args.protocol}.log").open("w", encoding="utf-8") as err:
    result = subprocess.run(command, stdout=out, stderr=err, timeout=90)
events = [json.loads(line) for line in events_file.read_text(encoding="utf-8").splitlines()]
completed = [event for event in events if event.get("type") == "turn.completed"]
answers = [event["item"]["text"] for event in events if event.get("item", {}).get("type") == "agent_message"]
tools = [event for event in events if event.get("type") == "item.completed" and event.get("item", {}).get("type") in ["command_execution", "mcp_tool_call"]]
answer = answers[-1] if answers else ''
facts = ['taskqorg/agent-context', '3600000'] if args.fixture == 'code' else ['amber-47', '6543', '2']
normalized = answer.replace(',', '').replace('_', '').replace(' ', '')
passed = result.returncode == 0 and bool(completed) and bool(tools) and all(value in normalized for value in facts)
if args.fixture == 'code':
    passed = passed and bool(re.search(r'integrity|целостност', answer, re.I))
summary = {"protocol": args.protocol, "passed": passed, "exit_code": result.returncode,
           "source": args.source, "fixture": args.fixture, "seed": seed,
           "tool_calls": len(tools), "usage": completed[-1].get("usage") if completed else None,
           "elapsed_ms": int((time.monotonic() - started) * 1000),
           "retrieval_calls": sum(event.get('item', {}).get('tool') == 'headroom_retrieve' for event in tools),
           "evidence_dir": str(work)}
work.joinpath(f"summary-{args.protocol}.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
print(json.dumps(summary))
raise SystemExit(0 if passed else 1)
