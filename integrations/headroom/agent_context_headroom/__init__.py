"""Headroom adapter reusing agent-context's existing SuperCompress provider."""
import hashlib
import json
import logging
import os
from pathlib import Path
import shutil
import subprocess

from headroom.transforms.compressor_registry import (
    CompressOutput, CompressorDescriptor,
)
logger = logging.getLogger("headroom.agent_context.supercompress")


def is_retrieval(content):
    # Codex delta frames can omit the originating tool name; recognize the native reply envelope.
    try:
        value = json.loads(content)
    except (ValueError, TypeError):
        return False
    if not isinstance(value, dict):
        return False
    if isinstance(value.get("original_content"), str) and value.get("source") in {"proxy", "local"} and value.get("hash"):
        return True
    blocks = value.get("content", [])
    return isinstance(blocks, list) and any(
        isinstance(block, dict) and block.get("type") == "text" and is_retrieval(block.get("text"))
        for block in blocks
    )


class Supercompress:
    descriptor = CompressorDescriptor(
        name="supercompress", content_types=["text/*", "application/json"],
        lossless=False, cost_tier="remote", recoverable=True,
    )

    def compress(self, inp):
        # Codex WS routes bypass Headroom's traced Pipeline; instrument the actual adapter call.
        from headroom.observability.tracing import get_headroom_tracer
        with get_headroom_tracer().start_as_current_span('agent-context.compression'):
            return self._compress(inp)

    def _compress(self, inp):
        import time
        from .observability import identity, record_compression
        started = time.monotonic()
        def record(status, after):
            record_compression(status, len(inp.content), after, int((time.monotonic() - started) * 1000))
        def original(status):
            record(status, len(inp.content))
            return CompressOutput(inp.content, 0, 0, False, compressed=True)

        if is_retrieval(inp.content):
            logger.info("SC skipped status=retrieval input_chars=%s", len(inp.content))
            return original('retrieval')
        # Source code passes through by default: A/B 2026-10-11 showed code compression saves ~4% input
        # but triggers retrieval in about half the runs (+40% net). Override with AGENT_CONTEXT_SKIP_TYPES.
        skip_types = [t for t in os.environ.get("AGENT_CONTEXT_SKIP_TYPES", "text/x-code").split(",") if t]
        if any(inp.content_type.startswith(t) for t in skip_types):
            logger.info("SC skipped status=content_type type=%s input_chars=%s", inp.content_type, len(inp.content))
            return original('content_type')
        if len(inp.content) < 2048:
            logger.info("SC skipped status=ineligible input_chars=%s query_chars=%s", len(inp.content), len(inp.query))
            return original('ineligible')
        node = os.environ.get("AGENT_CONTEXT_NODE") or shutil.which("node")
        bridge = os.environ.get("AGENT_CONTEXT_BRIDGE")
        if not node or not bridge or not Path(bridge).is_file():
            return original('bridge_unavailable')
        # Responses delta frames can omit the user turn; never read another session's prompt.
        from .request_context import query as request_query
        query = inp.query or request_query.get()
        if not query:
            logger.info("SC skipped status=missing_current_query input_chars=%s", len(inp.content))
            return original('missing_current_query')
        # Several tool results in one request share one budget; an exhausted budget passes content through.
        from .request_context import deadline
        import time
        limit = deadline.get()
        timeout = 12.0 if not limit or not limit[0] else min(12.0, limit[0] - time.monotonic())
        if timeout < 2:
            logger.info("SC skipped status=request_budget input_chars=%s", len(inp.content))
            return original('request_budget')
        payload = dict(context=inp.content, query=query,
                       session=identity.get().get('session.id') or identity.get().get('agent_context.request_id') or 'uncorrelated',
                       agent=os.environ.get('AGENT_CONTEXT_AGENT', 'headroom'),
                       timeout_ms=int((timeout - 1.5) * 1000))  # paid call ends before the bridge is killed
        try:
            process = subprocess.run(
                [node, bridge], input=json.dumps(payload),
                capture_output=True, text=True, encoding="utf-8", timeout=timeout,
            )
            if process.returncode:
                logger.warning("SC bridge failed exit_code=%s", process.returncode)
                return original('bridge_failed')
            result = json.loads(process.stdout)
            text = result.get("compressed_text")
            logger.info(
                "SC result status=%s input_chars=%s output_chars=%s elapsed_ms=%s",
                result.get("skipped") or "compressed", len(inp.content),
                len(text) if isinstance(text, str) else 0, result.get("elapsed_ms"),
            )
            if result.get("skipped") or not isinstance(text, str) or not text.strip():
                status = result.get('skipped')
                return original(status if status in {'timeout', 'no_gain', 'missing_key', 'key_conflict', 'too_large', 'empty', 'request_failed', 'invalid_response'} else 'invalid_response')
            digest = hashlib.sha256(inp.content.encode()).hexdigest()[:16]
            marker = f"\nRetrieve original: hash={digest} <<ccr:{digest}>>"
            if len(text + marker) >= len(inp.content):
                return original('no_gain')
            # Store before emitting a marker; an unavailable store must retain the original.
            from headroom.cache.compression_store import get_compression_store
            store = get_compression_store()
            store.store(original=inp.content, compressed=text + marker,
                        compression_strategy="external:supercompress", explicit_hash=digest)
            record('compressed', len(text + marker))
            return CompressOutput(
                text + marker, 0, 0, False,
                markers=[digest], recoverable={digest: inp.content},
            )
        except Exception as error:
            logger.warning("SC fallback exception_type=%s", type(error).__name__)
            return original('fallback')
