"""Local Headroom text adapter; structural formats stay with native handlers."""
import hashlib
import json
import logging
import re
from contextvars import ContextVar
from .providers import compress_context, provider_name

provider_outcome = ContextVar('provider_outcome', default=None)
from headroom.transforms.compressor_registry import CompressOutput, CompressorDescriptor

logger = logging.getLogger("headroom.agent_context.local")


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



def compress_text(content, query):
    result = compress_context(content, query)
    provider_outcome.set(result['outcome'])
    return result['compressed_text']


class LocalText:
    descriptor = CompressorDescriptor(
        name="local-text", content_types=["text/plain"],
        lossless=False, cost_tier="fast", recoverable=True,
    )

    def compress(self, inp):
        return self._compress(inp)

    def _compress(self, inp):
        from .observability import compression_outcome
        from .request_context import query as request_query
        def record(status, after):
            compression_outcome.set(status)
        def original(status):
            record(status, len(inp.content))
            return CompressOutput(inp.content, 0, 0, False, compressed=True)

        if is_retrieval(inp.content):
            return original('retrieval')
        if inp.content_type != 'text/plain':
            return original('content_type')
        if len(inp.content) < 2048:
            return original('ineligible')
        query = inp.query or request_query.get()
        if not query:
            return original('missing_current_query')
        try:
            provider_outcome.set(None)
            text = compress_text(inp.content, query)
            if provider_outcome.get() not in {None, 'compressed'}:
                return original(provider_outcome.get())
            digest = hashlib.sha256(inp.content.encode()).hexdigest()[:16]
            marked = text + f"\nRetrieve original: hash={digest} <<ccr:{digest}>>"
            if len(marked) >= len(inp.content):
                return original('no_gain')
            from headroom.cache.compression_store import get_compression_store
            store = get_compression_store()
            store.store(original=inp.content, compressed=marked,
                        compression_strategy="external:" + provider_name(), explicit_hash=digest)
            if store.retrieve(digest).original_content != inp.content:
                return original('fallback')
            record('compressed', len(marked))
            return CompressOutput(marked, 0, 0, False, markers=[digest], recoverable={digest: inp.content})
        except Exception as error:
            logger.warning("Local compression fallback exception_type=%s", type(error).__name__)
            return original('fallback')
