import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('agent_context_plugin', Path(__file__).parent / 'agent-context/__init__.py')
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

class Context:
    def __init__(self, url='http://127.0.0.1:18787'): self.url, self.hooks, self.tools = url, {}, {}
    def get_config(self, key, default=None): return self.url if key == 'proxy_url' else default
    def register_hook(self, name, handler): self.hooks[name] = handler
    def register_tool(self, **value): self.tools[value['name']] = value

class PluginTest(unittest.TestCase):
    def test_native_envelopes_compress_only_payload_and_preserve_metadata(self):
        ctx = Context(); plugin.register(ctx)
        ctx.hooks['pre_llm_call']('Exact question', session_id='one', turn_id='turn')
        text = 'routine line\n' * 300
        compressed = 'important fact <<ccr:0123456789abcdef>>'
        class Reply:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return json.dumps({'messages': [{'content': compressed}]}).encode()
        for tool, field in [('terminal', 'output'), ('read_file', 'content')]:
            envelope = {field: text, 'exit_code': 7, 'error': 'ERROR keep me', 'truncated': True, 'extra': {'nested': [1, None]}}
            with patch('urllib.request.urlopen', return_value=Reply()) as request:
                result = ctx.hooks['transform_tool_result'](tool, json.dumps(envelope), session_id='one', turn_id='turn')
                body = json.loads(request.call_args.args[0].data)
                self.assertEqual(body['messages'][-1]['content'], text)
                self.assertEqual(body['messages'][0]['content'], 'Exact question')
                self.assertEqual(json.loads(result), {**envelope, field: compressed})
            with patch('urllib.request.urlopen', side_effect=OSError):
                self.assertIsNone(ctx.hooks['transform_tool_result'](tool, json.dumps(envelope), session_id='one', turn_id='turn'))

    def test_unrecognized_envelopes_are_passed_intact(self):
        ctx = Context(); plugin.register(ctx)
        ctx.hooks['pre_llm_call']('Question', session_id='one', turn_id='turn')
        for tool, content in [('mcp_example', json.dumps({'output': 'x' * 3000})),
                              ('terminal', json.dumps({'output': ['x' * 3000]})),
                              ('terminal', '["' + 'x' * 3000 + '"]'),
                              ('terminal', '{broken ' + 'x' * 3000)]:
            with patch('urllib.request.urlopen', side_effect=OSError) as request:
                self.assertIsNone(ctx.hooks['transform_tool_result'](tool, content, session_id='one', turn_id='turn'))
                self.assertEqual(json.loads(request.call_args.args[0].data)['messages'][-1]['content'], content)

    def test_small_payload_and_no_gain_leave_original_envelope(self):
        ctx = Context(); plugin.register(ctx)
        ctx.hooks['pre_llm_call']('Question', session_id='one', turn_id='turn')
        with patch('urllib.request.urlopen') as request:
            self.assertIsNone(ctx.hooks['transform_tool_result']('terminal', json.dumps({'output': 'short', 'error': 'x' * 3000}), session_id='one', turn_id='turn'))
            request.assert_not_called()
        text = 'routine ' * 500
        class Reply:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return json.dumps({'messages': [{'content': text}]}).encode()
        with patch('urllib.request.urlopen', return_value=Reply()):
            self.assertIsNone(ctx.hooks['transform_tool_result']('terminal', json.dumps({'output': text, 'exit_code': 0}), session_id='one', turn_id='turn'))

    def test_all_tools_exact_query_and_session_isolation(self):
        ctx = Context(); plugin.register(ctx)
        text = 'routine ' * 1000
        ctx.hooks['pre_llm_call']('Exact question', session_id='one', turn_id='turn')
        class Reply:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return json.dumps({'messages': [{'role': 'user', 'content': 'Exact question'}, {'role': 'tool', 'content': 'small <<ccr:0123456789abcdef>>'}]}).encode()
        with patch('urllib.request.urlopen', return_value=Reply()) as request:
            for tool in ['terminal', 'read_file', 'web_extract', 'mcp_example']:
                self.assertIn('<<ccr:', ctx.hooks['transform_tool_result'](tool, text, session_id='one', turn_id='turn'))
                body = json.loads(request.call_args.args[0].data)
                self.assertEqual(body['messages'][0]['content'], 'Exact question')
            calls = request.call_count
            self.assertIsNone(ctx.hooks['transform_tool_result']('read_file', text, session_id='other', turn_id='turn'))
            self.assertIsNone(ctx.hooks['transform_tool_result']('agent_context_retrieve', text, session_id='one', turn_id='turn'))
            self.assertEqual(request.call_count, calls)
            ctx.hooks['post_llm_call'](session_id='one', turn_id='turn')
            self.assertIsNone(ctx.hooks['transform_tool_result']('read_file', text, session_id='one', turn_id='turn'))
        with patch('urllib.request.urlopen', side_effect=OSError):
            ctx.hooks['pre_llm_call']('Query', session_id='one', turn_id='turn')
            self.assertIsNone(ctx.hooks['transform_tool_result']('terminal', text, session_id='one', turn_id='turn'))
    def test_lifecycle_runs_once_per_session_and_again_after_proxy_failure(self):
        ctx = Context(); ctx.get_config = lambda key, default=None: {'proxy_url': ctx.url, 'node': 'node', 'launcher': 'launcher.mjs'}.get(key, default)
        plugin.register(ctx)
        with patch('subprocess.run') as run:
            ctx.hooks['pre_llm_call']('Query', session_id='one', turn_id='a')
            ctx.hooks['pre_llm_call']('Query', session_id='one', turn_id='b')
            self.assertEqual(run.call_count, 1)
            with patch('urllib.request.urlopen', side_effect=OSError):
                self.assertIsNone(ctx.hooks['transform_tool_result']('terminal', 'x' * 4096, session_id='one', turn_id='b'))
            ctx.hooks['pre_llm_call']('Query', session_id='one', turn_id='c')
            ctx.hooks['pre_llm_call']('Query', session_id='two', turn_id='a')
            self.assertEqual(run.call_count, 3)
    def test_nonlocal_proxy_is_rejected(self):
        for url in ['https://example.com', 'http://127.0.0.1:12/path', 'http://secret@127.0.0.1:12']:
            with self.assertRaises(ValueError): plugin.register(Context(url))

if __name__ == '__main__': unittest.main()
