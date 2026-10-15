#!/usr/bin/env python3
"""Container-free tests: all filesystem access stays in disposable fixtures."""
import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('env_transaction', Path(__file__).with_name('checkpoint-f-env.py'))
env = importlib.util.module_from_spec(spec)
spec.loader.exec_module(env)
URL = 'postgresql://smartlearning_dev_app:' + 'a' * 64 + '@127.0.0.1:5433/smartlearning_dev'
ORIGINAL = b'# preserved\r\nDATABASE_URL=old\r\nDIRECT_URL=old\r\nOTHER=value\r\n'


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / '.env.development'
        self.path.write_bytes(ORIGINAL)
        self.path.chmod(0o600)
        self.tx = env.EnvTransaction(self.path, self.root / 'backup')

    def test_round_trip_and_permissions(self):
        self.tx.prepare(URL)
        self.assertEqual(self.tx.backup.read_bytes(), ORIGINAL)
        self.assertEqual(stat.S_IMODE(self.tx.backup.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.tx.backup_dir.stat().st_mode), 0o700)
        self.tx.commit()
        self.assertEqual(self.path.read_bytes(), ORIGINAL.replace(b'old', URL.encode()))
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.tx.restore()
        self.assertEqual(self.path.read_bytes(), ORIGINAL)

    def test_migration_credential_protected_outside_application_env(self):
        migration = 'postgresql://smartlearning_dev_migrator:' + 'b'*64 + '@127.0.0.1:5433/smartlearning_dev'
        self.tx.prepare(URL, migration_url=migration)
        saved = self.tx.backup_dir / 'migration.url'
        self.assertEqual(saved.read_text(), migration)
        self.assertEqual(stat.S_IMODE(saved.stat().st_mode), 0o600)
        self.tx.commit()
        self.assertNotIn(migration.encode(), self.path.read_bytes())
        self.assertNotIn(b'smartlearning_dev_migrator', self.path.read_bytes())
        self.tx.restore()
        self.assertEqual(saved.read_text(), migration)

    def test_elevated_application_url_and_wrong_migration_url_block_before_backup(self):
        for role in ('smartlearning_dev_owner', 'smartlearning_dev_migrator'):
            with self.assertRaises(ValueError):
                self.tx.prepare(URL.replace('smartlearning_dev_app', role))
        with self.assertRaises(ValueError):
            self.tx.prepare(URL, migration_url=URL)
        self.assertFalse(self.tx.backup_dir.exists())

    def test_changed_migration_credential_blocks_application_env_commit(self):
        migration = 'postgresql://smartlearning_dev_migrator:' + 'b'*64 + '@127.0.0.1:5433/smartlearning_dev'
        self.tx.prepare(URL, migration_url=migration)
        (self.tx.backup_dir / 'migration.url').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'Migration credential changed'):
            self.tx.commit()
        self.assertEqual(self.path.read_bytes(), ORIGINAL)

    def test_verify_written_checks_committed_hash_target_and_permissions(self):
        with self.assertRaises(ValueError):
            self.tx.verify_written(URL)
        self.tx.prepare(URL)
        self.tx.commit()
        self.tx.verify_written(URL)
        with self.assertRaises(ValueError):
            self.tx.verify_written(URL.replace('a' * 64, 'b' * 64))
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):
            self.tx.verify_written(URL)
        self.path.chmod(0o600)
        self.path.write_bytes(b'changed')
        with self.assertRaises(ValueError):
            self.tx.verify_written(URL)

    def test_restore_before_commit_is_noop(self):
        self.tx.restore()
        self.tx.prepare(URL)
        self.tx.restore()
        self.assertEqual(self.path.read_bytes(), ORIGINAL)
        self.tx.state = 'invalid'
        with self.assertRaises(ValueError):
            self.tx.restore()

    def test_original_group_or_other_permissions_rejected(self):
        self.path.chmod(0o640)
        with self.assertRaises(ValueError):
            self.tx.prepare(URL)
        self.assertFalse(self.tx.backup_dir.exists())

    def test_invalid_url_never_creates_backup(self):
        for url in [URL + '?sslmode=disable', URL.replace(':5433/', ':5432/'),
                    URL.replace('a' * 64, 'A' * 64), URL.replace('127.0.0.1', 'localhost'),
                    URL.replace('smartlearning_dev_app', 'postgres'), URL + '\n']:
            with self.assertRaises(ValueError):
                self.tx.prepare(url)
        self.assertFalse(self.tx.backup_dir.exists())

    def test_existing_backup_rejected(self):
        self.tx.backup_dir.mkdir()
        with self.assertRaises(FileExistsError):
            self.tx.prepare(URL)
        self.assertEqual(self.path.read_bytes(), ORIGINAL)

    def test_symlink_file_and_parent_rejected(self):
        target = self.root / 'target'
        self.path.rename(target)
        self.path.symlink_to(target)
        with self.assertRaises(OSError):
            self.tx.prepare(URL)
        link = self.root / 'link'
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            env.EnvTransaction(link / 'target', self.root / 'backup').prepare(URL)

    def test_nonregular_and_unowned_file_rejected(self):
        self.path.unlink()
        os.mkfifo(self.path)
        with self.assertRaises(ValueError):
            self.tx.prepare(URL)
        self.path.unlink()
        self.path.write_bytes(ORIGINAL)
        self.path.chmod(0o600)
        with patch.object(env.os, 'getuid', return_value=os.getuid() + 1):
            with self.assertRaises(ValueError):
                self.tx.prepare(URL)

    def test_ambiguous_assignment_preserves_backup_and_env(self):
        original = ORIGINAL + b' export DATABASE_URL=unexpected\n'
        self.path.write_bytes(original)
        with self.assertRaises(ValueError):
            self.tx.prepare(URL)
        self.assertEqual(self.tx.backup.read_bytes(), original)
        self.assertEqual(self.path.read_bytes(), original)

    def test_concurrent_edit_blocks_commit_and_removes_temp(self):
        self.tx.prepare(URL)
        self.tx.before_replace = lambda: self.path.write_bytes(b'changed')
        with self.assertRaises(ValueError):
            self.tx.commit()
        self.assertEqual(self.path.read_bytes(), b'changed')
        self.assertEqual(list(self.root.glob('.checkpoint-f-*')), [])

    def test_restore_refuses_changed_current_and_backup(self):
        self.tx.prepare(URL)
        self.tx.commit()
        written = self.path.read_bytes()
        self.path.write_bytes(b'changed')
        with self.assertRaises(ValueError):
            self.tx.restore()
        self.path.write_bytes(written)
        self.tx.backup.write_bytes(b'changed')
        with self.assertRaises(ValueError):
            self.tx.restore()
        self.assertEqual(self.path.read_bytes(), written)

    def test_restore_refuses_unsafe_backup_permissions(self):
        self.tx.prepare(URL)
        self.tx.commit()
        self.tx.backup.chmod(0o644)
        with self.assertRaises(ValueError):
            self.tx.restore()

    def test_replace_failure_preserves_original(self):
        self.tx.prepare(URL)
        with patch.object(env.os, 'replace', side_effect=OSError('fixture failure')):
            with self.assertRaises(OSError):
                self.tx.commit()
        self.assertEqual(self.path.read_bytes(), ORIGINAL)
        self.assertEqual(list(self.root.glob('.checkpoint-f-*')), [])

    def test_directory_sync_failure_can_still_restore_after_rename(self):
        self.tx.prepare(URL)
        with patch.object(env, 'sync_dir', side_effect=OSError('fixture failure')):
            with self.assertRaises(OSError):
                self.tx.commit()
        self.assertEqual(self.tx.state, 'committed')
        self.tx.restore()
        self.assertEqual(self.path.read_bytes(), ORIGINAL)

    def test_restore_concurrent_edit_blocks(self):
        self.tx.prepare(URL)
        self.tx.commit()
        self.tx.before_replace = lambda: self.path.write_bytes(b'changed')
        with self.assertRaises(ValueError):
            self.tx.restore()
        self.assertEqual(self.path.read_bytes(), b'changed')


if __name__ == '__main__':
    unittest.main()
