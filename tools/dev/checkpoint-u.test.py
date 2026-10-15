#!/usr/bin/env python3
"""Repository-only lookup diagnosis: controlled fixtures, no executable launch."""
import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('checkpoint_u_r', Path(__file__).with_name('checkpoint-r.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class LookupDiagnosisTests(unittest.TestCase):
    def fixture_check(self, root):
        calls = []

        def lookup(name, *, path):
            calls.append((name, path))
            # Translate the reviewed search domain into an isolated fixture.
            # shutil.which never sees any installed executable directory.
            return shutil.which(name, path=str(root))

        probe = r.Probe(lookup=lookup, runner=lambda *a, **k: self.fail('runtime launch'),
                        evidence_root=root)
        check = probe.step('lookup')
        self.assertEqual(calls, [('docker', r.PATH)])
        return check

    def test_missing_nonexecutable_and_directory_share_not_found(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = {'phase': 'lookup', 'cause': 'NOT_FOUND', 'available': False}
            self.assertEqual(self.fixture_check(root), expected)
            candidate = root / 'docker'
            candidate.write_text('controlled fixture; never executed')
            candidate.chmod(0o600)
            self.assertEqual(self.fixture_check(root), expected)
            candidate.unlink()
            candidate.mkdir()
            self.assertEqual(self.fixture_check(root), expected)

    def test_executable_bit_reports_available_without_proving_launchability(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / 'docker'
            candidate.write_text('not a valid executable; never executed')
            candidate.chmod(0o700)
            self.assertEqual(self.fixture_check(root),
                             {'phase': 'lookup', 'cause': 'AVAILABLE', 'available': True})

    def test_candidate_outside_search_domain_is_not_found(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            search = root / 'search'
            search.mkdir()
            candidate = root / 'docker'
            candidate.write_text('controlled fixture; never executed')
            candidate.chmod(0o700)
            self.assertEqual(self.fixture_check(search),
                             {'phase': 'lookup', 'cause': 'NOT_FOUND', 'available': False})

    def test_available_lookup_then_missing_launch_blocks_without_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []

            def runner(argv, **kwargs):
                calls.append((argv, kwargs))
                raise FileNotFoundError('private simulated interpreter or executable failure')

            probe = r.Probe(lookup=lambda *a, **k: '/simulated/docker', runner=runner,
                            evidence_root=Path(directory))
            result = probe.execute(r.APPROVAL, r.contract_hash(), True)
            self.assertEqual(result['status'], 'BLOCKED')
            self.assertEqual(result['checks'], [
                {'phase': 'lookup', 'cause': 'AVAILABLE', 'available': True},
                {'phase': 'context-show', 'cause': 'NOT_FOUND'}])
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][0], r.plan()['commands'][0])
            self.assertEqual(calls[0][1]['env'], {'PATH': r.PATH})
            self.assertNotIn('/simulated/docker', str(result))
            self.assertNotIn('private', str(result))

    def test_explicit_lookup_permission_exception_is_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            def lookup(*a, **k):
                raise PermissionError('private simulated lookup failure')

            probe = r.Probe(lookup=lookup, runner=lambda *a, **k: self.fail('runtime'),
                            evidence_root=Path(directory))
            self.assertEqual(probe.step('lookup'),
                             {'phase': 'lookup', 'cause': 'PERMISSION_DENIED'})

    def test_r_and_n_fixed_environments_agree(self):
        # Adapter construction does not invoke runner, port probe or credentials.
        with tempfile.TemporaryDirectory() as directory:
            fail = lambda *a, **k: self.fail('runtime')
            adapter = r.n.Adapter(runner=fail, environment={}, port_probe=fail,
                                  credential_factory=fail, evidence_root=Path(directory))
            self.assertEqual(adapter.environment, r.plan()['environment'])


if __name__ == '__main__':
    unittest.main()
