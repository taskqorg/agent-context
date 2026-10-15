"""AgentQ terminal-result adapter; decisions, originals and stats belong to the binary."""
import json
import subprocess

_AGENTQ = @AGENTQ_EXE@


def transform(*, tool_name, args, result, session_id=None, turn_id=None, tool_call_id=None, **_):
    if tool_name != "terminal" or not isinstance(result, str):
        return None
    try:
        native = json.loads(result)
        if not isinstance(native, dict) or not isinstance(native.get("output"), str):
            return None
        payload = dict(adapter="hook", tool="terminal", command=args.get("command"),
                       text=native["output"], exit_code=native.get("exit_code"),
                       session=session_id, turn=turn_id, tool_call=tool_call_id)
        proc = subprocess.run([_AGENTQ, "compress", "hermes"], input=json.dumps(payload),
                              text=True, capture_output=True, timeout=4)
        if proc.returncode:
            return None
        compressed = json.loads(proc.stdout)
        if not isinstance(compressed.get("text"), str) or compressed["text"] == native["output"]:
            return None
        native["output"] = compressed["text"]
        return json.dumps(native, ensure_ascii=False)
    except (OSError, ValueError, TypeError, AttributeError, subprocess.TimeoutExpired):
        return None


def register(ctx):
    ctx.register_hook("transform_tool_result", transform)
