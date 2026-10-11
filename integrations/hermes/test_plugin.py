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
