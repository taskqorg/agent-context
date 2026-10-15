"""ACCOUNTING O4 / A2,A4: local native proof -> same exported event -> correlated native tool and usage.

False or absent delivery, unrelated sessions, duplicate export and partial usage cannot give full PASS.
"""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('qualification', Path(__file__).parents[1]/'scripts/check-compression-telemetry.py')
q = importlib.util.module_from_spec(spec); spec.loader.exec_module(q)
LOCAL = dict(schema=1,event_id='a'*32,time=100,agent='claude',adapter='run',tool='shell',runner='cargo test',
             engine='rtk',engine_version='0.51.0',version='0.6.2',installation='install',runtime='macos',
             session='native-session',tool_call='native-call',outcome='compressed',reason='compressed',bytes_in=4000,bytes_out=400,ref='rtk:fixture')
EVIDENCE = dict(installation='install',runtime='macos',client='claude',result='pass',session='native-session',ref='rtk:fixture',original_recovered=True,
                model_saw_reference=True,observed_usage=dict(input_tokens=4,output_tokens=100))
ROWS = [dict(name='agentq.compress',id='compress',traceId='a'*32,sessionId='',metadata={'attributes.agentq.'+k:v for k,v in LOCAL.items()}),
        dict(name='Tool: Bash',id='tool',traceId='native-trace',sessionId='native-session',metadata=dict(tool_id='native-call')),
        dict(name='LLM Call',type='GENERATION',id='generation',traceId='native-trace',sessionId='native-session',usageDetails=dict(output=100))]


class TelemetryChain(unittest.TestCase):
    def test_matching_delivery_deduplicates_without_inventing_usage(self):
        result=q.judge([LOCAL],ROWS+ROWS,EVIDENCE)
        self.assertEqual((result['compression'],result['export'],result['usage_coverage']),('pass','pass','pass'))
        self.assertEqual(result['usage_output']['exported'],100)
        self.assertTrue(result['observed_input_cache_coverage'].startswith('unknown'))

    def test_delivery_identity_and_native_visibility_are_required(self):
        self.assertEqual(q.judge([LOCAL],ROWS[1:],EVIDENCE)['compression'],'unknown')
        for key,value in [('bytes_out',500),('version','different'),('session','another'),('tool_call','other')]:
            rows=copy.deepcopy(ROWS);rows[0]['metadata']['attributes.agentq.'+key]=value
            self.assertEqual(q.judge([LOCAL],rows,EVIDENCE)['export'],'fail')
        result=q.judge([LOCAL],[ROWS[0],ROWS[2]],EVIDENCE)
        self.assertNotEqual(result['compression'],'pass')
        self.assertNotEqual(q.judge([LOCAL],ROWS,dict(EVIDENCE,model_saw_reference=False))['compression'],'pass')
        self.assertNotEqual(q.judge([LOCAL],ROWS,dict(EVIDENCE,original_recovered=False))['compression'],'pass')
        self.assertNotEqual(q.judge([LOCAL],ROWS,dict(EVIDENCE,client='codex'))['compression'],'pass')
        self.assertEqual(q.judge([LOCAL],ROWS,dict(EVIDENCE,runtime='windows'))['identity'],'fail')

    def test_missing_and_conflicting_usage_does_not_hide_working_compression(self):
        rows=copy.deepcopy(ROWS);rows[2]['usageDetails']['output']=50
        result=q.judge([LOCAL],rows,EVIDENCE)
        self.assertEqual(result['compression'],'pass')
        self.assertEqual(result['usage_coverage'],'fail')
        self.assertEqual(q.judge([LOCAL],ROWS[:2],EVIDENCE)['usage_coverage'],'unknown')
        conflict=copy.deepcopy(ROWS[2]);conflict['usageDetails']['output']=99
        self.assertEqual(q.judge([LOCAL],ROWS+[conflict],EVIDENCE)['usage_coverage'],'fail')
        rows=copy.deepcopy(ROWS);rows[2].pop('id')
        self.assertEqual(q.judge([LOCAL],rows,EVIDENCE)['usage_coverage'],'unknown')

    def test_query_failure_and_incomplete_pages_are_unknown_not_empty_success(self):
        self.assertEqual(q.observations(dict(status=200,body=dict(data=ROWS,meta={}))),ROWS)
        for payload in [dict(status=501,body={}),dict(data=ROWS,meta=dict(cursor='next')),dict(body={})]:
            with self.assertRaises((ValueError,KeyError)):q.observations(payload)


if __name__=='__main__':unittest.main()
