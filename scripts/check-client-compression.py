#!/usr/bin/env python3
"""Opt-in installed-client check: native cargo output -> automatic AgentQ compression -> recovery."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

COMMAND = 'cargo test --color never -- --test-threads=1'


def run(command, cwd, stem, timeout=120, stdin=None):
    """Keep durable logs and stop only this probe's process group at its deadline."""
    with stem.with_suffix('.stdout.jsonl').open('w') as out, stem.with_suffix('.stderr.log').open('w') as err:
        process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.PIPE if stdin else subprocess.DEVNULL,
                                   stdout=out, stderr=err, start_new_session=os.name != 'nt')
        try:
            process.communicate(stdin.encode() if stdin else None, timeout=timeout)
            return process.returncode
        except subprocess.TimeoutExpired:
            if os.name == 'nt':
                subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
            else:
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if os.name != 'nt':
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
                process.wait()
            return 'timeout'


def stats(install):
    records = {}
    errors = []
    folder = install / 'data/stats'
    for file in sorted(folder.glob('*.jsonl')):
        try:
            for line in file.read_text().splitlines():
                item = json.loads(line)
                records[item['event_id']] = item
        except (OSError, ValueError, KeyError) as exc:
            errors.append(f'{file.name}: {type(exc).__name__}')
    return records, errors


def events(path):
    result = []
    for line in path.read_text(errors='replace').splitlines():
        try:
            item = json.loads(line)
            if isinstance(item, dict):
                result.append(item)
        except ValueError:
            pass
    return result


def observed(client, rows):
    commands, replies, session = [], [], None
    for row in rows:
        session = row.get('thread_id', row.get('session_id', session))
        if client == 'codex':
            item = row.get('item', {})
            if row.get('type') == 'item.completed' and item.get('type') == 'command_execution':
                commands.append(dict(command=item.get('command', ''), output=item.get('aggregated_output', ''),
                                     exit_code=item.get('exit_code'), tool_call=item.get('id')))
            if item.get('type') == 'agent_message':
                replies.append(item.get('text', ''))
        else:
            message = row.get('message', {})
            for content in message.get('content', []) if isinstance(message, dict) else []:
                if content.get('type') == 'tool_use':
                    commands.append(dict(command=content.get('input', {}).get('command', ''), tool_call=content.get('id')))
                if content.get('type') == 'text':
                    replies.append(content.get('text', ''))
            for content in message.get('content', []) if isinstance(message, dict) else []:
                if content.get('type') == 'tool_result':
                    for command in commands:
                        if command['tool_call'] == content.get('tool_use_id'):
                            value = content.get('content', '')
                            command['output'] = value if isinstance(value, str) else json.dumps(value)
                            code = re.search(r'Exit code (\d+)', command['output'])
                            command['exit_code'] = int(code[1]) if code else (None if content.get('is_error') else 0)
                            command['completed'] = True
            if row.get('type') == 'result':
                replies.append(row.get('result', ''))
    return session, commands, '\n'.join(replies)


