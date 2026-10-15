"""Supplied fixtures only. No platform inspection or live provenance claims."""
import copy
import importlib.util
from pathlib import Path
import unittest


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixtures = load('y_fixtures', 'checkpoint-y.test.py')
y = fixtures.y
z = load('z', 'checkpoint-z.py')


class ObservationTests(unittest.TestCase):
    setUp = fixtures.DiscoveryTests.setUp
    lookup = fixtures.DiscoveryTests.lookup
    args = fixtures.DiscoveryTests.args
    probe = fixtures.DiscoveryTests.probe

    def observation(self):
        return {'deployment': copy.deepcopy(self.manifest), 'serialization': {
            'contractId': y.contract_digest(self.manifest), 'runId': y.RUN,
            'unchangedThroughLookup': True}}

    def verifier(self, observed=None, authenticate=None, observe=None):
        value = self.observation() if observed is None else observed
        return z.ObservationVerifier(
            observe=(lambda: value) if observe is None else observe,
            authenticate=(lambda expected, actual: True) if authenticate is None else authenticate,
            validate_manifest=y.validate_manifest, contract_digest=y.contract_digest, run_id=y.RUN)

    def assert_blocked(self, verifier):
        actual = self.probe(verify=verifier).execute(**self.args())
        self.assertEqual(actual['cause'], 'GUARD_BLOCKED')
        self.assertEqual(self.calls, [])
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertNotIn('SECRET', str(actual))

    def test_matching_supplied_observations_allow_fixture_lookup(self):
        calls = []
        def authenticate(expected, observed):
            calls.append(copy.deepcopy(observed))
            return True
        actual = self.probe(verify=self.verifier(authenticate=authenticate)).execute(**self.args())
        self.assertEqual(actual['status'], 'AVAILABLE')
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.calls, [('docker', y.DOMAIN)])

    def test_deployment_drift_blocks_before_evidence(self):
        edits = [(['platform'], 'win32'), (['version'], '3.12.1'),
                 (['repositorySources', 'checkpoint-y.py'], 'f' * 64),
                 (['upstreamCommit'], 'f' * 40), (['sourceArchiveSha256'], 'f' * 64),
                 (['buildConfiguration'], {'unreviewed': True}),
                 (['supervisorAttestation'], 'f' * 64),
                 (['immutableClosureAttestation'], 'f' * 64),
                 (['bootstrap', 'options'], ['-I']),
                 (['bootstrap', 'environment'], {'LC_ALL': 'SECRET'}),
                 (['bootstrap', 'excludeLoaderInjection'], 1)]
        edits += [(['artifacts', key], 'f' * 64) for key in self.manifest['artifacts']]
        edits += [(['artifacts', 'unknownImport'], 'f' * 64)]
        for path, value in edits:
            with self.subTest(path=path):
                observed = self.observation()
                target = observed['deployment']
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = value
                self.assert_blocked(self.verifier(observed))

    def test_missing_extra_and_serialization_drift(self):
        values = [None, {}, {'unexpected': 'SECRET'}]
        for key, value in [('contractId', 'f' * 64), ('runId', 'another-run'),
                           ('unchangedThroughLookup', False), ('unchangedThroughLookup', 1),
                           ('extra', 'SECRET')]:
            observed = self.observation()
            observed['serialization'][key] = value
            values.append(observed)
        for section in ('deployment', 'serialization'):
            observed = self.observation()
            del observed[section]
            values.append(observed)
        observed = self.observation()
        observed['extra'] = 'SECRET'
        values.append(observed)
        for observed in values:
            with self.subTest(shape=type(observed).__name__):
                self.assert_blocked(self.verifier(observe=lambda: observed))

    def test_authentication_failure_exception_and_mutation(self):
        for value in (False, None, 1):
            self.assert_blocked(self.verifier(authenticate=lambda e, o: value))
        def raises(*args):
            raise RuntimeError('SECRET')
        self.assert_blocked(self.verifier(authenticate=raises))
        self.assert_blocked(self.verifier(observe=raises))
        for section in ('expected', 'observed'):
            def mutate(expected, observed):
                if section == 'expected':
                    expected['artifacts']['stdlibImportClosure'] = 'f' * 64
                else:
                    observed['serialization']['unchangedThroughLookup'] = 1
                return True
            self.assert_blocked(self.verifier(authenticate=mutate))

    def test_second_observation_drift_stops_lookup_retains_evidence(self):
        calls = []
        def observe():
            observed = self.observation()
            if calls:
                observed['serialization']['unchangedThroughLookup'] = False
            calls.append(True)
            return observed
        actual = self.probe(verify=self.verifier(observe=observe)).execute(**self.args())
        self.assertEqual(actual['cause'], 'GUARD_BLOCKED')
        self.assertTrue(actual['evidenceStarted'])
        self.assertEqual(self.calls, [])
        self.assertTrue((self.root / y.RUN / 'discovery.jsonl').is_file())


if __name__ == '__main__':
    unittest.main()
