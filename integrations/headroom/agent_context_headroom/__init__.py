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
        def original():
            return CompressOutput(inp.content, 0, 0, False, compressed=True)

        if is_retrieval(inp.content):
            logger.info("SC skipped status=retrieval input_chars=%s", len(inp.content))
            return original()
        if len(inp.content) < 2048:
            logger.info("SC skipped status=ineligible input_chars=%s query_chars=%s", len(inp.content), len(inp.query))
            return original()
        node = os.environ.get("AGENT_CONTEXT_NODE") or shutil.which("node")
        bridge = os.environ.get("AGENT_CONTEXT_BRIDGE")
        if not node or not bridge or not Path(bridge).is_file():
            return original()
        # Responses delta frames can omit the user turn; never read another session's prompt.
        from .request_context import query as request_query
        query = inp.query or request_query.get()
        if not query:
            logger.info("SC skipped status=missing_current_query input_chars=%s", len(inp.content))
            return original()
        payload = dict(context=inp.content, query=query,
                       session="headroom", agent="headroom")
        try:
            process = subprocess.run(
                [node, bridge], input=json.dumps(payload),
                capture_output=True, text=True, encoding="utf-8", timeout=12,
            )
            if process.returncode:
                logger.warning("SC bridge failed exit_code=%s", process.returncode)
                return original()
            result = json.loads(process.stdout)
            text = result.get("compressed_text")
            logger.info(
                "SC result status=%s input_chars=%s output_chars=%s elapsed_ms=%s",
                result.get("skipped") or "compressed", len(inp.content),
                len(text) if isinstance(text, str) else 0, result.get("elapsed_ms"),
            )
            if result.get("skipped") or not isinstance(text, str) or not text.strip():
                return original()
            digest = hashlib.sha256(inp.content.encode()).hexdigest()[:16]
            marker = f"\nRetrieve original: hash={digest} <<ccr:{digest}>>"
            if len(text + marker) >= len(inp.content):
                return original()
            # Store before emitting a marker; an unavailable store must retain the original.
            from headroom.cache.compression_store import get_compression_store
            store = get_compression_store()
            store.store(original=inp.content, compressed=text + marker,
                        compression_strategy="external:supercompress", explicit_hash=digest)
            return CompressOutput(
                text + marker, 0, 0, False,
                markers=[digest], recoverable={digest: inp.content},
            )
        except Exception as error:
            logger.warning("SC fallback exception_type=%s", type(error).__name__)
            return original()
