"""ScaleDown hosted API; the user query must remain untouched."""
import math
import os

def compress(context, query, *, post, key, timeout):
    rate = os.environ.get('SCALEDOWN_COMPRESS_RATE', 'auto')
    if rate != 'auto':
        value = float(rate)
        if not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError('invalid_response')
    data = post('https://api.scaledown.xyz/compress/raw/', key,
                {'context': context, 'prompt': query, 'scaledown': {'rate': rate}}, timeout)
    result = data.get('results', {})
    if data.get('successful') is not True or result.get('original_prompt') != query:
        raise ValueError('invalid_response')
    return result.get('compressed_prompt')
