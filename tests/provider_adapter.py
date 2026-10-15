"""R3/R4: native frames -> core once -> stable replay; preserve protocol and original on faults."""
import asyncio
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('provider', Path(__file__).parents[1] / 'integrations/provider/agentq_provider.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
RAW = 'test sample ... ok\n' * 200 + '\n180 passed; 1 failed\nAGENTQ_CHECK_ERROR\n'
WRAPPED = 'Chunk ID: native\nProcess exited with code 101\nFinal output:\n' + RAW
CALL = dict(type='function_call', call_id='call-native', name='functions.exec_command', arguments=json.dumps(dict(cmd='cargo test --color never')))
BODY = dict(type='response.create', model='unchanged-model', instructions='Never change 12; do not remove negatives.', input=[
    dict(type='reasoning', encrypted_content='opaque-signed-payload'),
    dict(type='function_call_output', call_id='call-native', output=WRAPPED)])


class ProviderChain(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = p.State(self.tmp.name, '/agentq')
        self.state.observe('native-session', dict(type='response.output_item.done', item=CALL))
        self.requests = []

    def compress(self, *args, **kwargs):
        request = json.loads(kwargs['input'])
        self.requests.append(request)
        return subprocess.CompletedProcess([], 0, json.dumps(dict(text='180 passed; 1 failed\nAGENTQ_CHECK_ERROR\n[original rtk:fixture]', ref='rtk:fixture')), '')

    def test_native_shapes_replay_session_isolation_and_restart(self):
        for shape in [WRAPPED, [dict(type='input_text', text=WRAPPED), dict(type='image_url', image_url='opaque-image')],
                      json.dumps(dict(output=RAW, metadata=dict(exit_code=101, duration=2)))]:
            with self.subTest(shape=type(shape).__name__):
                body = copy.deepcopy(BODY)
                body['input'][-1]['output'] = shape
                session = p.digest(shape)
                self.state.observe(session, CALL)
                with patch.object(p.subprocess, 'run', side_effect=self.compress) as core:
                    result = self.state.transform(session, body)
                    self.assertNotEqual(result, body)
                    self.assertEqual(body['input'][0], result['input'][0])
                    self.assertEqual(body['instructions'], result['instructions'])
                    self.assertEqual(self.state.transform(session, body), result)
                    restarted = p.State(self.tmp.name, '/agentq')
                    self.assertEqual(restarted.transform(session, body), result)
                    self.assertEqual(core.call_count, 1)
                    self.assertEqual(self.state.transform('other-session', body), body)
                self.assertEqual(self.requests[-1]['session'], session)
                self.assertEqual(self.requests[-1]['tool_call'], 'call-native')
                self.assertEqual(self.requests[-1]['exit_code'], 101)
                self.assertEqual(self.requests[-1]['text'], RAW)
        wrapped = dict(type='response.create', response=copy.deepcopy(BODY), opaque='keep')
        self.state.observe('wrapped-session', CALL)
        with patch.object(p.subprocess, 'run', side_effect=self.compress):
            result = self.state.transform('wrapped-session', wrapped)
        self.assertEqual(result['opaque'], 'keep')
        self.assertNotEqual(result['response'], wrapped['response'])
        self.assertEqual(p.native_text('not a native result'), None)

    def test_recorded_codex_code_mode_carrier(self):
        fixture=json.loads((Path(__file__).parent/'fixtures/codex-code-mode.json').read_text())
        self.state.observe('native-recorded-session',dict(type='response.output_item.done',item=fixture['call']))
        body=dict(type='response.create',input=[fixture['output']],reasoning=dict(effort='low'))
        with patch.object(p.subprocess,'run',side_effect=self.compress) as core:
            result=self.state.transform('native-recorded-session',body)
        self.assertNotEqual(result,body)
        self.assertEqual(core.call_count,1)
        self.assertEqual(self.requests[-1]['command'],'cargo test --color never -- --test-threads=1')
        self.assertEqual(result['input'][0]['output'][0],fixture['output']['output'][0])
        self.assertEqual(result['reasoning'],body['reasoning'])
        for code in ["await tools.exec_command({cmd: userInput})", "const r=await tools.exec_command({cmd: load()});text(r);", "const r=await tools.exec_command({cmd:\"cargo\"+x});text(r);"]:
            self.assertIsNone(p.code_mode_command(code))

    def test_failure_and_changed_history_keep_original(self):
        with patch.object(p.subprocess, 'run', side_effect=subprocess.TimeoutExpired('agentq', 4)) as core:
            self.assertEqual(self.state.transform('native-session', BODY), BODY)
            self.assertEqual(self.state.transform('native-session', BODY), BODY)
            self.assertEqual(core.call_count, 1, 'a failed result is frozen too')
        changed = copy.deepcopy(BODY)
        changed['input'][-1]['output'] += 'later bytes'
        with patch.object(p.subprocess, 'run') as core:
            self.assertEqual(self.state.transform('native-session', changed), changed)
            core.assert_not_called()
        path = self.state.root / (p.digest('native-session') + '.json')
        path.write_text('{broken')
        with patch.object(p.subprocess, 'run') as core:
            self.assertEqual(self.state.transform('native-session', BODY), BODY)
            core.assert_not_called()

    def test_capacity_and_invalid_replay_preserve_original(self):
        with patch.object(p, 'LIMIT', 1), patch.object(p.subprocess, 'run', side_effect=self.compress):
            self.assertEqual(self.state.transform('native-session', BODY), BODY)
        path = self.state.root / (p.digest('native-session') + '.json')
        for invalid in [[], {"call": {"input": 4, "output": "bad"}}, {"call": {"input": "hash", "output": 4}}]:
            path.write_text(json.dumps(invalid))
            with patch.object(p.subprocess, 'run') as core:
                self.assertEqual(self.state.transform('native-session', BODY), BODY)
                core.assert_not_called()

    def test_http_empty_and_interrupted_body(self):
        async def exercise(queue):
            original = copy.deepcopy(queue)
            seen = []
            async def receive(): return queue.pop(0)
            async def send(event): pass
            async def app(scope, receive, send):
                for _ in original: seen.append(await receive())
            scope = dict(type='http', path='/v1/responses', headers=[(b'thread-id', b'native-session')])
            with patch.object(p.subprocess, 'run') as core:
                await p.Adapter(app, self.state)(scope, receive, send)
                core.assert_not_called()
            self.assertEqual(seen, original)
        asyncio.run(exercise([dict(type='http.request', body=b'', more_body=False)]))
        asyncio.run(exercise([dict(type='http.request', body=b'{partial', more_body=True), dict(type='http.disconnect')]))

    def test_http_fragments_and_websocket_cancellation(self):
        async def exercise(transport):
            received, sent = [], []
            raw = json.dumps(BODY).encode()
            if transport == 'http':
                queue = [dict(type='http.request', body=raw[:20], more_body=True), dict(type='http.request', body=raw[20:], more_body=False)]
            else:
                queue = [dict(type='websocket.connect'), dict(type='websocket.receive', text=raw.decode()), dict(type='websocket.receive', text='{"type":"response.cancel"}')]
            async def receive(): return queue.pop(0)
            async def send(event): sent.append(event)
            async def app(scope, receive, send):
                for _ in range(1 if transport == 'http' else 3): received.append(await receive())
                opaque = '{"type":"response.reasoning.delta","encrypted_content":"unchanged"}'
                await send(dict(type='websocket.send', text=opaque) if transport=='websocket' else dict(type='http.response.body', body=('data: '+opaque+'\n\n').encode()))
            scope = dict(type=transport, path='/v1/responses', headers=[(b'thread-id', b'native-session'),(b'session-id',b'transport-session'),(b'authorization',b'unchanged'),(b'content-length',str(len(raw)).encode())])
            with patch.object(p.subprocess, 'run', side_effect=self.compress):
                await p.Adapter(app, self.state)(scope, receive, send)
            value = json.loads(received[0]['body'] if transport=='http' else received[1]['text'])
            self.assertIn('rtk:fixture', str(value))
            if transport=='websocket': self.assertEqual(received[2]['text'], '{"type":"response.cancel"}')
            self.assertIn('unchanged', str(sent))
        asyncio.run(exercise('http'))
        asyncio.run(exercise('websocket'))


if __name__ == '__main__':
    unittest.main()
