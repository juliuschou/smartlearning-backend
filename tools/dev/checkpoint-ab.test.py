"""Composed AA/Y/Z fixture coverage only; no external authentication claims."""
import copy
import json
from pathlib import Path
import importlib.util
import unittest

spec = importlib.util.spec_from_file_location(
    'aa_fixtures', Path(__file__).with_name('checkpoint-aa.test.py'))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
aa, y = fixtures.aa, fixtures.y


class ComposedBindingTests(fixtures.BindingTests):

    def test_missing_supplied_sections_block_before_evidence(self):
        for section in self.supplied:
            with self.subTest(section=section):
                supplied = copy.deepcopy(self.supplied)
                del supplied[section]
                self.assert_blocked(self.bound(loaded=lambda: supplied))

    def test_missing_reviewed_adapter_commitments_block_before_evidence(self):
        digest = aa.binding_digest(self.binding)
        for role in aa.ADAPTERS:
            with self.subTest(role=role):
                binding = copy.deepcopy(self.binding)
                del binding['adapterSources'][role]
                self.assert_blocked(self.bound(binding=binding, digest=digest))

    def test_valid_but_different_y_manifest_cannot_reuse_binding(self):
        manifest = copy.deepcopy(self.manifest)
        manifest['supervisorAttestation'] = 'f' * 64
        actual = self.probe(verify=self.bound()).execute(**self.args(manifest))
        self.assertEqual(actual['cause'], 'GUARD_BLOCKED')
        self.assertEqual(self.calls, [])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_caller_binding_is_detached_after_construction(self):
        verifier = self.bound()
        self.binding['adapterSources']['lookup'] = 'f' * 64
        actual = self.probe(verify=verifier).execute(**self.args())
        self.assertEqual(actual['status'], 'AVAILABLE')
        self.assertEqual(self.calls, [('docker', y.DOMAIN)])

    def test_callback_binding_mutation_blocks_before_evidence(self):
        for phase in ('loaded', 'authenticate', 'observation'):
            with self.subTest(phase=phase):
                verifier = self.bound()
                def mutate():
                    verifier.binding['adapterSources']['lookup'] = 'f' * 64
                if phase == 'loaded':
                    def loaded():
                        mutate()
                        return copy.deepcopy(self.supplied)
                    verifier.loaded = loaded
                elif phase == 'authenticate':
                    def authenticate(binding, digest):
                        mutate()
                        return True
                    verifier.authenticate_binding = authenticate
                else:
                    observation = verifier.observation_verifier
                    def observe(manifest):
                        accepted = observation(manifest)
                        mutate()
                        return accepted
                    verifier.observation_verifier = observe
                self.assert_blocked(verifier)

    def test_second_binding_authentication_failure_retains_complete_evidence(self):
        authentications = []
        observations = []
        def authenticate(binding, digest):
            authentications.append(digest)
            return len(authentications) == 1
        observation = self.verifier()
        def verify_observation(manifest):
            observations.append(True)
            return observation(manifest)
        actual = self.probe(verify=self.bound(
            authenticate=authenticate, verifier=verify_observation)).execute(**self.args())
        self.assertEqual(actual['cause'], 'GUARD_BLOCKED')
        self.assertTrue(actual['evidenceStarted'])
        self.assertFalse(actual['recordingFailed'])
        self.assertEqual(actual['retentionPolicy'], y.RETENTION)
        self.assertEqual(len(authentications), 2)
        self.assertEqual(len(observations), 1)
        self.assertEqual(self.calls, [])
        records = [json.loads(line) for line in
                   (self.root / y.RUN / 'discovery.jsonl').read_text().splitlines()]
        self.assertEqual([record['event'] for record in records],
                         ['begin', 'intent', 'outcome', 'complete'])
        self.assertEqual(records[2]['phase'], 'guard')
        self.assertEqual(records[-1]['cause'], 'GUARD_BLOCKED')
        self.assertEqual(records[-1]['contractId'], y.contract_digest(self.manifest))
        self.assertNotIn('SECRET', str(actual) + str(records))


if __name__ == '__main__':
    unittest.main()
