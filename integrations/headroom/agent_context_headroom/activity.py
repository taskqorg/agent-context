import json


class ActivityTracker:
    """R4/R6: idle sockets are not in-flight model requests."""
    def __init__(self):
        self.connections = 0
        self.requests = 0
        self.sockets = {}
        self.stopping = False

    async def drain(self):
        if self.requests:
            return False
        self.stopping = True
        for entry in list(self.sockets.values()):
            await entry['send']({'type': 'websocket.close', 'code': 1012})
        return True


class Activity:
    def __init__(self, app, tracker):
        self.app, self.tracker = app, tracker

    async def __call__(self, scope, receive, send):
        tracker = self.tracker
        if scope['type'] not in {'http', 'websocket'} or scope.get('path', '').startswith('/agent-context/') or scope.get('path') == '/api/public/otel/v1/traces':
            return await self.app(scope, receive, send)
        if tracker.stopping:
            if scope['type'] == 'websocket':
                await send({'type': 'websocket.close', 'code': 1012})
            else:
                await send({'type': 'http.response.start', 'status': 503, 'headers': []})
                await send({'type': 'http.response.body', 'body': b'Service restarting'})
            return
        tracker.connections += 1
        pending = 0
        entry = {'send': send}
        if scope['type'] == 'http':
            pending = 1
            tracker.requests += 1
        else:
            tracker.sockets[id(entry)] = entry

        async def incoming():
            nonlocal pending
            message = await receive()
            if message['type'] == 'websocket.receive':
                if tracker.stopping:
                    return {'type': 'websocket.disconnect', 'code': 1012}
                pending += 1
                tracker.requests += 1
            return message

        async def outgoing(message):
            nonlocal pending
            await send(message)
            if message['type'] == 'websocket.send' and pending:
                try:
                    event = json.loads(message.get('text') or message.get('bytes', b''))
                    terminal = event.get('type') in {'response.completed', 'response.failed', 'response.incomplete', 'error'}
                except (ValueError, AttributeError, UnicodeDecodeError):
                    terminal = False
                if terminal:
                    pending -= 1
                    tracker.requests -= 1

        try:
            return await self.app(scope, incoming, outgoing)
        finally:
            tracker.requests -= pending
            tracker.connections -= 1
            tracker.sockets.pop(id(entry), None)
