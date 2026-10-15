"""A2 live-check verdict: service traffic and unrelated stats must never produce PASS."""
import importlib.util
import json
import os
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

    def test_cancelled_export_is_visible_without_disabling_local_compression(self):
        self.assertIn('cancelled', check.telemetry_diagnostic('SessionEnd hook [command] failed: Hook cancelled'))
        self.assertTrue(check.telemetry_diagnostic('').startswith('unknown:'))

    def test_codex_uses_native_policy_and_preserves_fixture_path(self):
        fixture = self.root / 'fixture with spaces'
        argv = check.codex_command('installed-codex', fixture)
        self.assertEqual(argv[0], 'installed-codex')
        self.assertEqual(argv[argv.index('-C') + 1], str(fixture))
        forbidden = {'--sandbox', '--full-auto', '--dangerously-bypass-approvals-and-sandbox',
                     '-a', '--ask-for-approval', '--model', '-m', '--config', '-c', '--profile', '-p'}
        self.assertFalse(forbidden.intersection(argv), 'qualification must inherit the installed policy/model/profile')

    def test_readonly_pytest_uses_native_session_call_and_full_original(self):
        session = '01234567-1234-1234-1234-0123456789ab'
        native = self.root / 'sessions/2026/10/15' / ('rollout-' + session + '.jsonl')
        native.parent.mkdir(parents=True)
        original = '\n'.join(f'test_native.py::test_pass_{i:03} PASSED' for i in range(180)) + '\n1 failed, 180 passed\n' + self.marker
        payloads = [dict(type='custom_tool_call', name='exec', call_id='actual-call', input='await tools.exec_command({cmd:"'+check.PYTEST+'"});'),
                    dict(type='custom_tool_call_output', call_id='actual-call', output=json.dumps(dict(exit_code=1, output=self.marker+' '+self.ref)))]
        native.write_text(''.join(json.dumps(dict(type='response_item', payload=p))+'\n' for p in payloads))
        rows = [dict(type='thread.started', thread_id=session), self.rows[-1]]
        with patch.dict(os.environ, CODEX_HOME=str(self.root)):
            rows, source = check.codex_native_rows(rows, check.PYTEST)
            self.assertEqual(source, 'native session transcript')
            self.assertEqual(check.observed('codex', rows)[1][0]['tool_call'], 'actual-call')
            other = [dict(type='thread.started', thread_id='ffffffff-ffff-ffff-ffff-ffffffffffff')]
            self.assertEqual(check.codex_native_rows(other, check.PYTEST)[0], other)
        def recover(*args, **kwargs):
            reply = dict(result=dict(content=[dict(type='text', text=json.dumps(dict(content=original)))]))
            (self.root / 'codex-recovery.stdout.jsonl').write_text(json.dumps(reply)+'\n')
            return 0
        record = dict(self.record, session=session, bytes_in=len(original.encode()))
        with patch.object(check, 'run', side_effect=recover):
            result = check.judge('codex', rows, [record], self.marker, Path('/agentq'), self.root, self.root, check.PYTEST)
            self.assertEqual(result['result'], 'pass')
            self.assertEqual(check.judge('codex', rows, [dict(record, session='other')], self.marker, Path('/agentq'), self.root, self.root, check.PYTEST)['result'], 'fail')

    def test_stats_use_package_export_and_reject_missing_or_conflicting_evidence(self):
        def response(records, errors=None):
            return subprocess.CompletedProcess([], 0, json.dumps(dict(schema=1, records=records, errors=errors or [])), '')
        with patch.object(check.subprocess, 'run', return_value=response([self.record])) as call:
            records, errors = check.stats(self.root)
            self.assertEqual(records, {'event': self.record})
            self.assertEqual(errors, [])
            self.assertEqual(call.call_args.args[0][1:], ['stats', '--records'])
            self.assertEqual(call.call_args.kwargs['env']['AGENTQ_INSTALL'], str(self.root))
        with patch.object(check.subprocess, 'run', return_value=response([self.record, dict(self.record, bytes_out=999)])):
            self.assertIn('conflicting local event ID', check.stats(self.root)[1])
        with patch.object(check.subprocess, 'run', return_value=subprocess.CompletedProcess([],1,'','unreadable')):
            self.assertTrue(check.stats(self.root)[1])
        with patch.object(check.subprocess, 'run', side_effect=subprocess.TimeoutExpired('export',10)):
            self.assertTrue(check.stats(self.root)[1])

    def test_explicit_binary_selects_version_without_changing_path(self):
        binary = self.root / 'native client with spaces'
        binary.write_text('invented executable fixture; not executed')
        with patch.object(check.shutil, 'which', return_value=None):
            self.assertEqual(check.client_binary('codex', str(binary)), str(binary.resolve()))
            self.assertIsNone(check.client_binary('codex', str(self.root / 'missing')))

    @unittest.skipUnless(os.name == 'nt', 'Windows installed embedded CLI path')
    def test_windows_embedded_cli_is_available_without_path_edits(self):
        binary = self.root / 'OpenAI/Codex/bin/invented-build/codex.exe'
        binary.parent.mkdir(parents=True)
        binary.write_text('invented executable fixture; not executed')
        with patch.dict(os.environ, LOCALAPPDATA=str(self.root)), patch.object(check.shutil, 'which', return_value=None):
            self.assertEqual(check.client_binary('codex'), str(binary))

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
