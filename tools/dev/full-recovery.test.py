#!/usr/bin/env python3
"""Container-free regression checks; never invoke DB/Jest/migrations."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).with_name('full-recovery.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RecoverySafety(unittest.TestCase):
    def test_public_forwarded_peer_cannot_expand_restore_access(self):
        class Result:
            returncode = 0
            stdout = json.dumps({'ok': False, 'sqlstate': '28000', 'peer': '8.8.8.8', 'role': 'app'}).encode()
        with patch.object(m, 'metadata'), patch.object(m, 'identity', return_value={'cluster': m.RUN}), patch.object(m.subprocess, 'run', return_value=Result()), patch.object(m, 'docker') as docker:
            with self.assertRaisesRegex(RuntimeError, 'outside private'):
                m.allow_forwarded_peer('restored')
            docker.assert_not_called()

    def test_empty_postgres_archive_is_valid_without_database_toc_entry(self):
        m.validate_toc(b';     Format: CUSTOM\n;     Dumped from database version: 16.4\n; 0 TOC Entries\n')
        with self.assertRaisesRegex(RuntimeError, 'Invalid custom'):
            m.validate_toc(b'not an archive')

    def test_snapshot_adapter_pins_source_queries_to_shared_snapshot(self):
        m.SNAPSHOTS[m.DB] = '00000003-00000001-1'
        with patch.object(m, 'docker', return_value=b'') as call:
            m.inventory_docker('exec', '-i', m.SOURCE_ID, 'psql', '-h', '/tmp', '-d', m.DB, data=b'SELECT 1;')
        args, kwargs = call.call_args
        self.assertIn('/var/run/postgresql', args)
        self.assertIn(b"SET TRANSACTION SNAPSHOT '00000003-00000001-1'", kwargs['data'])
        self.assertTrue(kwargs['data'].endswith(b'COMMIT;\n'))
        m.SNAPSHOTS.clear()

    def test_restore_never_imports_source_snapshot_or_socket(self):
        m.SNAPSHOTS[m.DB] = '00000003-00000001-1'
        with patch.object(m, 'docker', return_value=b'') as call:
            m.inventory_docker('exec', '-i', 'restored-id', 'psql', '-h', '/tmp', '-d', m.DB, data=b'SELECT 1;')
        self.assertIn('/tmp', call.call_args.args)
        self.assertEqual(call.call_args.kwargs['data'], b'SELECT 1;')
        m.SNAPSHOTS.clear()

    def test_unexpected_restore_identity_blocks_before_sql(self):
        with patch.object(m.local, 'inspect', return_value={
                'id': 'wrong', 'name': '/' + m.CONTAINER}) , patch.object(m, 'docker') as docker:
            with self.assertRaisesRegex(RuntimeError, 'ownership'):
                m.metadata('expected')
            docker.assert_not_called()

    def test_wrong_source_identity_fails(self):
        with patch.object(m.local, 'preflight', return_value={
                'id': 'wrong', 'state': 'running', 'health': 'healthy'}):
            with self.assertRaisesRegex(RuntimeError, 'Source identity'):
                m.source_check()

    def test_wsl_directory_cannot_substitute_for_windows_mount(self):
        class Result:
            returncode = 0
            stdout = b'{"filesystems":[{"target":"/","fstype":"ext4","source":"/dev/sda"}]}'
        with patch.object(m.subprocess, 'run', return_value=Result()):
            with self.assertRaisesRegex(RuntimeError, 'WSL backup fallback'):
                m.mount_check()


if __name__ == '__main__':
    unittest.main()