def judge(client, rows, new, marker, agentq, fixture, output):
    session, commands, reply = observed(client, rows)
    report = dict(client=client, session=session, native_commands=commands, result='fail',
                  new_records=len(new), correlated_records=0)
    # Native command must be requested. A hook may rewrite it, but the prompt never invokes agentq manually.
    native = [c for c in commands if COMMAND in c['command']]
    if not native or not any(c.get('exit_code') == 101 or marker in c.get('output', '') for c in native):
        report.update(result='unknown', reason='client did not execute the fixture command')
        return report
    adapter = 'provider' if client == 'codex' else 'run'
    matched = [r for r in new if r.get('agent') == client and r.get('adapter') == adapter
               and session and r.get('session') == session]
    report['correlated_records'] = len(matched)
    compressed = [r for r in matched if r.get('outcome') == 'compressed' and r.get('ref')
                  and isinstance(r.get('bytes_in'), int) and isinstance(r.get('bytes_out'), int)
                  and r['bytes_out'] < r['bytes_in'] and r['bytes_in'] >= 2048]
    if not compressed:
        report['reason'] = 'native tool ran, but no session-correlated successful AgentQ compression record'
        return report
    for record in compressed:
        reference = record['ref']
        request = json.dumps(dict(jsonrpc='2.0', id=1, method='tools/call',
                                  params=dict(name='get_original', arguments=dict(ref=reference)))) + '\n'
        stem = output / f'{client}-recovery'
        code = run([str(agentq), 'mcp', client], fixture, stem, timeout=15, stdin=request)
        recovered = events(stem.with_suffix('.stdout.jsonl'))
        try:
            original = json.loads(recovered[0]['result']['content'][0]['text'])['content']
            original_ok = (len(original.encode()) == record['bytes_in'] and marker in original
                           and all(f'test pass_{i:03}' in original for i in range(180))
                           and '180 passed; 1 failed' in original)
        except (ValueError, KeyError, IndexError, TypeError):
            original_ok = False
        # Require model acknowledgement too: local pre-transform tool events alone do not prove model input.
        model_saw_reference = reference in reply and marker in reply
        report.update(bytes_in=record['bytes_in'], bytes_out=record['bytes_out'], ref=reference,
                      original_recovered=code == 0 and original_ok, model_saw_reference=model_saw_reference)
        if original_ok and model_saw_reference and code == 0:
            report.update(result='pass', reason='native client, smaller model-visible output, correlated stats and complete recovery')
            return report
    report['reason'] = 'compression reported, but model visibility or original recovery was not proved'
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('client', choices=['codex', 'claude', 'both'])
    default = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / '.local/share'))) / 'agentq'
    parser.add_argument('--install', type=Path, default=default)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--timeout', type=int, default=120, choices=range(30, 301), metavar='30..300')
    args = parser.parse_args()
    output = (args.output or Path(tempfile.mkdtemp(prefix='agentq-client-check-'))).resolve()
    if args.output and output.exists() and any(output.iterdir()):
        parser.error('--output must be empty; keep earlier evidence in its own directory')
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != 'nt':
        output.chmod(0o700)
    install = args.install.expanduser().resolve()
    agentq = install / ('agentq.exe' if os.name == 'nt' else 'agentq')
    clients = ['codex', 'claude'] if args.client == 'both' else [args.client]
    report = dict(schema=1, started_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  install=str(install), settings_changed=False, results=[])
    for client in clients:
        print(f'{client}: checking installed integration; logs {output}', flush=True)
        missing = [c for c in [client, 'cargo'] if not shutil.which(c)]
        if missing or not agentq.is_file():
            report['results'].append(dict(client=client, result='unknown', reason='missing prerequisite: '+', '.join(missing or ['agentq'])))
            continue
        fixture = output / client
        (fixture / 'src').mkdir(parents=True, exist_ok=True)
        marker = 'AGENTQ_CHECK_' + uuid.uuid4().hex
        (fixture / 'Cargo.toml').write_text('[package]\nname="agentq_client_fixture"\nversion="0.1.0"\nedition="2021"\n[workspace]\n')
        source = '\n'.join(f'#[test]\nfn pass_{i:03}() {{ assert_eq!({i}, {i}); }}' for i in range(180))
        source += f'\n#[test]\nfn expected_failure() {{ panic!("{marker}"); }}\n'
        (fixture / 'src/lib.rs').write_text(source)
        # Warm compilation and establish actual output length; no dependency download is needed.
        baseline = output / f'{client}-baseline'
        baseline_code = run(['cargo', 'test', '--offline', '--color', 'never', '--', '--test-threads=1'], fixture, baseline)
        raw_bytes = baseline.with_suffix('.stdout.jsonl').stat().st_size
        if baseline_code != 101 or raw_bytes < 2048:
            report['results'].append(dict(client=client, result='unknown', reason='fixture baseline did not produce expected large failure output'))
            continue
        before, before_errors = stats(install)
        prompt = (f'In this directory, execute exactly once this shell command: {COMMAND}\n'
                  'Use your ordinary shell tool. Do not edit files, run other commands, delegate, or manually use wrappers. '
                  'The fixture intentionally has one failing test. Report the passed/failed counts, exit code, '
                  'the AGENTQ_CHECK_ error marker, and any original-recovery reference present in the tool output '
                  '(write null if no reference exists). Do not infer or invent a reference.')
        stem = output / client
        if client == 'codex':
            command = [client, '-a', 'never', 'exec', '--json', '--sandbox', 'workspace-write',
                       '--skip-git-repo-check', '--color', 'never', '-C', str(fixture), '-']
        else:
            command = [client, '-p', prompt, '--output-format', 'stream-json', '--verbose',
                       '--tools', 'Bash', '--allowedTools', 'Bash(cargo test *)', '--permission-mode', 'dontAsk',
                       '--max-budget-usd', '2', '--session-id', str(uuid.uuid4())]
        started = time.monotonic()
        code = run(command, fixture, stem, timeout=args.timeout, stdin=prompt if client == 'codex' else None)
        after, after_errors = stats(install)
        new = [v for k, v in after.items() if k not in before]
        (output / f'{client}-new-records.json').write_text(json.dumps(new, indent=2)+'\n')
        result = judge(client, events(stem.with_suffix('.stdout.jsonl')), new, marker,
                       agentq, fixture, output)
        result.update(client_version=subprocess.run([client, '--version'], capture_output=True, text=True, timeout=10).stdout.strip(),
                      agentq_version=subprocess.run([str(agentq), '--version'], capture_output=True, text=True, timeout=10).stdout.strip(),
                      client_exit=code, duration_s=round(time.monotonic()-started, 1),
                      baseline_bytes=raw_bytes, stats_errors=before_errors+after_errors)
        if code == 'timeout' or result['stats_errors']:
            result.update(result='unknown', reason='client timeout or unreadable stats; compression unproved')
        # Keep command/output evidence in private logs; the public report needs metadata only.
        result['native_commands'] = [{k: c.get(k) for k in ['command', 'exit_code', 'tool_call']} for c in result['native_commands']]
        report['results'].append(result)
        (output / 'report.json').write_text(json.dumps(report, indent=2)+'\n')
        print(f"{client}: {result['result'].upper()} — {result['reason']}", flush=True)
    report['finished_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (output / 'report.json').write_text(json.dumps(report, indent=2)+'\n')
    print(f'report: {output / "report.json"}', flush=True)
    return 0 if len(report['results']) == len(clients) and all(r['result']=='pass' for r in report['results']) else 1


if __name__ == '__main__':
    sys.exit(main())
