#!/usr/bin/env python3
"""Temporary files and mocked runtimes only; no Docker/SQL/real env access."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('checkpoint_g', Path(__file__).with_name('checkpoint-g.py'))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
t = g.f.load('f_tests', 'checkpoint-f.test.py')


class JournalTests(unittest.TestCase):
    def test_exclusive_protected_durable_files_and_sanitized_schema(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'evidence'
            journal = g.Journal(path)
            journal.event('begin')
            journal.event('after', operation='create', ids={'pg': t.CID})
            journal.outcome({'status': 'BLOCKED'})
            journal.close()
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
            self.assertEqual((path / 'outcome.json').stat().st_mode & 0o777, 0o600)
            events = [json.loads(s) for s in (path / 'lifecycle.jsonl').read_text().splitlines()]
            self.assertEqual([s['sequence'] for s in events], [1, 2])
            with self.assertRaises(FileExistsError):
                g.Journal(path)

    def test_symlink_parent_blocked(self):
        with tempfile.TemporaryDirectory() as root:
            alias = Path(root) / 'alias'
            alias.symlink_to(root)
            with self.assertRaises(ValueError):
                g.Journal(alias / 'evidence')

    def test_arbitrary_event_and_id_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            journal = g.Journal(Path(root) / 'evidence')
            try:
                with self.assertRaises(ValueError):
                    journal.event('password:secret')
                with self.assertRaises(ValueError):
                    journal.event('begin', ids={'pg': 'secret-url'})
            finally:
                journal.close()


class MemoryJournal:
    def __init__(self, fail=None):
        self.events = []
        self.results = []
        self.fail = fail

    def event(self, event, **kwargs):
        if event == self.fail:
            raise OSError('secret raw diagnostic')
        self.events.append((event, json.loads(json.dumps(kwargs))))

    def outcome(self, result):
        if self.fail == 'outcome':
            raise OSError('secret raw diagnostic')
        self.results.append(result)


class RecordingTests(unittest.TestCase):
    def executor(self, journal, runner):
        return g.RecordedExecutor(t.PLAN, journal=journal, runner=runner, environment={})

    def test_record_before_runtime_and_suppress_raw_diagnostics(self):
        journal = MemoryJournal()
        runner = t.StrictRunner([(t.docker('start', t.CID), ValueError('password=secret'))])
        executor = self.executor(journal, runner)
        with self.assertRaises(ValueError):
            executor.docker('start', t.CID)
        self.assertEqual([x[0] for x in journal.events], ['before', 'failed'])
        self.assertNotIn('secret', json.dumps(journal.events))

    def test_before_record_failure_prevents_command(self):
        runner = t.StrictRunner([])
        executor = self.executor(MemoryJournal('before'), runner)
        with self.assertRaisesRegex(ValueError, 'recording'):
            executor.docker('start', t.CID)
        self.assertEqual(runner.calls, [])

    def test_create_response_lost_recovers_exact_id_for_rollback(self):
        runner = t.StrictRunner([(t.docker('create', '--name', t.PLAN['container']), OSError('lost secret response'))])
        executor = self.executor(MemoryJournal(), runner)
        with patch.object(executor, 'runtime_identity'), patch.object(executor, 'inspect', return_value={'Id': t.CID}) as inspect, patch.object(executor, 'verify_container') as verify:
            with self.assertRaisesRegex(ValueError, 'Create response'):
                executor.docker('create', '--name', t.PLAN['container'])
            inspect.assert_called_once_with('container', t.PLAN['container'])
            verify.assert_called_once_with(t.CID, False)
        self.assertEqual(executor.ids, {'pg': t.CID})
        self.assertEqual(executor.unresolved, [])

    def test_create_after_record_failure_keeps_returned_id(self):
        runner = t.StrictRunner([(t.docker('create', '--name', t.PLAN['container']), t.CID)])
        executor = self.executor(MemoryJournal('after'), runner)
        with patch.object(executor, 'runtime_identity'), patch.object(executor, 'inspect', side_effect=ValueError('runtime unavailable')):
            with self.assertRaises(ValueError):
                executor.docker('create', '--name', t.PLAN['container'])
        self.assertEqual(executor.ids, {'pg': t.CID})
        self.assertEqual(executor.unresolved, ['pg'])
        self.assertTrue(executor.recording_failed)

    def test_recovered_foreign_id_is_retained_but_never_stopped(self):
        runner = t.StrictRunner([(t.docker('create', '--name', t.PLAN['container']), OSError('lost response'))])
        executor = self.executor(MemoryJournal(), runner)
        with patch.object(executor, 'runtime_identity'), patch.object(executor, 'inspect', return_value={'Id': t.CID}), patch.object(executor, 'verify_container', side_effect=ValueError('foreign resource')):
            with self.assertRaisesRegex(ValueError, 'Create response'):
                executor.docker('create', '--name', t.PLAN['container'])
            self.assertEqual(executor.rollback(), ['pg-stop-blocked'])
        self.assertEqual(executor.ids, {'pg': t.CID})
        self.assertEqual(executor.unresolved, ['pg'])
        self.assertEqual(len(runner.calls), 1)
        self.assertEqual(runner.replies, [])

    def test_lost_response_unavailable_runtime_marks_unknown_without_adoption(self):
        runner = t.StrictRunner([(t.docker('create', '--name', t.PLAN['container']), OSError())])
        executor = self.executor(MemoryJournal(), runner)
        with patch.object(executor, 'runtime_identity', side_effect=ValueError('unavailable')), patch.object(executor, 'inspect') as inspect:
            with self.assertRaises(ValueError):
                executor.docker('create', '--name', t.PLAN['container'])
            inspect.assert_not_called()
        self.assertEqual(executor.unresolved, ['pg'])
        self.assertEqual(executor.ids, {})

    def test_recorder_failure_does_not_prevent_guarded_rollback(self):
        executor = self.executor(MemoryJournal('before'), t.StrictRunner([(t.docker('stop', t.CID), '')]))
        executor.ids['pg'] = t.CID
        with patch.object(executor, 'runtime_identity'), patch.object(executor, 'verify_container'):
            self.assertEqual(executor.rollback(), [])
        self.assertTrue(executor.recording_failed)
        self.assertTrue(executor.rollback_attempted)

    def test_docker_events_filter_raw_attributes_and_unrelated_ids(self):
        output = '\n'.join(json.dumps({'Type': 'container', 'Action': 'die', 'Actor': {'ID': cid, 'Attributes': {'secret': 'credential'}}}) for cid in (t.CID, 'b'*64))
        executor = self.executor(MemoryJournal(), lambda *args, **kwargs: output)
        executor.ids['pg'] = t.CID
        with patch.object(executor, 'runtime_identity'):
            executor.capture_events()
        events = [x for x in executor.journal.events if x[0] == 'docker-event']
        self.assertEqual(len(events), 1)
        self.assertNotIn('credential', json.dumps(executor.journal.events))


class EntryTests(unittest.TestCase):
    def test_full_recorded_executor_with_simulated_runtime_and_role_routing(self):
        for audit_ok in (True, False):
            with self.subTest(audit_ok=audit_ok):
                journal = MemoryJournal()
                plan = dict(t.PLAN, runId=g.f.contract.RUN)
                helper_id = 'b'*64
                volumes = set()
                created = {}
                creation_args = {}
                running = False
                calls = []
                transactions = []
                readiness = "SELECT json_build_object('db',current_database(),'role',current_user,'tables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')); "
                good = {'migration_name': 'fixture', 'checksum': 'fixture-hash', 'finished': True, 'rolled_back': False}
                sql_results = [(readiness, {'db': plan['database'], 'role': plan['role'], 'tables': 0}),
                               (g.f.roles.setup('2'*64, '3'*64), True), (None, [good]), (None, 0),
                               (g.f.roles.GRANTS, True), (g.f.roles.AUDIT, audit_ok)]
                if audit_ok:
                    sql_results.append((g.f.roles.AUDIT, True))
                class Transaction:
                    path = g.f.contract.REPO / '.env.development'
                    backup_dir = g.BACKUP
                    def prepare(self, url, **kwargs): transactions.append(('prepare', url, kwargs))
                    def commit(self): transactions.append('commit')
                    def verify_written(self, url): transactions.append('verify-written')
                    def restore(self): transactions.append('restore')

                def runner(argv, **kwargs):
                    nonlocal running
                    calls.append(argv)
                    if argv == ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', g.f.WINDOWS]:
                        return 'PORT_AVAILABLE'
                    if argv == ['node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy']:
                        self.assertEqual(kwargs['env']['DATABASE_URL'], 'postgresql://smartlearning_dev_migrator:' + '2'*64 + '@127.0.0.1:5433/smartlearning_dev')
                        return ''
                    if argv == ['node', '-e', g.f.TCP]:
                        data = json.loads(kwargs['data'])
                        password = {plan['role']: '1'*64, plan['migrationRole']: '2'*64, plan['applicationRole']: '3'*64}[data['role']]
                        self.assertEqual(data['password'] == password, not data['reject'])
                        return 'AUTH_REJECTED' if data['reject'] else json.dumps({'db': plan['database'], 'role': data['role']})
                    self.assertEqual(argv[:3], ['docker', '--context', plan['context']])
                    args = argv[3:]
                    if args == ['context', 'show']: return plan['context']
                    if args == ['context', 'inspect', plan['context']]: return json.dumps([{'Endpoints': {'docker': {'Host': plan['endpoint']}}}])
                    if args == ['info', '--format', '{{.ID}}']: return plan['engineId']
                    if args == ['image', 'inspect', plan['imageId']]: return json.dumps([{'Id': plan['imageId'], 'Config': {'Entrypoint': ['docker-entrypoint.sh'], 'Cmd': ['postgres'], 'Volumes': {'/var/lib/postgresql/data': {}}}}])
                    if args == ['ps', '-a', '--format', '{{.Names}}']: return '\n'.join(created)
                    if args == ['volume', 'ls', '--format', '{{.Name}}']: return '\n'.join(sorted(volumes))
                    if args[:2] == ['volume', 'create']:
                        self.assertEqual(args[2:4], ['--label', plan['label']])
                        self.assertIn(args[4], (plan['secretVolume'], plan['dataVolume']))
                        self.assertNotIn(args[4], volumes)
                        volumes.add(args[4]); return args[4]
                    if args[:2] == ['volume', 'inspect']:
                        self.assertIn(args[2], volumes)
                        return json.dumps([{'Name': args[2], 'Labels': {g.f.LABEL: plan['runId']}, 'Driver': 'local', 'Options': None}])
                    if args[:3] == ['ps', '-a', '--filter']:
                        self.assertEqual(args[4:], ['--format', '{{.ID}}', '--no-trunc'])
                        volume = args[3].removeprefix('volume=')
                        return '\n'.join(cid for name, cid in created.items() if volume == plan['secretVolume'] or cid == t.CID)
                    if args[0] == 'create':
                        name = args[args.index('--name')+1]
                        self.assertNotIn(name, created)
                        cid = helper_id if name.endswith('-secret-helper') else t.CID
                        if name.endswith('-secret-helper'):
                            self.assertIn('--mount', args)
                            self.assertEqual(args[args.index('--mount')+1], 'type=tmpfs,destination=/var/lib/postgresql/data,readonly,tmpfs-size=1048576,tmpfs-mode=0700')
                        creation_args[cid] = args
                        created[name] = cid
                        return cid
                    if args[:2] == ['container', 'inspect']:
                        cid = args[2]
                        self.assertIn(cid, created.values())
                        helper = cid == helper_id
                        c = t.stock_helper_mounts(creation_args[cid]) if helper else t.container()
                        c['Id'] = cid
                        c['Config']['Labels'] = {g.f.LABEL: plan['runId']}
                        c['Name'] = '/' + (plan['runId']+'-secret-helper' if helper else plan['container'])
                        c['State'] = {'Running': False, 'Status': 'exited', 'ExitCode': 0} if helper else {'Running': running}
                        if running and not helper: c['NetworkSettings'] = {'Ports': c['HostConfig']['PortBindings']}
                        return json.dumps([c])
                    if args == ['start', '-ai', helper_id]:
                        self.assertEqual(kwargs['data'], ('1'*64).encode()); return ''
                    if args == ['start', t.CID]: running = True; return ''
                    if args[0] == 'exec':
                        self.assertEqual(args, ['exec', '-i', t.CID, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', plan['role'], '-d', plan['database']])
                        expected, response = sql_results.pop(0)
                        if expected is not None: self.assertEqual(kwargs['data'].decode(), expected)
                        return json.dumps(response)
                    if args[0] == 'events': return ''
                    if args == ['stop', t.CID]: running = False; return ''
                    if args == ['stop', helper_id]: return ''
                    self.fail('Unexpected simulated runtime command')

                def factory(*a, **kwargs):
                    return g.RecordedExecutor(*a, runner=runner, environment={}, port_probe=lambda: None,
                                              sleep=lambda _: self.fail('Unexpected retry'), **kwargs)
                with patch.object(g.f.contract, 'plan', return_value=plan), patch.object(g.env_module, 'EnvTransaction', return_value=Transaction()), patch.object(g.f.secrets, 'token_hex', side_effect=['1'*64, 'd'*64, '2'*64, '3'*64, 'e'*64, 'f'*64]):
                    result = g.execute(plan, approval=g.f.APPROVAL, privilege=g.PRIVILEGE, exclusive=True,
                                       expected_hash=g.contract_hash(plan), journal=journal, executor_factory=factory)
                self.assertEqual(result['status'], 'VERIFIED' if audit_ok else 'BLOCKED')
                self.assertEqual(sql_results, [])
                self.assertEqual(running, audit_ok)
                if audit_ok:
                    self.assertEqual(transactions[0], ('prepare', 'postgresql://smartlearning_dev_app:'+'3'*64+'@127.0.0.1:5433/smartlearning_dev', {'migration_url': 'postgresql://smartlearning_dev_migrator:'+'2'*64+'@127.0.0.1:5433/smartlearning_dev'}))
                    self.assertEqual(transactions[1:], ['commit', 'verify-written'])
                else:
                    self.assertEqual(transactions, ['restore'])
                for password in ('1'*64, '2'*64, '3'*64):
                    self.assertNotIn(password, json.dumps(journal.events))
                    self.assertNotIn(password, json.dumps(journal.results))

    def test_recorded_f_execution_and_transaction_failure_sequence(self):
        for commit_failure in (False, True):
            with self.subTest(commit_failure=commit_failure):
                journal = MemoryJournal()
                events = []
                class Transaction:
                    path = g.f.contract.REPO / '.env.development'
                    backup_dir = g.BACKUP

                    def prepare(self, url, **kwargs): events.append('prepare')
                    def commit(self):
                        events.append('commit')
                        if commit_failure:
                            raise OSError('raw-secret')
                    def verify_written(self, url): events.append('verify-written')
                    def restore(self): events.append('restore')

                plan = dict(t.PLAN, runId=g.f.contract.RUN)
                replies = [(t.docker('start', t.CID), '')]
                if commit_failure:
                    replies.append((t.docker('stop', t.CID), ''))
                runner = t.StrictRunner(replies)
                executor = g.RecordedExecutor(plan, journal=journal, runner=runner,
                                              environment={}, transaction=Transaction())
                def preflight(): executor.stages.append('preflight')
                def provision():
                    executor.ids['pg'] = t.CID
                    executor.password = 'raw-secret'
                    executor.migration_password = 'c' * 64
                    executor.docker('start', t.CID)
                    executor.stages.append('initialized-authenticated')
                def migrate():
                    executor.stages.append('migrated-empty')
                    return 'fixture-url'
                with patch.object(g.f.contract, 'plan', return_value=plan), patch.object(g.env_module, 'EnvTransaction', return_value=executor.transaction), patch.object(executor, 'preflight', side_effect=preflight), patch.object(executor, 'provision', side_effect=provision), patch.object(executor, 'migrate', side_effect=migrate), patch.object(executor, 'tcp', side_effect=lambda **k: events.append('tcp')), patch.object(executor, 'separate_roles'), patch.object(executor, 'sql', return_value=True), patch.object(executor, 'runtime_identity'), patch.object(executor, 'verify_container', return_value={'State': {'Running': True}}), patch.object(executor, 'capture_events', side_effect=lambda: events.append('capture')):
                    result = g.execute(plan, approval=g.f.APPROVAL, privilege=g.PRIVILEGE,
                                       exclusive=True, expected_hash=g.contract_hash(plan),
                                       journal=journal, executor_factory=lambda *a, **k: executor)
                self.assertEqual(result['status'], 'BLOCKED' if commit_failure else 'VERIFIED')
                self.assertEqual(events, ['prepare', 'commit', 'restore', 'capture'] if commit_failure else ['prepare', 'commit', 'verify-written', 'tcp', 'capture'])
                self.assertEqual(result['rollback'], [])
                self.assertEqual(executor.rollback_attempted, commit_failure)
                self.assertIsNone(executor.password)
                self.assertEqual(runner.replies, [])
                self.assertNotIn('raw-secret', json.dumps(journal.results))
                operations = [(event, data.get('operation')) for event, data in journal.events]
                self.assertIn(('before', 'start'), operations)
                self.assertIn(('after', 'start'), operations)
                self.assertEqual(('before', 'stop') in operations, commit_failure)

    def test_cli_pending_decision_blocks_before_evidence_and_execution(self):
        argv = ['checkpoint-g.py', '--execute', '--approval', g.f.APPROVAL,
                '--privilege', g.PRIVILEGE, '--contract-sha256', g.contract_hash(t.PLAN),
                '--exclusive-env-and-resources']
        with patch.object(g.sys, 'argv', argv), patch.object(g.f.contract, 'plan', return_value=t.PLAN), patch.object(g, 'CREDENTIAL_DECISION', 'pending'), patch.object(g, 'Journal') as journal, patch.object(g, 'execute') as execute:
            with self.assertRaisesRegex(ValueError, '^Credential decision pending$'):
                g.main()
            journal.assert_not_called()
            execute.assert_not_called()

    def test_cli_review_reports_disabled_without_evidence_or_execution(self):
        output = io.StringIO()
        with patch.object(g.sys, 'argv', ['checkpoint-g.py']), patch.object(g.sys, 'stdout', output), patch.object(g.f.contract, 'plan', return_value=t.PLAN), patch.object(g, 'CREDENTIAL_DECISION', 'pending'), patch.object(g, 'Journal') as journal, patch.object(g, 'execute') as execute:
            self.assertEqual(g.main(), 0)
            journal.assert_not_called()
            execute.assert_not_called()
        result = json.loads(output.getvalue())
        self.assertEqual(result['status'], 'REVIEW_ONLY')
        self.assertFalse(result['liveEnabled'])
        self.assertEqual(result['contractSha256'], g.contract_hash(t.PLAN))

    def test_cli_selected_roles_still_reject_old_privilege_approval_and_hash(self):
        base = ['checkpoint-g.py', '--execute', '--exclusive-env-and-resources']
        good = dict(approval=g.f.APPROVAL, privilege=g.PRIVILEGE, **{'contract-sha256': g.contract_hash(t.PLAN)})
        for key, old in [('approval', 'fresh-initdb-start-secret-helper-20-migrations-env-backup-update'),
                         ('privilege', 'accept-local-development-bootstrap-superuser'),
                         ('contract-sha256', '326716f266bcafb1b142da8764143d621add29150b5b0b6dd46c5fe652f7ff91')]:
            args = dict(good, **{key: old})
            argv = base + [value for name, value in args.items() for value in ('--'+name, value)]
            with patch.object(g.sys, 'argv', argv), patch.object(g.f.contract, 'plan', return_value=t.PLAN), patch.object(g, 'Journal') as journal, patch.object(g, 'execute') as execute:
                with self.assertRaisesRegex(ValueError, '^Live gate blocked$'):
                    g.main()
                journal.assert_not_called()
                execute.assert_not_called()

    def test_approval_privilege_exclusivity_and_hash_before_factory(self):
        journal = MemoryJournal()
        kwargs = dict(approval=g.f.APPROVAL, privilege=g.PRIVILEGE, exclusive=True,
                      expected_hash=g.contract_hash(t.PLAN), journal=journal)
        for key, bad in [('approval', ''), ('privilege', ''), ('exclusive', False), ('expected_hash', 'wrong')]:
            with patch.object(g.f.contract, 'plan', return_value=t.PLAN), patch.object(g, 'RecordedExecutor') as factory:
                with self.assertRaises(ValueError):
                    g.execute(t.PLAN, **dict(kwargs, **{key: bad}), executor_factory=factory)
                factory.assert_not_called()
        self.assertEqual(journal.events, [])

    def test_outcome_success_failure_and_event_failure(self):
        for failure in (None, 'execute', 'capture'):
            journal = MemoryJournal()
            executor = self.mock_executor(failure)
            with patch.object(g.f.contract, 'plan', return_value=t.PLAN):
                value = g.execute(t.PLAN, approval=g.f.APPROVAL, privilege=g.PRIVILEGE, exclusive=True,
                                  expected_hash=g.contract_hash(t.PLAN), journal=journal,
                                  executor_factory=lambda *a, **k: executor)
            self.assertEqual(value['status'], 'VERIFIED' if failure is None else 'BLOCKED')
            self.assertNotIn('raw-secret', json.dumps(journal.results))
            self.assertEqual(executor.rollback_attempted, failure is not None)

    @staticmethod
    def mock_executor(failure=None):
        class Fake:
            ids = {'pg': t.CID}
            stages = ['preflight']
            recording_failed = False
            rolling_back = False
            rollback_attempted = False
            rollback_errors = []
            unresolved = []

            def execute(self, *a, **k):
                if failure == 'execute':
                    self.rollback()
                    raise ValueError('raw-secret')

            def verify_container(self, cid):
                return {'State': {'Running': True}}

            def capture_events(self):
                if failure == 'capture':
                    raise ValueError('raw-secret')

            def rollback(self):
                self.rollback_attempted = True
                return []
        return Fake()

    def test_outcome_failure_rolls_back_and_suppresses_diagnostics(self):
        executor = self.mock_executor()
        with patch.object(g.f.contract, 'plan', return_value=t.PLAN):
            with self.assertRaisesRegex(ValueError, '^Outcome persistence blocked'):
                g.execute(t.PLAN, approval=g.f.APPROVAL, privilege=g.PRIVILEGE, exclusive=True,
                          expected_hash=g.contract_hash(t.PLAN), journal=MemoryJournal('outcome'),
                          executor_factory=lambda *a, **k: executor)
        self.assertTrue(executor.rollback_attempted)


if __name__ == '__main__':
    unittest.main()
