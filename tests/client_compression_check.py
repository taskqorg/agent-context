"""A2 live-check verdict: service traffic and unrelated stats must never produce PASS."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('client_check', Path(__file__).parents[1] / 'scripts/check-client-compression.py')
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class VerdictChain(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.marker = 'AGENTQ_CHECK_fixture'
        self.original = '\n'.join(f'test pass_{i:03} ... ok' for i in range(180)) + '\n180 passed; 1 failed\n' + self.marker
        self.ref = 'rtk:fixture'
        self.record = dict(event_id='event', agent='codex', session='session', adapter='provider',
                           outcome='compressed', ref=self.ref, bytes_in=len(self.original.encode()), bytes_out=200)
        self.rows = [dict(type='thread.started', thread_id='session'),
                     dict(type='item.completed', item=dict(type='command_execution', id='call', command=check.COMMAND, exit_code=101)),
                     dict(type='item.completed', item=dict(type='agent_message', text=self.marker+' '+self.ref))]

    def judge(self, records, rows=None):
        return check.judge('codex', self.rows if rows is None else rows, records, self.marker,
                           Path('/agentq'), self.root, self.root)

    def test_native_execution_without_compression_fails(self):
        self.assertEqual(self.judge([])['result'], 'fail')
        unrelated = dict(self.record, session='other-session')
        self.assertEqual(self.judge([unrelated])['result'], 'fail')
        self.assertEqual(self.judge([dict(self.record, adapter='run')])['result'], 'fail')
        self.assertEqual(self.judge([], [])['result'], 'unknown')
        denied = [self.rows[0], dict(type='item.completed', item=dict(type='command_execution', command=check.COMMAND, exit_code=None))]
        self.assertEqual(self.judge([], denied)['result'], 'unknown')

    def test_record_original_and_model_visibility_are_all_required(self):
        def recover(*args, **kwargs):
            text = json.dumps(dict(content=self.original))
            reply = dict(result=dict(content=[dict(type='text', text=text)]))
            (self.root / 'codex-recovery.stdout.jsonl').write_text(json.dumps(reply)+'\n')
            return 0
        with patch.object(check, 'run', side_effect=recover):
            self.assertEqual(self.judge([self.record])['result'], 'pass')
            self.assertEqual(self.judge([self.record], self.rows[:-1])['result'], 'fail')
            self.assertEqual(self.judge([dict(self.record, bytes_in=99)])['result'], 'fail')

    def test_claude_native_tool_evidence(self):
        rows = [dict(type='assistant', session_id='claude-session', message=dict(content=[
                    dict(type='tool_use', id='tool-id', name='Bash', input=dict(command=check.COMMAND))])),
                dict(type='user', session_id='claude-session', message=dict(content=[dict(type='tool_result', tool_use_id='tool-id', is_error=True, content='Error: Exit code 101\n180 passed; 1 failed')])),
                dict(type='result', session_id='claude-session', result='180 passed; 1 failed')]
        session, commands, reply = check.observed('claude', rows)
        self.assertEqual((session, commands[0]['tool_call']), ('claude-session', 'tool-id'))
        self.assertIn(check.COMMAND, commands[0]['command'])
        self.assertEqual(commands[0]['exit_code'], 101)
        self.assertIn('180 passed', reply)


if __name__ == '__main__':
    unittest.main()
