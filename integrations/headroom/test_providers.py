import os
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from pathlib import Path
from agent_context_headroom.providers import compress_context, settings

class ProvidersTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'AGENT_CONTEXT_HOME': self.home.name,
            'AGENT_CONTEXT_COMPRESSOR': 'headroom-local', 'SUPERCOMPRESS_API_KEY': 'test-only',
            'SCALEDOWN_API_KEY': 'test-only'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(self.home.cleanup)
        self.context = 'noise\n' * 600 + 'ERROR E42: never restart production\n'
        self.query = 'Preserve the error and restriction'

    def test_same_boundary_for_all_providers(self):
        from agent_context_headroom import provider_headroom
        answer = 'ERROR E42: never restart production\n'
        def send(url, key, payload, timeout):
            self.assertEqual(key, 'test-only')
            self.assertEqual(timeout, 10)
            self.assertEqual(payload['context'], self.context)
            self.assertEqual(payload.get('query', payload.get('prompt')), self.query)
            if 'scaledown' in url:
                return {'successful': True, 'results': {'original_prompt': self.query, 'compressed_prompt': answer}}
            self.assertEqual(payload['mode'], 'neural')
            return {'mode': 'neural', 'compressed_text': answer}
        with patch.object(provider_headroom, 'compress', return_value=answer):
            for name in ['headroom-local', 'supercompress', 'scaledown']:
                r = compress_context(self.context, self.query, provider=name, send=send)
                self.assertEqual(r['provider'], name)
                self.assertEqual(r['outcome'], 'compressed')
                self.assertEqual(r['compressed_text'], answer)

    def test_remote_errors_keep_original(self):
        for name in ['supercompress', 'scaledown']:
            for exc, expected in [(TimeoutError(), 'timeout'), (HTTPError('https://example.invalid', 429, '', {}, None), 'http_429')]:
                def send(*args): raise exc
                r = compress_context(self.context, self.query, provider=name, send=send)
                self.assertEqual(r['outcome'], expected)
                self.assertEqual(r['compressed_text'], self.context)

    def test_local_tools_never_calls_compressor(self):
        for context in [self.context, '{"error":"E42","exit":7}', 'def critical(): return 42']:
            def forbidden(*args):
                self.fail('local-tools must not call a cloud service')
            result = compress_context(context, self.query, provider='local-tools', send=forbidden)
            self.assertEqual(result['compressed_text'], context)
            self.assertEqual(result['outcome'], 'ineligible')

    def test_neural_downgrade_and_query_mutation_rejected(self):
        r = compress_context(self.context, self.query, provider='supercompress', send=lambda *a: {'mode': 'compiler', 'compressed_text': 'short'})
        self.assertEqual(r['outcome'], 'neural_unavailable')
        r = compress_context(self.context, self.query, provider='scaledown', send=lambda *a: {'successful': True, 'results': {'original_prompt': 'changed', 'compressed_prompt': 'short'}})
        self.assertEqual(r['outcome'], 'invalid_response')
        self.assertEqual(r['compressed_text'], self.context)

    def test_loss_of_error_is_rejected(self):
        r = compress_context(self.context, self.query, provider='supercompress', send=lambda *a: {'mode': 'neural', 'compressed_text': 'unrelated'})
        self.assertEqual(r['outcome'], 'lost_critical_evidence')
        self.assertEqual(r['compressed_text'], self.context)

    def test_missing_key_and_invalid_response(self):
        os.environ['SCALEDOWN_API_KEY'] = ''
        self.assertEqual(compress_context(self.context, self.query, provider='scaledown')['outcome'], 'missing_key')
        r = compress_context(self.context, self.query, provider='supercompress', send=lambda *a: {'mode': 'neural', 'compressed_text': None})
        self.assertEqual(r['outcome'], 'invalid_response')

    def test_scaledown_auto_and_explicit_rate(self):
        def send(url, key, payload, timeout):
            self.assertEqual(payload['scaledown']['rate'], os.environ.get('SCALEDOWN_COMPRESS_RATE', 'auto'))
            self.assertEqual(payload['prompt'], 'Keep the error')
            return {'successful': True, 'results': {'original_prompt': 'Keep the error',
                                                     'compressed_prompt': 'ERROR E42'}}
        for rate in ['auto', '0.5', '0', '1']:
            with patch.dict(os.environ, {'SCALEDOWN_COMPRESS_RATE': rate}):
                r = compress_context('noise\nERROR E42', 'Keep the error', provider='scaledown', send=send)
                self.assertEqual(r['outcome'], 'compressed')
        for rate in ['nan', '1.1', '-1', 'garbage']:
            with patch.dict(os.environ, {'SCALEDOWN_COMPRESS_RATE': rate}):
                r = compress_context('noise\nERROR E42', 'Keep the error', provider='scaledown',
                                     send=lambda *args: self.fail('invalid rate reached network'))
                self.assertEqual(r['outcome'], 'invalid_response')
                self.assertEqual(r['compressed_text'], 'noise\nERROR E42')

    def test_configuration_and_size_boundaries(self):
        with self.assertRaises(ValueError): compress_context('text', '')
        with self.assertRaises(ValueError): compress_context('text', 'query', provider='typo')
        self.assertEqual(compress_context('я' * 200001, 'query')['outcome'], 'too_large')
        file = Path(self.home.name) / '.agent-context/compression.json'
        file.parent.mkdir(); file.write_text('{"provider":"typo"}')
        os.environ.pop('AGENT_CONTEXT_COMPRESSOR')
        with self.assertRaises(ValueError): settings()

if __name__ == '__main__': unittest.main()
