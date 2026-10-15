#!/usr/bin/env python3
"""Container-free regression for fail-closed daily drill entry."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('drill', Path(__file__).with_name('daily-runtime.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class EntryTests(unittest.TestCase):
    def test_retained_evidence_rejects_replay_before_source_access(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(m, 'EVIDENCE', Path(temp)), patch.object(m.r, 'source_check') as source:
                with self.assertRaisesRegex(RuntimeError, 'collision'):
                    m.main()
                source.assert_not_called()

    def test_newest_corrupt_generation_never_falls_back_or_creates_cluster(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            destination = base / 'daily'
            destination.mkdir()
            for name in ['sl-daily-20261015T100000Z-00000000', 'sl-daily-20261015T110000Z-00000000']:
                p = destination / name
                p.mkdir()
                (p / 'success.json').write_text('{}')
            evidence = base / 'evidence'
            visited = []
            def reject(path):
                visited.append(path.name)
                raise m.d.Blocked('Backup hash mismatch')
            with patch.object(m, 'EVIDENCE', evidence), patch.object(m.r, 'EVIDENCE', evidence), \
                 patch.object(m.d, 'DEST', destination), patch.object(m.d, 'mount_check'), \
                 patch.object(m.d, 'verify_run', side_effect=reject), \
                 patch.object(m.r, 'source_check'), patch.object(m.r, 'docker') as docker:
                self.assertEqual(m.main(), 1)
                docker.assert_not_called()
                self.assertEqual(visited, ['sl-daily-20261015T110000Z-00000000'])
                result = json.loads((evidence / 'result.json').read_text())
                self.assertEqual(result['stage'], 'daily-integrity')
                self.assertIsNone(result['ownedContainer'])


if __name__ == '__main__':
    unittest.main()
