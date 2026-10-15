"""Injected preparation tests only; no installed-tool discovery or candidate launch."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('checkpoint_y', Path(__file__).with_name('checkpoint-y.py'))
y = importlib.util.module_from_spec(spec)
spec.loader.exec_module(y)


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)  # Fixture-owned only; never production evidence.
        self.root = Path(self.tmp.name)
        self.sources = {name: Path(__file__).with_name(name).read_bytes() for name in y.SOURCE_NAMES}
        self.manifest = {
            'implementation': 'CPython', 'version': '3.12.0', 'osName': 'posix',
            'platform': 'linux', 'pathModule': 'posixpath', 'pathsep': ':',
            'filesystemEncoding': 'utf-8', 'interpreter': '/fixture/python',
            'upstreamCommit': 'a' * 40, 'sourceArchiveSha256': 'b' * 64,
            'buildConfiguration': {'fixture': 'not-a-deployment'},
            'artifacts': {name: 'c' * 64 for name in (
                'executableBuild', 'stdlibImportClosure', 'loaderSharedLibraries',
                'trustedLauncher', 'reviewedStartupSources', 'reviewedLookupSources')},
            'repositorySources': {name: y.sha(data) for name, data in self.sources.items()},
            'bootstrap': {'environment': {'LC_ALL': 'C.UTF-8'},
                          'options': ['-I', '-S', '-B', '-X', 'utf8'],
                          'cwd': 'fixed-repository', 'excludeLoaderInjection': True},
            'supervisorAttestation': 'd' * 64, 'immutableClosureAttestation': 'e' * 64}
        self.calls = []

    def lookup(self, name, *, path):
        self.calls.append((name, path))
        return '/SECRET/candidate'

    def probe(self, lookup=None, verify=None, recorder=None, loaded_sources=None):
        return y.Discovery(lookup=self.lookup if lookup is None else lookup,
                           verify=(lambda m: True) if verify is None else verify,
                           loaded_sources=(lambda: dict(self.sources)) if loaded_sources is None else loaded_sources,
                           recorder=(lambda: y.Evidence(self.root)) if recorder is None else recorder)

    def args(self, manifest=None):
        m = self.manifest if manifest is None else manifest
        digest = y.contract_digest(m)
        return {'manifest': m, 'digest': digest, 'scope': {
            'humanApproved': True, 'externallySerialized': True,
            'runId': y.RUN, 'contractId': digest}}

    def records(self):
        return [json.loads(line) for line in (self.root / y.RUN / 'discovery.jsonl').read_text().splitlines()]

    def test_default_and_incomplete_gates_have_no_side_effects(self):
        def forbidden(*a, **k):
            self.fail('unexpected adapter call')
        p = self.probe(lookup=forbidden, verify=forbidden, recorder=forbidden, loaded_sources=forbidden)
        args = self.args()
        for omitted in args:
            incomplete = {k: v for k, v in args.items() if k != omitted}
            self.assertEqual(p.execute(**incomplete)['status'], 'REVIEW_ONLY')
        self.assertEqual(p.execute()['status'], 'REVIEW_ONLY')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_cli_flags_cannot_enable_execution(self):
        for argv in ([], ['--execute'], ['--approve', 'yes'],
                     ['--execute', '--approve', 'yes', '--contract-sha256', 'f' * 64, '--exclusive']):
            with self.subTest(argv=argv), contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(y.main(argv), 0)
                self.assertEqual(json.loads(out.getvalue())['status'], 'REVIEW_ONLY')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_available_exact_single_lookup_redaction_and_permissions(self):
        p = self.probe()
        actual = p.execute(**self.args())
        self.assertEqual(actual, y.result('AVAILABLE', 'AVAILABLE', True, True))
        self.assertEqual(self.calls, [('docker', y.DOMAIN)])
        records = self.records()
        self.assertEqual([r['event'] for r in records], ['begin', 'intent', 'outcome', 'complete'])
        for r in records:
            y.validate_event(r)
        self.assertNotIn('SECRET', json.dumps(records) + json.dumps(actual))
        self.assertEqual(stat.S_IMODE((self.root / y.RUN).stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.root / y.RUN / 'discovery.jsonl').stat().st_mode), 0o600)
        self.assertEqual(p.execute(**self.args())['status'], 'BLOCKED')
        self.assertEqual(len(self.calls), 1)

    def test_outcome_classifications(self):
        cases = [(None, 'NOT_FOUND', False), ('', 'INVALID_RESULT', None),
                 (False, 'INVALID_RESULT', None), (123, 'INVALID_RESULT', None),
                 (b'/SECRET', 'INVALID_RESULT', None),
                 (PermissionError('SECRET'), 'PERMISSION_DENIED', None),
                 (FileNotFoundError('SECRET'), 'OS_ERROR', None),
                 (OSError('SECRET'), 'OS_ERROR', None),
                 (RuntimeError('SECRET'), 'UNKNOWN', None),
                 (KeyboardInterrupt('SECRET'), 'UNKNOWN', None)]
        for value, cause, available in cases:
            with self.subTest(cause=cause, value=type(value).__name__), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                calls = []
                def lookup(name, *, path):
                    calls.append((name, path))
                    if isinstance(value, BaseException):
                        raise value
                    return value
                actual = self.probe(lookup=lookup, recorder=lambda: y.Evidence(root)).execute(**self.args())
                self.assertEqual(actual['cause'], cause)
                self.assertIs(actual['available'], available)
                self.assertEqual(calls, [('docker', y.DOMAIN)])
                text = (root / y.RUN / 'discovery.jsonl').read_text()
                self.assertNotIn('SECRET', text)
                self.assertEqual(json.loads(text.splitlines()[-1])['event'], 'complete')

    def test_missing_attestation_platform_source_import_bootstrap_drift(self):
        edits = [('version', '3.12.1'), ('platform', 'win32'), ('osName', 'nt'),
                 ('supervisorAttestation', ''), ('immutableClosureAttestation', ''),
                 ('interpreter', 'python3'), ('filesystemEncoding', 'ascii'),
                 ('artifacts', {}), ('bootstrap', {}), ('unexpected', 'SECRET')]
        args = self.args()
        for key, value in edits:
            with self.subTest(key=key):
                m = copy.deepcopy(self.manifest)
                m[key] = value
                actual = self.probe().execute(**{**args, 'manifest': m})
                self.assertEqual(actual['cause'], 'GUARD_BLOCKED')
        for verification in (False, None, 1):
            actual = self.probe(verify=lambda m: verification).execute(**args)
            self.assertEqual(actual['cause'], 'GUARD_BLOCKED')
        def untrusted(m):
            raise RuntimeError('SECRET unknown import, mutable closure or platform drift')
        self.assertEqual(self.probe(verify=untrusted).execute(**args)['cause'], 'GUARD_BLOCKED')
        self.sources['checkpoint-y.py'] += b'\n# drift'
        self.assertEqual(self.probe().execute(**args)['cause'], 'GUARD_BLOCKED')
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(self.calls, [])

    def test_scope_and_digest_drift(self):
        args = self.args()
        for field, value in [('humanApproved', False), ('externallySerialized', False),
                             ('runId', 'old-run'), ('contractId', 'f' * 64)]:
            altered = {**args, 'scope': {**args['scope'], field: value}}
            self.assertEqual(self.probe().execute(**altered)['cause'], 'GUARD_BLOCKED')
        self.assertEqual(self.probe().execute(**{**args, 'digest': '0' * 64})['cause'], 'GUARD_BLOCKED')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_second_guard_blocks_lookup_and_retains_evidence(self):
        count = []
        def verify(m):
            count.append(1)
            return len(count) == 1
        actual = self.probe(verify=verify).execute(**self.args())
        self.assertEqual(actual['cause'], 'GUARD_BLOCKED')
        self.assertTrue(actual['evidenceStarted'])
        self.assertFalse(actual['recordingFailed'])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.records()[-1]['status'], 'BLOCKED')

    def test_existing_identity_not_inspected_or_changed(self):
        directory = self.root / y.RUN
        directory.mkdir()
        sentinel = directory / 'keep'
        sentinel.write_text('SECRET')
        actual = self.probe().execute(**self.args())
        self.assertEqual(actual['status'], 'BLOCKED')
        self.assertFalse(actual['evidenceStarted'])
        self.assertTrue(actual['recordingFailed'])
        self.assertEqual(sentinel.read_text(), 'SECRET')
        self.assertEqual(list(directory.iterdir()), [sentinel])
        self.assertEqual(self.calls, [])

    def test_partial_initialization_retained_and_reported(self):
        with patch.object(y.os, 'open', side_effect=PermissionError('SECRET')):
            actual = self.probe().execute(**self.args())
        self.assertTrue(actual['evidenceStarted'])
        self.assertTrue(actual['recordingFailed'])
        self.assertTrue((self.root / y.RUN).is_dir())
        self.assertEqual(self.calls, [])

    def test_recorder_begin_intent_outcome_complete_close_failures(self):
        for failure in ('factory', 'open', 'begin', 'intent', 'outcome', 'complete', 'close'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                calls = []
                root = Path(temp)
                class Failing(y.Evidence):
                    def open(self):
                        super().open()
                        if failure == 'open':
                            raise OSError('SECRET')
                    def append(self, record):
                        if record['event'] == failure:
                            raise OSError('SECRET')
                        super().append(record)
                    def close(self):
                        super().close()
                        if failure == 'close':
                            raise OSError('SECRET')
                def factory():
                    if failure == 'factory':
                        raise OSError('SECRET')
                    return Failing(root)
                def lookup(name, *, path):
                    calls.append(1)
                    return '/SECRET'
                actual = self.probe(lookup=lookup, recorder=factory).execute(**self.args())
                self.assertEqual(actual['status'], 'BLOCKED')
                self.assertTrue(actual['recordingFailed'])
                self.assertEqual(actual['retentionPolicy'], y.RETENTION)
                self.assertEqual(len(calls), int(failure in ('outcome', 'complete', 'close')))
                self.assertEqual(actual['evidenceStarted'], failure != 'factory')
                if failure == 'close':
                    last = json.loads((root / y.RUN / 'discovery.jsonl').read_text().splitlines()[-1])
                    self.assertEqual(last['status'], 'AVAILABLE')  # Fallback still BLOCKED.

    def test_fsync_and_short_write_failures_prevent_lookup(self):
        for name, effect in [('fsync', OSError('SECRET')), ('write', 0)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                kwargs = {'side_effect': effect} if isinstance(effect, Exception) else {'return_value': effect}
                with patch.object(y.os, name, **kwargs):
                    actual = self.probe(recorder=lambda: y.Evidence(Path(temp))).execute(**self.args())
                self.assertTrue(actual['recordingFailed'])
                self.assertTrue(actual['evidenceStarted'])
                self.assertEqual(self.calls, [])
                self.assertTrue((Path(temp) / y.RUN).is_dir())

    def test_durable_intent_precedes_lookup(self):
        def lookup(name, *, path):
            self.assertEqual([r['event'] for r in self.records()], ['begin', 'intent'])
            return None
        self.assertEqual(self.probe(lookup=lookup).execute(**self.args())['status'], 'NOT_FOUND')

    def test_verifier_mutation_and_boolean_impostors_block(self):
        def verify(m):
            m['artifacts']['stdlibImportClosure'] = 'f' * 64
            return True
        self.assertEqual(self.probe(verify=verify).execute(**self.args())['cause'], 'GUARD_BLOCKED')
        args = self.args()
        args['scope']['humanApproved'] = 1
        self.assertEqual(self.probe().execute(**args)['cause'], 'GUARD_BLOCKED')
        m = copy.deepcopy(self.manifest)
        m['bootstrap']['excludeLoaderInjection'] = 1
        self.assertEqual(self.probe().execute(**{**self.args(), 'manifest': m})['cause'], 'GUARD_BLOCKED')
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(self.calls, [])

    def test_untrusted_parent_and_symlink_block(self):
        unsafe = self.root / 'unsafe'
        unsafe.mkdir(mode=0o777)
        unsafe.chmod(0o777)
        link = self.root / 'link'
        link.symlink_to(self.root, target_is_directory=True)
        for root in (unsafe, link):
            actual = self.probe(recorder=lambda: y.Evidence(root)).execute(**self.args())
            self.assertEqual(actual['status'], 'BLOCKED')
            self.assertFalse(actual['evidenceStarted'])
            self.assertTrue(actual['recordingFailed'])
            self.assertFalse((unsafe / y.RUN).exists())
        self.assertEqual(self.calls, [])

    def test_schema_rejects_extra_raw_fields(self):
        self.probe().execute(**self.args())
        record = self.records()[0]
        for extra in ('candidate', 'stdout', 'environment', 'error'):
            with self.assertRaises(ValueError):
                y.validate_event({**record, extra: 'SECRET'})


if __name__ == '__main__':
    unittest.main()
