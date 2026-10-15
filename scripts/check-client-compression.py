#!/usr/bin/env python3
"""Opt-in installed-client check: native test output -> automatic AgentQ compression -> recovery."""
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
PYTEST = 'pytest -s -v -p no:cacheprovider --color=no test_native.py'


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
    executable = install / ('agentq.exe' if os.name == 'nt' else 'agentq')
    try:
        result = subprocess.run([str(executable), 'stats', '--records'], capture_output=True,
                                text=True, encoding='utf-8', errors='replace', timeout=10,
                                env=dict(os.environ, AGENTQ_INSTALL=str(install)))
        if result.returncode:
            return {}, [f'local stats export failed (exit {result.returncode})']
        payload = json.loads(result.stdout)
        if payload.get('schema') != 1 or not isinstance(payload.get('records'), list) or not isinstance(payload.get('errors'), list):
            return {}, ['unsupported local stats export']
        records = {}
        errors = list(payload['errors'])
        for item in payload['records']:
            event_id = item['event_id']
            if event_id in records and records[event_id] != item:
                errors.append('conflicting local event ID')
            records[event_id] = item
        return records, errors
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as exc:
        return {}, [f'local stats export: {type(exc).__name__}']


def events(path):
    result = []
    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
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


def judge(client, rows, new, marker, agentq, fixture, output, command=COMMAND):
    session, commands, reply = observed(client, rows)
    report = dict(client=client, session=session, native_commands=commands, result='fail',
                  new_records=len(new), correlated_records=0)
    # Native command must be requested. A hook may rewrite it, but the prompt never invokes agentq manually.
    native = [c for c in commands if command in c['command']]
    expected_exits = (1,) if command == PYTEST else (1, 101)
    if not native or not any(c.get('exit_code') in expected_exits and (marker in c.get('output', '') or marker in reply) for c in native):
        report.update(result='unknown', reason='native fixture execution not proved')
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
                           and all((f'test_pass_{i:03}' if command == PYTEST else f'test pass_{i:03}') in original for i in range(180))
                           and ('1 failed, 180 passed' if command == PYTEST else '180 passed; 1 failed') in original)
        except (ValueError, KeyError, IndexError, TypeError):
            original_ok = False
        # Require model acknowledgement too: local pre-transform tool events alone do not prove model input.
        model_saw_reference = reference in reply and marker in reply
        report.update(event_id=record['event_id'], core_version=record.get('version'), core_engine_version=record.get('engine_version'), bytes_in=record['bytes_in'], bytes_out=record['bytes_out'], ref=reference,
                      original_recovered=code == 0 and original_ok, model_saw_reference=model_saw_reference)
        if original_ok and model_saw_reference and code == 0:
            report.update(result='pass', reason='native client, smaller model-visible output, correlated stats and complete recovery')
            return report
    report['reason'] = 'compression reported, but model visibility or original recovery was not proved'
    return report


def telemetry_diagnostic(stderr):
    # A successful compression run cannot certify the optional native exporter.
    if 'SessionEnd hook' in stderr and 'Hook cancelled' in stderr:
        return 'cancelled: SessionEnd hook; connected usage coverage unproved'
    return 'unknown: verify delivered observations separately'


def codex_command(executable, fixture):
    return [executable, 'exec', '--json', '--skip-git-repo-check', '--color', 'never', '-C', str(fixture), '-']


def codex_native_rows(rows, command):
    """Read only this native session; code-mode calls are absent from some CLI stdout schemas."""
    session, commands, _ = observed('codex', rows)
    if commands or not session or not re.fullmatch(r'[0-9a-f-]{36}', session):
        return rows, 'stdout'
    home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    files = list((home / 'sessions').glob('*/*/*/*' + session + '.jsonl'))
    if len(files) != 1:
        return rows, 'native transcript unavailable'
    try:
        if files[0].stat().st_size > 16 << 20:
            return rows, 'native transcript exceeds bound'
        native = events(files[0])
    except OSError:
        return rows, 'native transcript unreadable'
    pending, extra = {}, []
    for row in native:
        p = row.get('payload', {})
        if row.get('type') != 'response_item':
            continue
        if p.get('type') in ['function_call', 'custom_tool_call']:
            source = p.get('arguments', p.get('input', ''))
            if p.get('call_id') and isinstance(source, str) and p.get('name') in ['exec', 'exec_command', 'shell_command', 'shell'] and command in source:
                pending[p.get('call_id')] = dict(type='command_execution', id=p.get('call_id'), command=command)
        if p.get('type') in ['function_call_output', 'custom_tool_call_output'] and p.get('call_id') in pending:
            item = pending.pop(p['call_id'])
            raw = p.get('output', '')
            if isinstance(raw, str):
                texts = [raw]
            elif isinstance(raw, list):
                texts = [p.get('text') for p in raw if isinstance(p, dict) and p.get('type') == 'input_text']
            else:
                texts = []
            results = []
            for text in texts:
                try:
                    value = json.loads(text)
                except (ValueError, TypeError):
                    continue
                if isinstance(value, dict) and type(value.get('exit_code')) is int and isinstance(value.get('output'), str):
                    results.append(value)
            if len(results) != 1:
                continue
            item.update(exit_code=results[0]['exit_code'], aggregated_output=results[0]['output'])
            extra.append(dict(type='item.completed', item=item))
    return rows + extra, 'native session transcript'


def client_binary(client, explicit=None):
    if explicit:
        path = Path(explicit).expanduser()
        return str(path.resolve()) if path.is_file() else shutil.which(explicit)
    found = shutil.which(client)
    if found:
        return found
    if client == 'codex' and os.name == 'nt' and os.environ.get('LOCALAPPDATA'):
        paths = list((Path(os.environ['LOCALAPPDATA']) / 'OpenAI/Codex/bin').glob('*/codex.exe'))
        return str(max(paths, key=lambda p: p.stat().st_mtime_ns)) if paths else None
    return None


