"""Correlate native compression spans without exporting generation usage twice."""
from contextlib import asynccontextmanager
from contextvars import ContextVar
import json
import io
import logging
import os
import re
from pathlib import Path
import uuid
from collections import Counter
from threading import Lock
import time

identity = ContextVar('agent_context_request', default={})
_outcomes = Counter()
_outcome_lock = Lock()
_last_compression = None
_tool_context = Counter()


def record_compression(status, before, after, elapsed_ms):
    global _last_compression
    with _outcome_lock:
        _outcomes[status] += 1
        _last_compression = time.time()
    from opentelemetry import trace
    span = trace.get_current_span()
    for key, value in {'outcome': status, 'input_chars': before, 'output_chars': after,
                       'elapsed_ms': elapsed_ms, 'compressor': 'supercompress'}.items():
        span.set_attribute('agent_context.compression.' + key, value)
    normal = {'compressed', 'retrieval', 'content_type', 'ineligible', 'no_gain', 'empty', 'too_large', 'request_budget'}
    if status not in normal:
        span.set_attribute('langfuse.observation.level', 'ERROR')
        span.set_attribute('langfuse.observation.status_message', status)
        from opentelemetry.trace import Status, StatusCode
        span.set_status(Status(StatusCode.ERROR, status))


def compression_status():
    with _outcome_lock:
        return {'supercompress_outcomes': dict(_outcomes), 'last_attempt_at': _last_compression,
                'tool_context': dict(_tool_context),
                'coverage': 'router_tool_blocks_only_not_all_codex_ws_frames',
                'proof': 'adapter_outcomes_not_model_token_savings'}


def configure_environment():
    if os.environ.get('AGENT_CONTEXT_LANGFUSE') != '1':
        os.environ['HEADROOM_LANGFUSE_ENABLED'] = 'false'
        return False
    try:
        home = Path(os.environ.get('AGENT_CONTEXT_HOME', str(Path.home())))
        enrolled = home / '.agent-context/enrollment.json'
        if enrolled.is_file():
            source = home / '.codex/langfuse.json'
            if source.is_file() and json.loads(source.read_text()).get('enabled') is False:
                raise ValueError('Langfuse disabled by profile owner')
            from .collector import device_config
            _, device = device_config()
            os.environ['LANGFUSE_PUBLIC_KEY'] = 'pk-lf-device-' + device['device']
            os.environ['LANGFUSE_SECRET_KEY'] = 'sk-lf-device-' + device['token']
            os.environ['LANGFUSE_BASE_URL'] = 'http://127.0.0.1:' + os.environ['AGENT_CONTEXT_PROXY_PORT']
        if not (os.environ.get('LANGFUSE_PUBLIC_KEY') and os.environ.get('LANGFUSE_SECRET_KEY')):
            home = Path(os.environ.get('AGENT_CONTEXT_HOME', str(Path.home())))
            path = Path(os.environ.get('AGENT_CONTEXT_LANGFUSE_CONFIG', str(home / '.codex/langfuse.json')))
            if path.is_file():
                config = json.loads(path.read_text(encoding='utf-8'))
                if config.get('enabled') is False:
                    raise ValueError('Langfuse disabled by profile owner')
            else:
                # Only the default installation's existing source; never another profile or host.
                names = ['PUBLIC_KEY', 'SECRET_KEY', 'BASE_URL']
                values = {name: os.environ.get('HERMES_LANGFUSE_' + name) for name in names}
                if not (values['PUBLIC_KEY'] and values['SECRET_KEY']):
                    from dotenv import dotenv_values
                    source = home / '.hermes/.env'
                    lines = source.read_text(encoding='utf-8').splitlines()
                    selected = '\n'.join(line for line in lines if re.match(r'^\s*(?:export\s+)?HERMES_LANGFUSE_(PUBLIC_KEY|SECRET_KEY|BASE_URL)\s*=', line))
                    parsed = dotenv_values(stream=io.StringIO(selected), interpolate=False)
                    values = {name: parsed.get('HERMES_LANGFUSE_' + name) for name in names}
                config = {name.lower(): value for name, value in values.items()}
            for target, source in [('LANGFUSE_PUBLIC_KEY', 'public_key'), ('LANGFUSE_SECRET_KEY', 'secret_key'), ('LANGFUSE_BASE_URL', 'base_url')]:
                if not isinstance(config.get(source), str) or not config[source]:
                    raise ValueError('Incomplete Langfuse configuration')
                os.environ[target] = config[source]
        from urllib.parse import urlparse
        url = urlparse(os.environ.get('LANGFUSE_BASE_URL') or os.environ.get('LANGFUSE_HOST', ''))
        if url.scheme not in {'http', 'https'} or not url.netloc or url.username or url.password:
            raise ValueError('Missing or invalid Langfuse destination')
        os.environ['LANGFUSE_BASE_URL'] = url.geturl()
    except (OSError, ValueError, ImportError, TypeError):
        os.environ['HEADROOM_LANGFUSE_ENABLED'] = 'false'
        logging.getLogger(__name__).warning('Langfuse unavailable; compression remains enabled')
        return False
    os.environ['HEADROOM_LANGFUSE_ENABLED'] = 'true'
    os.environ['HEADROOM_LANGFUSE_SERVICE_NAME'] = 'agent-context-proxy'
    os.environ['HEADROOM_BEACON'] = 'off'
    os.environ['HEADROOM_TELEMETRY'] = 'off'
    os.environ['DO_NOT_TRACK'] = '1'
    return True


