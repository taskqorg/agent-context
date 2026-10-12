"""Private durable OTLP outbox; the agent's model traffic never enters the team gateway."""
import asyncio
import base64
from contextlib import asynccontextmanager, contextmanager
import gzip
import hmac
import hashlib
import re
import json
import os
import logging
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
    url = urlparse(value['gateway'])
    if url.scheme != 'https' or url.username or url.password or url.path.rstrip('/') not in ('', '/api/public/agent-context') or url.query or url.fragment:
        raise ValueError('Invalid gateway')
    if not re.fullmatch(r'[a-f0-9]{32}', value['device']) or not re.fullmatch(r'acd_[a-f0-9]{64}', value['token']):
        raise ValueError('Invalid device')
    if value.get('user') is not None and (not isinstance(value['user'], str) or not re.fullmatch(r'[a-zA-Z0-9-]{1,39}', value['user'])):
        raise ValueError('Invalid telemetry user')
    return home, value


def collector_config():
    home = Path(os.environ.get('AGENT_CONTEXT_HOME') or str(Path.home()))
    if (home / '.agent-context/enrollment.json').exists():
        home, device = device_config()
        return home, dict(device, public_key='pk-lf-device-' + device['device'], secret_key='sk-lf-device-' + device['token'], enrolled=True)
    source = Path(os.environ.get('AGENT_CONTEXT_LANGFUSE_CONFIG', str(home / '.codex/langfuse.json')))
    config = json.loads(source.read_text())
    url = urlparse(config.get('agent_context_base_url') or config['base_url'])
    if config.get('enabled') is False or url.scheme not in ('https', 'http') or not url.netloc or url.username or url.password or url.query or url.fragment:
        raise ValueError('Invalid Langfuse destination')
    if not all(isinstance(config.get(k), str) and config[k] for k in ('public_key', 'secret_key')):
        raise ValueError('Missing Langfuse credentials')
    # Loopback is this collector, never an upstream destination.
    if url.hostname in ('localhost', '127.0.0.1', '::1') and str(url.port) == os.environ.get('AGENT_CONTEXT_PROXY_PORT'):
        raise ValueError('Recursive Langfuse destination')
    user = config.get('user_id')
    if user is not None and (not isinstance(user, str) or not re.fullmatch(r'[a-zA-Z0-9-]{1,39}', user)):
        raise ValueError('Invalid telemetry user')
    return home, dict(config, gateway=url.geturl().rstrip('/'), device='local', user=user, enrolled=False)


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


def label_payload(data, user=None):
    value = json.loads(data)
    labels = {'agent': os.environ.get('AGENT_CONTEXT_AGENT', 'unknown'), 'host': os.environ.get('AGENT_CONTEXT_HOST', 'unknown'), 'runtime': os.environ.get('AGENT_CONTEXT_RUNTIME', 'native')}
    for resource in value['resourceSpans']:
        if resource.get('resource', {}).get('attributes'):
            resource['resource']['attributes'] = [a for a in resource['resource']['attributes'] if a.get('key') not in ('user.id', 'langfuse.user.id', 'langfuse.trace.tags')]
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
                values = [tag for tag in values if not str(tag.get('stringValue', '')).startswith(('agent:', 'host:', 'runtime:', 'user:'))]
                values += [{'stringValue': key + ':' + label} for key, label in labels.items()]
                if user:
                    values.append({'stringValue': 'user:' + user})
                span['attributes'] = [attr for attr in attrs if attr.get('key') not in ['langfuse.trace.tags', 'user.id', 'langfuse.user.id', 'agent_context.user', 'agent_context.telemetry.schema', *['agent_context.' + key for key in labels]]]
                span['attributes'] += [{'key': 'langfuse.trace.tags', 'value': {'arrayValue': {'values': values}}}]
                span['attributes'] += [{'key': 'agent_context.telemetry.schema', 'value': {'intValue': '1'}}]
                if user:
                    span['attributes'] += [{'key': k, 'value': {'stringValue': user}} for k in ('user.id', 'langfuse.user.id', 'agent_context.user')]
                span['attributes'] += [{'key': 'agent_context.' + key, 'value': {'stringValue': label}} for key, label in labels.items()]
                # Langfuse SDK metadata fields suppress the generic OTLP attribute fallback.
                canonical = dict(labels, **{'telemetry.schema': 1})
                if user:
                    canonical['user'] = user
                prefix = 'langfuse.observation.metadata.attributes.agent_context.'
                span['attributes'] = [a for a in span['attributes'] if a.get('key') not in [prefix + k for k in (*labels, 'telemetry.schema', 'user')]]
                span['attributes'] += [{'key': prefix + k, 'value': {'intValue': str(v)} if isinstance(v, int) else {'stringValue': v}} for k, v in canonical.items()]
                # Native exporters' explicit metadata replaces generic OTLP attributes in Langfuse.
                for item in span['attributes']:
                    if item.get('key') != 'langfuse.observation.metadata':
                        continue
                    metadata = json.loads(item.get('value', {}).get('stringValue', '{}'))
                    if not isinstance(metadata, dict):
                        raise ValueError('Invalid observation metadata')
                    metadata.update({'attributes.agent_context.' + k: v for k, v in labels.items()})
                    metadata['attributes.agent_context.telemetry.schema'] = 1
                    metadata.pop('attributes.agent_context.user', None)
                    if user:
                        metadata['attributes.agent_context.user'] = user
                    item['value'] = {'stringValue': json.dumps(metadata, separators=(',', ':'))}

    return json.dumps(value, separators=(',', ':')).encode()


