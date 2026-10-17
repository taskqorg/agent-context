#!/usr/bin/env python3
"""R3/R4: frozen native output -> pinned installed engine -> reduction, guards and recovery.

Offline: no model calls, authentication changes or production configuration writes.
Byte reductions are not measured model-token or billing savings.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import re
from unittest.mock import patch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    default = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / '.local/share'))) / 'agentq'
    parser.add_argument('--install', type=Path, default=default)
    parser.add_argument('--binary', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    install = args.install.expanduser().resolve()
    binary = (args.binary or install / ('agentq.exe' if os.name == 'nt' else 'agentq')).resolve()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error('--output must be empty')
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    report = dict(schema=1, measurement='bytes, not billed tokens', results=[])
    with tempfile.TemporaryDirectory(prefix='agentq-benchmark-') as tmp:
        root = Path(tmp)
        lab = root / 'install'
        (lab / 'data').mkdir(parents=True)
        # Only immutable installed engines are shared; all state and configuration are private.
        (lab / 'engines').mkdir()
        for engine in (install / 'engines').glob('rtk-*'):
            shutil.copytree(engine, lab / 'engines' / engine.name)
        env = dict(os.environ, AGENTQ_INSTALL=str(lab))
        fixture = root / 'fixture'
        (fixture / 'src').mkdir(parents=True)
        (fixture / 'Cargo.toml').write_text('[package]\nname="agentq_benchmark"\nversion="0.1.0"\nedition="2021"\n[workspace]\n')
        source = '\n'.join(f'#[test]\nfn pass_{i:03}() {{ assert_eq!({i}, {i}); }}' for i in range(180))
        captures = {}
        for failure in [False, True]:
            (fixture / 'src/lib.rs').write_text(source + ('\n#[test]\nfn expected_failure() { panic!("AGENTQ_BENCH_ERROR"); }\n' if failure else '\n'))
            run = subprocess.run(['cargo', 'test', '--offline', '--color', 'never', '--', '--test-threads=1'], cwd=fixture, capture_output=True, text=True, timeout=60)
            if run.returncode != (101 if failure else 0):
                raise RuntimeError('native fixture did not execute as expected')
            captures['failure' if failure else 'success'] = (run.stdout, run.returncode)
        raw, code = captures['failure']
        cases = [
            ('hermes_success', *captures['success'], 'cargo test --color never -- --test-threads=1', {}, True),
            ('hermes_failure', *captures['failure'], 'cargo test --color never -- --test-threads=1', {}, True),
            ('noisy_success', *captures['success'], 'cargo test --color never -- --test-threads=1', {}, True),
            ('noisy_failure', raw, code, 'cargo test --color never -- --test-threads=1', {}, True),
            ('unicode_failure', raw.replace('AGENTQ_BENCH_ERROR', 'AGENTQ_BENCH_ERROR ошибка 日本語'), code, 'cargo test --color never -- --test-threads=1', {}, True),
            ('short', 'one passed\n', 0, 'cargo test', {}, False),
            ('code', 'fn example() { /* retain source */ }\n' * 120, 0, 'cargo test', {}, False),
            ('json', json.dumps(dict(items=list(range(1000)))), 0, 'cargo test', {}, False),
            ('constraints', 'You must keep all 12 constraints and never drop a negative.\n' * 100, 0, 'cargo test', {}, False),
            ('unqualified', raw, code, 'cat source.rs', {}, False),
            ('disabled', raw, code, 'cargo test', dict(enabled=False), False),
            ('agent_disabled', raw, code, 'cargo test', dict(agents=dict(codex=False)), False),
            ('missing_exit', raw, None, 'cargo test', {}, False),
        ]
        for name, text, exit_code, command, config, smaller in cases:
            (lab / 'data/config.json').write_text(json.dumps(dict(compression=dict(stats='off', **config))))
            payload = dict(adapter='provider', tool='exec_command', command=command, text=text, exit_code=exit_code, session='benchmark', tool_call=name)
            started = time.monotonic()
            envelope_ok = True
            if name.startswith('hermes_'):
                namespace = {}
                plugin = (Path(__file__).resolve().parents[1] / 'integrations/hermes/__init__.py').read_text()
                exec(compile(plugin.replace('@AGENTQ_EXE@', repr(str(binary))), 'hermes-adapter', 'exec'), namespace)
                native = dict(output=text, exit_code=exit_code, opaque='preserved')
                with patch.dict(os.environ, AGENTQ_INSTALL=str(lab)):
                    transformed_result = namespace['transform'](tool_name='terminal', args=dict(command=command), result=json.dumps(native), session_id='benchmark', turn_id='turn', tool_call_id=name)
                wrapped = json.loads(transformed_result) if transformed_result else {}
                transformed = wrapped.get('output', '')
                envelope_ok = wrapped == dict(native, output=transformed)
                ref = re.search(r'\[AgentQ original ref: (rtk:[^;]+);', transformed)
                value = dict(text=transformed, ref=ref.group(1) if ref else None)
                returncode = 0 if transformed_result else 1
            else:
                proc = subprocess.run([str(binary), 'compress', 'codex'], input=json.dumps(payload), env=env, capture_output=True, text=True, timeout=10)
                value = json.loads(proc.stdout) if proc.returncode == 0 else {}
                transformed = value.get('text', '')
                returncode = proc.returncode
            recovery = None
            if smaller and value.get('ref'):
                request = dict(jsonrpc='2.0', id=1, method='tools/call', params=dict(name='get_original', arguments=dict(ref=value['ref'])))
                recovered = subprocess.run([str(binary), 'mcp', 'codex'], input=json.dumps(request)+'\n', env=env, capture_output=True, text=True, timeout=10)
                try:
                    recovery = json.loads(json.loads(recovered.stdout.splitlines()[0])['result']['content'][0]['text'])['content'] == text
                except (KeyError, ValueError, IndexError, TypeError):
                    recovery = False
            correct = (len(transformed.encode()) < len(text.encode()) and recovery is True) if smaller else transformed == text and value.get('ref') is None
            if smaller:
                correct &= ('180 passed' in transformed and 'FAIL' not in transformed and '1 failed' not in transformed) if exit_code == 0 else ('AGENTQ_BENCH_ERROR' in transformed and ('1 FAIL' in transformed or '1 failed' in transformed))
            report['results'].append(dict(scenario=name, result='pass' if returncode == 0 and correct and envelope_ok else 'fail', bytes_in=len(text.encode()), bytes_out=len(transformed.encode()), original_recovered=recovery, fixture_sha256=hashlib.sha256(text.encode()).hexdigest(), duration_ms=round(1000*(time.monotonic()-started))))
        exported = subprocess.run([str(binary), 'telemetry', 'export'], env=env, capture_output=True, text=True, timeout=10)
        rows = [json.loads(line) for line in exported.stdout.splitlines()] if exported.returncode == 0 else []
        records = [row['record'] for row in rows[1:] if row.get('kind') == 'stats']
        expected = {case[0] for case in cases}
        observed = {record.get('tool_call') for record in records if record.get('session') == 'benchmark'}
        report['local_telemetry'] = dict(result='pass' if rows and rows[0].get('schema') == 'agentq.telemetry/1'
                                       and rows[0].get('errors') == {} and len(records) == len(cases) and observed == expected else 'fail',
                                       records=len(records), missing_calls=sorted(expected-observed),
                                       retrieval_events=sum(row.get('kind') == 'event' and row.get('record', {}).get('name') == 'agentq.retrieval' for row in rows[1:]))
        report['binary_version'] = subprocess.run([str(binary), '--version'], capture_output=True, text=True, timeout=10).stdout.strip()
    report['result'] = 'pass' if all(r['result']=='pass' for r in report['results']) and report['local_telemetry']['result'] == 'pass' else 'fail'
    (output / 'report.json').write_text(json.dumps(report, indent=2)+'\n')
    for row in report['results']:
        print(f"{row['scenario']}: {row['result'].upper()} {row['bytes_in']} -> {row['bytes_out']} bytes")
    return 0 if report['result']=='pass' else 1


if __name__ == '__main__':
    raise SystemExit(main())
