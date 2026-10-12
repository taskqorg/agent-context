"""Small local qualification: real command output, observed client envelopes, no model calls."""
import argparse
import copy
import hashlib
import json
import os
import re
from pathlib import Path
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]

def execute(argv, *, text=None, cwd=None, env=None):
    start = time.perf_counter()
    r = subprocess.run(argv, input=text, text=True, capture_output=True, cwd=cwd,
                       env=env, timeout=60)
    return r, (time.perf_counter() - start) * 1000

def envelopes(text):
    return [
        {'type': 'function_call_output', 'call_id': 'probe-1', 'output': text},
        {'type': 'custom_tool_call_output', 'call_id': 'probe-1', 'output': text},
        {'type': 'tool_result', 'tool_use_id': 'probe-1', 'content': text, 'is_error': False},
        {'hook_event_name': 'PostToolUse', 'tool_name': 'Bash', 'session_id': 'probe-session',
         'tool_response': {'stdout': text, 'stderr': 'preserve stderr', 'exitCode': 7}},
    ]

def replace(envelope, text):
    r = copy.deepcopy(envelope)
    if 'tool_response' in r:
        r['tool_response']['stdout'] = text
    else:
        r['output' if 'output' in r else 'content'] = text
    return r

def self_check():
    for e in envelopes('original'):
        assert replace(replace(e, 'compressed'), 'original') == e
        assert e == replace(e, 'original')
    assert all(x in 'ERROR E42 retries=3' for x in ['ERROR E42', 'retries=3'])

