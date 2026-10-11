"""Isolated qualification runner; does not install agent configuration."""
import os
import json
import socket
import time
import hmac
import logging
from fastapi import Request, HTTPException
from pathlib import Path
import uvicorn
from headroom.proxy.models import ProxyConfig
from headroom.proxy.server import create_app


def main():
    from .observability import configure_environment, attach, compression_status
    telemetry = configure_environment()
    # Benchmark-only switch: "native" runs Headroom's built-in compressors (incl. Kompress) instead of SuperCompress.
    native = os.environ.get("AGENT_CONTEXT_COMPRESSOR") == "native"
    config = ProxyConfig(
        port=int(os.environ.get("AGENT_CONTEXT_PROXY_PORT", "18787")),
        mode="cache", compressors=None if native else {"supercompress"},
        optimize=os.environ.get("AGENT_CONTEXT_OPTIMIZE", "1") != "0",
        disable_kompress=not native, disable_kompress_fallback=not native,
        image_optimize=False, read_lifecycle=False,
        cache_enabled=False, rate_limit_enabled=False, retry_enabled=False,
        memory_enabled=False, subscription_tracking_enabled=False,
        offline=not telemetry, stateless=True, log_requests=False,
        keep_last_turns=0,
    )
    from .request_context import CurrentRequest
    # shortcut: Headroom 0.40 lacks a switch for schema compaction; keep native schemas intact.
    # This override is process-local and must be requalified on any Headroom update.
    from headroom.proxy import tool_schema_compaction
    tool_schema_compaction.compact_tools = lambda payload: (payload, False, 0, 0)
    # shortcut: Headroom 0.40 hardcodes a 5s Codex WS frame budget. Invariant: SC fetch 10s < bridge 12s < frame 15s,
    # so a paid call always finishes inside the frame budget. Requalify on Headroom update.
    from headroom.proxy.handlers import openai as openai_handler
    openai_handler._CODEX_WS_COMPRESSION_TIMEOUT_SECONDS = 15.0
    app = create_app(config)
    logging.getLogger('headroom.proxy').setLevel(logging.WARNING)
    app.state.agent_context_active = 0
    app.state.agent_context_last_activity = time.time()
    class Activity:
        def __init__(self, app):
            self.app = app
        async def __call__(self, scope, receive, send):
            if scope['type'] not in {'http', 'websocket'} or scope.get('path', '').startswith('/agent-context/'):
                return await self.app(scope, receive, send)
            app.state.agent_context_active += 1
            app.state.agent_context_last_activity = time.time()
            try:
                return await self.app(scope, receive, send)
            finally:
                app.state.agent_context_active -= 1
                app.state.agent_context_last_activity = time.time()
    app.add_middleware(Activity)
    app.add_middleware(CurrentRequest)
    # Headroom 0.40 has no public option to replace its default Read/Glob exclusion set.
    # shortcut: pinned integration config; requalify this shim before changing Headroom.
    from headroom.transforms.content_router import ContentRouter
    if native:
        # shortcut: same retrieval guard the SC adapter has; Codex delta frames omit the tool name,
        # so stock Headroom recompresses headroom_retrieve output into a new marker (endless loop).
        from headroom.transforms.content_router import RouterCompressionResult, CompressionStrategy
        from . import is_retrieval
        stock = ContentRouter.compress
        def guarded(self, content, *args, **kwargs):
            if is_retrieval(content):
                return RouterCompressionResult(compressed=content, original=content, strategy_used=CompressionStrategy.PASSTHROUGH)
            from headroom.observability.tracing import get_headroom_tracer
            from opentelemetry import trace
            with get_headroom_tracer().start_as_current_span('agent-context.compression.native'):
                result = stock(self, content, *args, **kwargs)
                span = trace.get_current_span()
                span.set_attribute('agent_context.compression.input_chars', len(content))
                span.set_attribute('agent_context.compression.output_chars', len(result.compressed))
                span.set_attribute('agent_context.compression.outcome', 'compressed' if len(result.compressed) < len(content) else 'no_gain')
                return result
        ContentRouter.compress = guarded
    # Read-only accounting around the pinned router; it never rewrites the user's messages.
    from .observability import account_tool_context
    import copy
    original_apply = ContentRouter.apply
    def accounted_apply(self, messages, *args, **kwargs):
        before = copy.deepcopy(messages)
        result = original_apply(self, messages, *args, **kwargs)
        account_tool_context(before, result.messages)
        return result
    ContentRouter.apply = accounted_apply
    for pipeline in (app.state.proxy.anthropic_pipeline, app.state.proxy.openai_pipeline):
        routers = [transform for transform in pipeline.transforms if isinstance(transform, ContentRouter)]
        if len(routers) != 1:
            raise RuntimeError('Unsupported Headroom router layout; refuse partial coverage')
        routers[0].config.exclude_tools = set()
    if telemetry:
        attach(app)
    from .collector import attach_collector
    attach_collector(app)
    owner = os.environ.get('AGENT_CONTEXT_PROXY_OWNER', '')
    @app.get('/agent-context/health')
    async def owned_health():
        return {'owner': owner, 'pid': os.getpid(), 'active': app.state.agent_context_active, 'telemetry': telemetry,
                'version': os.environ.get('AGENT_CONTEXT_VERSION', 'unknown'),
                'host': os.environ.get('AGENT_CONTEXT_HOST', 'unknown'), 'runtime': os.environ.get('AGENT_CONTEXT_RUNTIME', 'native'),
                'compressor': 'headroom' if native else 'supercompress', 'compression': compression_status()}
    # The native upstream catch-all must follow local management routes.
    app.router.routes.insert(0, app.router.routes.pop())
    @app.post('/agent-context/shutdown')
    async def shutdown(request: Request):
        key = os.environ.get('AGENT_CONTEXT_CONTROL_KEY', '')
        if not key or not hmac.compare_digest(request.headers.get('x-agent-context-control', ''), key):
            raise HTTPException(status_code=403)
        if app.state.agent_context_active:
            raise HTTPException(status_code=409)
        runner.should_exit = True
        return {'stopping': True}
    app.router.routes.insert(0, app.router.routes.pop())
    with socket.socket() as sock:
        if os.name != 'nt':
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(('127.0.0.1', config.port))
        sock.listen(128)
        ready = os.environ.get('AGENT_CONTEXT_READY_FILE')
        if ready:
            destination = Path(ready)
            temporary = destination.with_suffix('.tmp')
            temporary.write_text(json.dumps({'owner': owner, 'pid': os.getpid(), 'port': sock.getsockname()[1]}))
            temporary.replace(destination)
        runner = uvicorn.Server(uvicorn.Config(app, log_level='warning'))
        runner.run(sockets=[sock])


if __name__ == "__main__":
    main()
