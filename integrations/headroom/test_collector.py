import asyncio
import gzip
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import time
import urllib.error
import urllib.request
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('collector', Path(__file__).parent / 'agent_context_headroom/collector.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class CollectorTests(unittest.IsolatedAsyncioTestCase):
    def test_sender_lease_is_exclusive_and_released_on_failure(self):
        from agent_context_headroom.collector import sender_lease
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            with sender_lease(target) as first:
                self.assertTrue(first)
                with sender_lease(target) as second:
                    self.assertFalse(second)
            with self.assertRaises(RuntimeError):
                with sender_lease(target) as acquired:
                    self.assertTrue(acquired)
                    raise RuntimeError('fixture abort')
            with sender_lease(target) as recovered:
                self.assertTrue(recovered)

    def test_short_enrolled_proxy_keeps_final_spans_when_gateway_is_down(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / '.agent-context').mkdir()
            device = dict(gateway='https://127.0.0.1:1', device='d' * 32, token='acd_' + 'e' * 64)
            (home / '.agent-context/enrollment.json').write_text(json.dumps(device))
            cli = Path(__file__).resolve().parents[2] / 'bin/agent-context.js'
            (home / '.agent-context/launcher.mjs').write_text('import ' + json.dumps(cli.as_uri()) + ';\n')
            ready = home / 'ready.json'
            env = {**os.environ, 'AGENT_CONTEXT_HOME': directory, 'AGENT_CONTEXT_PROXY_PORT': '0',
                   'AGENT_CONTEXT_READY_FILE': str(ready), 'AGENT_CONTEXT_CONTROL_KEY': 'test-control',
                   'AGENT_CONTEXT_LANGFUSE': '1', 'AGENT_CONTEXT_AGENT': 'hermes',
                   'AGENT_CONTEXT_HOST': 'test', 'AGENT_CONTEXT_STAGE': 'qualification',
                   'HEADROOM_OFFLINE': '0'}  # This fixture exports to its own loopback collector.
            with (home / 'proxy.log').open('w') as log:
                child = subprocess.Popen([sys.executable, '-m', 'agent_context_headroom.proxy'], env=env, stdout=log, stderr=log)
                try:
                    deadline = time.monotonic() + 30
                    while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.05)
                    self.assertTrue(ready.exists(), 'Owned proxy did not start')
                    base = 'http://127.0.0.1:' + str(json.loads(ready.read_text())['port'])
                    while time.monotonic() < deadline:
                        try:
                            with urllib.request.urlopen(base + '/agent-context/health', timeout=1):
                                break
                        except OSError:
                            self.assertIsNone(child.poll(), 'Owned proxy exited during startup')
                            time.sleep(0.05)
                    else:
                        self.fail('Owned proxy never became healthy')
                    body = {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'Find the important fact'},
                            {'role': 'tool', 'content': 'Routine work completed successfully.\n' * 160 + 'Important fact: amber-47 uses port 6543.'}]}
                    request = urllib.request.Request(base + '/v1/compress', data=json.dumps(body).encode(),
                              headers={'Content-Type': 'application/json', 'x-session-id': 'shutdown-session'})
                    with urllib.request.urlopen(request, timeout=15) as response:
                        self.assertEqual(response.status, 200)
                    request = urllib.request.Request(base + '/agent-context/shutdown', data=b'',
                              headers={'x-agent-context-control': 'test-control'})
                    deadline = time.monotonic() + 20
                    while True:
                        try:
                            with urllib.request.urlopen(request, timeout=15) as response:
                                self.assertEqual(response.status, 200)
                            break
                        except urllib.error.HTTPError as error:
                            if error.code != 409 or time.monotonic() >= deadline:
                                raise
                            time.sleep(0.05)  # The last OTLP batch may still be arriving.
                    self.assertEqual(child.wait(timeout=20), 0)
                    packets = list((home / '.agent-context/telemetry-outbox').rglob('*.json'))
                    self.assertTrue(packets, 'Final spans were lost instead of queued')
                    self.assertIn('shutdown-session', ''.join(p.read_text() for p in packets))
                finally:
                    if child.poll() is None:
                        child.terminate()
                        child.wait(timeout=10)

    def test_identity_overrides_exporter_aliases_without_changing_event_ids(self):
        payload = {'resourceSpans': [{'resource': {'attributes': [
            {'key': 'user.id', 'value': {'stringValue': 'email@example.invalid'}}]},
            'scopeSpans': [{'spans': [{'traceId': 'a' * 32, 'spanId': 'b' * 16,
                'attributes': [{'key': 'langfuse.observation.metadata', 'value': {'stringValue': '{"native.step":2}'}}, {'key': 'user.id', 'value': {'stringValue': 'email@example.invalid'}},
                    {'key': 'langfuse.session.id', 'value': {'stringValue': 'native-session'}},
                    {'key': 'langfuse.trace.tags', 'value': {'stringValue': '["user:old","host:old","owner:keep"]'}}]}]}]}]}
        with patch.dict(os.environ, {'AGENT_CONTEXT_HOST': 'test', 'AGENT_CONTEXT_AGENT': 'codex'}):
            for user in ('employee', None):
                result = json.loads(collector.label_payload(json.dumps(payload).encode(), user))
                span = result['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
                attrs = {a['key']: a['value'] for a in span['attributes']}
                self.assertEqual(span['traceId'], 'a' * 32)
                self.assertEqual(attrs['langfuse.session.id']['stringValue'], 'native-session')
                self.assertNotIn('email@example.invalid', json.dumps(result))
                metadata = json.loads(attrs['langfuse.observation.metadata']['stringValue'])
                self.assertEqual(metadata['native.step'], 2)
                self.assertEqual(metadata['attributes.agent_context.telemetry.schema'], 1)
                self.assertEqual(attrs['langfuse.observation.metadata.attributes.agent_context.telemetry.schema'], {'intValue': '1'})
                self.assertEqual(attrs['langfuse.observation.metadata.attributes.agent_context.host']['stringValue'], 'test')
                self.assertEqual(attrs.get('user.id'), {'stringValue': user} if user else None)
                self.assertIn('owner:keep', json.dumps(result))

    async def test_direct_collector_retains_partial_rejection_then_replays_same_ids(self):
        from fastapi import FastAPI
        import httpx
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / '.codex').mkdir()
            config = {'public_key': 'synthetic-public', 'secret_key': 'synthetic-secret',
                      'base_url': 'http://127.0.0.1:18787', 'agent_context_base_url': 'https://lf.invalid', 'user_id': 'employee'}
            (home / '.codex/langfuse.json').write_text(json.dumps(config))
            with patch.dict(os.environ, {'AGENT_CONTEXT_HOME': directory, 'AGENT_CONTEXT_PROXY_PORT': '18787',
                                        'AGENT_CONTEXT_LANGFUSE_CONFIG': str(home / '.codex/langfuse.json')}):
                app = FastAPI()
                self.assertTrue(collector.attach_collector(app))
                auth = 'Basic ' + collector.base64.b64encode(b'synthetic-public:synthetic-secret').decode()
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://local') as client:
                    unsupported = await client.post('/api/public/media', headers={'Authorization': auth}, json={})
                    self.assertEqual(unsupported.status_code, 501)
                    result = await client.post('/api/public/otel/v1/traces', headers={'Authorization': auth}, json={'resourceSpans': []})
                    self.assertEqual(result.status_code, 200)
                queue = list((home / '.agent-context/telemetry-outbox').rglob('*.json'))
                attempts = []
                async def receive(request):
                    self.assertEqual(str(request.url), 'https://lf.invalid/api/public/otel/v1/traces')
                    self.assertEqual(request.headers['Authorization'], auth)
                    self.assertEqual(request.headers['x-langfuse-ingestion-version'], '4')
                    attempts.append(request.content)
                    return httpx.Response(200, json={'partialSuccess': {'rejectedSpans': 1}} if len(attempts) == 1 else {})
                real_client = httpx.AsyncClient
                with patch.object(collector.httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(receive), **kw)):
                    await app.state.agent_context_flush()
                    self.assertTrue(queue[0].exists())
                    self.assertEqual(app.state.agent_context_collector_status(), {'failures': 1, 'lastError': 'partial_rejection'})
                    original_destination = config['agent_context_base_url']
                    config['agent_context_base_url'] = 'https://other.invalid'
                    (home / '.codex/langfuse.json').write_text(json.dumps(config))
                    await app.state.agent_context_flush()
                    self.assertEqual(len(attempts), 1, 'Old queue must not cross destinations')
                    config['agent_context_base_url'] = original_destination
                    (home / '.codex/langfuse.json').write_text(json.dumps(config))
                    await app.state.agent_context_flush()
                    self.assertFalse(queue[0].exists())
                    self.assertEqual(app.state.agent_context_collector_status(), {'failures': 1, 'lastError': None})
                    self.assertEqual(attempts[0], attempts[1])
                config.pop('agent_context_base_url')
                (home / '.codex/langfuse.json').write_text(json.dumps(config))
                self.assertRaises(ValueError, collector.collector_config)

    def test_windows_outbox_uses_the_private_writer_stdin_without_creating_a_plaintext_file(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory) / 'queue'
            data = b'{"resourceSpans":[]}'
            fake_os = SimpleNamespace(name='nt', environ={'AGENT_CONTEXT_HOME': directory, 'AGENT_CONTEXT_NODE': 'node-fixture'})
            with patch.object(collector, 'os', fake_os), patch('subprocess.run') as run:
                collector.enqueue(queue, data)
                args = run.call_args.args[0]
                self.assertEqual(args[2:4], ['telemetry', 'enqueue'])
                self.assertEqual(run.call_args.kwargs['input'], data)
                self.assertNotIn(data.decode(), ' '.join(args))
                self.assertEqual(list(queue.iterdir()), [])

    def test_protobuf_and_gzip_keep_native_ids_and_attributes(self):
        from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
        message = ExportTraceServiceRequest()
        span = message.resource_spans.add().scope_spans.add().spans.add()
        span.trace_id = bytes.fromhex('a' * 32)
        span.span_id = bytes.fromhex('b' * 16)
        span.name = 'native generation'
        attr = span.attributes.add()
        attr.key = 'gen_ai.usage.input_tokens'
        attr.value.int_value = 42
        value = json.loads(collector.decode_otlp(gzip.compress(message.SerializeToString()), 'application/x-protobuf', 'gzip'))
        result = value['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        self.assertEqual(result['traceId'], 'a' * 32)
        self.assertEqual(result['spanId'], 'b' * 16)
        self.assertEqual(result['attributes'][0]['value']['intValue'], '42')
        with self.assertRaises(ValueError):
            collector.decode_otlp(gzip.compress(b'x' * (collector.MAX_BODY + 1)), 'application/json', 'gzip')

    async def test_outage_retains_private_queue_restart_drains_and_unauthorized_input_is_rejected(self):
        from fastapi import FastAPI
        import httpx
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            device = dict(gateway='https://gateway.invalid', device='d' * 32, token='acd_' + 'e' * 64)
            (home / '.agent-context').mkdir()
            (home / '.agent-context/enrollment.json').write_text(json.dumps(device))
            cli = Path(__file__).resolve().parents[2] / 'bin/agent-context.js'
            (home / '.agent-context/launcher.mjs').write_text('import ' + json.dumps(cli.as_uri()) + ';\n')
            with patch.dict(os.environ, {'AGENT_CONTEXT_HOME': directory, 'AGENT_CONTEXT_AGENT': 'codex'}):
                app = FastAPI()
                self.assertTrue(collector.attach_collector(app))
                transport = httpx.ASGITransport(app)
                async with httpx.AsyncClient(transport=transport, base_url='http://local') as client:
                    self.assertEqual((await client.post('/api/public/otel/v1/traces', json={})).status_code, 401)
                    auth = 'Basic ' + collector.base64.b64encode(('pk-lf-device-' + device['device'] + ':sk-lf-device-' + device['token']).encode()).decode()
                    response = await client.post('/api/public/otel/v1/traces', headers={'Authorization': auth}, json={'resourceSpans': []})
                    self.assertEqual(response.status_code, 200)
                queue = list((home / '.agent-context/telemetry-outbox').rglob('*.json'))
                self.assertEqual(len(queue), 1)
                if os.name != 'nt':  # Windows ACLs are checked by the real private-file Node test.
                    self.assertEqual(queue[0].stat().st_mode & 0o777, 0o600)
                attempts = []
                async def receive(request):
                    attempts.append(request)
                    self.assertEqual(request.headers['Authorization'], 'Bearer ' + device['token'])
                    return httpx.Response(503 if len(attempts) == 1 else 200, json={})
                real_client = httpx.AsyncClient
                def fake_client(**kwargs):
                    return real_client(transport=httpx.MockTransport(receive), **kwargs)
                original_sleep = asyncio.sleep
                async def fast_sleep(_):
                    await original_sleep(0.01)
                restarted = FastAPI()
                collector.attach_collector(restarted)
                with patch.object(collector.httpx, 'AsyncClient', fake_client), patch.object(collector.asyncio, 'sleep', fast_sleep):
                    async with restarted.router.lifespan_context(restarted):
                        for _ in range(100):
                            if len(attempts) >= 2 and not queue[0].exists():
                                break
                            await original_sleep(0.01)
                        self.assertGreaterEqual(len(attempts), 2)
                        self.assertFalse(queue[0].exists())


if __name__ == '__main__':
    unittest.main()
