#!/usr/bin/env python3
"""Offline orchestration regressions: every external operation is mocked."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import MagicMock, patch

SPEC = importlib.util.spec_from_file_location('cold_rebuild_under_test', Path(__file__).with_name('cold-rebuild.py'))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class ClosedPortTests(unittest.TestCase):
    def test_refused_connection_accepts_closed_listener_despite_time_wait(self):
        import errno
        with patch('socket.socket') as factory:
            sock = factory.return_value.__enter__.return_value
            sock.connect_ex.return_value = errno.ECONNREFUSED
            sock.bind.side_effect = OSError(errno.EADDRINUSE, 'TIME_WAIT')
            m.assert_closed_port(3001)
            sock.bind.assert_not_called()

    def test_accepting_listener_is_rejected(self):
        with patch('socket.socket') as factory:
            factory.return_value.__enter__.return_value.connect_ex.return_value = 0
            with self.assertRaisesRegex(RuntimeError, 'listener'):
                m.assert_closed_port(3001)

    def test_timeout_or_unexpected_network_error_is_not_treated_as_closed(self):
        import errno
        with patch('socket.socket') as factory:
            factory.return_value.__enter__.return_value.connect_ex.return_value = errno.ETIMEDOUT
            with self.assertRaisesRegex(RuntimeError, 'listener'):
                m.assert_closed_port(55433)

    def test_socket_exception_is_not_treated_as_closed(self):
        import socket
        with patch('socket.socket') as factory:
            factory.return_value.__enter__.return_value.connect_ex.side_effect = socket.timeout()
            with self.assertRaises(socket.timeout):
                m.assert_closed_port(55433)

    def test_unexpected_network_error_is_not_treated_as_closed(self):
        import errno
        with patch('socket.socket') as factory:
            sock = factory.return_value.__enter__.return_value
            sock.connect_ex.return_value = errno.EHOSTUNREACH
            with self.assertRaisesRegex(RuntimeError, 'listener'):
                m.assert_closed_port(55433)
            sock.settimeout.assert_called_once_with(2)



class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.evidence = self.base / 'evidence'
        self.backups = self.base / 'backups'
        self.backups.mkdir()
        self.cid = 'a' * 64
        self.inventory = {'tables': [], 'sequences': []}
        self.properties = [{'name': 'postgres', 'acl': None, 'owner': 'admin', 'connection_limit': -1}]
        stamp = {'postgres': '2026-01-01T00:00:00+00:00', 'smartlearning_test': '2026-01-01T00:00:00+00:00'}
        self.backup = self.backups / 'sl-daily-20260101T000000Z-aaaaaaaa'
        self.backup.mkdir()
        (self.backup / 'source-manifest.json').write_text(json.dumps({'databases': {db: self.inventory for db in m.d.DATABASES}, 'snapshotUTC': stamp, 'properties': self.properties}))
        for db in m.d.DATABASES:
            (self.backup / (db + '.toc')).write_bytes(b'toc')
        self.manifest = {'engine': m.r.local.ENGINE, 'image': m.r.local.IMAGE, 'volume': m.r.local.VOLUME, 'source': {'system': 'source'}, 'snapshotUTC': stamp, 'files': {}, 'consistency': 'snapshot'}
        self.identity = {'system': 'fresh', 'cluster': m.RUN, 'database': m.r.DB, 'role': m.r.ADMIN, 'schema': 'public', 'recovery': False}
        self.state = 'created'
        self.records = {}
        self.docker = MagicMock(side_effect=self.docker_result)
        self.metadata = MagicMock(side_effect=lambda cid: {'id': cid, 'state': self.state})
        self.process = MagicMock(returncode=0)
        self.process.communicate.return_value = (b'FUNCTION_SMOKE_PASS\nCOMPILED_READINESS_PASS\nAPP_CLEANUP_PASS\nTIMING {"serviceReadyOffsetSeconds": 1}\n', b'')
        self.process.poll.return_value = 0
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        patches = [patch.object(m, 'EVIDENCE', self.evidence), patch.object(m.d, 'DEST', self.backups), patch.dict(os.environ, {'SL_COLD_REBUILD_AUTHORIZATION': m.RUN}), patch.object(m.signal, 'signal'), patch.object(m.signal, 'alarm'), patch.object(m.os, 'umask'), patch.object(m.d, 'mount_check'), patch.object(m.d, 'file_hash', return_value='digest'), patch.object(m.d, 'verify_run', return_value=self.manifest), patch.object(m.d, 'acl'), patch.object(m.d, 'validate_toc'), patch.object(m.r, 'source_check', return_value={'id': m.r.SOURCE_ID}), patch.object(m.r, 'identity', side_effect=lambda cid: {'system': 'source'} if cid == m.r.SOURCE_ID else self.identity), patch.object(m.r, 'docker', self.docker), patch.object(m.r, 'metadata', self.metadata), patch.object(m.r, 'free_port'), patch.object(m, 'assert_closed_port'), patch.object(m.r, 'record', side_effect=lambda name, value: self.records.update({name: value})), patch.object(m.r, 'restore', return_value=b'toc'), patch.object(m.r.legacy, 'inventory', return_value=self.inventory), patch.object(m.r, 'properties', return_value=self.properties), patch.object(m.r, 'dbsql'), patch.object(m, 'prepare_build'), patch.object(m, 'allow_forwarded_peer'), patch.object(m.subprocess, 'check_output', side_effect=lambda args, **kw: b'v26.5.1' if args == ['node', '--version'] else b'11.17.0' if args == ['npm', '--version'] else b'"app_role"'), patch.object(m.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout=b'SCRAM_RECOVERY_PASS')), patch.object(m.subprocess, 'Popen', return_value=self.process)]
        for p in patches:
            self.stack.enter_context(p)

    def docker_result(self, *args, **kwargs):
        if args[:2] == ('network', 'inspect'):
            return json.dumps([{'Labels': {'smartlearning.checkpoint': m.RUN}, 'Driver': 'bridge', 'IPAM': {'Config': [{'Gateway': '172.20.0.1'}]}}]).encode()
        if args[0] == 'create':
            return self.cid.encode()
        if args[0] == 'start':
            self.state = 'running'
        if args[0] == 'stop':
            self.state = 'exited'
        return b''

    def execute(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return m.main()

    def test_missing_authorization_never_creates_resources(self):
        with patch.dict(os.environ, {'SL_COLD_REBUILD_AUTHORIZATION': ''}):
            with self.assertRaisesRegex(RuntimeError, 'authorization'):
                self.execute()
        self.docker.assert_not_called()
        self.assertFalse(self.evidence.exists())

    def test_consumed_run_authorization_rejected_before_any_io(self):
        with patch.dict(os.environ, {'SL_COLD_REBUILD_AUTHORIZATION': 'sl-cold-rebuild-20261015-01'}), \
             patch.object(m.r, 'docker') as docker, patch.object(m, 'prepare_build') as build:
            with self.assertRaisesRegex(RuntimeError, 'authorization'):
                m.main()
            docker.assert_not_called()
            build.assert_not_called()
            self.assertFalse(self.evidence.exists())

    def test_consumed_run02_authorization_rejected_before_io(self):
        with patch.dict(os.environ, {'SL_COLD_REBUILD_AUTHORIZATION': 'sl-cold-rebuild-20261015-02'}), patch.object(m.r, 'docker') as docker:
            with self.assertRaisesRegex(RuntimeError, 'authorization'):
                m.main()
            docker.assert_not_called()
            self.assertFalse(self.evidence.exists())

    def test_consumed_run03_authorization_rejected_before_io(self):
        with patch.dict(os.environ, {'SL_COLD_REBUILD_AUTHORIZATION': 'sl-cold-rebuild-20261015-03'}), patch.object(m.r, 'docker') as docker, patch.object(m, 'prepare_build') as build:
            with self.assertRaisesRegex(RuntimeError, 'authorization'):
                m.main()
            docker.assert_not_called()
            build.assert_not_called()
            self.assertFalse(self.evidence.exists())

    def test_all_runtime_bindings_use_fresh_run(self):
        self.assertEqual(m.RUN, 'sl-cold-rebuild-20261015-04')
        for name in ['cold-rebuild.py', 'cold-rebuild-config.cjs', 'cold-rebuild-credentials.cjs',
                     'cold-rebuild-runtime.cjs', 'cold-rebuild-sql.cjs']:
            text = (Path(__file__).parent / name).read_text()
            self.assertIn(m.RUN, text, name)
            self.assertNotIn('sl-cold-rebuild-20261015-01', text, name)
            self.assertNotIn('sl-cold-rebuild-20261015-02', text, name)
            self.assertNotIn('sl-cold-rebuild-20261015-03', text, name)
        self.assertEqual(m.r.CONTAINER, m.RUN + '-pg')
        self.assertEqual(m.r.VOLUME, m.RUN + '-data')
        self.assertEqual(m.r.NETWORK, m.RUN + '-net')

    def test_existing_evidence_rejects_replay(self):
        self.evidence.mkdir()
        with self.assertRaisesRegex(RuntimeError, 'no replay'):
            self.execute()
        self.docker.assert_not_called()

    def test_success_stops_exact_owned_container_and_records_rto(self):
        self.assertEqual(self.execute(), 0)
        self.docker.assert_any_call('stop', '--time', '30', self.cid, timeout=45)
        self.assertEqual(self.records['result.json']['status'], 'PASS')
        self.assertGreaterEqual(self.records['result.json']['timings']['serviceReadySeconds'], 1)
        self.assertTrue(self.records['result.json']['restoreStopped'])

    def test_first_port_failure_still_checks_second_and_records_safe_diagnostics(self):
        with patch.object(m, 'assert_closed_port', side_effect=[RuntimeError('private-detail'), None]) as closed:
            self.assertEqual(self.execute(), 1)
        self.assertEqual([call.args[0] for call in closed.call_args_list], [3001, 55433])
        result = self.records['result.json']
        self.assertEqual(result['cleanupFailures'], ['ports-not-closed'])
        self.assertEqual(result['portClosure']['3001']['status'], 'BLOCKED')
        self.assertEqual(result['portClosure']['55433']['status'], 'PASS')
        self.assertTrue(result['reason'])
        self.assertNotIn('private-detail', json.dumps(self.records))

    def test_stopped_ports_do_not_mask_owned_container_stop_failure(self):
        original = self.docker.side_effect
        def docker(*args, **kwargs):
            if args[0] == 'stop':
                raise RuntimeError('stop failed')
            return original(*args, **kwargs)
        self.docker.side_effect = docker
        self.assertEqual(self.execute(), 1)
        result = self.records['result.json']
        self.assertFalse(result['restoreStopped'])
        self.assertIn('restore-stop-unconfirmed', result['cleanupFailures'])
        self.assertEqual(result['status'], 'BLOCKED')

    def test_configuration_failure_is_sanitized_before_resource_creation(self):
        original = m.subprocess.check_output.side_effect
        def output(args, **kwargs):
            if 'tools/dev/cold-rebuild-config.cjs' in args:
                raise subprocess.CalledProcessError(1, args, stderr=b'secret-do-not-log')
            return original(args, **kwargs)
        with patch.object(m.subprocess, 'check_output', side_effect=output):
            self.assertEqual(self.execute(), 1)
        self.assertEqual(self.records['configuration.json']['category'], 'CONFIGURATION_REJECTED')
        self.assertNotIn('secret-do-not-log', json.dumps(self.records))
        self.assertFalse(any(call.args[0] in ['create', 'start'] or call.args[:2] in [('network', 'create'), ('volume', 'create')] for call in self.docker.call_args_list))

    def test_newest_corrupt_generation_never_falls_back(self):
        newest = self.backups / 'sl-daily-20260102T000000Z-bbbbbbbb'
        newest.mkdir()
        with patch.object(m.d, 'verify_run', side_effect=RuntimeError('corrupt')) as verify:
            self.assertEqual(self.execute(), 1)
        verify.assert_called_once_with(newest)
        m.prepare_build.assert_not_called()
        self.docker.assert_not_called()

    def test_inventory_mismatch_prevents_runtime_and_stops_restore(self):
        with patch.object(m.r.legacy, 'inventory', return_value={'different': True}):
            self.assertEqual(self.execute(), 1)
        m.allow_forwarded_peer.assert_not_called()
        m.subprocess.Popen.assert_not_called()
        self.docker.assert_any_call('stop', '--time', '30', self.cid, timeout=45)

    def test_nonindependent_system_identifier_prevents_runtime(self):
        self.identity['system'] = 'source'
        self.assertEqual(self.execute(), 1)
        m.subprocess.Popen.assert_not_called()
        self.assertIn('Independent identity', self.records['result.json']['reason'])

    def test_partial_create_timeout_reconciles_and_stops_exact_identity(self):
        ordinary = self.docker_result
        def ambiguous(*args, **kwargs):
            if args[0] == 'create':
                self.state = 'running'
                raise subprocess.TimeoutExpired('docker create', 60)
            return ordinary(*args, **kwargs)
        self.docker.side_effect = ambiguous
        with patch.object(m.r.local, 'inspect', return_value={'id': self.cid}):
            self.assertEqual(self.execute(), 1)
        self.metadata.assert_any_call(self.cid)
        self.docker.assert_any_call('stop', '--time', '30', self.cid, timeout=45)
        self.assertEqual(self.records['result.json']['ownedContainer'], self.cid)

    def test_partial_create_unverified_identity_is_never_stopped(self):
        self.docker.side_effect = lambda *a, **kw: (_ for _ in ()).throw(subprocess.TimeoutExpired('create', 60)) if a[0] == 'create' else self.docker_result(*a, **kw)
        with patch.object(m.r.local, 'inspect', return_value={'id': self.cid}), patch.object(m.r, 'metadata', side_effect=RuntimeError('ownership mismatch')):
            self.assertEqual(self.execute(), 1)
        self.assertFalse(any(c.args[0] == 'stop' for c in self.docker.call_args_list))
        self.assertIn('partial-create-inspection-required', self.records['result.json']['cleanupFailures'])

    def test_runtime_timeout_terminates_worker_before_restore_stop(self):
        self.process.communicate.side_effect = [subprocess.TimeoutExpired('node', 120), (b'', b'')]
        self.process.poll.return_value = None
        self.assertEqual(self.execute(), 1)
        self.process.terminate.assert_called_once()
        self.docker.assert_any_call('stop', '--time', '30', self.cid, timeout=45)


class IndependentBuildTests(unittest.TestCase):
    def test_build_timeout_terminates_owned_session_group(self):
        proc = MagicMock(pid=321)
        proc.wait.side_effect = [subprocess.TimeoutExpired('npm', 1), 0]
        with patch.object(m.subprocess, 'Popen', return_value=proc) as spawn, patch.object(m.os, 'killpg', side_effect=[None, ProcessLookupError()]) as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                m.run_build_command(['npm', 'ci'], Path('/tmp/offline-build'), {'PATH': '/offline'}, 1)
        self.assertTrue(spawn.call_args.kwargs['start_new_session'])
        self.assertEqual(kill.call_args_list[0].args, (321, m.signal.SIGTERM))
        self.assertEqual(proc.wait.call_count, 2)

    def test_fresh_install_generate_build_with_private_cache_and_no_env_copy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            evidence = root / 'evidence'
            evidence.mkdir()
            (root / 'src').mkdir()
            (root / 'prisma').mkdir()
            (root / 'src/main.ts').write_text('await app.listen(port);')
            (root / 'prisma/schema.prisma').write_text('schema')
            (root / '.env.test').write_text('SECRET=never-copy')
            (root / 'node_modules').mkdir()
            for name in ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'nest-cli.json', 'prisma.config.ts']:
                (root / name).write_text('{}')
            calls = []
            def command(args, build, env, timeout):
                calls.append((args, build, env.copy(), timeout))
                if args == ['npm', 'run', 'build']:
                    output = build / 'dist/src/main.js'
                    output.parent.mkdir(parents=True)
                    output.write_text('compiled')
                return 0
            with patch.object(m, 'ROOT', root), patch.object(m, 'EVIDENCE', evidence), patch.object(m, 'run_build_command', side_effect=command), patch.object(m, 'npm_configuration_preflight', return_value={'status': 'PASS'}), patch.object(m.r, 'record'):
                m.prepare_build()
            self.assertEqual([x[0] for x in calls], [['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], ['npm', 'run', 'prisma:generate'], ['npm', 'run', 'build']])
            build = evidence / 'build'
            self.assertFalse((build / '.env.test').exists())
            self.assertFalse((build / 'node_modules').exists())
            self.assertEqual((root / 'src/main.ts').read_text(), 'await app.listen(port);')
            self.assertIn("'127.0.0.1'", (build / 'src/main.ts').read_text())
            for _, cwd, env, _ in calls:
                self.assertEqual(cwd, build)
                self.assertEqual(env['npm_config_cache'], str(evidence / 'npm-cache'))
                self.assertNotEqual(env['npm_config_userconfig'], env['npm_config_globalconfig'])
                for key in ['npm_config_userconfig', 'npm_config_globalconfig']:
                    config = Path(env[key])
                    self.assertEqual(config.read_text(), '')
                    self.assertEqual(config.stat().st_mode & 0o777, 0o600)
                self.assertEqual(env['HOME'], str(evidence / 'npm-home'))
                self.assertNotIn('NODE_PATH', env)



if __name__ == '__main__':
    unittest.main()
