"""Container-free safety regressions; never loads env or contacts Docker."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('local_db', Path(__file__).with_name('local-db.py'))
db = importlib.util.module_from_spec(spec)
spec.loader.exec_module(db)


def owned():
    return dict(id='a' * 64, name='/' + db.NAME, image=db.IMAGE,
                state='running', health='healthy', user='postgres',
                entrypoint=['postgres'], cmd=['-D', '/var/lib/postgresql/data'],
                mounts=[dict(Type='volume', Name=db.VOLUME, RW=True,
                             Destination='/var/lib/postgresql/data')],
                ports={'5432/tcp': [dict(HostIp='127.0.0.1', HostPort='5432')]},
                restart='unless-stopped', network=db.NAME + '_default', privileged=False,
                labels={db.LABEL: 'retained-test-v1', 'com.docker.compose.project': db.NAME,
                        'com.docker.compose.service': 'db'})


class SafetyTests(unittest.TestCase):
    def test_inspect_handles_container_without_healthcheck(self):
        import json
        record = owned()
        record['health'] = None
        with patch.object(db, 'docker', return_value=json.dumps(record)) as docker:
            self.assertIsNone(db.inspect(db.ORIGINAL)['health'])
            template = docker.call_args.args[3]
            self.assertIn('index .State "Health"', template)
            self.assertNotIn('.State.Health', template)

    def test_review_is_offline(self):
        with patch.object(db, 'docker', side_effect=AssertionError('Docker forbidden')):
            with patch('sys.argv', ['local-db.py']):
                db.main()

    def test_drift_blocks_before_docker(self):
        with patch.object(db, 'COMPOSE_SHA256', 'wrong'), patch.dict('os.environ', {}, clear=True):
            with patch.object(db, 'docker', side_effect=AssertionError('Docker forbidden')):
                with self.assertRaises(db.Blocked):
                    db.preflight()

    def test_reject_unsafe_owned_configuration(self):
        db.validate_owned(owned())
        for key, value in [('image', 'other'), ('labels', {}), ('mounts', []),
                           ('ports', {}), ('user', 'root'), ('privileged', True),
                           ('network', 'host'), ('restart', 'always'),
                           ('entrypoint', ['docker-entrypoint.sh'])]:
            with self.subTest(key=key):
                record = copy.deepcopy(owned())
                record[key] = value
                with self.assertRaises(db.Blocked):
                    db.validate_owned(record)

    def test_other_volume_consumer_blocks(self):
        def docker(*args, **kwargs):
            if args[0] == 'context': return 'default'
            if args[0] == 'info': return db.ENGINE
            if args[0] == 'volume': return db.VOLUME
            if args[0] == 'image': return db.IMAGE
            if '-a' in args: return 'a' * 64
            if args[0] == 'ps': return 'b' * 64
            self.fail('Unexpected Docker call')
        original = dict(id=db.ORIGINAL, state='exited')
        with patch.dict('os.environ', {}, clear=True), patch.object(db, 'docker', side_effect=docker):
            with patch.object(db, 'inspect', side_effect=[original, owned()]):
                with self.assertRaisesRegex(db.Blocked, 'Another running'):
                    db.preflight()

    def test_engine_mismatch_stops_before_resource_access(self):
        with patch.dict('os.environ', {}, clear=True):
            with patch.object(db, 'docker', side_effect=['default', 'other-engine']) as docker:
                with self.assertRaisesRegex(db.Blocked, 'engine mismatch'):
                    db.preflight()
                self.assertEqual(docker.call_count, 2)

    def test_environment_override_blocks_before_docker(self):
        with patch.dict('os.environ', {'DOCKER_HOST': 'unreviewed'}, clear=True):
            with patch.object(db, 'docker', side_effect=AssertionError('Docker forbidden')):
                with self.assertRaisesRegex(db.Blocked, 'overrides'):
                    db.preflight()

    def test_stop_never_mutates_replaced_identity(self):
        other = owned()
        other['id'] = 'b' * 64
        with patch.object(db, 'preflight', return_value=other):
            with patch.object(db, 'docker', side_effect=AssertionError('Mutation forbidden')):
                with self.assertRaises(db.Blocked):
                    db.stop_owned(owned())

    def test_docker_timeout_is_sanitized(self):
        import subprocess
        with patch.object(db.subprocess, 'run', side_effect=subprocess.TimeoutExpired('secret', 1)):
            with self.assertRaisesRegex(db.Blocked, 'timed out') as caught:
                db.docker('info')
            self.assertNotIn('secret', str(caught.exception))

    def test_health_failure_stops_waiting(self):
        record = owned()
        record['health'] = 'unhealthy'
        with patch.object(db, 'inspect', return_value=record), patch.object(db.time, 'sleep') as sleep:
            with self.assertRaises(db.Blocked):
                db.wait_healthy(record['id'])
            sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