class CorrelatedTracer:
    def __init__(self, delegate):
        self.delegate = delegate

    def start_as_current_span(self, name, *, attributes=None):
        values = dict(attributes or {}, **identity.get())
        values['langfuse.observation.type'] = 'span'
        stage = os.environ.get('AGENT_CONTEXT_STAGE', 'qualification')
        values['langfuse.environment'] = stage if stage in {'production', 'development', 'qualification'} else 'qualification'
        values['agent_context.version'] = os.environ.get('AGENT_CONTEXT_VERSION', 'unknown')
        values['agent_context.agent'] = os.environ.get('AGENT_CONTEXT_AGENT', 'unknown')
        values['agent_context.host'] = os.environ.get('AGENT_CONTEXT_HOST', 'unknown')
        values['agent_context.runtime'] = os.environ.get('AGENT_CONTEXT_RUNTIME', 'native')
        values['agent_context.compressor'] = 'headroom' if os.environ.get('AGENT_CONTEXT_COMPRESSOR') == 'native' else 'supercompress'
        values['langfuse.trace.tags'] = ['agent:' + values['agent_context.agent'], 'host:' + values['agent_context.host'], 'runtime:' + values['agent_context.runtime'], 'component:compression']
        if values.get('session.id'):
            values['langfuse.session.id'] = values['session.id']
        # Compression token estimates are not generation usage or monetary savings.
        return self.delegate.start_as_current_span(name, attributes=values)


class RequestIdentity:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] not in {'http', 'websocket'}:
            return await self.app(scope, receive, send)
        headers = {key.decode().lower(): value.decode() for key, value in scope.get('headers', [])}
        session = headers.get('session_id') or headers.get('x-session-id')
        turn = headers.get('x-codex-turn-id') or headers.get('x-turn-id')
        raw = headers.get('x-codex-turn-metadata', '')
        if len(raw) <= 4096:
            try:
                metadata = json.loads(raw)
                if isinstance(metadata, dict):
                    session = metadata.get('thread_id') or session
                    turn = metadata.get('turn_id') or turn
            except ValueError:
                pass
        valid = lambda value: isinstance(value, str) and bool(re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', value))
        session = session if valid(session) else None
        turn = turn if valid(turn) else None
        values = {'agent_context.request_id': uuid.uuid4().hex,
                  'agent_context.native_session_missing': not bool(session),
                  'agent_context.native_turn_missing': not bool(turn)}
        if session and len(session) <= 128:
            values['session.id'] = session
        if turn and len(turn) <= 128:
            values['agent_context.turn_id'] = turn
        token = identity.set(values)
        try:
            return await self.app(scope, receive, send)
        finally:
            identity.reset(token)


def attach(app):
    from headroom.observability.tracing import get_headroom_tracer, set_headroom_tracer
    original = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        async with original(application):
            set_headroom_tracer(CorrelatedTracer(get_headroom_tracer()))
            yield
    app.router.lifespan_context = lifespan
    app.add_middleware(RequestIdentity)


def delivery_probe(probe):
    """Reuse the installed OTLP SDK; legacy trace-create ingestion is rejected by Langfuse v4."""
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.id_generator import RandomIdGenerator
    from opentelemetry.sdk.trace.export import SpanExportResult
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from headroom.observability.tracing import LangfuseTracingConfig
    class ProbeIds(RandomIdGenerator):
        def generate_trace_id(self):
            return int(probe['id'], 16)
    config = LangfuseTracingConfig.from_env()
    provider = TracerProvider(id_generator=ProbeIds())
    exporter = OTLPSpanExporter(endpoint=config.endpoint, headers=config.headers, timeout=5)
    span = provider.get_tracer('agent-context-delivery').start_span('Agent Context delivery check', attributes={
        'langfuse.observation.type': 'span', 'langfuse.environment': 'qualification',
        'langfuse.session.id': probe['sessionId'], 'session.id': probe['sessionId'],
        'langfuse.trace.tags': probe['tags'], 'langfuse.trace.name': 'Agent Context delivery check',
        'agent_context.version': probe['version'], 'agent_context.host': probe['host'],
        'agent_context.runtime': probe['runtime'], 'agent_context.synthetic': True,
    })
    span.end()
    try:
        return 'accepted' if exporter.export([span]) == SpanExportResult.SUCCESS else 'rejected'
    finally:
        exporter.shutdown()
        provider.shutdown()


if __name__ == '__main__':
    import sys
    print(json.dumps({'status': delivery_probe(json.loads(sys.argv[1]))}))


def tool_blocks(messages):
    """Count only textual tool payloads; exclude user prompts, instructions and binary media."""
    blocks = []
    for message in messages:
        content = message.get('content', [])
        if message.get('role') == 'tool':
            if isinstance(content, str):
                blocks.append(content)
            elif isinstance(content, list):
                blocks.extend(block.get('text', '') for block in content if isinstance(block, dict) and block.get('type') == 'text')
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict) or block.get('type') != 'tool_result':
                    continue
                result = block.get('content', '')
                if isinstance(result, str):
                    blocks.append(result)
                elif isinstance(result, list):
                    blocks.extend(item.get('text', '') for item in result if isinstance(item, dict) and item.get('type') == 'text')
    return [block for block in blocks if isinstance(block, str)]


def account_tool_context(before, after):
    originals, transmitted = tool_blocks(before), tool_blocks(after)
    # A changed block layout has no reliable per-block denominator.
    if len(originals) != len(transmitted):
        return
    with _outcome_lock:
        _tool_context['input_chars'] += sum(map(len, originals))
        _tool_context['output_chars'] += sum(map(len, transmitted))
        _tool_context['compressed'] += sum(len(b) < len(a) for a, b in zip(originals, transmitted))
        _tool_context['passthrough'] += sum(len(b) >= len(a) for a, b in zip(originals, transmitted))
