"""Private durable OTLP outbox; the agent's model traffic never enters the team gateway."""
import asyncio
import base64
from contextlib import asynccontextmanager
import gzip
import hmac
import json
import os
from pathlib import Path
import uuid
from urllib.parse import urlparse

import httpx
from fastapi import Request
from starlette.responses import JSONResponse, Response

MAX_BODY = 4 * 1024 * 1024
MAX_QUEUE = 20 * 1024 * 1024


def device_config():
    home = Path(os.environ.get('AGENT_CONTEXT_HOME') or str(Path.home()))
    value = json.loads((home / '.agent-context/enrollment.json').read_text())
    import re
    url = urlparse(value['gateway'])
    if url.scheme != 'https' or url.username or url.password or url.path.rstrip('/') not in ('', '/api/public/agent-context') or url.query or url.fragment:
        raise ValueError('Invalid gateway')
    if not re.fullmatch(r'[a-f0-9]{32}', value['device']) or not re.fullmatch(r'acd_[a-f0-9]{64}', value['token']):
        raise ValueError('Invalid device')
    return home, value


def decode_otlp(data, content_type, encoding):
    if encoding == 'gzip':
        import io
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as source:
            data = source.read(MAX_BODY + 1)
    elif encoding:
        raise ValueError('Unsupported encoding')
    if len(data) > MAX_BODY:
        raise ValueError('Body too large')
    if content_type.split(';')[0] == 'application/x-protobuf':
        from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
        from google.protobuf.json_format import MessageToDict
        message = ExportTraceServiceRequest()
        message.ParseFromString(data)
        value = MessageToDict(message, use_integers_for_enums=True)
        # protobuf JSON defaults byte IDs to base64; OTLP/JSON requires hexadecimal IDs.
        for resource in value.get('resourceSpans', []):
            for scope in resource.get('scopeSpans', []):
                for span in scope.get('spans', []):
                    for item in [span, *span.get('links', [])]:
                        for field in ('traceId', 'spanId', 'parentSpanId'):
                            if field in item:
                                item[field] = base64.b64decode(item[field], validate=True).hex()
                    span.setdefault('attributes', [])
    elif content_type.split(';')[0] == 'application/json':
        value = json.loads(data)
    else:
        raise ValueError('Unsupported OTLP format')
    if not isinstance(value, dict) or not isinstance(value.get('resourceSpans'), list):
        raise ValueError('Invalid OTLP')
    return json.dumps(value, separators=(',', ':')).encode()


def enqueue(directory, data):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    if len(data) > MAX_BODY or sum(p.stat().st_size for p in directory.glob('*.json') if not p.is_symlink()) + len(data) > MAX_QUEUE:
        raise ValueError('Outbox full')
    target = directory / (uuid.uuid4().hex + '.json')
    if os.name == 'nt':
        import shutil
        import subprocess
        home = Path(os.environ.get('AGENT_CONTEXT_HOME') or str(Path.home()))
        node = os.environ.get('AGENT_CONTEXT_NODE') or shutil.which('node')
        if not node:
            raise ValueError('Private Windows outbox writer unavailable')
        subprocess.run([node, str(home / '.agent-context/launcher.mjs'), 'telemetry', 'enqueue', str(target)], input=data, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12, check=True)
        return
    temporary = target.with_suffix('.tmp')
    try:
        with temporary.open('xb') as out:
            os.chmod(temporary, 0o600)
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def label_payload(data):
    value = json.loads(data)
    labels = {'agent': os.environ.get('AGENT_CONTEXT_AGENT', 'unknown'), 'host': os.environ.get('AGENT_CONTEXT_HOST', 'unknown'), 'runtime': os.environ.get('AGENT_CONTEXT_RUNTIME', 'native')}
    for resource in value['resourceSpans']:
        for scope in resource.get('scopeSpans', []):
            for span in scope.get('spans', []):
                attrs = span.setdefault('attributes', [])
                tags = next((attr['value'] for attr in attrs if attr.get('key') == 'langfuse.trace.tags'), {})
                values = tags.get('arrayValue', {}).get('values', [])
                if tags.get('stringValue'):
                    try:
                        values = [{'stringValue': tag} for tag in json.loads(tags['stringValue']) if isinstance(tag, str)]
                    except (ValueError, TypeError):
                        values = []
                values = [tag for tag in values if not str(tag.get('stringValue', '')).startswith(('agent:', 'host:', 'runtime:'))]
                values += [{'stringValue': key + ':' + label} for key, label in labels.items()]
                span['attributes'] = [attr for attr in attrs if attr.get('key') not in ['langfuse.trace.tags', *['agent_context.' + key for key in labels]]]
                span['attributes'] += [{'key': 'langfuse.trace.tags', 'value': {'arrayValue': {'values': values}}}]
                span['attributes'] += [{'key': 'agent_context.' + key, 'value': {'stringValue': label}} for key, label in labels.items()]
    return json.dumps(value, separators=(',', ':')).encode()


def attach_collector(app):
    try:
        home, device = device_config()
    except (OSError, ValueError, KeyError):
        return False
    directory = home / '.agent-context/telemetry-outbox' / device['device'] / os.environ.get('AGENT_CONTEXT_AGENT', 'codex')
    expected = 'Basic ' + base64.b64encode(('pk-lf-device-' + device['device'] + ':sk-lf-device-' + device['token']).encode()).decode()
    original = app.router.lifespan_context

    async def flush():
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            while True:
                try:
                    pending = sorted(directory.glob('*.json'), key=lambda p: p.stat().st_mtime)[:8]
                except OSError:
                    pending = []
                for file in pending:
                    if file.is_symlink():
                        continue
                    try:
                        _, current = device_config()
                        if current['device'] != device['device']:
                            break
                        result = await client.post(current['gateway'] + '/api/public/otel/v1/traces', content=file.read_bytes(), headers={'Authorization': 'Bearer ' + current['token'], 'Content-Type': 'application/json'})
                        if result.status_code == 200:
                            file.unlink(missing_ok=True)
                        else:
                            break
                    except (OSError, ValueError, KeyError, httpx.HTTPError):
                        break
                await asyncio.sleep(5)

    @asynccontextmanager
    async def lifespan(application):
        async with original(application):
            task = asyncio.create_task(flush())
            try:
                yield
            finally:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
    app.router.lifespan_context = lifespan

    @app.post('/api/public/otel/v1/traces')
    async def ingest(request: Request):
        if not hmac.compare_digest(request.headers.get('authorization', ''), expected):
            return JSONResponse({'error': 'device_access_denied'}, status_code=401)
        try:
            data = bytearray()
            async for chunk in request.stream():
                data.extend(chunk)
                if len(data) > MAX_BODY:
                    return JSONResponse({'error': 'body_limit'}, status_code=413)
            payload = decode_otlp(bytes(data), request.headers.get('content-type', ''), request.headers.get('content-encoding', ''))
            # No await between capacity check and atomic write: one event loop serializes enqueue.
            enqueue(directory, label_payload(payload))
            return Response(b'', media_type='application/x-protobuf') if request.headers.get('content-type') == 'application/x-protobuf' else JSONResponse({})
        except Exception:
            return JSONResponse({'error': 'outbox_unavailable_or_invalid_otlp'}, status_code=503)
    app.router.routes.insert(0, app.router.routes.pop())
    return True
