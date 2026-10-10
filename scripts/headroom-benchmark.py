"""Paired whole-task runs: same fixture, model, tools and transport in both arms."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--headroom', required=True)
parser.add_argument('--repeats', type=int, default=2)
parser.add_argument('--port', type=int, default=18792)
parser.add_argument('--fixtures', nargs='+', choices=['error', 'routine', 'code'], default=['error', 'routine'])
args = parser.parse_args()
if not 1 <= args.repeats <= 3:
    parser.error('repeats must be 1..3')
root = Path(tempfile.mkdtemp(prefix='agent-context-benchmark-'))
rows = []
for fixture in args.fixtures:
    for repeat in range(args.repeats):
        # Alternate order to reduce systematic cache/order bias; keep reported cached usage.
        arms = ['baseline', 'compressed'] if repeat % 2 == 0 else ['compressed', 'baseline']
        for arm in arms:
            work = root / f'{fixture}-{repeat}-{arm}'
            command = [sys.executable, str(Path(__file__).with_name('headroom-qualify.py')),
                       '--source', 'shell', '--fixture', fixture, '--protocol', 'ws',
                       '--port', str(args.port), '--headroom', args.headroom,
                       '--approve-retrieval-test-tool', '--cwd', str(work)]
            result = subprocess.run(command, env=dict(os.environ, AGENT_CONTEXT_OPTIMIZE='0' if arm == 'baseline' else '1'), timeout=170)
            summary_file = work / 'summary-ws.json'
            summary = json.loads(summary_file.read_text()) if summary_file.exists() else {'passed': False}
            rows.append(dict(summary, arm=arm, fixture=fixture, repeat=repeat))
            (root / 'results.json').write_text(json.dumps(rows, indent=2) + '\n')
            if result.returncode:
                raise SystemExit(f'Unqualified benchmark arm; retain evidence at {root}')
print(json.dumps({'evidence_dir': str(root), 'rows': rows}))
