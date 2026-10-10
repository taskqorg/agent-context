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

identity = ContextVar('agent_context_request', default={})


def configure_environment():
    if os.environ.get('AGENT_CONTEXT_LANGFUSE') != '1':
        return False
    try:
        if not (os.environ.get('LANGFUSE_PUBLIC_KEY') and os.environ.get('LANGFUSE_SECRET_KEY')):
            home = Path(os.environ.get('AGENT_CONTEXT_HOME', str(Path.home())))
            path = Path(os.environ.get('AGENT_CONTEXT_LANGFUSE_CONFIG', str(home / '.codex/langfuse.json')))
            if path.is_file():
                config = json.loads(path.read_text(encoding='utf-8'))
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
        values['agent_context.version'] = '0.1.11'
        values['agent_context.agent'] = os.environ.get('AGENT_CONTEXT_AGENT', 'unknown')
        values['agent_context.host'] = os.environ.get('AGENT_CONTEXT_HOST', 'unknown')
        values['langfuse.trace.tags'] = ['agent:' + values['agent_context.agent'], 'host:' + values['agent_context.host'], 'component:compression']
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