def corpus(lab, claude_original):
    fixtures = []
    def add(id, text, query, needles, kind, filter=None, provenance='real repository content'):
        assert all(n in text for n in needles), 'invalid evidence checklist: ' + id
        path = lab / 'corpus' / (id + '.txt')
        path.write_text(text)
        fixtures.append(dict(id=id, path=str(path), query=query, needles=needles,
                             kind=kind, filter=filter, provenance=provenance,
                             input_sha256=hashlib.sha256(text.encode()).hexdigest()))
    (lab / 'corpus').mkdir(exist_ok=True)
    log = Path(claude_original).read_text() if claude_original else (
        '\n'.join(f'INFO heartbeat worker=7 ok tick={i}' for i in range(400)) +
        '\nERROR E42 db.internal:5432 retries=3 release=1.2.3')
    add('claude-bash-log', log, 'ERROR E42 database address retries release',
        ['ERROR E42', 'db.internal:5432', 'retries=3', 'release=1.2.3'], 'log', 'log',
        'actual Claude Desktop pre-hook output' if claude_original else 'reproduction of live Claude fixture')
    # Real pytest output from a tiny isolated project, including a deliberate failing test.
    testfile = lab / 'test_probe.py'
    testfile.write_text('import pytest\n@pytest.mark.parametrize("n", range(40))\n'
                        'def test_ok(n): assert n >= 0\n'
                        'def test_retry():\n    retries = 3\n    assert retries == 2, "ERROR E42 retries=3 expected=2"\n')
    pytest, _ = execute([sys.executable, '-m', 'pytest', '-v', str(testfile)], cwd=lab)
    if pytest.returncode != 1 or '40 passed' not in pytest.stdout:
        raise RuntimeError('isolated pytest fixture failed to generate expected output')
    add('codex-test-failure', pytest.stdout + pytest.stderr, 'test_retry ERROR E42 retries=3 expected=2',
        ['test_retry', 'ERROR E42 retries=3 expected=2', '1 failed', '40 passed'], 'test', 'pytest', 'actual isolated pytest output')
    add('codex-code-read', (ROOT / 'src/local-compression.js').read_text(),
        'compressLocal stdout JSON parse error handling timeout maxBuffer critical evidence',
        ['export async function compressLocal', 'timeout: 10000', 'maxBuffer: 1024 * 1024',
         'JSON.parse(stdout)', 'reject(parseError)', 'lost_critical_evidence'], 'code')
    add('codex-json-read', (ROOT / 'package.json').read_text(), 'version scripts engines dependencies',
        ['"0.4.0"', '"node": ">=22"', '"prepack"', '"smol-toml"'], 'json')
    search, _ = execute(['rg', '-n', 'timeout|critical|compressed_text', 'src/local-compression.js'], cwd=ROOT)
    add('codex-search', search.stdout, 'timeout critical compressed_text',
        ['timeout: 10000', 'lost_critical_evidence', 'compressed_text'], 'search', 'grep', 'actual rg output')
    add('claude-doc-read', (ROOT / 'docs/spec/PRODUCT.md').read_text(), 'normal login subscription permissions hook trust',
        ['Keep normal login, subscription, model selection, permissions and hook trust.'], 'docs')
    add('dense-protected', 'Release amber-47 uses port 6543. Retry limit is 2. Do not restart production.',
        'release port retry restriction', ['amber-47', '6543', 'limit is 2', 'Do not restart production'], 'dense',
        provenance='synthetic safety control')
    (lab / 'corpus.json').write_text(json.dumps(fixtures))
    return fixtures

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--lab', required=True)
    p.add_argument('--claude-original')
    p.add_argument('--output', required=True)
    p.add_argument('--boost-container', action='store_true')
    p.add_argument('--accept-boost-preview', action='store_true')
    args = p.parse_args()
    self_check()
    import tiktoken
    sys.path.insert(0, str(ROOT / 'integrations/headroom'))
    from agent_context_headroom.providers import compress_context
    encoder = tiktoken.get_encoding('o200k_base')
    tokens = lambda s: len(encoder.encode(s))
    lab = Path(args.lab).resolve()
    lab.mkdir(exist_ok=True)
    fixtures = corpus(lab, args.claude_original)
    env = {k: os.environ[k] for k in ['PATH', 'TMPDIR'] if k in os.environ}
    env.update(RTK_TELEMETRY_DISABLED='1', RTK_SUPPRESS_HOOK_WARNING='1',
               RTK_DB_PATH=str(lab / 'rtk.db'), RTK_RECALL_DB=str(lab / 'rtk-recall.db'),
               XDG_CONFIG_HOME=str(lab / 'config'), RTK_TEE_DIR=str(lab / 'tee'),
               AGENT_CONTEXT_HOME=str(lab), HF_HUB_OFFLINE='1', HEADROOM_OFFLINE='1')
    os.environ['AGENT_CONTEXT_HOME'] = str(lab)
    os.environ['AGENT_CONTEXT_COMPRESSOR'] = 'headroom-local'
    rows = []
    def record(name, f, output, ms, outcome, recovery, extra=None):
        original = Path(f['path']).read_text()
        envelope_ok = all(replace(replace(e, output), original) == e for e in envelopes(original))
        row = dict(variant=name, fixture=f['id'], input_tokens=tokens(original), output_tokens=tokens(output),
                   elapsed_ms=round(ms, 2), outcome=outcome,
                   evidence_preserved=all(n in output for n in f['needles']),
                   missing=[n for n in f['needles'] if n not in output],
                   envelope_roundtrip=envelope_ok, recovery_ok=recovery)
        if extra: row.update(extra)
        if f['kind'] == 'json':
            # Only a JSON-preserving transform passes this representation check.
            # MCP replies wrap data in text; validate the returned document, not that wrapper.
            document = output
            if name == 'context-mode':
                marker = '```\n\n'
                document = output.split(marker, 1)[-1].strip()
            try:
                parsed = json.loads(document)
                row['valid_json'] = all(parsed.get(k) == json.loads(original)[k]
                                        for k in ['version', 'engines', 'scripts', 'dependencies'])
            except (ValueError, AttributeError):
                row['valid_json'] = False
        rows.append(row)
        # Outputs remain isolated: publish metadata only.
        dest = lab / 'outputs' / (name + '-' + f['id'] + '-' + str(len(rows)) + '.txt')
        dest.parent.mkdir(exist_ok=True)
        dest.write_text(output)
    for f in fixtures:
        original = Path(f['path']).read_text()
        for repeat in range(3):
            record('baseline', f, original, 0, 'unchanged', True)
            result = compress_context(original, f['query'], provider='headroom-local')
            record('headroom', f, result['compressed_text'], result['elapsed_ms'], result['outcome'],
                   Path(f['path']).read_text() == original)
            if f['filter']:
                r, ms = execute([str(lab / 'rtk/rtk'), 'pipe', '-f', f['filter']], text=original, cwd=lab, env=env)
                output = r.stdout if r.returncode == 0 and r.stdout.strip() else original
                record('rtk', f, output, ms, 'filtered' if r.returncode == 0 else 'filter_error',
                       False, {'provider_exit_code': r.returncode})
            else:
                record('rtk', f, original, 0, 'unsupported_passthrough', True)
    cm, _ = execute(['node', str(ROOT / 'scripts/context-options-mcp.mjs'),
                      str(lab / 'context-mode/node_modules/context-mode'), str(lab / 'corpus.json'),
                      str(lab / ('context-mode-state-' + str(time.time_ns())))], cwd=lab, env=env)
    if cm.returncode:
        raise RuntimeError('context-mode probe failed: ' + cm.stderr[-1000:])
    data = json.loads(cm.stdout)
    by_id = {f['id']: f for f in fixtures}
    for row in data['results']:
        record('context-mode', by_id[row['fixture']], row['output'], row['elapsed_ms'],
               'tool_error' if row['error'] else 'sandbox_recipe', row['recovery_ok'],
               {'request_tokens': tokens(row['request_text']), 'recovery_response_tokens': tokens(row['recovery_response'])})
    if args.boost_container:
        if not args.accept_boost_preview:
            p.error('--boost-container requires explicit --accept-boost-preview')
        (lab / '.boost').mkdir(exist_ok=True)
        (lab / '.boost/config.toml').write_text('accept_terms = "yes"\n[tracing]\nreport = false\nupload = false\n[update]\nauto_update = false\n')
        started, _ = execute(['docker', 'run', '-d', '--rm', '--network', 'none', '--read-only',
            '--tmpfs', '/tmp', '--tmpfs', '/root/.local',
            '--mount', f'type=bind,src={lab},dst=/lab',
            '--mount', f'type=bind,src={lab}/.boost,dst=/root/.boost', '--workdir', '/lab',
            '--env', 'BOOST_AUTO_UPDATE=false', '--env', 'BOOST_DB_PATH=/tmp/boost.db',
            '--env', 'BOOST_FEATURE_FLAGS_FORCE_ENABLED=boost-cli-filtering',
            'ubuntu:24.04', 'sleep', '300'])
        if started.returncode: raise RuntimeError('isolated Boost container failed to start')
        container = started.stdout.strip()
        try:
            for f in fixtures:
                original = Path(f['path']).read_text()
                for repeat in range(3):
                    # Current official recipe is a suffix pipe, NOT `boost pytest`.
                    r, ms = execute(['docker', 'exec', '-i', container, '/lab/boost-linux/boost'], text=original)
                    output = r.stdout if r.returncode == 0 and r.stdout.strip() else original
                    pointer = re.search(r'boost retrieve (\d+)', output)
                    recovered = False
                    if pointer:
                        raw, _ = execute(['docker', 'exec', container, '/lab/boost-linux/boost', 'retrieve', pointer[1]])
                        recovered = raw.returncode == 0 and raw.stdout == original
                    record('boost', f, output, ms, 'provider_error' if r.returncode else ('suffix_filtered' if pointer else 'passthrough'),
                           recovered or output == original,
                           {'provider_exit_code': r.returncode, 'latency_scope': 'docker exec + Linux CLI'})
        finally:
            execute(['docker', 'stop', container])
    summaries = []
    for name in ['baseline', 'headroom', 'rtk', 'context-mode'] + (['boost'] if args.boost_container else []):
        selected = [r for r in rows if r['variant'] == name]
        before, after = sum(r['input_tokens'] for r in selected), sum(r['output_tokens'] for r in selected)
        summaries.append(dict(variant=name, reduction_pct=round(100*(1-after/before), 1),
                              p50_active_ms=round(statistics.median(r['elapsed_ms'] for r in selected if r['elapsed_ms'] > 0), 2) if name != 'baseline' else 0,
                              evidence_failures=sum(not r['evidence_preserved'] for r in selected),
                              envelope_failures=sum(not r['envelope_roundtrip'] for r in selected)))
    report = dict(scope='local replay; not downstream quality, subscription savings, native hook qualification or OS qualification',
                  tokenizer='o200k_base estimate for both clients; not measured Claude token usage', repeats=3,
                  versions={'headroom-ai': '0.40.0', 'rtk': '0.51.0', 'context-mode': '1.0.169', 'boost': '0.15.4'},
                  corpus=[{k: v for k,v in f.items() if k != 'path'} for f in fixtures],
                  context_mode_startup_ms=round(data['startup_ms'], 2),
                  context_mode_all_tool_schema_tokens=tokens(data['tool_schema']),
                  boost_feature_override='boost-cli-filtering enabled locally; offline default was disabled' if args.boost_container else None,
                  recovery_notes={'headroom': 'original retained by replay harness; no native retrieval qualification',
                                  'rtk': 'pipe filter native recall not wired; original retained by replay harness',
                                  'boost': 'native retrieve pointer; exact comparison can fail on built-in path redaction; network-disabled Linux container',
                                  'context-mode': 'original returned in bounded chunks through ctx_execute_file'},
                  blocked={'boost': None if args.boost_container else 'not included; needs explicit preview acceptance and isolated container',
                           'token-optimizer': 'not installed; broad overlapping hooks excluded from first small trial'},
                  summaries=summaries, rows=rows)
    Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(summaries))

if __name__ == '__main__':
    main()
