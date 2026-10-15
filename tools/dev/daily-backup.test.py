#!/usr/bin/env python3
"""Container-free publication/failure regressions; never invokes DB test setup."""
import contextlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('daily', Path(__file__).with_name('daily-backup.py'))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
RUN = 'sl-daily-20261015T084000Z-1234abcd'


class FakeSource:
    def versions(self):
        return {'fixture': True}

    def identity(self):
        return {'database': 'smartlearning_test', 'role': b.ADMIN, 'schema': 'public', 'recovery': False, 'system': '123'}

    def backup(self, directory):
        for name in ['globals.sql', 'postgres.dump', 'postgres.toc', 'smartlearning_test.dump', 'smartlearning_test.toc', 'source-manifest.json']:
            (directory / name).write_text('fixture-only\n')
        return {db: b.utc() for db in b.DATABASES}


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.stack = contextlib.ExitStack()
        self.stack.enter_context(patch.object(b, 'DEST', self.root))
        self.stack.enter_context(patch.object(b, 'mount_check'))
        self.stack.enter_context(patch.object(b, 'acl', side_effect=self.acl))
        self.stack.enter_context(patch.object(b, 'required_space', return_value=2147483648))
        self.stack.enter_context(patch.object(b, 'publish', side_effect=self.publish))
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.stack.close)

    def acl(self, run, action, required=0):
        if action == 'Create':
            (self.root / (run + '.partial')).mkdir()

    def publish(self, run):
        target = self.root / run
        if target.exists():
            raise b.Blocked('Collision')
        (self.root / (run + '.partial')).rename(target)

    def run_backup(self, **kw):
        return b.run_backup(RUN, source_factory=FakeSource, **kw)

    def test_success_publishes_and_hashes_every_payload_before_index(self):
        self.assertEqual(self.run_backup()['status'], 'PASS')
        manifest = b.verify_run(self.root / RUN)
        self.assertFalse(manifest['restoreVerified'])
        self.assertEqual(json.loads((self.root / 'last-success.json').read_text())['run'], RUN)
        self.assertFalse((self.root / (RUN + '.partial')).exists())

    def test_safe_failure_does_not_access_source_or_change_previous_index(self):
        index = self.root / 'last-success.json'
        index.write_text('previous-index')
        with patch.object(b, 'Source', side_effect=AssertionError('Source accessed')):
            result = b.run_backup(RUN, source_factory=lambda: self.fail('Source accessed'), safe_failure=True)
        self.assertEqual(result['status'], 'FAIL')
        self.assertEqual(index.read_text(), 'previous-index')
        self.assertFalse((self.root / RUN).exists())

    def test_run_collision_does_not_touch_existing_data(self):
        (self.root / RUN).mkdir()
        (self.root / RUN / 'keep').write_text('keep')
        self.assertEqual(self.run_backup()['status'], 'FAIL')
        self.assertEqual((self.root / RUN / 'keep').read_text(), 'keep')

    def test_acl_failure_prevents_sensitive_writes(self):
        with patch.object(b, 'acl', side_effect=b.Blocked('ACL rejected')):
            self.assertEqual(self.run_backup()['status'], 'FAIL')
        self.assertFalse((self.root / (RUN + '.partial')).exists())

    def test_mount_failure_never_falls_back(self):
        with patch.object(b, 'mount_check', side_effect=b.Blocked('Mount rejected')):
            self.assertEqual(self.run_backup()['status'], 'FAIL')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_timeout_leaves_partial_and_previous_index(self):
        (self.root / 'last-success.json').write_text('previous')
        with patch.object(FakeSource, 'backup', side_effect=b.Blocked('Timed out')):
            result = self.run_backup()
        self.assertEqual(result['status'], 'FAIL')
        self.assertTrue((self.root / (RUN + '.partial')).is_dir())
        self.assertEqual((self.root / 'last-success.json').read_text(), 'previous')

    def test_hash_corruption_is_rejected_by_consumers(self):
        self.assertEqual(self.run_backup()['status'], 'PASS')
        (self.root / RUN / 'postgres.dump').write_text('corrupt')
        with self.assertRaises(b.Blocked):
            b.verify_run(self.root / RUN)

    def test_partial_never_counts_as_success(self):
        with patch.object(b, 'publish', side_effect=b.Blocked('Crash before publication')):
            self.assertEqual(self.run_backup()['status'], 'FAIL')
        with self.assertRaises(b.Blocked):
            b.status()
        self.assertFalse((self.root / 'last-success.json').exists())

    def test_publication_before_index_crash_is_recoverable_by_status(self):
        with patch.object(b, 'update_index', side_effect=b.Blocked('Index crash')):
            result = self.run_backup()
        self.assertEqual(result['status'], 'FAIL')
        self.assertTrue(result['published'])
        self.assertEqual(b.status()['run'], RUN)

    def test_partial_tampering_blocks_publication(self):
        original = b.verify_partial
        def corrupt(path, run):
            (path / 'globals.sql').write_text('tampered')
            original(path, run)
        with patch.object(b, 'verify_partial', side_effect=corrupt):
            self.assertEqual(self.run_backup()['status'], 'FAIL')
        self.assertFalse((self.root / RUN).exists())

    def test_space_failure_prevents_directory_creation(self):
        with patch.object(b, 'required_space', side_effect=b.Blocked('Space insufficient')):
            self.assertEqual(self.run_backup()['status'], 'FAIL')
        self.assertFalse((self.root / (RUN + '.partial')).exists())

    def test_overlapping_runs_are_blocked(self):
        with b.lock():
            with self.assertRaises(b.Blocked):
                with b.lock():
                    self.fail('Second lock acquired')

    def test_manifest_path_traversal_rejected(self):
        self.assertEqual(self.run_backup()['status'], 'PASS')
        path = self.root / RUN / 'success.json'
        manifest = json.loads(path.read_text())
        manifest['files']['../../secret'] = manifest['files'].pop('globals.sql')
        path.write_text(json.dumps(manifest))
        with self.assertRaises(b.Blocked):
            b.verify_run(self.root / RUN)

    def test_invalid_id_is_rejected_without_side_effects(self):
        with self.assertRaises(b.Blocked):
            b.run_backup('../escape')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_snapshot_cleanup_kills_exporter_when_cleanup_is_interrupted(self):
        source = b.Source.__new__(b.Source)
        source.cid = 'fixture'
        source.tokens = {}
        proc = MagicMock()
        proc.stdout.readline.return_value = b'00000001-00000002-1\n'
        proc.poll.return_value = None
        proc.communicate.side_effect = b.Blocked('deadline during cleanup')
        with patch.object(b.subprocess, 'Popen', return_value=proc), patch.object(b.select, 'select', return_value=([proc.stdout], [], [])):
            with self.assertRaises(b.Blocked):
                with source.snapshot('postgres'):
                    self.assertIn('postgres', source.tokens)
        proc.kill.assert_called_once()
        proc.wait.assert_called_once_with(timeout=5)
        self.assertEqual(source.tokens, {})

    def test_inventory_imports_exact_exported_snapshot(self):
        source = b.Source.__new__(b.Source)
        source.tokens = {'postgres': '00000001-00000002-1'}
        with patch.object(b, 'docker', return_value=b'') as docker:
            source.inventory_docker('exec', '-i', 'fixture', 'psql', '-h', '/tmp', '-d', 'postgres', data=b'SELECT 1;')
        self.assertIn('/var/run/postgresql', docker.call_args.args)
        self.assertIn(b"SET TRANSACTION SNAPSHOT '00000001-00000002-1'", docker.call_args.kwargs['data'])
        self.assertIn(b'READ ONLY', docker.call_args.kwargs['data'])

    def test_empty_postgres_toc_allowed_but_wrong_database_rejected(self):
        listing = b';     dbname: postgres\n;     Format: CUSTOM\n;     Dumped from database version: 17\n'
        b.validate_toc(listing, 'postgres')
        with self.assertRaises(b.Blocked):
            b.validate_toc(listing, 'smartlearning_test')

    def test_command_failure_does_not_expose_stderr(self):
        with patch.object(b.subprocess, 'run', return_value=type('Result', (), {'returncode': 1, 'stderr': b'secret'})()):
            with self.assertRaisesRegex(b.Blocked, 'raw logs suppressed'):
                b.command(['mock'])


if __name__ == '__main__':
    unittest.main()
