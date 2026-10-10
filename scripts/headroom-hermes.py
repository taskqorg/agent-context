"""Qualify the native Hermes all-tool hook in a disposable profile, retaining root auth."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, required=True)
parser.add_argument('--cwd', required=True)
parser.add_argument('--hermes', required=True)
args = parser.parse_args()
work = Path(args.cwd)
work.mkdir(parents=True, exist_ok=True)
profiles = Path.home() / '.hermes/profiles'
profiles.mkdir(parents=True, exist_ok=True)
# Native named profiles share root auth read-only; an arbitrary HERMES_HOME would not.
profile = Path(tempfile.mkdtemp(prefix='agent-context-qualification-', dir=profiles))
work.joinpath('profile-location.txt').write_text(str(profile))
package = Path(__file__).resolve().parent.parent
shutil.copytree(package / 'integrations/hermes/agent-context', profile / 'plugins/agent-context', dirs_exist_ok=True)
config = {'model': {'default': 'gpt-6.1-sol', 'provider': 'openai-codex'}, 'mcp_servers': {'fixture': {'command': os.environ.get('AGENT_CONTEXT_NODE', 'node'), 'args': [str(package / 'scripts/headroom-fixture.js')], 'enabled': True}}, 'plugins': {'enabled': ['agent-context'], 'entries': {'agent-context': {'settings': {'proxy_url': f'http://127.0.0.1:{args.port}'}}}}}
profile.joinpath('config.yaml').write_text(json.dumps(config))
fixture = '\n'.join(f'Record {i}: Successful routine deployment completed; no action required.' for i in range(160))
work.joinpath('fixture.txt').write_text(fixture + '\nImportant finding: release amber-47 uses port 6543 and has retry limit 2.\n')
query = 'Use only the fixture read_fixture MCP tool once to get the synthetic deployment records. Report the important release name, port and retry limit. Do not change files or use other tools except agent_context_retrieve if needed.'
work.joinpath('query.txt').write_text(query)
command = [args.hermes, 'chat', '--cli', '--oneshot', '--quiet', '--provider', 'openai-codex', '--model', 'gpt-6.1-sol', '--toolsets', 'fixture,agent_context', '--max-turns', '5', '--run-budget', '90', '--in', str(work), '--format', 'stream-json', '--query-file', str(work / 'query.txt')]
with work.joinpath('events.jsonl').open('w') as out, work.joinpath('stderr.log').open('w') as err:
    try:
        result = subprocess.run(command, env=dict(os.environ, HERMES_HOME=str(profile)), stdout=out, stderr=err, timeout=120)
    finally:
        shutil.rmtree(profile)
# Qualification requires provider completion, not merely presence of facts echoed in the tool log.
events = [json.loads(line) for line in work.joinpath('events.jsonl').read_text().splitlines() if line.startswith('{')]
completed = [event for event in events if event.get('type') == 'result']
answer = completed[-1].get('text', '') if completed else ''
passed = result.returncode == 0 and bool(completed) and all(fact in answer for fact in ['amber-47', '6543', '2'])
summary = {'agent': 'hermes', 'passed': passed, 'exit_code': result.returncode, 'usage': completed[-1].get('tokens') if completed else None, 'event_types': [x.get('type') for x in events], 'evidence_dir': str(work)}
work.joinpath('summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary))
raise SystemExit(0 if passed else 1)