def destination_id(config):
    return hashlib.sha256(('\0'.join(config.get(k) or '' for k in ('gateway', 'public_key', 'secret_key', 'user'))).encode()).hexdigest()


def attach_collector(app):
    try:
        home, device = collector_config()
    except (OSError, ValueError, KeyError):
        return False
    directory = home / '.agent-context/telemetry-outbox' / device['device'] / os.environ.get('AGENT_CONTEXT_AGENT', 'codex')
    if not device['enrolled']:
        directory /= destination_id(device)
    expected = 'Basic ' + base64.b64encode((device['public_key'] + ':' + device['secret_key']).encode()).decode()
    original = app.router.lifespan_context

    drain_lock = asyncio.Lock()
    status_file = directory / 'delivery.status'
    def delivery_status():
        try:
            with status_file.open() as source:
                value = json.loads(source.read(4096))
            error = value.get('lastError')
            if type(value.get('failures')) is not int or not 0 <= value['failures'] <= 2**53-1 or error not in (None, 'http_rejected', 'partial_rejection', 'transport_error', 'queue_unreadable'):
                raise ValueError('Invalid delivery status')
            return {'failures': value['failures'], 'lastError': error}
        except FileNotFoundError:
            return {'failures': 0, 'lastError': None}
        except (OSError, ValueError):
            return {'failures': 0, 'lastError': 'status_unreadable'}
    def remember(error):
        state = delivery_status()
        state['failures'] = min(2**53-1, state['failures'] + int(error is not None))
        state['lastError'] = error
        temporary = status_file.with_suffix('.tmp')
        try:
            if temporary.is_symlink() or status_file.is_symlink():
                raise ValueError('Invalid status path')
            with temporary.open('w') as output:
                os.chmod(temporary, 0o600)
                json.dump(state, output)
            temporary.replace(status_file)
        except (OSError, ValueError):
            logging.getLogger(__name__).error('Telemetry delivery status unavailable')
        if error:
            logging.getLogger(__name__).warning('Telemetry delivery failed category=%s', error)
    app.state.agent_context_collector_status = delivery_status
    async def flush_once():
        try:
            async with drain_lock, httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
                with sender_lease(directory) as acquired:
                    if not acquired:
                        return
                    try:
                        pending = sorted(directory.glob('*.json'), key=lambda p: p.stat().st_mtime)[:8]
                    except OSError:
                        remember('queue_unreadable')
                        pending = []
                    for file in pending:
                        if file.is_symlink():
                            continue
                        try:
                            _, current = collector_config()
                            if current['device'] != device['device'] or destination_id(current) != destination_id(device):
                                break
                            auth = 'Bearer ' + current['token'] if current['enrolled'] else 'Basic ' + base64.b64encode((current['public_key'] + ':' + current['secret_key']).encode()).decode()
                            result = await client.post(current['gateway'] + '/api/public/otel/v1/traces', content=file.read_bytes(), headers={'Authorization': auth, 'Content-Type': 'application/json', 'x-langfuse-ingestion-version': '4'})
                            if result.status_code == 200 and not result.json().get('partialSuccess', {}).get('rejectedSpans'):
                                file.unlink(missing_ok=True)
                                remember(None)
                            else:
                                remember('partial_rejection' if result.status_code == 200 else 'http_rejected')
                                break
                        except (OSError, ValueError, KeyError, httpx.HTTPError):
                            remember('transport_error')
                            break
        except (OSError, ValueError):
            remember('queue_unreadable')
    async def flush():
        while True:
            await flush_once()
            await asyncio.sleep(5)

    app.state.agent_context_flush = flush_once

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
    # Project credentials must never fall through to the model provider's catch-all.
    @app.api_route('/api/public/{unsupported:path}', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    async def unsupported_telemetry(unsupported: str):
        return JSONResponse({'error': 'unsupported_local_telemetry_endpoint'}, status_code=501)
    app.router.routes.insert(0, app.router.routes.pop())

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
            enqueue(directory, label_payload(payload, device.get('user')))
            return Response(b'', media_type='application/x-protobuf') if request.headers.get('content-type') == 'application/x-protobuf' else JSONResponse({})
        except Exception:
            return JSONResponse({'error': 'outbox_unavailable_or_invalid_otlp'}, status_code=503)
    app.router.routes.insert(0, app.router.routes.pop())
    return True
@contextmanager
def sender_lease(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    file = directory / 'sender.lock'
    if file.is_symlink():
        raise ValueError('Invalid sender lease')
    with file.open('a+b') as handle:
        if not file.stat().st_size:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
            return
        try:
            yield True
        finally:
            if os.name == 'nt':
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
