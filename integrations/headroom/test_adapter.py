import json
import asyncio
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from agent_context_headroom import Supercompress
from headroom.transforms.compressor_registry import CompressInput, CompressorRegistry


class AdapterTest(unittest.TestCase):
    def test_accounting_excludes_user_prompt_and_counts_protected_unchanged_tool_text(self):
        from agent_context_headroom.observability import account_tool_context, compression_status
        before = [{'role': 'user', 'content': 'private user query'}, {'role': 'tool', 'content': 'long tool context'}, {'role': 'user', 'content': [{'type': 'tool_result', 'content': 'ERROR retain'}, {'type': 'text', 'text': 'user words'}]}]
        after = [{'role': 'user', 'content': 'private user query'}, {'role': 'tool', 'content': 'short'}, {'role': 'user', 'content': [{'type': 'tool_result', 'content': 'ERROR retain'}]}]
        prior = compression_status()['tool_context']
        account_tool_context(before, after)
        current = compression_status()['tool_context']
        self.assertEqual(current.get('input_chars', 0) - prior.get('input_chars', 0), len('long tool context') + len('ERROR retain'))
        self.assertEqual(current.get('compressed', 0) - prior.get('compressed', 0), 1)
        self.assertEqual(current.get('passthrough', 0) - prior.get('passthrough', 0), 1)

    def test_compression_failures_have_error_level_while_normal_skip_does_not(self):
        from agent_context_headroom.observability import record_compression
        class Span:
            def __init__(self): self.values = {}
            def set_attribute(self, key, value): self.values[key] = value
            def set_status(self, status): self.status = status
        for outcome, error in [('timeout', True), ('no_gain', False), ('request_budget', False)]:
            span = Span()
            with patch('opentelemetry.trace.get_current_span', return_value=span): record_compression(outcome, 100, 100, 1)
            self.assertEqual(span.values.get('langfuse.observation.level') == 'ERROR', error)

    def test_langfuse_reuses_only_this_profiles_existing_source(self):
        from agent_context_headroom.observability import configure_environment
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / '.hermes').mkdir()
            (home / '.hermes/.env').write_text('HERMES_LANGFUSE_PUBLIC_KEY="synthetic-public"\nHERMES_LANGFUSE_SECRET_KEY="synthetic-secret"\nHERMES_LANGFUSE_BASE_URL=https://example.invalid\nUNRELATED_PRIVATE_KEY=must-not-be-exported\n')
            with patch.dict(os.environ, {'AGENT_CONTEXT_LANGFUSE': '1', 'AGENT_CONTEXT_HOME': directory}, clear=True):
                self.assertTrue(configure_environment())
                self.assertEqual(os.environ['LANGFUSE_PUBLIC_KEY'], 'synthetic-public')
                self.assertNotIn('UNRELATED_PRIVATE_KEY', os.environ)
            with patch.dict(os.environ, {'AGENT_CONTEXT_LANGFUSE': '1', 'AGENT_CONTEXT_HOME': str(home / 'other-profile')}, clear=True):
                self.assertFalse(configure_environment())
                self.assertNotIn('LANGFUSE_SECRET_KEY', os.environ)

    def test_explicit_profile_never_resolves_the_operating_system_home(self):
        from agent_context_headroom.observability import configure_environment
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {'AGENT_CONTEXT_LANGFUSE': '1', 'AGENT_CONTEXT_HOME': directory}, clear=True), patch('pathlib.Path.home', side_effect=RuntimeError('home unavailable')):
                self.assertFalse(configure_environment())

    def test_invalid_optional_telemetry_is_fail_open(self):
        from agent_context_headroom.observability import configure_environment
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'config.json'
            file.write_text('{invalid')
            with patch.dict(os.environ, {'AGENT_CONTEXT_LANGFUSE': '1', 'AGENT_CONTEXT_LANGFUSE_CONFIG': str(file), 'AGENT_CONTEXT_HOME': directory}, clear=True):
                self.assertFalse(configure_environment())
                self.assertEqual(os.environ['HEADROOM_LANGFUSE_ENABLED'], 'false')

    def test_concurrent_native_identity_and_empty_user_are_isolated(self):
        from agent_context_headroom.request_context import CurrentRequest, query
        from agent_context_headroom.observability import identity
        async def run():
            ready = asyncio.Event()
            seen = []
            async def connection(name):
                messages = iter([
                    {'type': 'websocket.receive', 'text': json.dumps({'client_metadata': {'thread_id': name, 'turn_id': 'turn-' + name}, 'input': [{'role': 'user', 'content': name}]})},
                    {'type': 'websocket.receive', 'text': json.dumps({'input': [{'role': 'user', 'content': ''}]})},
                ])
                async def receive(): return next(messages)
                async def app(scope, receive, send):
                    await receive()
                    seen.append(name)
                    if len(seen) == 2: ready.set()
                    await ready.wait()
                    self.assertEqual(query.get(), name)
                    self.assertEqual(identity.get()['session.id'], name)
                    self.assertEqual(identity.get()['agent_context.turn_id'], 'turn-' + name)
                    await receive()
                    self.assertEqual(query.get(), '')
                await CurrentRequest(app)({'type': 'websocket'}, receive, None)
                self.assertEqual(identity.get(), {})
                self.assertEqual(query.get(), '')
            await asyncio.gather(connection('one'), connection('two'))
        asyncio.run(run())

    def test_request_query_is_exact_and_cannot_leak_between_connections(self):
        from agent_context_headroom.request_context import CurrentRequest, query, current_query
        user = 'Exact user question with numbers 6543 and quoted text.'
        self.assertEqual(current_query({'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': user}]}]}), user)
        seen = []
        async def app(scope, receive, send):
            await receive()
            seen.append(query.get())
            await receive()
            seen.append(query.get())
        async def run():
            for text in [user, 'Other isolated connection']:
                messages = iter([{'type': 'websocket.receive', 'text': json.dumps({'input': [{'role': 'user', 'content': text}]})}, {'type': 'websocket.receive', 'text': json.dumps({'input': [{'type': 'function_call_output', 'output': 'result'}]})}])
                async def receive(): return next(messages)
                await CurrentRequest(app)({'type': 'websocket'}, receive, None)
                self.assertEqual(query.get(), '')
        asyncio.run(run())
        self.assertEqual(seen, [user, user, 'Other isolated connection', 'Other isolated connection'])

    def test_missing_query_is_passthrough_and_tracing_has_no_generation_usage(self):
        from agent_context_headroom.observability import CorrelatedTracer
        with patch('subprocess.run', side_effect=AssertionError('missing query must not call SC')):
            value = 'routine output ' * 500
            self.assertEqual(Supercompress().compress(CompressInput(value, 'text/plain', '')).content, value)
        class Delegate:
            def start_as_current_span(self, name, *, attributes): return attributes
        values = CorrelatedTracer(Delegate()).start_as_current_span('compress', attributes={'headroom.tokens.before': 400})
        self.assertEqual(values['langfuse.observation.type'], 'span')
        self.assertFalse(any(key.startswith('gen_ai.usage') for key in values))

    def test_compression_span_has_native_session_host_runtime_and_no_raw_content(self):
        from agent_context_headroom.observability import CorrelatedTracer, identity
        class Delegate:
            def start_as_current_span(self, name, *, attributes): return attributes
        token = identity.set({'session.id': 'native-session', 'agent_context.turn_id': 'native-turn'})
        try:
            with patch.dict(os.environ, {'AGENT_CONTEXT_HOST': 'fra', 'AGENT_CONTEXT_RUNTIME': 'native', 'AGENT_CONTEXT_AGENT': 'hermes'}):
                values = CorrelatedTracer(Delegate()).start_as_current_span('compress')
                self.assertEqual(values['langfuse.session.id'], 'native-session')
                self.assertEqual(values['agent_context.turn_id'], 'native-turn')
                self.assertIn('host:fra', values['langfuse.trace.tags'])
                self.assertIn('runtime:native', values['langfuse.trace.tags'])
                self.assertEqual(values['agent_context.compressor'], 'supercompress')
        finally:
            identity.reset(token)

    def test_entrypoint(self):
        registry = CompressorRegistry()
        registry.discover()
        self.assertIsNotNone(registry.get("supercompress"))

    def test_retrieval_delta_is_not_compressed_again(self):
        reply = json.dumps({"content": [{"type": "text", "text": json.dumps({
            "source": "proxy", "hash": "abc123", "original_content": "fact " * 1000,
        })}]})
        with patch("subprocess.run", side_effect=AssertionError("retrieval must never call SC")):
            self.assertEqual(Supercompress().compress(CompressInput(reply, "text/plain", "query")).content, reply)

    def test_recovery_and_failures_preserve_original(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = Path(directory) / "bridge.js"
            bridge.touch()
            inp = CompressInput("routine result " * 500, "text/plain", "exact user question")
            with patch.dict(os.environ, {"AGENT_CONTEXT_BRIDGE": str(bridge), "AGENT_CONTEXT_NODE": "node"}):
                response = subprocess.CompletedProcess([], 0, json.dumps({"compressed_text": "retained result", "skipped": None}), "")
                with patch("subprocess.run", return_value=response) as run:
                    from agent_context_headroom.observability import identity
                    token = identity.set({'session.id': 'native-session'})
                    try:
                        with patch.dict(os.environ, {'AGENT_CONTEXT_AGENT': 'codex'}):
                            result = Supercompress().compress(inp)
                    finally:
                        identity.reset(token)
                    self.assertEqual(json.loads(run.call_args.kwargs["input"])["query"], inp.query)
                    self.assertEqual(json.loads(run.call_args.kwargs["input"])["session"], 'native-session')
                    self.assertEqual(json.loads(run.call_args.kwargs["input"])["agent"], 'codex')
                    self.assertLess(len(result.content), len(inp.content))
                    digest = next(iter(result.recoverable))
                    from headroom.cache.compression_store import get_compression_store
                    recovered = get_compression_store().retrieve(digest)
                    self.assertIsNotNone(recovered)
                    self.assertEqual(recovered.original_content, inp.content)
                for response in [
                    subprocess.CompletedProcess([], 1, "", "private stderr"),
                    subprocess.CompletedProcess([], 0, "invalid", ""),
                    subprocess.CompletedProcess([], 0, json.dumps({"compressed_text": "", "skipped": "timeout"}), ""),
                ]:
                    with patch("subprocess.run", return_value=response):
                        self.assertEqual(Supercompress().compress(inp).content, inp.content)
                with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, json.dumps({"compressed_text": "short"}), "")), patch("headroom.cache.compression_store.get_compression_store", side_effect=OSError):
                    self.assertEqual(Supercompress().compress(inp).content, inp.content)


if __name__ == "__main__":
    unittest.main()
