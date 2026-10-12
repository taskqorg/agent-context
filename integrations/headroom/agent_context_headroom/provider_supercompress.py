"""Hosted Neural v2, never silently substituted with the compiler engine."""
def compress(context, query, *, post, key, timeout):
    data = post('https://www.supercompress.dev/api/v1/compress', key,
                {'context': context, 'query': query, 'mode': 'neural'}, timeout)
    if data.get('neural_keep_fallback') is True or data.get('mode') not in {'neural', 'neural-keep'}:
        raise ValueError('neural_unavailable')
    return data.get('compressed_text', data.get('compressed_context', data.get('compressed')))
