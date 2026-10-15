#!/usr/bin/env python3
"""Container-free executor boundary regressions; all runtime calls are scripted."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('checkpoint_f', Path(__file__).with_name('checkpoint-f.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

PLAN = dict(context='fixture-context', endpoint='fixture-endpoint', engineId='fixture-engine',
            imageId='sha256:fixture', container='fixture-pg', runId='fixture-run',
            dataVolume='fixture-data', secretVolume='fixture-secret', label='smartlearning.checkpoint=fixture-run',
            database='smartlearning_dev', role='smartlearning_dev_owner',
            migrationRole='smartlearning_dev_migrator', applicationRole='smartlearning_dev_app', publish='127.0.0.1:5433:5432',
            migrations={'sql': [{'name': 'fixture', 'sha256': 'fixture-hash'}]})
CID = 'a' * 64


class StrictRunner:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if not self.replies:
            raise AssertionError('Unexpected runtime command: ' + repr(argv))
        expected, result = self.replies.pop(0)
        if argv != expected:
            raise AssertionError('Command mismatch: ' + repr(argv))
        if isinstance(result, Exception):
            raise result
        return result


def docker(*args):
    return ['docker', '--context', PLAN['context'], *args]


def container(helper=False):
    mounts = [{'Type': 'volume', 'Name': PLAN['secretVolume'],
               'Destination': '/secret' if helper else '/run/secrets', 'RW': helper}]
    if helper:
        mounts.append({'Type': 'tmpfs', 'Destination': '/var/lib/postgresql/data', 'RW': False})
    if not helper:
        mounts.append({'Type': 'volume', 'Name': PLAN['dataVolume'],
                       'Destination': '/var/lib/postgresql/data', 'RW': True})
    return dict(Id=CID, Image=PLAN['imageId'], Name='/' + (PLAN['runId'] + '-secret-helper' if helper else PLAN['container']),
                State={'Running': False}, Config={'User': '0:0' if helper else '', 'Entrypoint': ['sh'] if helper else ['docker-entrypoint.sh'], 'Cmd': ['-ceu', module.HELPER_SCRIPT] if helper else ['postgres'], 'Labels': {module.LABEL: PLAN['runId']}, 'Env': [
                    'POSTGRES_PASSWORD_FILE=' + module.SECRET_PATH, 'POSTGRES_DB=' + PLAN['database'],
                    'POSTGRES_USER=' + PLAN['role'], 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256']},
                HostConfig={'Mounts': [{'Type': 'tmpfs', 'Target': '/var/lib/postgresql/data', 'ReadOnly': True, 'TmpfsOptions': {'SizeBytes': 1048576, 'Mode': 448}}] if helper else [], 'NetworkMode': 'none' if helper else 'default', 'RestartPolicy': {'Name': 'no'}, 'PortBindings': {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '5433'}]}},
                Mounts=mounts)


def stock_helper_mounts(create_args):
    """Image VOLUME is inherited unless creation explicitly shadows its target."""
    c = container(True)
    option = 'type=tmpfs,destination=/var/lib/postgresql/data,readonly,tmpfs-size=1048576,tmpfs-mode=0700'
    if '--mount' not in create_args or create_args[create_args.index('--mount') + 1] != option:
        c['Mounts'][1] = {'Type': 'volume', 'Name': 'fixture-anonymous',
                          'Destination': '/var/lib/postgresql/data', 'RW': True}
        c['HostConfig']['Mounts'] = []
    return c


class ExecutorTests(unittest.TestCase):
    def executor(self, replies=(), **kwargs):
        runner = StrictRunner(replies)
        return module.Executor(copy.deepcopy(PLAN), runner=runner, environment={},
                               port_probe=lambda: None, sleep=lambda _: None, **kwargs), runner

    def test_approval_and_exclusive_access_required_before_commands(self):
        for approval, exclusive in [('', True), (module.APPROVAL, False)]:
            executor, runner = self.executor()
            with self.assertRaisesRegex(ValueError, 'approval'):
                executor.execute(approval, exclusive)
            self.assertEqual(runner.calls, [])
        executor, runner = self.executor()
        with self.assertRaisesRegex(ValueError, 'transaction'):
            executor.execute(module.APPROVAL, True)
        self.assertEqual(runner.calls, [])

    def test_preflight_rejects_runtime_and_connection_overrides(self):
        for key in ['DOCKER_HOST', 'DOCKER_CONTEXT', 'PGHOST', 'PGPASSWORD', 'DATABASE_URL', 'DIRECT_URL']:
            executor, runner = self.executor()
            executor.environment[key] = 'fixture'
            with patch.object(module.contract, 'plan', return_value=PLAN), self.assertRaisesRegex(ValueError, 'override'):
                executor.preflight()
            self.assertEqual(runner.calls, [])

    def preflight_replies(self):
        return [(docker('context', 'show'), PLAN['context']),
                (docker('context', 'inspect', PLAN['context']), json.dumps([{'Endpoints': {'docker': {'Host': PLAN['endpoint']}}}])),
                (docker('info', '--format', '{{.ID}}'), PLAN['engineId']),
                (docker('image', 'inspect', PLAN['imageId']), json.dumps([{'Id': PLAN['imageId'], 'Config': {'Entrypoint': ['docker-entrypoint.sh'], 'Cmd': ['postgres'], 'User': '', 'Volumes': {'/var/lib/postgresql/data': {}}}}])),
                (docker('ps', '-a', '--format', '{{.Names}}'), ''),
                (docker('volume', 'ls', '--format', '{{.Name}}'), ''),
                (['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', module.WINDOWS], 'PORT_AVAILABLE')]

    def test_preflight_wrong_runtime_identity_collisions_and_windows_fail_closed(self):
        cases = [(0, 'other', 'Context'), (1, json.dumps([{'Endpoints': {'docker': {'Host': 'other'}}}]), 'Endpoint'),
                 (2, 'other', 'Engine'), (3, json.dumps([{'Id': 'other', 'Config': {'Entrypoint': [], 'User': ''}}]), 'image'),
                 (4, PLAN['container'], 'collision'), (4, PLAN['runId'] + '-secret-helper', 'collision'),
                 (5, PLAN['dataVolume'], 'collision'), (5, PLAN['secretVolume'], 'collision'),
                 (6, 'UNRECOGNIZED', 'Windows')]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'prisma.config.ts').write_text('dotenv.config({ path: envFile }); url: process.env["DATABASE_URL"]')
            for index, response, message in cases:
                with self.subTest(message=message, index=index):
                    replies = self.preflight_replies()[:index + 1]
                    replies[index] = (replies[index][0], response)
                    executor, runner = self.executor(replies)
                    with patch.object(module.contract, 'plan', return_value=PLAN), patch.object(module.contract, 'REPO', root), self.assertRaisesRegex(ValueError, message):
                        executor.preflight()
                    self.assertEqual(runner.replies, [])
                    self.assertEqual(executor.stages, [])

    def test_container_mount_label_publication_and_secret_guards(self):
        mutations = [lambda c: c['Mounts'].append({'Type': 'bind'}),
                     lambda c: c['Mounts'][0].update(RW=True),
                     lambda c: c['Config'].update(Labels={}),
                     lambda c: c['HostConfig']['PortBindings']['5432/tcp'][0].update(HostIp='0.0.0.0'),
                     lambda c: c['Config']['Env'].append('POSTGRES_PASSWORD=hidden'),
                     lambda c: c['Config']['Env'].append('OTHER=fixture-password')]
        for mutate in mutations:
            c = container()
            mutate(c)
            executor, runner = self.executor([(docker('container', 'inspect', CID), json.dumps([c]))])
            executor.password = 'fixture-password'
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                executor.verify_container(CID)
            self.assertEqual(runner.replies, [])

    def test_stock_volume_without_override_blocks_before_start(self):
        c = stock_helper_mounts([])
        executor, runner = self.executor([(docker('container', 'inspect', CID), json.dumps([c]))])
        with self.assertRaisesRegex(ValueError, 'Mount mismatch'):
            executor.verify_container(CID, True)
        self.assertEqual(len(runner.calls), 1)

    def test_helper_rejects_implicit_volume_and_changed_tmpfs(self):
        for mutation in ('anonymous', 'writable', 'size', 'extra'):
            c = container(True)
            if mutation == 'anonymous':
                c['Mounts'][1] = {'Type': 'volume', 'Name': 'anonymous', 'Destination': '/var/lib/postgresql/data', 'RW': True}
            elif mutation == 'writable':
                c['Mounts'][1]['RW'] = True
            elif mutation == 'size':
                c['HostConfig']['Mounts'][0]['TmpfsOptions']['SizeBytes'] = 2097152
            else:
                c['Mounts'].append({'Type': 'bind', 'Destination': '/extra', 'RW': False})
            executor, runner = self.executor([(docker('container', 'inspect', CID), json.dumps([c]))])
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                executor.verify_container(CID, True)
            self.assertEqual(len(runner.calls), 1)

    def test_volume_rejects_foreign_consumers(self):
        volume = {'Name': PLAN['dataVolume'], 'Labels': {module.LABEL: PLAN['runId']}, 'Driver': 'local', 'Options': None}
        executor, _ = self.executor([
            (docker('volume', 'inspect', PLAN['dataVolume']), json.dumps([volume])),
            (docker('ps', '-a', '--filter', 'volume=' + PLAN['dataVolume'], '--format', '{{.ID}}', '--no-trunc'), 'foreign-id')])
        with self.assertRaisesRegex(ValueError, 'consumer'):
            executor.check_volume(PLAN['dataVolume'], [CID])

    def test_helper_accepts_owned_pg_consumer_during_rollback(self):
        helper_id = 'b' * 64
        c = container(True)
        c['Id'] = helper_id
        volume = {'Name': PLAN['secretVolume'], 'Labels': {module.LABEL: PLAN['runId']}, 'Driver': 'local', 'Options': None}
        replies = [(docker('container', 'inspect', helper_id), json.dumps([c])),
                   (docker('volume', 'inspect', PLAN['secretVolume']), json.dumps([volume])),
                   (docker('ps', '-a', '--filter', 'volume=' + PLAN['secretVolume'], '--format', '{{.ID}}', '--no-trunc'), CID + '\n' + helper_id),
                   (docker('stop', helper_id), '')]
        executor, runner = self.executor(replies)
        executor.ids.update(pg=CID, helper=helper_id)
        original = executor.verify_container
        def verify(cid, helper=False):
            if not helper:
                raise ValueError('PG ownership changed')
            return original(cid, helper)
        with patch.object(executor, 'runtime_identity'), patch.object(executor, 'verify_container', side_effect=verify):
            self.assertEqual(executor.rollback(), ['pg-stop-blocked'])
        self.assertEqual(runner.replies, [])

    def test_helper_command_network_and_privilege_guards(self):
        for mutation in [lambda c: c['Config'].update(User='postgres'),
                         lambda c: c['Config'].update(Cmd=['-ceu', 'other']),
                         lambda c: c['HostConfig'].update(NetworkMode='host'),
                         lambda c: c['HostConfig'].update(Privileged=True)]:
            c = container(True)
            mutation(c)
            executor, runner = self.executor([(docker('container', 'inspect', CID), json.dumps([c]))])
            with self.assertRaises(ValueError):
                executor.verify_container(CID, True)
            self.assertEqual(runner.replies, [])

    def test_running_container_actual_publication_required(self):
        c = container()
        c['State']['Running'] = True
        c['NetworkSettings'] = {'Ports': {'5432/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '5433'}]}}
        executor, runner = self.executor([(docker('container', 'inspect', CID), json.dumps([c]))])
        with self.assertRaisesRegex(ValueError, 'Actual publication'):
            executor.verify_container(CID)
        self.assertEqual(runner.replies, [])

    def provision_mocks(self, executor, sql_result=None, helper_exit=0):
        helper_id = 'b' * 64
        helper = {'State': {'Status': 'exited', 'ExitCode': helper_exit}}
        return [patch.object(module.secrets, 'token_hex', return_value='fixture-password'),
                patch.object(executor, 'runtime_identity'), patch.object(executor, 'volume'),
                patch.object(executor, 'verify_container', side_effect=[helper, helper, container()]),
                patch.object(executor, 'sql', return_value=sql_result or {'db': PLAN['database'], 'role': PLAN['role'], 'tables': 0}),
                patch.object(executor, 'tcp'),
                patch.object(executor, 'docker', side_effect=[helper_id, '', CID, ''])]

    def test_provision_secret_stdin_and_helper_uid_guard_before_write(self):
        from contextlib import ExitStack
        executor, runner = self.executor()
        with ExitStack() as stack:
            mocks = [stack.enter_context(p) for p in self.provision_mocks(executor)]
            executor.provision()
        calls = mocks[-1].call_args_list
        topology = stock_helper_mounts(calls[0].args)
        self.assertEqual(topology['Mounts'][1]['Type'], 'tmpfs')
        self.assertEqual(calls[1].kwargs, {'data': b'fixture-password'})
        self.assertTrue(all('fixture-password' not in repr(call.args) for call in calls))
        self.assertNotIn('fixture-password', repr(executor.environment))
        self.assertLess(module.HELPER_SCRIPT.index('999:999'), module.HELPER_SCRIPT.index('cat >'))
        self.assertEqual(mocks[-2].call_args_list, [unittest.mock.call(), unittest.mock.call(True)])
        self.assertEqual(executor.stages, ['initialized-authenticated'])
        self.assertEqual(runner.calls, [])

    def test_provision_helper_failure_blocks_pg_creation(self):
        from contextlib import ExitStack
        executor, runner = self.executor()
        with ExitStack() as stack:
            mocks = [stack.enter_context(p) for p in self.provision_mocks(executor, helper_exit=1)]
            with self.assertRaisesRegex(ValueError, 'helper failed'):
                executor.provision()
        self.assertEqual(len(mocks[-1].call_args_list), 2)
        mocks[2].assert_called_once_with(PLAN['secretVolume'])
        mocks[4].assert_not_called()
        mocks[5].assert_not_called()
        self.assertNotIn('pg', executor.ids)
        self.assertEqual(runner.calls, [])

    def test_provision_wrong_or_nonempty_sql_target_blocks_tcp(self):
        from contextlib import ExitStack
        good = {'db': PLAN['database'], 'role': PLAN['role'], 'tables': 0}
        for result in [dict(good, db='wrong'), dict(good, role='wrong'), dict(good, tables=1)]:
            executor, runner = self.executor()
            with ExitStack() as stack:
                mocks = [stack.enter_context(p) for p in self.provision_mocks(executor, sql_result=result)]
                with self.assertRaisesRegex(ValueError, 'SQL target'):
                    executor.provision()
            mocks[-2].assert_not_called()
            self.assertEqual(executor.stages, [])
            self.assertEqual(runner.calls, [])

    def test_tcp_password_stdin_and_auth_result_guards(self):
        good = json.dumps({'db': PLAN['database'], 'role': PLAN['role']})
        for reject, result, accepted in [(False, good, True), (True, 'AUTH_REJECTED', True),
                                         (False, json.dumps({'db': 'wrong', 'role': PLAN['role']}), False),
                                         (True, good, False)]:
            executor, runner = self.executor([(['node', '-e', module.TCP], result)])
            executor.password = 'fixture-password'
            with patch.object(module.secrets, 'token_hex', return_value='fixture-invalid'):
                if accepted:
                    executor.tcp(reject)
                else:
                    with self.assertRaisesRegex(ValueError, 'authentication'):
                        executor.tcp(reject)
            argv, kwargs = runner.calls[0]
            self.assertNotIn('fixture-password', repr(argv))
            self.assertNotIn('fixture-invalid', repr(argv))
            self.assertEqual(kwargs['env'], {})
            self.assertEqual(json.loads(kwargs['data']), {'password': 'fixture-invalid' if reject else 'fixture-password', 'reject': reject, 'role': PLAN['role']})
            self.assertEqual(runner.replies, [])

    def test_run_suppresses_stderr_and_redacts_subprocess_failure(self):
        from types import SimpleNamespace
        with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stdout=b'fixture-secret')) as process:
            with self.assertRaisesRegex(ValueError, '^Subprocess blocked$'):
                module.run(['fixture-command'], data=b'fixture-secret', env={})
        self.assertEqual(process.call_args.kwargs['stderr'], module.subprocess.DEVNULL)
        with patch.object(module.subprocess, 'run', side_effect=OSError('fixture-secret')):
            with self.assertRaisesRegex(ValueError, '^Subprocess unavailable$'):
                module.run(['fixture-command'], env={})

    def test_migration_drift_before_and_after_deploy(self):
        for after in (False, True):
            replies = [(['node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'], '')] if after else []
            executor, runner = self.executor(replies)
            executor.ids['pg'] = CID
            executor.password = 'fixture-password'
            executor.migration_password = 'c' * 64
            drift = copy.deepcopy(PLAN)
            drift['migrations']['sql'][0]['sha256'] = 'changed'
            with patch.object(module.contract, 'plan', side_effect=[PLAN, drift] if after else [drift]), patch.object(executor, 'runtime_identity'), patch.object(executor, 'verify_container'), self.assertRaisesRegex(ValueError, 'drift'):
                executor.migrate()
            self.assertEqual(runner.replies, [])
            if after:
                self.assertEqual(runner.calls[0][1]['env']['NODE_ENV'], 'development')
                self.assertNotIn('fixture-password', ' '.join(runner.calls[0][0]))

    def test_migration_command_failure_never_queries_completion(self):
        executor, runner = self.executor([(['node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'], ValueError('deploy failed'))])
        executor.ids['pg'] = CID
        executor.password = 'fixture-password'
        executor.migration_password = 'c' * 64
        with patch.object(module.contract, 'plan', return_value=PLAN), patch.object(executor, 'runtime_identity'), patch.object(executor, 'verify_container'), patch.object(executor, 'sql', side_effect=AssertionError('SQL after failed deploy')), self.assertRaisesRegex(ValueError, 'deploy failed'):
            executor.migrate()
        self.assertEqual(executor.stages, [])
        self.assertEqual(runner.replies, [])

    def test_migration_completion_and_empty_data_required(self):
        good = {'migration_name': 'fixture', 'checksum': 'fixture-hash', 'finished': True, 'rolled_back': False}
        for rows, count in [([], 0), ([dict(good, checksum='other')], 0), ([dict(good, finished=False)], 0),
                            ([dict(good, rolled_back=True)], 0), ([good], 1)]:
            executor, _ = self.executor([(['node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'], '')])
            executor.ids['pg'] = CID
            executor.password = 'fixture-password'
            executor.migration_password = 'c' * 64
            with patch.object(module.contract, 'plan', return_value=PLAN), patch.object(executor, 'runtime_identity'), patch.object(executor, 'verify_container'), patch.object(executor, 'sql', side_effect=[rows, count]), self.assertRaises(ValueError):
                executor.migrate()
            self.assertEqual(executor.stages, [])

    def test_execute_stage_order_and_credential_cleanup(self):
        events = []
        class Transaction:
            path = module.contract.REPO / '.env.development'
            backup_dir = Path('/home/user/.local/share/smartlearning') / PLAN['runId']
            def prepare(self, url, **kwargs): events.append(('prepare', url))
            def commit(self): events.append('commit')
            def verify_written(self, url): events.append('verify-written'); return True
            def restore(self): events.append('restore')
        executor, runner = self.executor(transaction=Transaction())
        def stage(name):
            events.append(name)
            executor.stages.append(name)
            executor.password = 'fixture-password'
            executor.migration_password = 'c' * 64
        def migration():
            stage('migrated-empty')
            return 'fixture-url'
        with patch.object(executor, 'preflight', side_effect=lambda: stage('preflight')), patch.object(executor, 'provision', side_effect=lambda: stage('initialized-authenticated')), patch.object(executor, 'migrate', side_effect=migration), patch.object(executor, 'tcp', side_effect=lambda **k: events.append('tcp')), patch.object(executor, 'separate_roles', side_effect=lambda: stage('roles-separated')), patch.object(executor, 'sql', return_value=True):
            result = executor.execute(module.APPROVAL, True)
        self.assertEqual(events, ['preflight', 'initialized-authenticated', 'roles-separated', 'migrated-empty', ('prepare', 'fixture-url'), 'commit', 'verify-written', 'tcp'])
        self.assertEqual(result['stages'], ['preflight', 'initialized-authenticated', 'roles-separated', 'migrated-empty', 'env-updated'])
        self.assertIsNone(executor.password)
        self.assertIsNone(executor.migration_password)
        self.assertIsNone(executor.application_password)
        self.assertEqual(runner.calls, [])

    def test_separate_roles_uses_stdin_and_distinct_credentials(self):
        executor, runner = self.executor()
        executor.ids['pg'] = CID
        executor.password = 'a' * 64
        sql_argv = docker('exec', '-i', CID, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', PLAN['role'], '-d', PLAN['database'])
        runner.replies = [(sql_argv, 'true'), (['node', '-e', module.TCP], json.dumps({'db': PLAN['database'], 'role': PLAN['migrationRole']})),
                          (['node', '-e', module.TCP], 'AUTH_REJECTED')]
        with patch.object(module.contract, 'plan', return_value=PLAN), patch.object(executor, 'runtime_identity'), patch.object(executor, 'verify_container'), patch.object(module.secrets, 'token_hex', side_effect=['b'*64, 'c'*64, 'd'*64]):
            executor.separate_roles()
        self.assertEqual(executor.stages, ['roles-separated'])
        self.assertEqual(executor.migration_password, 'b' * 64)
        self.assertEqual(executor.application_password, 'c' * 64)
        sql = runner.calls[0][1]['data'].decode()
        self.assertIn("PASSWORD '" + 'b'*64 + "'", sql)
        self.assertIn("PASSWORD '" + 'c'*64 + "'", sql)
        self.assertTrue(all('b'*64 not in repr(argv) and 'c'*64 not in repr(argv) for argv, _ in runner.calls))
        self.assertEqual(runner.replies, [])

    def test_role_setup_rejects_duplicate_and_malicious_credentials_before_sql(self):
        for password in ('x\'; CREATE ROLE attacker SUPERUSER; --', 'A'*64, ''):
            with self.assertRaises(ValueError):
                module.roles.setup(password, 'b'*64)
        with self.assertRaises(ValueError):
            module.roles.setup('a'*64, 'a'*64)
        executor, runner = self.executor()
        executor.password = 'a'*64
        with patch.object(module.contract, 'plan', return_value=PLAN), patch.object(executor, 'runtime_identity'), patch.object(executor, 'sql') as sql, patch.object(module.secrets, 'token_hex', return_value='a'*64):
            with self.assertRaisesRegex(ValueError, 'Duplicate bootstrap'):
                executor.separate_roles()
            sql.assert_not_called()
        self.assertEqual(runner.calls, [])

    def test_migration_uses_migrator_and_returns_only_application_url(self):
        good = {'migration_name': 'fixture', 'checksum': 'fixture-hash', 'finished': True, 'rolled_back': False}
        for privileges_ok in (True, False):
            executor, runner = self.executor([(['node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'], '')])
            executor.ids['pg'] = CID
            executor.password = 'a'*64
            executor.migration_password = 'b'*64
            executor.application_password = 'c'*64
            with patch.object(module.contract, 'plan', return_value=PLAN), patch.object(executor, 'runtime_identity'), patch.object(executor, 'verify_container'), patch.object(executor, 'sql', side_effect=[[good], 0, True, privileges_ok]), patch.object(executor, 'tcp') as tcp:
                if privileges_ok:
                    self.assertEqual(executor.migrate(), 'postgresql://smartlearning_dev_app:' + 'c'*64 + '@127.0.0.1:5433/smartlearning_dev')
                    self.assertEqual(tcp.call_args_list, [unittest.mock.call(role=PLAN['applicationRole']), unittest.mock.call(True, role=PLAN['applicationRole'])])
                else:
                    with self.assertRaisesRegex(ValueError, 'Effective role privileges'):
                        executor.migrate()
                    tcp.assert_not_called()
                    self.assertEqual(executor.stages, [])
            child_env = runner.calls[0][1]['env']
            self.assertEqual(child_env['DATABASE_URL'], 'postgresql://smartlearning_dev_migrator:' + 'b'*64 + '@127.0.0.1:5433/smartlearning_dev')
            self.assertNotIn('a'*64, repr(child_env))
            self.assertNotIn('c'*64, repr(child_env))


    def test_execute_failure_restores_and_reports_blocked_stops(self):
        class Transaction:
            path = module.contract.REPO / '.env.development'
            backup_dir = Path('/home/user/.local/share/smartlearning') / PLAN['runId']
            def restore(self): raise OSError('private diagnostic')
        executor, runner = self.executor(transaction=Transaction())
        executor.ids.update(pg=CID, helper='b' * 64)
        executor.password = 'fixture-password'
        with patch.object(executor, 'preflight', side_effect=ValueError('fixture-password')), patch.object(executor, 'runtime_identity'), patch.object(executor, 'verify_container', side_effect=ValueError('foreign resource')), self.assertRaisesRegex(ValueError, 'rollback=env-restore-blocked,pg-stop-blocked,helper-stop-blocked') as error:
            executor.execute(module.APPROVAL, True)
        self.assertNotIn('fixture-password', str(error.exception))
        self.assertNotIn('private diagnostic', str(error.exception))
        self.assertIsNone(executor.password)
        self.assertEqual(runner.calls, [])


if __name__ == '__main__':
    unittest.main()
