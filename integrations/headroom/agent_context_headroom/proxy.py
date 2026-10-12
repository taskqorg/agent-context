"""Isolated qualification runner; does not install agent configuration."""
import os
import asyncio

# Local deterministic compression only; never fetch model weights.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
import json
import socket
import time
import hmac
import math
import re
import logging
from fastapi import Request, HTTPException
from pathlib import Path
import uvicorn
from headroom.proxy.models import ProxyConfig
from headroom.proxy.server import create_app


def main():
    with socket.socket() as sock:
        if os.name != 'nt':
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(('127.0.0.1', int(os.environ.get('AGENT_CONTEXT_PROXY_PORT', '18787'))))
        # The local telemetry exporter must use the reserved port, never port zero.
        os.environ['AGENT_CONTEXT_PROXY_PORT'] = str(sock.getsockname()[1])
        serve(sock)


def serve(sock):
    from .providers import provider_name
    compressor = provider_name()
    from .observability import configure_environment, attach, compression_status
    telemetry = configure_environment()
    config = ProxyConfig(
        port=int(os.environ.get("AGENT_CONTEXT_PROXY_PORT", "18787")),
        mode="cache", compressors=({"smart_crusher", "search", "log", "tabular", "config", "html", "local-text"}
                                   if compressor == 'headroom-local' else {"local-text"}),
        optimize=False,
        disable_kompress=True, disable_kompress_fallback=True,
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
    app = create_app(config)
    logging.getLogger('headroom.proxy').setLevel(logging.WARNING)
    from .activity import Activity, ActivityTracker
    activity = ActivityTracker()
    app.state.agent_context_stopping = False
    app.state.agent_context_last_activity = time.time()
    app.add_middleware(Activity, tracker=activity)
    app.add_middleware(CurrentRequest)
    # Headroom 0.40 has no public option to replace its default Read/Glob exclusion set.
    # shortcut: pinned integration config; requalify this shim before changing Headroom.
    from headroom.transforms.content_router import ContentRouter
    from headroom.transforms.content_router import RouterCompressionResult, CompressionStrategy
    from . import is_retrieval
    original_compress = ContentRouter.compress
    def safe_compress(self, content, *args, **kwargs):
        from headroom.observability.tracing import get_headroom_tracer
        from .observability import compression_outcome, record_compression
        token = compression_outcome.set(None)
        started = time.monotonic()
        try:
            with get_headroom_tracer().start_as_current_span('agent-context.compression'):
                try:
                    if is_retrieval(content):
                        compression_outcome.set('retrieval')
                        result = RouterCompressionResult(compressed=content, original=content,
                            strategy_used=CompressionStrategy.PASSTHROUGH, routing_log=[])
                    else:
                        result = original_compress(self, content, *args, **kwargs)
                except Exception:
                    compression_outcome.set('fallback')
                    result = RouterCompressionResult(compressed=content, original=content,
                        strategy_used=CompressionStrategy.PASSTHROUGH, routing_log=[])
                status = compression_outcome.get() or ('compressed' if len(result.compressed) < len(content) else 'passthrough')
                record_compression(status, len(content), len(result.compressed),
                    int((time.monotonic() - started) * 1000), result.strategy_used.value)
                return result
        finally:
            compression_outcome.reset(token)
    ContentRouter.compress = safe_compress
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
    for pipeline in (app.state.proxy.anthropic_pipeline, app.state.proxy.openai_pipeline,
                     *app.state.proxy._compress_pipeline_cache.values()):
        routers = [transform for transform in pipeline.transforms if isinstance(transform, ContentRouter)]
        if len(routers) != 1:
            raise RuntimeError('Unsupported Headroom router layout; refuse partial coverage')
        routers[0].config.exclude_tools = set()
        routers[0].config.relevance_split = False
    if telemetry:
        attach(app)
    from .collector import attach_collector
    attach_collector(app)
    owner = os.environ.get('AGENT_CONTEXT_PROXY_OWNER', '')
    @app.post('/agent-context/native-event')
    async def native_event(request: Request):
        key = os.environ.get('AGENT_CONTEXT_CONTROL_KEY', '')
        if not key or not hmac.compare_digest(request.headers.get('x-agent-context-control', ''), key):
            raise HTTPException(status_code=403)
        body = await request.body()
        if len(body) > 4096:
            raise HTTPException(status_code=413)
        try:
            value = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            raise HTTPException(status_code=400)
        if not isinstance(value, dict) or not isinstance(value.get('id'), str) or not re.fullmatch(r'[a-f0-9-]{36}', value['id']) or value.get('engine') != 'rtk' or value.get('token_source') != 'rtk_estimate' or any(type(value.get(k)) not in (int, float) or not math.isfinite(value[k]) or not 0 <= value[k] <= 2**53-1 for k in ('input_tokens', 'output_tokens', 'elapsed_ms')):
            raise HTTPException(status_code=400)
        from .observability import native_seen, record_native
        if native_seen(value['id']):
            return {'accepted': True, 'telemetry': telemetry}
        from headroom.observability.tracing import get_headroom_tracer
        attributes = {}
        if isinstance(value.get('session'), str):
            attributes['session.id'] = value['session'][:128]
        with get_headroom_tracer().start_as_current_span('agent-context.native-tool', attributes=attributes) as span:
            for field in ('input_tokens', 'output_tokens', 'elapsed_ms', 'token_source'):
                span.set_attribute('agent_context.compression.' + field, value[field])
            span.set_attribute('agent_context.compression.strategy', 'rtk-native')
            for field in ('engine_version', 'wrapper_version', 'id'):
                if isinstance(value.get(field), str):
                    span.set_attribute('agent_context.compression.' + field, value[field][:128])
            if type(value.get('exit_code')) is int:
                span.set_attribute('agent_context.compression.exit_code', value['exit_code'])
            if isinstance(value.get('call'), str):
                span.set_attribute('agent_context.tool_call_id', value['call'][:128])
        record_native(value)
        return {'accepted': True, 'telemetry': telemetry}
    app.router.routes.insert(0, app.router.routes.pop())

    @app.get('/agent-context/health')
    async def owned_health():
        return {'owner': owner, 'pid': os.getpid(), 'active': activity.connections, 'active_requests': activity.requests, 'drain_protocol': 1, 'telemetry': telemetry,
                'version': os.environ.get('AGENT_CONTEXT_VERSION', 'unknown'), 'native_event_protocol': 1,
                'host': os.environ.get('AGENT_CONTEXT_HOST', 'unknown'), 'runtime': os.environ.get('AGENT_CONTEXT_RUNTIME', 'native'),
                'compressor': compressor, 'compression': compression_status(),
                'collector': app.state.agent_context_collector_status() if hasattr(app.state, 'agent_context_collector_status') else None}
    # The native upstream catch-all must follow local management routes.
    app.router.routes.insert(0, app.router.routes.pop())
    @app.post('/agent-context/shutdown')
    async def shutdown(request: Request):
        key = os.environ.get('AGENT_CONTEXT_CONTROL_KEY', '')
        if not key or not hmac.compare_digest(request.headers.get('x-agent-context-control', ''), key):
            raise HTTPException(status_code=403)
        if app.state.agent_context_stopping:
            return {'stopping': True}
        if not await activity.drain():
            raise HTTPException(status_code=409)
        app.state.agent_context_stopping = True
        if telemetry:
            # Keep the loopback receiver alive while the native SDK exports its last batch.
            from headroom.observability.tracing import shutdown_headroom_tracing
            await asyncio.to_thread(shutdown_headroom_tracing)
        flush = getattr(app.state, 'agent_context_flush', None)
        if flush:
            await flush()
        runner.should_exit = True
        return {'stopping': True}
    app.router.routes.insert(0, app.router.routes.pop())
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
