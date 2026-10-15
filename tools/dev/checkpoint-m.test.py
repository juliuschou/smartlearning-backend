#!/usr/bin/env python3
"""Container-free tests: do not execute Docker or PostgreSQL."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('checkpoint_m', Path(__file__).with_name('checkpoint-m.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class DiagnosticTests(unittest.TestCase):
    def drive(self, failure=None):
        queries = []
        def sql(query):
            queries.append(query)
            if failure and len(queries) == failure[0]:
                if isinstance(failure[1], Exception):
                    raise failure[1]
                return failure[1]
            return not query.startswith('BEGIN;\n')
        return m.diagnose(sql, 'a' * 64, 'b' * 64), queries

    def test_positive_negative_and_restoration_cases(self):
        result, queries = self.drive()
        self.assertEqual(result['status'], 'SYNTHETIC_VERIFIED')
        self.assertEqual(len(queries), 4 + 2 * len(m.CASES))
        self.assertEqual(queries[3], m.roles.AUDIT)
        for index, (_, mutation) in enumerate(m.CASES):
            self.assertEqual(queries[4 + 2 * index], 'BEGIN;\n' + mutation + ';\n' + m.roles.AUDIT + '\nROLLBACK;')
            self.assertEqual(queries[5 + 2 * index], m.roles.AUDIT)
        self.assertTrue(all(check['matched'] for check in result['checks']))

    def test_positive_false_stops_before_negative_cases(self):
        result, queries = self.drive((4, False))
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(len(queries), 4)
        self.assertEqual(result['checks'][-1]['result'], False)

    def test_negative_true_stops_before_restoration_or_other_cases(self):
        result, queries = self.drive((5, True))
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(len(queries), 5)

    def test_failed_restoration_stops(self):
        result, queries = self.drive((6, False))
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(len(queries), 6)

    def test_non_boolean_is_not_success(self):
        for invalid in (1, 0, None, 'true', {'secret': 'do-not-publish'}):
            result, queries = self.drive((4, invalid))
            self.assertEqual(len(queries), 4)
            self.assertEqual(result['checks'][-1]['classification'], 'INVALID_RESULT')
            self.assertNotIn('do-not-publish', json.dumps(result))

    def test_failure_is_sanitized_and_never_retried(self):
        for error, expected in ((m.DiagnosticFailure('42601'), '42601'),
                                (m.DiagnosticFailure('secret-do-not-publish'), 'UNKNOWN'),
                                (RuntimeError('secret-do-not-publish'), 'UNKNOWN')):
            result, queries = self.drive((4, error))
            self.assertEqual(len(queries), 4)
            self.assertEqual(result['checks'][-1]['classification'], expected)
            self.assertNotIn('secret-do-not-publish', json.dumps(result))

    def test_invalid_or_duplicate_credentials_never_call_sql(self):
        for passwords in (('bad', 'b' * 64), ('a' * 64, 'a' * 64)):
            with patch('builtins.print'):
                result = m.diagnose(lambda _: self.fail('SQL called'), *passwords)
            self.assertEqual(result['status'], 'BLOCKED')

    def test_only_allowlisted_error_prefixes_are_classified(self):
        self.assertEqual(m.classify(b'ERROR:  42601: secret SQL\nDETAIL: token'), '42601')
        self.assertEqual(m.classify(b'psql:<stdin>:2: ERROR:  42501: token'), '42501')
        for stderr in (b'DETAIL: 42601', b'ERROR: XX000: raw', b'password=42601', b''):
            self.assertEqual(m.classify(stderr), 'UNKNOWN')

    def test_subprocess_failure_never_exposes_diagnostics(self):
        with patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess(
                [], 1, b'private-query', b'ERROR: 42601: private-password')):
            with self.assertRaises(m.DiagnosticFailure) as caught:
                m.diagnostic_run(['mock'])
        self.assertEqual(caught.exception.classification, '42601')
        self.assertEqual(str(caught.exception), 'Diagnostic blocked')

    def test_timeout_does_not_expose_captured_output(self):
        with patch.object(m.subprocess, 'run', side_effect=subprocess.TimeoutExpired(
                ['mock'], 30, output=b'private', stderr=b'private')):
            with self.assertRaises(m.DiagnosticFailure) as caught:
                m.diagnostic_run(['mock'])
        self.assertEqual(caught.exception.classification, 'TRANSPORT_UNAVAILABLE')
        self.assertNotIn('private', str(caught.exception))

    def test_availability_and_decoding_failures_have_same_sanitized_classification(self):
        failures = (
            FileNotFoundError(2, 'private executable missing', '/private/docker'),
            PermissionError(13, 'private permission denied', '/private/docker'),
            OSError(8, 'private executable format', '/private/docker'),
        )
        for failure in failures:
            with self.subTest(failure=type(failure).__name__), patch.object(
                    m.subprocess, 'run', side_effect=failure) as run:
                with self.assertRaises(m.DiagnosticFailure) as caught:
                    m.diagnostic_run(['mock'])
                self.assertEqual(run.call_count, 1)
                self.assertEqual(caught.exception.classification, 'TRANSPORT_UNAVAILABLE')
                self.assertEqual(str(caught.exception), 'Diagnostic blocked')
                self.assertTrue(caught.exception.__suppress_context__)
        with patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess(
                [], 0, b'private\xff', b'private stderr')):
            with self.assertRaises(m.DiagnosticFailure) as caught:
                m.diagnostic_run(['mock'])
        self.assertEqual(caught.exception.classification, 'TRANSPORT_UNAVAILABLE')
        self.assertEqual(str(caught.exception), 'Diagnostic blocked')

    def test_success_forwards_only_explicit_environment_and_decodes_stdout(self):
        environment = {'PATH': '/fixture/bin'}
        with patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess(
                [], 0, b'available\n', b'private stderr')) as run:
            self.assertEqual(m.diagnostic_run(['mock'], env=environment), 'available\n')
        run.assert_called_once_with(['mock'], input=None, env=environment, timeout=30,
            cwd=m.f.contract.REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)

    def test_nonzero_runtime_exit_is_unknown_rather_than_transport_unavailable(self):
        with patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess(
                [], 1, b'private stdout', b'private runtime unavailable')):
            with self.assertRaises(m.DiagnosticFailure) as caught:
                m.diagnostic_run(['mock'])
        self.assertEqual(caught.exception.classification, 'UNKNOWN')
        self.assertEqual(str(caught.exception), 'Diagnostic blocked')

    def test_guards_run_before_sql_and_blocks_do_not_publish_raw_exception(self):
        transport = m.SQLTransport(runner=lambda *a, **kw: self.fail('runner reached'))
        transport.ids['pg'] = 'c' * 64
        calls = []
        transport.runtime_identity = lambda: calls.append('runtime')
        def blocked(cid):
            calls.append('container-mount-consumer')
            raise ValueError('private metadata')
        transport.verify_container = blocked
        result = m.diagnose(transport.sql, 'a' * 64, 'b' * 64)
        self.assertEqual(calls, ['runtime', 'container-mount-consumer'])
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertNotIn('private', json.dumps(result))

    def test_exact_guarded_psql_uses_stdin_and_verbose(self):
        transport = m.SQLTransport()
        transport.ids['pg'] = 'c' * 64
        calls = []
        transport.runtime_identity = lambda: calls.append('runtime')
        transport.verify_container = lambda cid: calls.append('container')
        def docker(*args, data=None):
            calls.append((args, data))
            return 'true\n'
        transport.docker = docker
        self.assertIs(transport.sql(m.roles.AUDIT), True)
        self.assertEqual(calls[:2], ['runtime', 'container'])
        args, data = calls[2]
        self.assertIn('VERBOSITY=verbose', args)
        self.assertEqual(data, m.roles.AUDIT.encode())
        self.assertNotIn(m.roles.AUDIT, args)

    def test_no_live_lifecycle_or_inherited_environment(self):
        transport = m.SQLTransport(runner=lambda *a, **kw: self.fail('runner reached'))
        for name in ('preflight', 'provision', 'separate_roles', 'migrate', 'execute'):
            with self.assertRaisesRegex(ValueError, 'not enabled'):
                getattr(transport, name)()
        with self.assertRaises(ValueError):
            m.SQLTransport(environment={'DATABASE_URL': 'private'})

    def test_contract_drift_blocks_before_runtime(self):
        transport = m.SQLTransport(runner=lambda *a, **kw: self.fail('runner reached'))
        transport.p['runId'] = 'sl-i-20261014-01'
        with self.assertRaisesRegex(ValueError, 'contract drift'):
            transport.sql(m.roles.AUDIT)

    def test_cli_review_and_execute_rejection_are_container_free(self):
        script = str(Path(__file__).with_name('checkpoint-m.py'))
        import sys
        review = subprocess.run([sys.executable, '-B', script], capture_output=True, check=True)
        self.assertEqual(json.loads(review.stdout)['status'], 'REVIEW_ONLY')
        blocked = subprocess.run([sys.executable, '-B', script, '--execute'], capture_output=True)
        self.assertEqual(blocked.returncode, 1)
        self.assertEqual(json.loads(blocked.stdout)['classification'], 'LIVE_NOT_ENABLED')

    def test_fresh_contract_and_source_bound_hash(self):
        plan = m.plan()
        self.assertFalse(plan['liveEnabled'])
        self.assertNotIn('migrations', plan)
        self.assertNotIn('sl-i-', json.dumps(plan))
        self.assertNotIn('sl-e-', json.dumps(plan))
        self.assertEqual(plan['audit'], m.roles.AUDIT)
        self.assertEqual(len(m.contract_hash()), 64)
        self.assertIs(m.SQLTransport.verify_container, m.f.Executor.verify_container)
        self.assertIs(m.SQLTransport.rollback, m.f.Executor.rollback)


if __name__ == '__main__':
    unittest.main()
