"""Container-free safety gates for the one authorized C recovery run."""
import importlib.util
from pathlib import Path
import unittest
import subprocess
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('checkpoint_c', Path(__file__).with_name('checkpoint-c.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class SafetyGates(unittest.TestCase):
    def test_sql_json_array_spanning_lines_keeps_every_database(self):
        with patch.object(c, 'docker', return_value=b'[{"name":"postgres"},\n {"name":"smartlearning_test"}]\n'):
            self.assertEqual(c.json_sql('isolated', 'role', 'postgres', 'SELECT json_agg(x)'),
                             [{'name': 'postgres'}, {'name': 'smartlearning_test'}])

    def test_foreign_same_name_volume_is_rejected_before_use(self):
        foreign = {'Name': c.WORK_VOLUME, 'Driver': 'local', 'Options': None,
                   'Labels': {'smartlearning.checkpoint': 'another-run'}}
        with patch.object(c, 'inspect', return_value=foreign), patch.object(c, 'docker') as docker:
            with self.assertRaisesRegex(RuntimeError, 'ownership mismatch'):
                c.owned_volume(c.WORK_VOLUME)
            docker.assert_not_called()

    def test_manifest_rejects_symlink_even_in_command_substitution(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'external').symlink_to('/tmp')
            result = subprocess.run(['bash', '-ceu', c.MANIFEST + '\nvalue=$(manifest "$1"); echo UNSAFE',
                                     '--', directory], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b'UNSAFE', result.stdout)

    def test_missing_exact_authorization_argument_performs_no_docker_operation(self):
        with patch.object(c.sys, 'argv', ['checkpoint-c.py']), patch.object(c, 'docker') as docker:
            with self.assertRaisesRegex(RuntimeError, 'authorized-run'):
                c.main()
            docker.assert_not_called()

    def test_engine_mismatch_stops_before_inspection_or_mutation(self):
        with patch.dict(c.os.environ, {}, clear=True), \
                patch.object(c.subprocess, 'check_output', return_value=b'default\n'), \
                patch.object(c, 'docker', return_value=b'wrong-engine\n') as docker:
            with self.assertRaisesRegex(RuntimeError, 'Engine mismatch'):
                c.source_check()
            self.assertEqual(docker.call_args_list[0].args, ('info', '--format', '{{.ID}}'))
            self.assertEqual(docker.call_count, 1)

    def test_existing_running_source_consumer_is_a_hard_stop(self):
        source = {'Id': c.SOURCE_ID, 'Image': c.IMAGE, 'State': {'Status': 'exited'},
                  'Mounts': [{'Type': 'volume', 'Name': c.SOURCE,
                              'Destination': '/var/lib/postgresql/data'}]}
        with patch.dict(c.os.environ, {}, clear=True), \
                patch.object(c.subprocess, 'check_output', return_value=b'default\n'), \
                patch.object(c, 'inspect', return_value=source), \
                patch.object(c, 'docker', side_effect=[c.ENGINE.encode(), b'unix:///var/run/docker.sock',
                                                     b'active-consumer\n']) as docker:
            with self.assertRaisesRegex(RuntimeError, 'running consumer'):
                c.source_check()
            self.assertFalse(any(call.args[0] in ('create', 'start', 'exec', 'volume')
                                 for call in docker.call_args_list))


if __name__ == '__main__':
    unittest.main()
