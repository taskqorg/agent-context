import json
import asyncio
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from agent_context_headroom import LocalText
from headroom.transforms.compressor_registry import CompressInput, CompressorRegistry


class AdapterTest(unittest.TestCase):
    def test_native_hermes_turn_id_survives_headers_and_body_validation(self):
        from agent_context_headroom.observability import RequestIdentity, identity
        from agent_context_headroom.request_context import CurrentRequest
        turn = 'session-one:6353306a-9c8a-4788-b0f8-4189b454f9d6:63da2176'
        async def run():
            for source in ['header', 'body']:
                for candidate, expected in [(turn, turn), ('bad\nheader', None), ('x' * 129, None)]:
                    async def receive():
                        return {'type': 'http.request', 'body': json.dumps({'client_metadata': {'thread_id': 'session-one', 'turn_id': candidate} if source == 'body' else {}}).encode()}
                    async def app(scope, receive, send):
                        await receive()
                        self.assertEqual(identity.get().get('agent_context.turn_id'), expected)
                        self.assertEqual(identity.get()['agent_context.native_turn_missing'], expected is None)
                    headers = [(b'x-session-id', b'session-one')]
                    if source == 'header': headers.append((b'x-turn-id', candidate.encode()))
                    await RequestIdentity(CurrentRequest(app))({'type': 'http', 'headers': headers}, receive, None)
                    self.assertEqual(identity.get(), {})
        asyncio.run(run())

    def test_claude_request_links_native_tool_ids_without_payloads_or_history(self):
        from agent_context_headroom.request_context import CurrentRequest, request_tool_result_ids
        from agent_context_headroom.observability import identity
        request = {'metadata': {'user_id': json.dumps({'session_id': 'session-one'})}, 'messages': [
            {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'old-tool'}]},
            {'role': 'user', 'content': [
                {'type': 'tool_result', 'tool_use_id': 'toolu_current', 'content': 'PRIVATE'},
                {'type': 'tool_result', 'tool_use_id': 'toolu_current'},
                {'type': 'tool_result', 'tool_use_id': 'invalid id PRIVATE'},
                {'type': 'text', 'text': 'PRIVATE'},
            ]},
        ]}
        self.assertEqual(request_tool_result_ids(request), ['toolu_current'])
        for invalid in [None, [], {'messages': None}, {'messages': ['bad']}, {'messages': [{'role': 'user', 'content': 'next question'}]}]:
            self.assertEqual(request_tool_result_ids(invalid), [])
        async def run():
            messages = iter([{'type': 'websocket.receive', 'text': json.dumps(request)},
                             {'type': 'websocket.receive', 'text': json.dumps({'messages': [{'role': 'user', 'content': 'next question'}]})}])
            async def receive(): return next(messages)
            async def app(scope, receive, send):
                await receive()
                self.assertEqual(identity.get()['session.id'], 'session-one')
                self.assertEqual(identity.get()['agent_context.request_tool_result_ids'], ['toolu_current'])
                self.assertNotIn('agent_context.turn_id', identity.get())
                self.assertNotIn('PRIVATE', json.dumps(identity.get()))
                await receive()
                self.assertNotIn('agent_context.request_tool_result_ids', identity.get())
            await CurrentRequest(app)({'type': 'websocket'}, receive, None)
            self.assertEqual(identity.get(), {})
        asyncio.run(run())

    def test_proxy_enables_structural_and_local_text_without_models(self):
        from agent_context_headroom import proxy
        from headroom.transforms.content_router import ContentRouter, CompressionStrategy
        checked = []
        telemetry_ports = []
        def configure_telemetry():
            telemetry_ports.append(int(os.environ['AGENT_CONTEXT_PROXY_PORT']))
            return True
        def inspect(runner, sockets):
            self.assertEqual(telemetry_ports, [sockets[0].getsockname()[1]])
            self.assertGreater(telemetry_ports[0], 0)
            app = runner.config.app
            pipelines = [app.state.proxy.anthropic_pipeline, app.state.proxy.openai_pipeline,
                         *app.state.proxy._compress_pipeline_cache.values()]
            for pipeline in pipelines:
                for router in pipeline.transforms:
                    if not isinstance(router, ContentRouter):
                        continue
                    self.assertFalse(router.config.enable_kompress)
                    self.assertFalse(router.config.relevance_split)
                    self.assertEqual(router.config.fallback_strategy, CompressionStrategy.PASSTHROUGH)
                    self.assertEqual(router.config.active_external_compressors, ['local-text'])
                    self.assertTrue(router.config.enable_smart_crusher)
                    self.assertTrue(router.config.enable_log_compressor)
                    self.assertFalse(router.config.enable_code_aware)
                    checked.append(router.eager_load_compressors())
                    rows = [{'id': i, 'status': 'ok', 'description': 'Routine background job completed successfully.'} for i in range(120)]
                    rows[37] = {'id': 37, 'status': 'failed', 'error': 'E42 do not retry until snapshot verified'}
                    raw = json.dumps(rows, indent=2)
                    with patch('socket.socket.connect', side_effect=AssertionError('No compression network')):
                        from agent_context_headroom.observability import record_compression
                        with patch('agent_context_headroom.observability.record_compression', wraps=record_compression) as record:
                            result = router.compress(raw, context='Find the failed job and its recovery rule').compressed
                            record.assert_called_once()
                            self.assertEqual(record.call_args.args[0], 'compressed')
                            self.assertEqual(record.call_args.args[1:3], (len(raw), len(result)))
                            self.assertGreaterEqual(record.call_args.args[3], 0)
                        self.assertLess(len(result), len(raw))
                        self.assertIn('E42', result)
                        reply = json.dumps({'source': 'proxy', 'hash': 'abc123', 'original_content': raw})
                        self.assertEqual(router.compress(reply).compressed, reply)
                        code = 'def keep_all(x):\n    return x + 12345\n' * 150
                        self.assertEqual(router.compress(code, context='Explain keep_all').compressed, code)
                        from headroom.tokenizers.estimator import EstimatingTokenCounter
                        messages = [{'role': 'system', 'content': raw}, {'role': 'user', 'content': raw}, {'role': 'tool', 'tool_call_id': 't', 'content': raw}]
                        transformed = router.apply(messages, EstimatingTokenCounter()).messages
                        self.assertEqual(transformed[0]['content'], raw)
                        self.assertEqual(transformed[1]['content'], raw)

        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'AGENT_CONTEXT_HOME': directory, 'AGENT_CONTEXT_PROXY_PORT': '0',
            'AGENT_CONTEXT_LANGFUSE': '0', 'AGENT_CONTEXT_COMPRESSOR': 'headroom-local',
        }), patch('agent_context_headroom.observability.configure_environment', side_effect=configure_telemetry), \
             patch('agent_context_headroom.observability.attach'), \
             patch.object(ContentRouter, 'apply', ContentRouter.apply), \
             patch.object(ContentRouter, 'compress', ContentRouter.compress), \
             patch.object(ContentRouter, '_get_kompress') as kompress, \
             patch.object(ContentRouter, '_prefetch_kompress_artifacts_async') as prefetch, \
             patch.object(proxy.uvicorn.Server, 'run', inspect):
            proxy.main()
            self.assertGreaterEqual(len(checked), 2)
            kompress.assert_not_called()
            prefetch.assert_not_called()
            self.assertEqual(os.environ['HF_HUB_OFFLINE'], '1')
            self.assertEqual(os.environ['TRANSFORMERS_OFFLINE'], '1')

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
        for outcome, error in [('neural_unavailable', True), ('timeout', True), ('no_gain', False), ('request_budget', False)]:
            span = Span()
            with patch('opentelemetry.trace.get_current_span', return_value=span): record_compression(outcome, 100, 100, 1)
            self.assertEqual(span.values.get('langfuse.observation.level') == 'ERROR', error)
            self.assertEqual(span.values['agent_context.compression.strategy'], 'local-text')
            self.assertEqual(span.values['agent_context.compression.elapsed_ms'], 1)

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
            self.assertEqual(LocalText().compress(CompressInput(value, 'text/plain', '')).content, value)
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
                self.assertEqual(values['agent_context.compressor'], 'local-tools')
        finally:
            identity.reset(token)

    def test_native_event_session_overrides_missing_request_session_flag(self):
        # R9: a loopback native event supplies identity outside model-request headers.
        from agent_context_headroom.observability import CorrelatedTracer, identity
        class Delegate:
            def start_as_current_span(self, name, *, attributes): return attributes
        token = identity.set({'agent_context.native_session_missing': True,
                              'agent_context.native_turn_missing': True})
        try:
            values = CorrelatedTracer(Delegate()).start_as_current_span(
                'agent-context.native-tool', attributes={'session.id': 'native-session'})
            self.assertEqual(values['langfuse.session.id'], 'native-session')
            self.assertFalse(values['agent_context.native_session_missing'])
            self.assertTrue(values['agent_context.native_turn_missing'])
        finally:
            identity.reset(token)

    def test_entrypoint(self):
        registry = CompressorRegistry()
        registry.discover()
        self.assertIsNotNone(registry.get("local-text"))

    def test_retrieval_delta_is_not_compressed_again(self):
        reply = json.dumps({"content": [{"type": "text", "text": json.dumps({
            "source": "proxy", "hash": "abc123", "original_content": "fact " * 1000,
        })}]})
        with patch("subprocess.run", side_effect=AssertionError("retrieval must never call SC")):
            self.assertEqual(LocalText().compress(CompressInput(reply, "text/plain", "query")).content, reply)

    def test_recovery_and_failures_preserve_original(self):
        inp = CompressInput("routine result " * 500, "text/plain", "exact user question")
        with patch("agent_context_headroom.compress_text", return_value="retained result"):
            result = LocalText().compress(inp)
            self.assertLess(len(result.content), len(inp.content))
            digest = next(iter(result.recoverable))
            from headroom.cache.compression_store import get_compression_store
            self.assertEqual(get_compression_store().retrieve(digest).original_content, inp.content)
            with patch("headroom.cache.compression_store.get_compression_store", side_effect=OSError):
                self.assertEqual(LocalText().compress(inp).content, inp.content)
        with patch("agent_context_headroom.compress_text", side_effect=RuntimeError('private')):
            self.assertEqual(LocalText().compress(inp).content, inp.content)

    @patch.dict(os.environ, {'AGENT_CONTEXT_COMPRESSOR': 'headroom-local'})
    def test_real_textcrusher_is_offline_and_retains_critical_lines(self):
        from agent_context_headroom import compress_text
        content = "\n".join(f"Section {i}: Routine reports are reviewed every week and archived by the coordinator." for i in range(70))
        content += "\nERROR E42: Do not restart billing until snapshot snap-7c9 is verified."
        with patch('socket.socket.connect', side_effect=AssertionError('No network')), patch('subprocess.run', side_effect=AssertionError('No bridge')):
            result = compress_text(content, 'Preserve E42 and its recovery restrictions')
        self.assertLess(len(result), len(content))
        self.assertIn('ERROR E42: Do not restart billing until snapshot snap-7c9 is verified.', result)
        with patch('headroom.transforms.text_crusher.TextCrusher.compress') as crush:
            crush.return_value.compressed = 'all good'
            self.assertEqual(compress_text(content, 'Preserve errors'), content)



if __name__ == "__main__":
    unittest.main()
