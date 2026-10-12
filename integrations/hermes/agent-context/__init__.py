"""Native all-tool interception; keeps Hermes auth, approvals and tracer intact."""
import json
import logging
import threading
import subprocess
import urllib.parse
import urllib.request


logger = logging.getLogger('agent_context.hermes')

def register(ctx):
    base = ctx.get_config('proxy_url', '')
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise ValueError('Agent Context requires a configured loopback proxy URL')
    queries = {}
    started = set()
    lock = threading.Lock()

    def remember(user_message, session_id='', turn_id='', **kwargs):
        node, launcher = ctx.get_config('node', ''), ctx.get_config('launcher', '')
        # One lifecycle per session; a failed proxy call clears it so the next turn restarts the service.
        if node and launcher and session_id not in started:
            try:
                subprocess.run([node, launcher, 'lifecycle', 'hermes'], timeout=25, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except (OSError, subprocess.SubprocessError):
                # Compression is off for this turn; make it visible instead of silently failing open.
                try:
                    subprocess.Popen([node, launcher, 'incidents', 'record'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).communicate(
                        b'{"component":"agent-adapter","operation":"lifecycle","category":"startup_failed","agent":"hermes"}', timeout=5)
                except (OSError, subprocess.SubprocessError):
                    pass
                return None
            with lock:
                if len(started) >= 256:
                    started.clear()
                started.add(session_id)
        logger.info('remember session_present=%s turn_present=%s query_chars=%s', bool(session_id), bool(turn_id), len(user_message) if isinstance(user_message, str) else 0)
        if not session_id or not turn_id or not isinstance(user_message, str):
            return None
        with lock:
            if len(queries) >= 256:
                queries.pop(next(iter(queries)))
            queries[(session_id, turn_id)] = user_message
        return None

    def forget(session_id='', turn_id='', **kwargs):
        with lock:
            queries.pop((session_id, turn_id), None)

    def transform(tool_name, result, session_id='', turn_id='', **kwargs):
        if tool_name == 'agent_context_retrieve' or not isinstance(result, str) or len(result) < 2048:
            return None
        with lock:
            query = queries.get((session_id, turn_id))
        logger.info('transform tool=%s input_chars=%s query_present=%s', tool_name, len(result), bool(query))
        if not query:
            return None
        content, envelope = result, None
        field = {'terminal': 'output', 'read_file': 'content'}.get(tool_name)
        if field:
            try:
                candidate = json.loads(result)
                if isinstance(candidate, dict) and isinstance(candidate.get(field), str):
                    envelope, content = candidate, candidate[field]
            except ValueError:
                pass
        if len(content) < 2048:
            return None
        # Headroom routes JSON structurally; give it the native tool's text payload.
        body = {'model': ctx.get_config('tokenizer_model', 'gpt-6.1-sol'), 'messages': [{'role': 'user', 'content': query}, {'role': 'tool', 'content': content}]}
        request = urllib.request.Request(base + '/v1/compress', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'x-session-id': session_id, 'x-turn-id': turn_id})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                value = json.load(response)['messages'][-1]['content']
            if isinstance(value, str) and value and len(value) < len(content):
                if envelope is not None:
                    envelope[field] = value
                    value = json.dumps(envelope, ensure_ascii=False)
                if len(value) < len(result):
                    return value
        except OSError:
            with lock:
                started.discard(session_id)
        except (ValueError, KeyError, IndexError):
            pass
        return None

    def retrieve(args, **kwargs):
        ref = args.get('hash', '')
        if len(ref) != 16 or any(c not in '0123456789abcdef' for c in ref):
            return json.dumps({'error': 'Invalid recovery reference'})
        try:
            with urllib.request.urlopen(base + '/v1/retrieve/' + ref, timeout=5) as response:
                original = json.load(response).get('original_content')
            if isinstance(original, str):
                return original
        except (OSError, ValueError):
            pass
        return json.dumps({'error': 'Original unavailable; do not infer missing facts'})

    ctx.register_hook('pre_llm_call', remember)
    ctx.register_hook('transform_tool_result', transform)
    ctx.register_hook('post_llm_call', forget)
    ctx.register_tool(name='agent_context_retrieve', toolset='agent_context',
                      schema={'name': 'agent_context_retrieve', 'description': 'Read the exact original for a compression marker. Read-only.', 'parameters': {'type': 'object', 'properties': {'hash': {'type': 'string'}}, 'required': ['hash'], 'additionalProperties': False}}, handler=retrieve)
