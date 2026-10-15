#!/usr/bin/env python3
"""Container-free full lifecycle fixtures. Never contact Docker or PostgreSQL."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('checkpoint_n', Path(__file__).with_name('checkpoint-n.py'))
n = importlib.util.module_from_spec(spec)
spec.loader.exec_module(n)


class Runtime:
    """Model image VOLUME, retained resources, inspect metadata and SQL stdout."""
    def __init__(self):
        self.p = n.plan()
        self.calls, self.queries = [], []
        self.volumes, self.containers = {}, {}
        self.sql_failure = None
        self.drift = None
        self.interrupt_create = False
        self.ignore_tmpfs = False
        self.stop_failure = False

    def __call__(self, argv, *, data=None, env=None, timeout=30):
        self.calls.append((list(argv), data, dict(env or {})))
        if argv[0] == 'powershell.exe':
            return 'PORT_AVAILABLE'
        if argv[:3] != ['docker', '--context', self.p['context']]:
            raise AssertionError('Unexpected non-Docker command')
        a = argv[3:]
        if a == ['context', 'show']:
            return self.p['context']
        if a[:2] == ['context', 'inspect']:
            return json.dumps([{'Endpoints': {'docker': {'Host': self.p['endpoint']}}}])
        if a[:1] == ['info']:
            return self.p['engineId']
        if a[:2] == ['image', 'inspect']:
            return json.dumps([{'Id': self.p['imageId'], 'Config': {'Entrypoint': ['docker-entrypoint.sh'],
                'Cmd': ['postgres'], 'User': '', 'Volumes': {'/var/lib/postgresql/data': {}}}}])
        if a[:2] == ['volume', 'ls']:
            return '\n'.join(self.volumes)
        if a[:2] == ['volume', 'create']:
            name = a[-1]
            self.volumes[name] = {'Name': name, 'Labels': {n.f.LABEL: self.p['runId']}, 'Driver': 'local', 'Options': None}
            return name
        if a[:2] == ['volume', 'inspect']:
            return json.dumps([self.volumes[a[-1]]])
        if a[0] == 'ps':
            if '--filter' in a:
                name = a[a.index('--filter') + 1].removeprefix('volume=')
                ids = [cid for cid, c in self.containers.items() if any(x.get('Name') == name for x in c['Mounts'])]
                if self.drift == 'consumer' and self.queries:
                    ids.append('f' * 64)
                return '\n'.join(ids)
            return '\n'.join(c['Name'][1:] for c in self.containers.values())
        if a[0] == 'create':
            helper = '--entrypoint' in a
            cid = ('a' if helper else 'b') * 64
            mounts = []
            for index, value in enumerate(a):
                if value == '-v':
                    bits = a[index + 1].split(':')
                    mounts.append({'Type': 'volume', 'Name': bits[0], 'Destination': bits[1], 'RW': len(bits) < 3 or bits[2] != 'ro'})
            config_mounts = []
            if helper:
                option = 'type=tmpfs,destination=/var/lib/postgresql/data,readonly,tmpfs-size=1048576,tmpfs-mode=0700'
                if not self.ignore_tmpfs and '--mount' in a and a[a.index('--mount') + 1] == option:
                    mounts.append({'Type': 'tmpfs', 'Destination': '/var/lib/postgresql/data', 'RW': False})
                    config_mounts = [{'Type': 'tmpfs', 'Target': '/var/lib/postgresql/data', 'ReadOnly': True,
                                     'TmpfsOptions': {'SizeBytes': 1048576, 'Mode': 448}}]
                else:
                    mounts.append({'Type': 'volume', 'Name': 'anonymous-image-volume', 'Destination': '/var/lib/postgresql/data', 'RW': True})
            ports = {} if helper else {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '5433'}]}
            self.containers[cid] = {'Id': cid, 'Image': self.p['imageId'], 'Name': '/' + a[a.index('--name') + 1],
                'Config': {'Labels': {n.f.LABEL: self.p['runId']}, 'User': '0:0' if helper else '',
                    'Entrypoint': ['sh'] if helper else ['docker-entrypoint.sh'],
                    'Cmd': ['-ceu', n.f.HELPER_SCRIPT] if helper else ['postgres'],
                    'Env': [a[i + 1] for i, v in enumerate(a) if v == '-e']},
                'HostConfig': {'Binds': [a[i + 1] for i, v in enumerate(a) if v == '-v'],
                    'Mounts': config_mounts, 'RestartPolicy': {'Name': 'no'},
                    'NetworkMode': 'none' if helper else 'default', 'PortBindings': ports},
                'Mounts': mounts, 'State': {'Running': False, 'Status': 'created', 'ExitCode': 0},
                'NetworkSettings': {'Ports': ports}}
            if self.interrupt_create:
                raise n.m.DiagnosticFailure('TRANSPORT_UNAVAILABLE')
            return cid
        if a[:2] == ['container', 'inspect']:
            c = copy.deepcopy(self.containers[a[-1]])
            if self.queries and c['Id'] == 'b' * 64:
                if self.drift == 'ownership': c['Config']['Labels'] = {}
                if self.drift == 'mount': c['Mounts'][1]['RW'] = True
                if self.drift == 'bind': c['HostConfig']['Binds'].append('/host/private:/extra:ro')
                if self.drift == 'configured-mount': c['HostConfig']['Mounts'].append({'Type': 'bind', 'Source': '/host', 'Target': '/extra'})
            return json.dumps([c])
        if a[0] == 'start':
            c = self.containers[a[-1]]
            helper = c['Config']['Entrypoint'] == ['sh']
            c['State'].update(Running=not helper, Status='exited' if helper else 'running')
            return ''
        if a[0] == 'stop':
            if self.stop_failure: raise n.m.DiagnosticFailure('TRANSPORT_UNAVAILABLE')
            self.containers[a[-1]]['State'].update(Running=False, Status='exited')
            return ''
        if a[0] == 'exec':
            if data is None:
                if 'pg_isready' not in a[-1]: raise AssertionError('Unexpected health probe')
                return '0'
            query = data.decode()
            self.queries.append(query)
            if self.sql_failure and len(self.queries) == self.sql_failure[0]:
                result = self.sql_failure[1]
                if isinstance(result, BaseException): raise result
                return json.dumps(result)
            if 'json_build_object' in query:
                return json.dumps({'db': self.p['database'], 'role': self.p['role'], 'tables': 0})
            return json.dumps(not query.startswith('BEGIN;\nREVOKE') and not query.startswith('BEGIN;\nGRANT'))
        raise AssertionError('Unexpected Docker operation: ' + repr(a))


class LifecycleTests(unittest.TestCase):
    def drive(self, configure=None, **kwargs):
        runtime = Runtime()
        if configure: configure(runtime)
        with tempfile.TemporaryDirectory() as directory:
            credentials = iter(['c' * 64, 'd' * 64, 'e' * 64])
            adapter = n.Adapter(runner=runtime, environment={}, port_probe=lambda: None,
                sleep=lambda _: self.fail('Automatic retry forbidden'), evidence_root=Path(directory),
                credential_factory=lambda _: next(credentials))
            result = adapter.execute(n.APPROVAL, n.contract_hash(), exclusive=True, **kwargs)
            evidence = {str(p.relative_to(directory)): p.read_text() for p in Path(directory).rglob('*') if p.is_file()}
        return result, runtime, adapter, evidence

    def test_success_uses_real_guards_and_complete_sql_driver(self):
        result, runtime, adapter, evidence = self.drive()
        self.assertEqual(result['status'], 'SYNTHETIC_VERIFIED')
        self.assertEqual(len(runtime.queries), 1 + 4 + 2 * len(n.m.CASES))
        self.assertTrue(evidence)
        self.assertEqual(len(runtime.volumes), 2)
        self.assertTrue(all(not c['State']['Running'] for c in runtime.containers.values()))
        helper = runtime.containers['a' * 64]
        self.assertEqual(helper['Mounts'][-1]['Type'], 'tmpfs')
        self.assertFalse(helper['Mounts'][-1]['RW'])
        for password in ['c' * 64, 'd' * 64, 'e' * 64]:
            self.assertNotIn(password, json.dumps(result))
            self.assertNotIn(password, json.dumps(evidence))
            for argv, _, env in runtime.calls:
                self.assertNotIn(password, repr(argv))
                self.assertNotIn(password, repr(env))
        self.assertTrue(all(argv[3] not in ('rm', 'restart', 'prune') for argv, _, _ in runtime.calls if argv[0] == 'docker'))

    def test_sql_failure_is_sanitized_and_never_retried(self):
        result, runtime, _, evidence = self.drive(lambda r: setattr(r, 'sql_failure', (5, n.m.DiagnosticFailure('42601'))))
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(len(runtime.queries), 5)
        self.assertIn('42601', json.dumps(result) + json.dumps(evidence))

    def test_initial_sqlstate_failure_remains_allowlisted_and_no_diagnostic_runs(self):
        result, runtime, _, files = self.drive(lambda r: setattr(r, 'sql_failure',
            (1, n.m.DiagnosticFailure('42601'))))
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['classification'], '42601')
        self.assertEqual(len(runtime.queries), 1)
        lines = [json.loads(line) for filename, value in files.items() if filename.endswith('.jsonl')
                 for line in value.splitlines()]
        self.assertTrue(any(item.get('classification') == '42601' for item in lines))

    def test_each_initial_runtime_transport_failure_stops_without_provisioning(self):
        p = n.plan()
        commands = [
            ['context', 'show'], ['context', 'inspect', p['context']],
            ['info', '--format', '{{.ID}}'], ['image', 'inspect', p['imageId']],
        ]
        outputs = [p['context'], json.dumps([{'Endpoints': {'docker': {'Host': p['endpoint']}}}]),
                   p['engineId'], json.dumps([{'Id': p['imageId']}])]
        failures = [FileNotFoundError('private missing executable'),
                    PermissionError('private denied executable'),
                    subprocess.TimeoutExpired(['private'], 30, output=b'private', stderr=b'private'),
                    subprocess.CompletedProcess([], 0, b'private\xff', b'private')]
        for stage in range(len(commands)):
            for failure in failures:
                with self.subTest(stage=stage, failure=type(failure).__name__), tempfile.TemporaryDirectory() as directory:
                    def runner(*args, **kwargs):
                        return n.m.diagnostic_run(*args, **kwargs)
                    adapter = n.Adapter(runner=runner, environment={'PATH': '/private/inherited/bin'},
                        evidence_root=Path(directory),
                        port_probe=lambda: self.fail('Port probe reached'),
                        sleep=lambda _: self.fail('Retry reached'),
                        credential_factory=lambda _: self.fail('Provisioning reached'))
                    responses = [subprocess.CompletedProcess([], 0, value.encode(), b'')
                                 for value in outputs[:stage]] + [failure]
                    with patch.object(n.m.subprocess, 'run', side_effect=responses) as run:
                        result = adapter.execute(n.APPROVAL, n.contract_hash(), exclusive=True)
                    lines = [json.loads(line) for line in
                        (Path(directory) / p['runId'] / 'lifecycle.jsonl').read_text().splitlines()]
                    self.assertEqual(result['classification'], 'TRANSPORT_UNAVAILABLE')
                    self.assertEqual(result['status'], 'BLOCKED')
                    self.assertEqual(result['checks'], [])
                    self.assertEqual(result['errors'], ['lifecycle-blocked'])
                    self.assertEqual(result['unresolvedCreates'], [])
                    self.assertFalse(result['recordingFailed'])
                    self.assertEqual([line['event'] for line in lines], ['begin', 'blocked', 'complete'])
                    self.assertNotIn('private', json.dumps(result) + json.dumps(lines))
                    self.assertEqual([call.args[0] for call in run.call_args_list],
                        [['docker', '--context', p['context'], *command] for command in commands[:stage + 1]])
                    for call in run.call_args_list:
                        self.assertEqual(call.kwargs['env'], {'PATH':
                            '/usr/local/bin:/usr/bin:/bin:/mnt/c/Windows/System32/WindowsPowerShell/v1.0'})
                    self.assertFalse(adapter.ids)

    def test_unexpected_boolean_and_nonboolean_stop_driver(self):
        for value in (False, 1, 'private-result', {'secret': 'private-result'}):
            with self.subTest(value=value):
                result, runtime, _, evidence = self.drive(lambda r: setattr(r, 'sql_failure', (5, value)))
                self.assertEqual(result['status'], 'BLOCKED')
                self.assertEqual(len(runtime.queries), 5)
                self.assertNotIn('private-result', json.dumps(result) + json.dumps(evidence))

    def test_ownership_mount_consumer_drift_blocks_sql_and_pg_stop(self):
        for drift in ('ownership', 'mount', 'consumer', 'bind', 'configured-mount'):
            with self.subTest(drift=drift):
                result, runtime, _, _ = self.drive(lambda r: setattr(r, 'drift', drift))
                self.assertEqual(result['status'], 'BLOCKED')
                self.assertEqual(len(runtime.queries), 1)
                stops = [argv[-1] for argv, _, _ in runtime.calls if argv[3] == 'stop']
                self.assertNotIn('b' * 64, stops)

    def test_interrupted_create_is_not_retried_or_adopted(self):
        result, runtime, _, evidence = self.drive(lambda r: setattr(r, 'interrupt_create', True))
        self.assertEqual(result['status'], 'BLOCKED')
        creates = [a for a, _, _ in runtime.calls if a[3] == 'create']
        self.assertEqual(len(creates), 1)
        self.assertFalse(runtime.queries)
        self.assertFalse(any(a[3] in ('start', 'stop') for a, _, _ in runtime.calls))
        self.assertTrue(evidence)

    def test_authorization_hash_exclusivity_gate_before_runtime(self):
        for approval, digest, exclusive in [('', n.contract_hash(), True),
                (n.APPROVAL, '0' * 64, True), (n.APPROVAL, n.contract_hash(), False)]:
            runtime = Runtime()
            adapter = n.Adapter(runner=runtime, environment={}, port_probe=lambda: None)
            with self.assertRaises(ValueError): adapter.execute(approval, digest, exclusive=exclusive)
            self.assertFalse(runtime.calls)

    def test_image_volume_not_shadowed_blocks_before_helper_start(self):
        result, runtime, _, _ = self.drive(lambda r: setattr(r, 'ignore_tmpfs', True))
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertFalse(runtime.queries)
        self.assertFalse(any(a[3] == 'start' for a, _, _ in runtime.calls))
        self.assertEqual(runtime.containers['a' * 64]['Mounts'][-1]['Name'], 'anonymous-image-volume')
        self.assertIn('helper', result['unresolvedCreates'])

    def test_unexpected_negative_true_and_failed_restoration_stop(self):
        for query_index, value in ((6, True), (7, False)):
            with self.subTest(query_index=query_index):
                result, runtime, _, _ = self.drive(lambda r: setattr(r, 'sql_failure', (query_index, value)))
                self.assertEqual(result['status'], 'BLOCKED')
                self.assertEqual(len(runtime.queries), query_index)

    def test_guarded_stop_failure_is_retained_and_recorded(self):
        result, runtime, _, evidence = self.drive(lambda r: setattr(r, 'stop_failure', True))
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertIn('pg-stop-blocked', result['errors'])
        self.assertTrue(runtime.containers['b' * 64]['State']['Running'])
        self.assertTrue(result['retained'])
        self.assertIn('stop-blocked', json.dumps(evidence))

    def test_invalid_and_duplicate_credentials_create_no_resources(self):
        for values in (['a' * 64] * 3, ['invalid', 'b' * 64, 'c' * 64]):
            runtime = Runtime()
            with tempfile.TemporaryDirectory() as directory:
                credentials = iter(values)
                adapter = n.Adapter(runner=runtime, environment={}, port_probe=lambda: None,
                    evidence_root=Path(directory), credential_factory=lambda _: next(credentials))
                result = adapter.execute(n.APPROVAL, n.contract_hash(), exclusive=True)
            self.assertEqual(result['status'], 'BLOCKED')
            self.assertFalse(runtime.containers)
            self.assertFalse(runtime.volumes)
            self.assertIsNone(adapter.password)
            self.assertIsNone(adapter.migration_password)
            self.assertIsNone(adapter.application_password)

    def test_single_use_cannot_be_reexecuted_after_success(self):
        _, runtime, adapter, _ = self.drive()
        count = len(runtime.calls)
        with self.assertRaises(ValueError):
            adapter.execute(n.APPROVAL, n.contract_hash(), exclusive=True)
        self.assertEqual(len(runtime.calls), count)

    def test_evidence_begin_failure_prevents_all_runtime_calls(self):
        with patch.object(n.Evidence, 'append', side_effect=OSError('private-evidence')):
            result, runtime, _, _ = self.drive()
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertFalse(runtime.calls)
        self.assertTrue(result['recordingFailed'])
        self.assertNotIn('private-evidence', json.dumps(result))

    def test_recording_failure_after_owned_pg_start_guards_stop(self):
        append = n.Evidence.append
        def fail_initialized(evidence, event, **fields):
            if event == 'initialized': raise OSError('private-evidence')
            return append(evidence, event, **fields)
        with patch.object(n.Evidence, 'append', fail_initialized):
            result, runtime, _, evidence = self.drive()
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertFalse(runtime.containers['b' * 64]['State']['Running'])
        self.assertEqual(len(runtime.queries), 1)
        self.assertTrue(result['recordingFailed'])
        complete = [json.loads(line) for filename, value in evidence.items() if filename.endswith('.jsonl')
                    for line in value.splitlines() if json.loads(line)['event'] == 'complete'][0]
        self.assertTrue(complete['recordingFailed'])
        self.assertIn('recording-blocked', complete['errors'])
        self.assertNotIn('private-evidence', json.dumps(result) + json.dumps(evidence))

    def test_imported_source_changes_cannot_be_approved_as_new_contract(self):
        original = Path.read_bytes
        for filename in n.SOURCE_FILES:
            def drift(path, target=filename):
                value = original(path)
                return value + b'\n# changed after import\n' if path.name == target else value
            with self.subTest(filename=filename), patch.object(Path, 'read_bytes', drift):
                with self.assertRaisesRegex(ValueError, 'source drift'):
                    n.plan()
                with self.assertRaisesRegex(ValueError, 'source drift'):
                    n.contract_hash()
                runtime_calls = []
                with self.assertRaisesRegex(ValueError, 'source drift'):
                    n.Adapter(runner=lambda *a, **kw: runtime_calls.append(a), environment={}).execute(
                        n.APPROVAL, '0' * 64, exclusive=True)
                self.assertFalse(runtime_calls)

    def test_complete_record_captures_unresolved_create_and_failure_codes(self):
        result, _, _, files = self.drive(lambda r: setattr(r, 'interrupt_create', True))
        lines = [json.loads(line) for filename, value in files.items() if filename.endswith('.jsonl')
                 for line in value.splitlines()]
        complete = next(item for item in lines if item['event'] == 'complete')
        self.assertEqual(complete['errors'], result['errors'])
        self.assertEqual(complete['unresolvedCreates'], ['helper'])
        self.assertIs(complete['recordingFailed'], False)

    def test_evidence_close_failure_is_reported_without_secret(self):
        close = n.Evidence.close
        def fail_close(evidence):
            close(evidence)
            raise OSError('private-close')
        with patch.object(n.Evidence, 'close', fail_close):
            result, runtime, _, evidence = self.drive()
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertIn('recording-blocked', result['errors'])
        self.assertNotIn('private-close', json.dumps(result) + json.dumps(evidence))

    def test_mutable_plan_drift_blocks_before_any_runtime_command(self):
        runtime = Runtime()
        with tempfile.TemporaryDirectory() as directory:
            adapter = n.Adapter(runner=runtime, environment={}, port_probe=lambda: None,
                evidence_root=Path(directory))
            adapter.p['dataVolume'] = 'foreign-data'
            result = adapter.execute(n.APPROVAL, n.contract_hash(), exclusive=True)
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertFalse(runtime.calls)
        self.assertFalse(runtime.volumes)

    def test_source_contract_drift_before_runtime_blocks(self):
        runtime = Runtime()
        with tempfile.TemporaryDirectory() as directory:
            adapter = n.Adapter(runner=runtime, environment={}, port_probe=lambda: None,
                evidence_root=Path(directory))
            digest = n.contract_hash()
            with patch.object(n, 'contract_hash', side_effect=[digest, '0' * 64]):
                result = adapter.execute(n.APPROVAL, digest, exclusive=True)
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertFalse(runtime.calls)

    def test_cli_default_and_incomplete_execution_do_not_contact_runtime(self):
        script = str(Path(__file__).with_name('checkpoint-n.py'))
        review = subprocess.run([sys.executable, '-B', script], capture_output=True, check=True)
        self.assertEqual(json.loads(review.stdout)['status'], 'REVIEW_ONLY')
        blocked = subprocess.run([sys.executable, '-B', script, '--execute'], capture_output=True)
        self.assertNotEqual(blocked.returncode, 0)
        self.assertEqual(json.loads(blocked.stdout)['status'], 'BLOCKED')


class EvidenceTests(unittest.TestCase):
    def test_invalid_identity_and_digest_fail_before_creating_root(self):
        for run_id, digest in (('../escape', 'a' * 64), ('/absolute', 'a' * 64),
                (n.plan()['runId'], 'invalid')):
            with self.subTest(run_id=run_id), tempfile.TemporaryDirectory() as directory:
                root = Path(directory) / 'evidence'
                with self.assertRaises((ValueError, OSError)):
                    n.Evidence(root, run_id, digest)
                self.assertFalse(root.exists())
                self.assertFalse((Path(directory) / 'escape').exists())

    def test_symlink_ancestor_is_rejected_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / 'real').mkdir()
            (base / 'link').symlink_to(base / 'real', target_is_directory=True)
            with self.assertRaises((ValueError, OSError)):
                n.Evidence(base / 'link' / 'evidence', n.plan()['runId'], n.contract_hash())
            self.assertFalse((base / 'real' / 'evidence').exists())

    def test_lock_permissions_and_hardlink_fail_closed(self):
        for unsafe in ('mode', 'hardlink'):
            with self.subTest(unsafe=unsafe), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                lock = root / '.sql-lifecycle-port-5433.lock'
                lock.touch(mode=0o600)
                if unsafe == 'mode': lock.chmod(0o644)
                else: os.link(lock, root / 'second-link')
                with self.assertRaises((ValueError, OSError)):
                    n.Evidence(root, n.plan()['runId'], n.contract_hash())
                self.assertFalse((root / n.plan()['runId']).exists())

    def test_same_root_lock_serializes_and_consumed_directory_blocks_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = n.Evidence(root, n.plan()['runId'], n.contract_hash())
            try:
                with self.assertRaises((ValueError, OSError)):
                    n.Evidence(root, n.plan()['runId'], n.contract_hash())
            finally:
                evidence.close()
            with self.assertRaises((ValueError, OSError)):
                n.Evidence(root, n.plan()['runId'], n.contract_hash())
            lines = (root / n.plan()['runId'] / 'lifecycle.jsonl').read_text().splitlines()
            self.assertEqual(len(lines), 1)
            self.assertEqual(json.loads(lines[0])['event'], 'begin')


if __name__ == '__main__':
    unittest.main()
