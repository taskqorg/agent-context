"""Same synthetic inputs for every provider. No model calls or customer context."""
import argparse
import json
from .providers import PROVIDERS, compress_context

def fixtures():
    noise = '\n'.join(f'INFO background worker {i}: no change, heartbeat accepted' for i in range(120))
    return [
        ('logs', noise + '\nERROR E42: release amber-47 uses port 6543; retry limit 2\n' + noise,
         'Find the exact error, release, port and retry limit', ['ERROR E42', 'amber-47', '6543', 'limit 2']),
        ('code', noise + '\ndef connect():\n    port = 6543\n    retries = 2\n    return port, retries\n',
         'Preserve the connect function, its port and retries', ['def connect()', '6543', 'retries = 2']),
        ('dense', 'Release amber-47 uses port 6543. Retry limit is 2. Do not restart production.',
         'State all release settings and the restriction', ['amber-47', '6543', '2', 'Do not restart production']),
        ('json', json.dumps({'release': 'amber-47', 'port': 6543, 'retry_limit': 2,
                             'noise': [f'heartbeat {i}' for i in range(120)]}),
         'Find release amber-47, port 6543 and retry_limit 2', ['amber-47', '6543', 'retry_limit']),
    ]

def benchmark(names, run=compress_context):
    import tiktoken
    encoder = tiktoken.get_encoding('o200k_base')
    rows = []
    for name in names:
        for label, context, query, needles in fixtures():
            result = run(context, query, provider=name)
            text = result.pop('compressed_text')
            rows.append(dict(result, fixture=label, input_tokens=len(encoder.encode(context)),
                             output_tokens=len(encoder.encode(text)),
                             evidence_preserved=all(needle in text for needle in needles)))
    return {'measurement': 'provider_only_not_model_quality_or_subscription_savings',
            'tokenizer': 'o200k_base', 'rows': rows}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--provider', choices=[*PROVIDERS, 'all'], default='all')
    args = parser.parse_args()
    print(json.dumps(benchmark(list(PROVIDERS) if args.provider == 'all' else [args.provider])))
