#!/usr/bin/env python3
"""Container-free contract and environment transformation regressions."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('checkpoint_e', Path(__file__).with_name('checkpoint-e.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PreparationTests(unittest.TestCase):
    def test_plan_never_launches_processes(self):
        with patch('subprocess.run', side_effect=AssertionError('Runtime forbidden')):
            plan = module.plan()
        self.assertEqual(plan['publish'], '127.0.0.1:5433:5432')
        self.assertEqual(plan['restartPolicy'], 'no')
        self.assertEqual(len(plan['migrations']['sql']), 20)
        self.assertEqual(plan['status'], 'PREPARED_NOT_AUTHORIZED_FOR_EXECUTION')
        self.assertIn('DB-backed tests', plan['excluded'])
        self.assertEqual(len({plan['role'], plan['migrationRole'], plan['applicationRole']}), 3)
        self.assertEqual(len(plan['rolePolicySha256']), 64)

    def test_hash_changes_with_sql(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'migration_lock.toml').write_text('provider = "postgresql"')
            directory = root / '20261013000000_fixture'
            directory.mkdir()
            sql = directory / 'migration.sql'
            sql.write_text('SELECT 1;')
            before = module.migration_manifest(root)
            sql.write_text('SELECT 2;')
            self.assertNotEqual(before, module.migration_manifest(root))

    def test_symlink_sql_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / '20261013000000_fixture'
            directory.mkdir()
            source = root / 'outside.sql'
            source.write_text('SELECT 1;')
            (directory / 'migration.sql').symlink_to(source)
            with self.assertRaises(ValueError):
                module.migration_manifest(root)

    def test_transform_preserves_other_settings_and_crlf(self):
        content = '# DATABASE_URL=comment\r\nDATABASE_URL=old\r\nDIRECT_URL=old\r\nPORT=3000\r\n'
        url = 'postgresql://owner:generated@localhost:5433/smartlearning_dev'
        self.assertEqual(module.replace_connections(content, url),
                         '# DATABASE_URL=comment\r\nDATABASE_URL=' + url +
                         '\r\nDIRECT_URL=' + url + '\r\nPORT=3000\r\n')

    def test_ambiguous_assignments_rejected(self):
        for content in ('PORT=3000\n', 'DATABASE_URL=a\nDATABASE_URL=b\n',
                        'export DATABASE_URL=a\n', ' DATABASE_URL=a\n',
                        'DATABASE_URL=a\nDIRECT_URL=b\nDIRECT_URL=c\n'):
            with self.subTest(content=content), self.assertRaises(ValueError):
                module.replace_connections(content, 'postgresql://proposed')

    def test_url_newline_rejected(self):
        with self.assertRaises(ValueError):
            module.replace_connections('DATABASE_URL=old\n', 'postgresql://new\nPORT=1')


if __name__ == '__main__':
    unittest.main()
