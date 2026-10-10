"""Own the isolated proxy lifecycle for a bounded subscription qualification."""
import argparse
import json
import uuid
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--agent", choices=["codex", "claude", "hermes"], default="codex")
parser.add_argument("--source", choices=["shell", "mcp", "retrieval"], default="retrieval")
parser.add_argument("--fixture", choices=["routine", "error", "code"], default="routine")
parser.add_argument("--protocol", choices=["ws", "http"], default="ws")
parser.add_argument("--port", type=int, default=0)
parser.add_argument("--cwd")
parser.add_argument("--headroom", required=True)
parser.add_argument("--hermes")
parser.add_argument("--approve-fixture-test-tool", action="store_true")
parser.add_argument("--approve-retrieval-test-tool", action="store_true")
args = parser.parse_args()
if not args.port:
    # Production services own 18787-18790; pick a free loopback port instead.
    import socket
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        args.port = probe.getsockname()[1]
root = Path(__file__).resolve().parent.parent
work = Path(args.cwd or tempfile.mkdtemp(prefix="agent-context-qualification-"))
work.mkdir(parents=True, exist_ok=True)
owner = str(uuid.uuid4())
environment = dict(os.environ, AGENT_CONTEXT_PROXY_OWNER=owner, AGENT_CONTEXT_BRIDGE=str(root / "bin/headroom-compress.js"),
                   AGENT_CONTEXT_PROXY_PORT=str(args.port), PYTHONDONTWRITEBYTECODE="1")
with work.joinpath("proxy.log").open("w", encoding="utf-8") as log:
    process = subprocess.Popen([sys.executable, "-m", "agent_context_headroom.proxy"],
                               stdout=log, stderr=log, env=environment)
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError("Proxy startup failed; inspect private proxy.log")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{args.port}/agent-context/health", timeout=0.2) as response:
                    if response.status == 200 and json.load(response).get('owner') == owner:
                        break
            except OSError:
                time.sleep(0.2)
        else:
            raise RuntimeError("Proxy health timeout")
        command = [sys.executable, str(root / "scripts/headroom-live.py"), "--source", args.source,
                   "--fixture", args.fixture, "--protocol", args.protocol, "--port", str(args.port), "--cwd", str(work),
                   "--headroom", args.headroom]
        if args.agent == "claude":
            command = [sys.executable, str(root / "scripts/headroom-claude.py"), "--port", str(args.port), "--cwd", str(work), "--headroom", args.headroom]
        if args.agent == "hermes":
            if not args.hermes:
                raise RuntimeError("Hermes qualification requires --hermes executable")
            command = [sys.executable, str(root / "scripts/headroom-hermes.py"), "--port", str(args.port), "--cwd", str(work), "--hermes", args.hermes]
        if args.approve_retrieval_test_tool and args.agent == "codex":
            command.append("--approve-retrieval-test-tool")
        if args.approve_fixture_test_tool and args.agent == "codex":
            command.append("--approve-fixture-test-tool")
        result = subprocess.run(command, timeout=125, env=environment)
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
raise SystemExit(result.returncode)
