"""Use only the current request's exact user text, never persisted session history."""
from contextvars import ContextVar
import json
import re

query = ContextVar('agent_context_query', default='')


def current_query(body):
    if not isinstance(body, dict):
        return ''
    messages = body.get('input', body.get('messages', []))
    if not isinstance(messages, list):
        return ''
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get('role') != 'user':
            continue
        content = message.get('content', '')
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return '\n'.join(block['text'] for block in content if isinstance(block, dict) and block.get('type') in {'text', 'input_text'} and isinstance(block.get('text'), str))
    return ''


class CurrentRequest:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] not in {'http', 'websocket'}:
            return await self.app(scope, receive, send)
        token = query.set('')
        from .observability import identity
        identity_token = identity.set(dict(identity.get()))
        body = bytearray()

        async def capture():
            message = await receive()
            payload = None
            if message['type'] == 'websocket.receive':
                payload = message.get('text') or message.get('bytes')
            elif message['type'] == 'http.request':
                if len(body) + len(message.get('body', b'')) <= 2_000_000:
                    body.extend(message.get('body', b''))
                if not message.get('more_body'):
                    payload = body
            if payload and len(payload) > 2_000_000:
                query.set('')
            if payload and len(payload) <= 2_000_000:
                try:
                    request = json.loads(payload)
                    value = current_query(request)
                    from .observability import identity
                    native = request.get('client_metadata', {}) if isinstance(request, dict) else {}
                    if not isinstance(native, dict):
                        native = {}
                    metadata = request.get('metadata', {}) if isinstance(request, dict) else {}
                    if isinstance(metadata, dict) and isinstance(metadata.get('user_id'), str):
                        try:
                            decoded = json.loads(metadata['user_id'])
                            if isinstance(decoded, dict):
                                native = dict(native, **decoded)
                        except ValueError:
                            pass
                    ids = dict(identity.get())
                    for key, source in [('session.id', native.get('thread_id') or native.get('session_id')), ('agent_context.turn_id', native.get('turn_id'))]:
                        if isinstance(source, str) and re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', source):
                            ids[key] = source
                            ids['agent_context.native_session_missing' if key == 'session.id' else 'agent_context.native_turn_missing'] = False
                    identity.set(ids)
                    messages = request.get('input', request.get('messages', [])) if isinstance(request, dict) else []
                    if value or isinstance(messages, list) and any(isinstance(item, dict) and item.get('role') == 'user' for item in messages):
                        query.set(value)
                except (ValueError, TypeError):
                    pass
            return message
        try:
            return await self.app(scope, capture, send)
        finally:
            query.reset(token)
            identity.reset(identity_token)
