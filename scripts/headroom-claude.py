"""Real Claude subscription qualification with process-only proxy routing."""
import argparse
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, required=True)
parser.add_argument('--headroom', required=True)
parser.add_argument('--cwd', required=True)
args = parser.parse_args()
work = Path(args.cwd)
work.mkdir(parents=True, exist_ok=True)
fixture = '\n'.join(f'Record {i}: Successful routine deployment completed; no action required.' for i in range(160))
fixture += '\nImportant finding: release amber-47 uses port 6543 and has retry limit 2.\n'
work.joinpath('fixture.txt').write_text(fixture)
config = {'mcpServers': {'headroom': {'command': args.headroom, 'args': ['mcp', 'serve', '--proxy-url', f'http://127.0.0.1:{args.port}'], 'env': {'HEADROOM_STATELESS': 'true', 'HEADROOM_OFFLINE': '1'}}}}
work.joinpath('mcp.json').write_text(json.dumps(config))
command = ['claude', '-p', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', str(work / 'mcp.json'),
           '--no-session-persistence', '--output-format', 'json', '--max-turns', '5', '--tools', 'Read',
           '--allowedTools', 'Read,mcp__headroom__headroom_retrieve',
           '--', 'Read fixture.txt once using Read. Report the important release name, port and retry limit. If compressed data omits needed details, use headroom_retrieve. No other tools or file changes.']
env = dict(os.environ, ANTHROPIC_BASE_URL=f'http://127.0.0.1:{args.port}', ENABLE_TOOL_SEARCH='true')
with work.joinpath('result.json').open('w') as out, work.joinpath('stderr.log').open('w') as err:
    result = subprocess.run(command, cwd=work, stdout=out, stderr=err, env=env, timeout=120)
value = json.loads(work.joinpath('result.json').read_text())
answer = value.get('result', '')
passed = result.returncode == 0 and not value.get('is_error') and all(x in answer for x in ['amber-47', '6543', '2'])
summary = {'agent': 'claude', 'passed': passed, 'exit_code': result.returncode, 'usage': value.get('usage'), 'model_usage': value.get('modelUsage'), 'evidence_dir': str(work)}
work.joinpath('summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary))
raise SystemExit(0 if passed else 1)
