import asyncio
import gzip
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('collector', Path(__file__).parent / 'agent_context_headroom/collector.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class CollectorTests(unittest.IsolatedAsyncioTestCase):
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
