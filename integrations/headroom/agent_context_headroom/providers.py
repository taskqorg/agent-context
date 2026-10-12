"""Shared boundary for three compressors. No agent config or transport here."""
import json
import os
from pathlib import Path
import re
import socket
import ssl
import time
from urllib import request, error
from . import provider_headroom, provider_supercompress, provider_scaledown

PROVIDERS = {'local-tools': None, 'headroom-local': provider_headroom, 'supercompress': provider_supercompress,
             'scaledown': provider_scaledown}
HOME = lambda: Path(os.environ.get('AGENT_CONTEXT_HOME') or Path.home())

def settings():
    file = HOME() / '.agent-context/compression.json'
    config = json.loads(file.read_text(encoding='utf-8')) if file.exists() else {}
    name = os.environ.get('AGENT_CONTEXT_COMPRESSOR', config.get('provider', 'local-tools'))
    timeout = config.get('timeout_seconds', 10)
    if name not in PROVIDERS or type(timeout) not in (int, float) or not 0.1 <= timeout <= 30:
        raise ValueError('invalid_provider_config')
    return name, timeout

def provider_name():
    return settings()[0]

def credentials(name):
    if name in {'headroom-local', 'local-tools'}:
        return ''
    variable = 'SUPERCOMPRESS_API_KEY' if name == 'supercompress' else 'SCALEDOWN_API_KEY'
    if os.environ.get(variable):
        return os.environ[variable]
    if name == 'supercompress':
        file = HOME() / '.supercompress/config.json'
        return json.loads(file.read_text(encoding='utf-8')).get('api_key', '') if file.exists() else ''
    file = HOME() / '.agent-context/scaledown/api-key'
    return file.read_text(encoding='utf-8').strip() if file.exists() else ''

class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def post(url, key, payload, timeout):
    import certifi
    opener = request.build_opener(NoRedirect(), request.HTTPSHandler(
        context=ssl.create_default_context(cafile=certifi.where())))
    req = request.Request(url, data=json.dumps(payload).encode('utf-8'),
                          headers={'Content-Type': 'application/json', 'X-API-Key': key})
    with opener.open(req, timeout=timeout) as response:
        body = response.read(1_000_001)
    if len(body) > 1_000_000:
        raise ValueError('response_too_large')
    data = json.loads(body)
    if not isinstance(data, dict):
        raise ValueError('invalid_response')
    return data

def compress_context(context, query, *, provider=None, timeout=None, send=post):
    if not isinstance(context, str) or not isinstance(query, str) or not query.strip():
        raise ValueError('context_and_query_required')
    configured, default_timeout = settings()
    name = provider or configured
    limit = default_timeout if timeout is None else timeout
    if name not in PROVIDERS or type(limit) not in (int, float) or not 0.1 <= limit <= 30:
        raise ValueError('invalid_provider_config')
    started = time.monotonic()
    def result(text, outcome):
        return {'compressed_text': text, 'provider': name, 'outcome': outcome,
                'input_chars': len(context), 'output_chars': len(text),
                'elapsed_ms': round((time.monotonic() - started) * 1000, 2)}
    if not context.strip():
        return result(context, 'empty')
    if len(context.encode('utf-8')) > 400_000:
        return result(context, 'too_large')
    if name == 'local-tools':
        return result(context, 'ineligible')
    try:
        key = credentials(name)
        if name != 'headroom-local' and not key:
            return result(context, 'missing_key')
        text = PROVIDERS[name].compress(context, query, post=send, key=key, timeout=limit)
        if not isinstance(text, str) or not text.strip():
            return result(context, 'invalid_response')
        critical = [line for line in context.splitlines() if re.match(r'^\s*(ERROR|FATAL|Traceback)\b', line)]
        if any(line not in text for line in critical):
            return result(context, 'lost_critical_evidence')
        return result(text, 'compressed') if len(text) < len(context) else result(context, 'no_gain')
    except error.HTTPError as exc:
        return result(context, 'http_' + str(exc.code))
    except (TimeoutError, socket.timeout):
        return result(context, 'timeout')
    except ValueError as exc:
        reason = str(exc)
        return result(context, reason if reason in {'neural_unavailable', 'invalid_response', 'response_too_large'} else 'invalid_response')
    except Exception:
        return result(context, 'provider_unavailable')
