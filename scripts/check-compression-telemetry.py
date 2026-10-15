#!/usr/bin/env python3
"""ACCOUNTING O4: native test evidence -> local core record -> delivered Langfuse observation.

Read existing exports only. No collector, credentials, network, settings writes or service restart.
"""
import argparse
import json
from pathlib import Path

FIELDS = ('schema', 'event_id', 'time', 'agent', 'adapter', 'tool', 'runner', 'engine',
          'engine_version', 'version', 'session', 'turn', 'tool_call', 'outcome', 'reason', 'bytes_in', 'bytes_out', 'ref')


def observations(value):
    if isinstance(value, list):
        return value
    if not isinstance(value, dict):
        raise ValueError('invalid observation export')
    if 'status' in value:
        if value['status'] != 200:
            raise ValueError('observation query did not return HTTP 200')
        value = value['body']
    rows = value.get('data')
    if not isinstance(rows, list):
        raise ValueError('missing observation data')
    if value.get('meta', {}).get('cursor'):
        raise ValueError('observation query is incomplete; more cursor pages exist')
    return rows


def record(observation):
    metadata = observation.get('metadata') or {}
    result = {}
    for key, value in metadata.items():
        if key.startswith('attributes.agentq.'):
            key = key.removeprefix('attributes.agentq.')
        elif key.startswith('agentq.'):
            key = key.removeprefix('agentq.')
        else:
            continue
        if value == 'null':
            value = None
        if key in ('schema', 'time', 'bytes_in', 'bytes_out') and isinstance(value, str):
            try: value = int(value)
            except ValueError: pass
        result[key] = value
    return result


def judge(local, rows, evidence):
    out = dict(compression='unknown', export='unknown', native_tool='unknown', usage_coverage='unknown',
               scope='one recorded native session; no fleet or whole-task savings claim', reasons=[])
    session, ref = evidence.get('session'), evidence.get('ref')
    if evidence.get('result') != 'pass' or not session or not ref:
        out['reasons'].append('native client/ref/original proof is incomplete')
        return out
    matched = [r for r in local if r.get('session') == session and r.get('ref') == ref]
    unique = {r.get('event_id'): r for r in matched}
    if len(unique) != 1 or any(r != unique.get(r.get('event_id')) for r in matched):
        out['reasons'].append('local event missing, ambiguous or conflicting')
        return out
    expected = next(iter(unique.values()))
    if expected.get('agent') != evidence.get('client') or expected.get('adapter') != {'codex': 'provider', 'claude': 'run'}.get(evidence.get('client')):
        out['reasons'].append('client or adapter differs from native test'); return out
    size_in, size_out = expected.get('bytes_in'), expected.get('bytes_out')
    if not (type(size_in) is int and type(size_out) is int and 0 <= size_out < size_in):
        out['compression'] = 'fail'; out['reasons'].append('invalid or non-reducing byte pair'); return out
    exported = [r for r in rows if r.get('name') == 'agentq.compress' and record(r).get('event_id') == expected.get('event_id')]
    if not exported:
        out['reasons'].append('compression event not read back centrally; delivery is unproved')
        return out
    if any(r.get('traceId') != expected.get('event_id') or any(record(r).get(k) != expected.get(k) for k in FIELDS) for r in exported):
        out['export'] = 'fail'; out['reasons'].append('delivered event differs from local producer record'); return out
    out.update(export='pass', event_id=expected['event_id'], session=session, bytes_in=size_in, bytes_out=size_out)
    out['identity'] = 'unknown'
    if all(evidence.get(k) for k in ('installation', 'runtime')):
        out['identity'] = 'pass' if all(record(r).get(k) == evidence[k] for r in exported for k in ('installation', 'runtime')) else 'fail'
    if out['identity'] != 'pass':
        out['reasons'].append('installation/runtime identity missing or mismatched')
    tools = [r for r in rows if r.get('sessionId') == session and (r.get('metadata') or {}).get('tool_id') == expected.get('tool_call')]
    if tools and expected.get('tool_call'):
        out['native_tool'] = 'pass'
    else:
        out['reasons'].append('native tool observation missing for the same session and tool-call ID')
    if (expected.get('outcome') == 'compressed' and expected.get('reason') == 'compressed'
            and evidence.get('original_recovered') is True and evidence.get('model_saw_reference') is True
            and out['native_tool'] == 'pass'):
        out['compression'] = 'pass'
    else:
        out['reasons'].append('native execution, model visibility or exact original recovery unproved')
    # Check a non-overlapping category only; input/cache semantics need their exporter-specific mapping.
    expected_usage = evidence.get('observed_usage') or {}
    output_tokens = expected_usage.get('output_tokens')
    generations = [r for r in rows if r.get('sessionId') == session and r.get('type') == 'GENERATION']
    if any(not isinstance(r.get('id'), str) or not r['id'] or not isinstance(r.get('traceId'), str) or not r['traceId'] for r in generations):
        out['reasons'].append('generation identity unavailable'); return out
    values = [(r.get('usageDetails') or {}).get('output') for r in generations]
    if type(output_tokens) is int and output_tokens >= 0 and values and all(type(v) is int and v >= 0 for v in values):
        # Duplicate deliveries of one observation never contribute twice.
        unique_usage = {}
        for row, value in zip(generations, values):
            key = (row.get('traceId'), row.get('id'))
            if key in unique_usage and unique_usage[key] != value:
                out['usage_coverage'] = 'fail'; out['reasons'].append('conflicting generation usage'); return out
            unique_usage[key] = value
        actual = sum(unique_usage.values())
        out['usage_output'] = dict(native=output_tokens, exported=actual)
        out['usage_coverage'] = 'pass' if actual == output_tokens else 'fail'
        if actual != output_tokens:
            out['reasons'].append('native output-token total and delivered generations disagree')
    else:
        out['reasons'].append('native/exported usage unavailable; token/cost effect remains unknown')
    out['observed_input_cache_coverage'] = 'unknown: exporter-specific input/cache mapping not qualified here'
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--local', type=Path, required=True, help='existing checker *-new-records.json')
    parser.add_argument('--observations', type=Path, nargs='+', required=True, help='complete Langfuse CLI observation exports')
    parser.add_argument('--evidence', type=Path, required=True, help='one native result from check-client-compression.py')
    args = parser.parse_args()
    try:
        if any(path.stat().st_size > 16 * 1024 * 1024 for path in [args.local, args.evidence, *args.observations]):
            raise ValueError('export exceeds qualification read bound')
        rows = [row for path in args.observations for row in observations(json.loads(path.read_text()))]
        result = judge(json.loads(args.local.read_text()), rows, json.loads(args.evidence.read_text()))
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        result = dict(compression='unknown', export='unknown', usage_coverage='unknown', reason=type(exc).__name__)
    print(json.dumps(result, indent=2))
    return 0 if result.get('compression') == 'pass' and result.get('usage_coverage') == 'pass' and result.get('identity') == 'pass' else 1


if __name__ == '__main__':
    raise SystemExit(main())