def main():
    parser = argparse.ArgumentParser(prog='agentq check compression', description=__doc__)
    parser.add_argument('client', choices=['codex', 'claude', 'both'])
    default = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / '.local/share'))) / 'agentq'
    parser.add_argument('--codex', help='Codex CLI executable for a specific version')
    parser.add_argument('--claude', help='Claude CLI executable for a specific version')
    parser.add_argument('--fixture', choices=['cargo', 'pytest'], default='cargo', help='pytest needs an installed pytest on PATH; no client permission changes')
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
    fixture_command = PYTEST if args.fixture == 'pytest' else COMMAND
    report = dict(schema=1, started_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  install=str(install), settings_changed=False, results=[])
    for client in clients:
        print(f'{client}: checking installed integration; logs {output}', flush=True)
        executable = client_binary(client, getattr(args, client))
        missing = ([client] if not executable else []) + ([] if shutil.which(args.fixture) else [args.fixture])
        if missing or not agentq.is_file():
            report['results'].append(dict(client=client, result='unknown', reason='missing prerequisite: '+', '.join(missing or ['agentq'])))
            continue
        fixture = output / client
        (fixture / 'src').mkdir(parents=True, exist_ok=True)
        marker = 'AGENTQ_CHECK_' + uuid.uuid4().hex
        if args.fixture == 'cargo':
            (fixture / 'Cargo.toml').write_text('[package]\nname="agentq_client_fixture"\nversion="0.1.0"\nedition="2021"\n[workspace]\n')
            source = '\n'.join(f'#[test]\nfn pass_{i:03}() {{ assert_eq!({i}, {i}); }}' for i in range(180))
            (fixture / 'src/lib.rs').write_text(source + f'\n#[test]\nfn expected_failure() {{ panic!("{marker}"); }}\n')
        else:
            source = '\n'.join(f'def test_pass_{i:03}(): assert {i} == {i}' for i in range(180))
            (fixture / 'test_native.py').write_text(source + f'\ndef test_expected_failure(): assert False, "{marker}"\n')
        # Warm compilation and establish actual output length; no dependency download is needed.
        baseline = output / f'{client}-baseline'
        baseline_code = run(fixture_command.split() if args.fixture == 'pytest' else ['cargo', 'test', '--offline', '--color', 'never', '--', '--test-threads=1'], fixture, baseline)
        raw_bytes = baseline.with_suffix('.stdout.jsonl').stat().st_size
        if baseline_code != (1 if args.fixture == 'pytest' else 101) or raw_bytes < 2048:
            report['results'].append(dict(client=client, result='unknown', reason='fixture baseline did not produce expected large failure output'))
            continue
        before, before_errors = stats(install)
        prompt = (f'In this directory, execute exactly once this shell command: {fixture_command}\n'
                  'Use your ordinary shell tool. Do not edit files, run other commands, delegate, or manually use wrappers. '
                  'The fixture intentionally has one failing test. Report the passed/failed counts, exit code, '
                  'the AGENTQ_CHECK_ error marker, and any original-recovery reference present in the tool output '
                  '(write null if no reference exists). Do not infer or invent a reference.')
        stem = output / client
        if client == 'codex':
            command = codex_command(executable, fixture)
        else:
            command = [executable, '-p', prompt, '--output-format', 'stream-json', '--verbose',
                       '--tools', 'Bash', '--allowedTools', f'Bash({args.fixture} *)',
                       f"Bash(AGENTQ_AGENT=claude AGENTQ_SESSION=* AGENTQ_TOOL_CALL=* '{agentq}' run -- {args.fixture} *)",
                       '--permission-mode', 'dontAsk',
                       '--max-budget-usd', '2', '--session-id', str(uuid.uuid4())]
        started = time.monotonic()
        code = run(command, fixture, stem, timeout=args.timeout, stdin=prompt if client == 'codex' else None)
        after, after_errors = stats(install)
        new = [v for k, v in after.items() if k not in before]
        (output / f'{client}-new-records.json').write_text(json.dumps(new, indent=2)+'\n')
        rows = events(stem.with_suffix('.stdout.jsonl'))
        rows, evidence = codex_native_rows(rows, fixture_command) if client == 'codex' else (rows, 'stdout')
        result = judge(client, rows, new, marker, agentq, fixture, output, fixture_command)
        result.update(fixture=args.fixture, native_evidence=evidence)
        result['native_surface'] = 'cli'
        result['fixture_permission_scope'] = 'inherited native policy' if client == 'codex' else 'command-only fixture allowlist; other tools disabled; dontAsk'
        result['installation'] = (install / 'data/installation').read_text().strip() if (install / 'data/installation').is_file() else None
        result['runtime'] = 'windows' if os.name == 'nt' else 'macos' if sys.platform == 'darwin' else 'wsl' if os.environ.get('WSL_DISTRO_NAME') or Path('/proc/sys/fs/binfmt_misc/WSLInterop').exists() else 'linux'
        result['native_telemetry_delivery'] = telemetry_diagnostic(stem.with_suffix('.stderr.log').read_text(encoding='utf-8', errors='replace'))
        result['observed_usage'] = next((r.get('usage') for r in reversed(events(stem.with_suffix('.stdout.jsonl'))) if r.get('type') == ('turn.completed' if client == 'codex' else 'result')), None)
        result.update(client_version=subprocess.run([executable, '--version'], capture_output=True, text=True, timeout=10).stdout.strip(),
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
