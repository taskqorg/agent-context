"""Compare saved cloud credentials through the existing provider boundary. Never print keys."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import statistics
import subprocess
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def git_fixtures(lab):
    repo = lab / 'git-history'
    repo.mkdir(exist_ok=True)
    run = lambda *args: subprocess.run(['git', *args], cwd=repo, check=True, text=True, capture_output=True)
    if not (repo / '.git').exists():
        run('init', '-q')
        for n in range(30):
            run('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit',
                '--allow-empty', '-q', '-m', f'fix: preserve command evidence item {n}; port=6543 retry=2 release=amber-47')
    text = run('log', '--oneline', '-n', '30').stdout
    assert len(text.splitlines()) == 30 and len(text) > 2048
    hook = re.search(r"query: '([^']+)'", (ROOT / 'src/hooks.js').read_text())[1]
    rows = []
    for name, query in [('git-log-full', 'Return all requested git history. Preserve every commit hash and full subject.'),
                        ('git-log-hook-policy', hook)]:
        path = lab / 'corpus' / (name + '.txt')
        path.write_text(text)
        rows.append(dict(id=name, path=str(path), query=query, needles=text.splitlines(),
                         kind='git', filter='git-log', provenance='actual git log from isolated 30-commit fixture repository'))
    return rows

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--lab', required=True)
    p.add_argument('--output', required=True)
    args = p.parse_args()
    lab = Path(args.lab).resolve()
    sys.path.insert(0, str(ROOT / 'integrations/headroom'))
    from agent_context_headroom import providers, provider_supercompress
    import tiktoken
    encoder = tiktoken.get_encoding('o200k_base')
    count = lambda text: len(encoder.encode(text))
    # Use canonical saved credentials in memory; no copy into the isolated lab.
    os.environ.pop('AGENT_CONTEXT_HOME', None)
    for name, variable in [('supercompress', 'SUPERCOMPRESS_API_KEY'), ('scaledown', 'SCALEDOWN_API_KEY')]:
        key = providers.credentials(name)
        if key: os.environ[variable] = key
    os.environ.update(AGENT_CONTEXT_HOME=str(lab), AGENT_CONTEXT_COMPRESSOR='headroom-local')
    fixtures = json.loads((lab / 'corpus.json').read_text()) + git_fixtures(lab)
    helpers = runpy.run_path(str(ROOT / 'scripts/context-options-benchmark.py'))
    helpers['self_check']()
    variants = [('supercompress-neural', 'supercompress', 'neural'),
                ('supercompress-compiler', 'supercompress', 'compiler'),
                ('scaledown-0.5', 'scaledown', 0.5), ('scaledown-auto', 'scaledown', 'auto')]
    rows = []
    def record(variant, f, output, ms, outcome, raw=None, meta=None):
        original = Path(f['path']).read_text()
        def evidence(text): return all(n in text for n in f['needles'])
        row = dict(variant=variant, fixture=f['id'], input_tokens=count(original), output_tokens=count(output),
                   elapsed_ms=round(ms, 2), outcome=outcome, evidence_ok=evidence(output),
                   missing_count=sum(n not in output for n in f['needles']),
                   envelope_ok=all(helpers['replace'](helpers['replace'](e, output), original) == e
                                   for e in helpers['envelopes'](original)))
        if raw is not None: row.update(raw_tokens=count(raw), raw_evidence_ok=evidence(raw), raw_same_as_input=raw == original)
        if f['kind'] == 'json':
            try: row['valid_json'] = json.loads(output) == json.loads(original)
            except ValueError: row['valid_json'] = False
        if meta: row.update(meta)
        rows.append(row)
        (lab / 'outputs' / f'{variant}-{f["id"]}-{len(rows)}.txt').write_text(output)
    for variant, provider, mode in variants:
        consecutive = 0
        stopped = False
        for f in fixtures:
            original = Path(f['path']).read_text()
            for repeat in range(3):
                if stopped:
                    rows.append(dict(variant=variant, fixture=f['id'], outcome='not_run_after_repeated_failure'))
                    continue
                captured = {}
                def send(url, key, payload, timeout):
                    if provider == 'scaledown': payload = dict(payload, scaledown={'rate': mode})
                    data = providers.post(url, key, payload, timeout)
                    result = data.get('results', {})
                    raw = result.get('compressed_prompt') if provider == 'scaledown' else data.get('compressed_text')
                    captured.update(raw=raw, response_mode=data.get('mode'), policy_name=data.get('policy_name'),
                        service_input_tokens=data.get('total_original_tokens', data.get('original_tokens')),
                        service_output_tokens=data.get('total_compressed_tokens', data.get('kept_tokens')),
                        returned_query_unchanged=result.get('original_prompt') == f['query'] if provider == 'scaledown' else None)
                    return data
                def compiler(context, query, *, post, key, timeout):
                    data = post('https://www.supercompress.dev/api/v1/compress', key,
                                {'context': context, 'query': query}, timeout)
                    policy = str(data.get('policy_name', '')).lower().replace('-', ' ')
                    if data.get('mode') not in (None, 'compiler') or policy != 'supercompress compiler':
                        raise ValueError('invalid_response')
                    return data.get('compressed_text')
                with patch.object(provider_supercompress, 'compress', compiler if mode == 'compiler' else provider_supercompress.compress):
                    r = providers.compress_context(original, f['query'], provider=provider, timeout=10, send=send)
                output = r.pop('compressed_text')
                raw = captured.pop('raw', None)
                record(variant, f, output, r['elapsed_ms'], r['outcome'], raw, captured)
                print(json.dumps({'variant': variant, 'fixture': f['id'], 'outcome': r['outcome'], 'ms': r['elapsed_ms']}), flush=True)
                failed = r['outcome'] not in ('compressed', 'no_gain')
                consecutive = consecutive + 1 if failed else 0
                if consecutive >= 2: stopped = True
    # Same new Git payloads through local candidates; previous seven cases remain frozen.
    env = dict(os.environ, RTK_TELEMETRY_DISABLED='1', RTK_SUPPRESS_HOOK_WARNING='1',
               RTK_DB_PATH=str(lab / 'rtk.db'), RTK_RECALL_DB=str(lab / 'rtk-recall.db'))
    for f in fixtures[-2:]:
        original = Path(f['path']).read_text()
        for repeat in range(3):
            r = providers.compress_context(original, f['query'], provider='headroom-local')
            record('headroom', f, r['compressed_text'], r['elapsed_ms'], r['outcome'])
            r, ms = helpers['execute']([str(lab / 'rtk/rtk'), 'pipe', '-f', 'git-log'], text=original, cwd=lab, env=env)
            record('rtk', f, r.stdout if r.returncode == 0 else original, ms, 'filtered' if r.returncode == 0 else 'filter_error')
            r, ms = helpers['execute']([str(lab / 'rtk/rtk'), 'git', 'log', '--oneline', '-n', '30'],
                                      cwd=lab / 'git-history', env=env)
            record('rtk-native', f, r.stdout if r.returncode == 0 else original, ms,
                   'native_command' if r.returncode == 0 else 'command_error')
    (lab / 'git-corpus.json').write_text(json.dumps(fixtures[-2:]))
    cm, _ = helpers['execute'](['node', str(ROOT / 'scripts/context-options-mcp.mjs'),
        str(lab / 'context-mode/node_modules/context-mode'), str(lab / 'git-corpus.json'),
        str(lab / 'cloud-git-context-mode-state')], cwd=lab)
    if cm.returncode: raise RuntimeError('context-mode Git replay failed')
    for r in json.loads(cm.stdout)['results']:
        f = next(f for f in fixtures if f['id'] == r['fixture'])
        record('context-mode', f, r['output'], r['elapsed_ms'], 'sandbox_recipe', meta={'recovery_ok': r['recovery_ok']})
    summaries = []
    for variant, _, _ in variants:
        a = [r for r in rows if r['variant'] == variant and 'input_tokens' in r]
        summaries.append(dict(variant=variant, attempts=len(a), planned=3*len(fixtures),
            reduction_pct=round(100*(1-sum(r['output_tokens'] for r in a)/sum(r['input_tokens'] for r in a)), 2),
            p50_ms=round(statistics.median(r['elapsed_ms'] for r in a),2),
            failures=sum(r['outcome'] not in ('compressed','no_gain') for r in a),
            evidence_failures=sum(not r['evidence_ok'] for r in a)))
    report = dict(scope='same wrapper; safe frozen corpus; actual cloud API calls; not model quality or subscription savings',
        timeout_seconds=10, tokenizer='o200k_base', repeats=3, credentials='canonical saved source; values never copied or printed',
        corpus=[dict(id=f['id'],query=f['query'],kind=f['kind'],input_sha256=hashlib.sha256(Path(f['path']).read_bytes()).hexdigest()) for f in fixtures],
        summaries=summaries, rows=rows)
    Path(args.output).write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(summaries),flush=True)

if __name__ == '__main__': main()
