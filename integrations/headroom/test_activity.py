import asyncio
import unittest
from agent_context_headroom.activity import Activity, ActivityTracker


class ActivityTests(unittest.TestCase):
    def test_draining_keeps_authenticated_collector_route_available(self):
        async def scenario():
            tracker = ActivityTracker()
            await tracker.drain()
            called = []
            async def app(scope, receive, send): called.append(scope['path'])
            await Activity(app, tracker)({'type': 'http', 'path': '/api/public/otel/v1/traces'}, None, None)
            self.assertEqual(called, ['/api/public/otel/v1/traces'])
            self.assertEqual(tracker.requests, 0)
        asyncio.run(scenario())

    def test_websocket_update_preserves_request_and_closes_only_after_completion(self):
        async def scenario():
            tracker = ActivityTracker()
            started, finish, completed, disconnect = [asyncio.Event() for _ in range(4)]
            sent = []
            async def send(message):
                sent.append(message)
            messages = iter([{'type': 'websocket.receive', 'text': '{"type":"response.create"}'}])
            async def receive():
                return next(messages)
            async def app(scope, receive, send):
                await receive()
                started.set()
                await finish.wait()
                await send({'type': 'websocket.send', 'bytes': b'{"type":"response.completed"}'})
                completed.set()
                await disconnect.wait()
            task = asyncio.create_task(Activity(app, tracker)({'type': 'websocket', 'path': '/v1/responses'}, receive, send))
            await started.wait()
            self.assertEqual(tracker.requests, 1)
            self.assertFalse(await tracker.drain())
            self.assertFalse(tracker.stopping)
            finish.set()
            await completed.wait()
            self.assertEqual(tracker.connections, 1)
            self.assertTrue(await tracker.drain())
            self.assertEqual(sent[-1], {'type': 'websocket.close', 'code': 1012})
            disconnect.set()
            await task
            self.assertEqual((tracker.connections, tracker.requests), (0, 0))
        asyncio.run(scenario())

    def test_unknown_output_stays_busy_and_failure_releases_counters(self):
        async def scenario():
            tracker = ActivityTracker()
            async def receive(): return {'type': 'websocket.receive', 'text': '{}'}
            async def send(message): pass
            async def app(scope, receive, send):
                await receive()
                await send({'type': 'websocket.send', 'text': 'invalid JSON'})
                self.assertFalse(await tracker.drain())
                raise RuntimeError('fixture disconnect')
            with self.assertRaises(RuntimeError):
                await Activity(app, tracker)({'type': 'websocket', 'path': '/v1/responses'}, receive, send)
            self.assertEqual((tracker.connections, tracker.requests), (0, 0))
        asyncio.run(scenario())
