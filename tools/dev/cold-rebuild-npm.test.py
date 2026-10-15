#!/usr/bin/env python3
"""Real npm parser regression: no install, downloads, Docker or database."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cold_npm', Path(__file__).with_name('cold-rebuild.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class NpmConfigTests(unittest.TestCase):
    def test_real_npm_rejects_original_double_load(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            env = m.create_build_env(root)
            env.update(npm_config_userconfig='/dev/null', npm_config_globalconfig='/dev/null')
            result = m.npm_configuration_preflight(root, env)
            self.assertEqual(result['status'], 'BLOCKED')
            self.assertEqual(result['category'], 'configuration-double-load')

    def test_real_npm_accepts_actual_launcher_configuration_without_inherited_loaders(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.dict(os.environ, {'NODE_OPTIONS': '--require=must-not-load', 'npm_config_registry': 'https://invalid.example'}):
                env = m.create_build_env(root)
            self.assertNotIn('NODE_OPTIONS', env)
            self.assertNotIn('npm_config_registry', env)
            self.assertNotEqual(Path(env['npm_config_userconfig']).resolve(), Path(env['npm_config_globalconfig']).resolve())
            for key in ['npm_config_userconfig', 'npm_config_globalconfig']:
                self.assertEqual(Path(env[key]).read_bytes(), b'')
                self.assertEqual(Path(env[key]).stat().st_mode & 0o777, 0o600)
            self.assertEqual(m.npm_configuration_preflight(root, env)['status'], 'PASS')
            self.assertFalse((root / 'node_modules').exists())

    def test_preflight_failure_prevents_install_and_preserves_safe_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'src').mkdir()
            (root / 'prisma').mkdir()
            (root / 'src/main.ts').write_text('await app.listen(port);')
            for name in ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'nest-cli.json', 'prisma.config.ts']:
                (root / name).write_text('{}')
            evidence = root / 'evidence'
            evidence.mkdir()
            blocked = {'status': 'BLOCKED', 'category': 'configuration-double-load'}
            with patch.object(m, 'ROOT', root), patch.object(m, 'EVIDENCE', evidence), \
                 patch.object(m, 'npm_configuration_preflight', return_value=blocked), \
                 patch.object(m, 'run_build_command') as install, patch.object(m.r, 'record') as receipt:
                with self.assertRaisesRegex(RuntimeError, 'preflight failed'):
                    m.prepare_build()
                install.assert_not_called()
                receipt.assert_called_once_with('npm-preflight.json', blocked)

    def test_install_failure_keeps_exit_code_and_stops_later_stages(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'src').mkdir()
            (root / 'prisma').mkdir()
            (root / 'src/main.ts').write_text('await app.listen(port);')
            for name in ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'nest-cli.json', 'prisma.config.ts']:
                (root / name).write_text('{}')
            evidence = root / 'evidence'
            evidence.mkdir()
            records = {}
            with patch.object(m, 'ROOT', root), patch.object(m, 'EVIDENCE', evidence), \
                 patch.object(m, 'npm_configuration_preflight', return_value={'status': 'PASS'}), \
                 patch.object(m, 'run_build_command', return_value=7) as install, \
                 patch.object(m.r, 'record', side_effect=lambda name, value: records.update({name: dict(value)})):
                with self.assertRaisesRegex(RuntimeError, 'failed: install'):
                    m.prepare_build()
                self.assertEqual(install.call_count, 1)
                self.assertEqual(records['build-install.json']['exitCode'], 7)
                self.assertEqual(records['build-install.json']['status'], 'BLOCKED')
                self.assertGreaterEqual(records['build-install.json']['elapsedSeconds'], 0)
                self.assertNotIn('build-generate.json', records)


if __name__ == '__main__':
    unittest.main()
