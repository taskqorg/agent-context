"""Native Hermes transform contract; core compression is checked by tests/compression.rs."""
import json
from pathlib import Path
import subprocess
import types
import unittest
from unittest.mock import patch

source=(Path(__file__).resolve().parents[1]/'integrations/hermes/__init__.py').read_text().replace('@AGENTQ_EXE@',repr('/fixture/agentq'))
adapter=types.ModuleType('hermes_adapter');exec(compile(source,'hermes-adapter','exec'),adapter.__dict__)

class HermesAdapter(unittest.TestCase):
    def test_terminal_preserves_envelope_and_correlates_native_call(self):
        original=dict(output='native output',exit_code=101,error='native error',opaque={'keep':True})
        with patch.object(adapter.subprocess,'run',return_value=types.SimpleNamespace(returncode=0,stdout=json.dumps(dict(text='short ref')))) as run:
            result=adapter.transform(tool_name='terminal',args={'command':'cargo test'},result=json.dumps(original),session_id='s',turn_id='t',tool_call_id='c')
            expected=dict(original,output='short ref');self.assertEqual(json.loads(result),expected)
            args,kw=run.call_args;self.assertEqual(args[0],['/fixture/agentq','compress','hermes'])
            self.assertEqual(json.loads(kw['input']),dict(adapter='hook',tool='terminal',command='cargo test',text='native output',exit_code=101,session='s',turn='t',tool_call='c'))
            self.assertLessEqual(kw['timeout'],4)
    def test_other_tools_never_invoke_core_and_failures_preserve_original(self):
        with patch.object(adapter.subprocess,'run') as run:
            self.assertIsNone(adapter.transform(tool_name='read_file',args={},result='{}'));run.assert_not_called()
        for failure in [OSError(),subprocess.TimeoutExpired('agentq',4)]:
            with patch.object(adapter.subprocess,'run',side_effect=failure):
                self.assertIsNone(adapter.transform(tool_name='terminal',args={},result='{"output":"native"}'))
        for reply in ['{}','not json','{"text":"native"}']:
            with patch.object(adapter.subprocess,'run',return_value=types.SimpleNamespace(returncode=0,stdout=reply)):
                self.assertIsNone(adapter.transform(tool_name='terminal',args={},result='{"output":"native"}'))

if __name__=='__main__':unittest.main()
