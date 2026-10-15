"""Injected binding fixtures; source labels are not live adapter identities."""
import copy
from pathlib import Path
import importlib.util
import unittest


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixtures = load('z_fixtures', 'checkpoint-z.test.py')
y = fixtures.y
aa = load('aa', 'checkpoint-aa.py')


class BindingTests(fixtures.ObservationTests):
    def setUp(self):
        super().setUp()
        self.supplied = {
            'repositorySources': {name: Path(__file__).with_name(name).read_bytes()
                                  for name in aa.SOURCES},
            'adapterSources': {name: ('fixture-only:' + name).encode() for name in aa.ADAPTERS},
            'dependencyClosure': {'fixtureClosure': b'fixture-only closure'}}
        self.binding = {'format': 'sl-aa-binding-v1',
                        'yContractId': y.contract_digest(self.manifest),
                        **{section: {name: y.sha(data) for name, data in values.items()}
                           for section, values in self.supplied.items()}}

    def bound(self, binding=None, digest=None, loaded=None, authenticate=None, verifier=None):
        binding = self.binding if binding is None else binding
        return aa.BoundVerifier(binding=binding,
            digest=aa.binding_digest(binding) if digest is None else digest,
            loaded=(lambda: copy.deepcopy(self.supplied)) if loaded is None else loaded,
            authenticate_binding=(lambda b, d: True) if authenticate is None else authenticate,
            observation_verifier=self.verifier() if verifier is None else verifier,
            contract_digest=y.contract_digest)

    def test_bound_matching_and_single_lookup(self):
        actual = self.probe(verify=self.bound()).execute(**self.args())
        self.assertEqual(actual['status'], 'AVAILABLE')
        self.assertEqual(self.calls, [('docker', y.DOMAIN)])
        self.assertNotIn('SECRET', str(actual))

    def test_missing_changed_extra_sources_and_adapters(self):
        for section, values in self.supplied.items():
            for name in values:
                for edit in ('missing', 'changed', 'extra', 'invalid'):
                    with self.subTest(section=section, name=name, edit=edit):
                        supplied = copy.deepcopy(self.supplied)
                        if edit == 'missing':
                            del supplied[section][name]
                        elif edit == 'extra':
                            supplied[section]['unknown'] = b'SECRET'
                        else:
                            supplied[section][name] = b'SECRET' if edit == 'changed' else None
                        self.assert_blocked(self.bound(loaded=lambda: supplied))

    def test_digest_binds_all_commitments(self):
        original = aa.binding_digest(self.binding)
        self.assert_blocked(self.bound(digest=y.contract_digest(self.manifest)))
        for section in self.supplied:
            changed = copy.deepcopy(self.binding)
            name = next(iter(changed[section]))
            changed[section][name] = 'f' * 64
            self.assertNotEqual(aa.binding_digest(changed), original)
            self.assert_blocked(self.bound(binding=changed, digest=original))
        for key in self.binding:
            missing = copy.deepcopy(self.binding)
            del missing[key]
            self.assert_blocked(self.bound(binding=missing, digest=original))

    def test_authentication_mutation_exceptions_and_z_failure(self):
        for value in (False, None, 1):
            self.assert_blocked(self.bound(authenticate=lambda b, d: value))
        def raises(*args):
            raise RuntimeError('SECRET')
        self.assert_blocked(self.bound(authenticate=raises))
        self.assert_blocked(self.bound(loaded=raises))
        def mutate(binding, digest):
            binding['adapterSources']['observe'] = 'f' * 64
            return True
        self.assert_blocked(self.bound(authenticate=mutate))
        self.assert_blocked(self.bound(verifier=self.verifier(authenticate=lambda e, o: False)))

    def test_second_guard_adapter_drift_retains_evidence(self):
        calls = []
        def supplied():
            value = copy.deepcopy(self.supplied)
            if calls:
                value['adapterSources']['observe'] = b'changed'
            calls.append(True)
            return value
        actual = self.probe(verify=self.bound(loaded=supplied)).execute(**self.args())
        self.assertEqual(actual['cause'], 'GUARD_BLOCKED')
        self.assertTrue(actual['evidenceStarted'])
        self.assertEqual(self.calls, [])
        self.assertTrue((self.root / y.RUN / 'discovery.jsonl').is_file())

    def test_recorder_failure_overrides_bound_available(self):
        class Recorder(y.Evidence):
            def close(self):
                super().close()
                raise OSError('SECRET')
        actual = self.probe(verify=self.bound(), recorder=lambda: Recorder(self.root)).execute(**self.args())
        self.assertEqual(actual['cause'], 'RECORDING_FAILED')
        self.assertTrue(actual['recordingFailed'])
        self.assertNotIn('SECRET', str(actual))


if __name__ == '__main__':
    unittest.main()
