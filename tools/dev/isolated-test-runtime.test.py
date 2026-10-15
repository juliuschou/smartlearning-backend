import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('runtime_check', Path(__file__).with_name('isolated-test-runtime.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class OwnershipGuard(unittest.TestCase):
    def fixture(self):
        return {'Image': m.IMAGE, 'Config': {'User': '999:999', 'Labels': {'smartlearning.checkpoint': m.RUN}},
                'HostConfig': {'RestartPolicy': {'Name': 'no'}, 'Privileged': False,
                               'PortBindings': {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '55433'}]}},
                'Mounts': [{'Type': 'volume', 'RW': True, 'Name': m.OLD + '-data', 'Destination': '/var/lib/postgresql/data'}],
                'NetworkSettings': {'Networks': {m.OLD + '-net': {}}}}

    def test_accepts_exact_continuation(self):
        m.shape(self.fixture(), m.RUN)

    def test_rejects_source_volume(self):
        obj = self.fixture()
        obj['Mounts'][0]['Name'] = 'source-data'
        with self.assertRaises(RuntimeError):
            m.shape(obj, m.RUN)

    def test_rejects_public_port(self):
        obj = self.fixture()
        obj['HostConfig']['PortBindings']['5432/tcp'][0]['HostIp'] = '0.0.0.0'
        with self.assertRaises(RuntimeError):
            m.shape(obj, m.RUN)

    def test_rejects_foreign_ownership_image_user_or_extra_mount(self):
        for key in ['label', 'image', 'user', 'mount']:
            obj = copy.deepcopy(self.fixture())
            if key == 'label': obj['Config']['Labels']['smartlearning.checkpoint'] = 'foreign'
            if key == 'image': obj['Image'] = 'unreviewed'
            if key == 'user': obj['Config']['User'] = '0:0'
            if key == 'mount': obj['Mounts'].append(obj['Mounts'][0])
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                m.shape(obj, m.RUN)


class HbaGuard(unittest.TestCase):
    def test_clones_only_app_exact_peer_with_password_auth(self):
        original = b'local all all trust\nhost smartlearning_test app_user 192.168.127.1/32 trust\n'
        result = m.executor_hba(original, 'app_user')
        self.assertTrue(result.startswith(original))
        self.assertIn(b'host smartlearning_test sl_isolated_test_executor 192.168.127.1/32 scram-sha-256', result)

    def test_rejects_public_broad_or_missing_peer(self):
        for address in ['0.0.0.0/0', '192.168.0.0/16', '8.8.8.8/32', '127.0.0.1/32']:
            with self.subTest(address=address), self.assertRaises(RuntimeError):
                m.executor_hba(('host smartlearning_test app_user ' + address + ' trust').encode(), 'app_user')
        with self.assertRaises(RuntimeError):
            m.executor_hba(b'host other_db app_user 192.168.0.1/32 trust', 'app_user')


class InterruptGuard(unittest.TestCase):
    def test_soft_interrupt_unwinds_and_masks_repeat_signals(self):
        from unittest.mock import patch
        with patch.object(m.signal, 'signal') as install:
            with self.assertRaises(RuntimeError):
                m.interrupted(m.signal.SIGTERM, None)
            self.assertEqual(install.call_count, 2)
            install.assert_any_call(m.signal.SIGTERM, m.signal.SIG_IGN)
            install.assert_any_call(m.signal.SIGINT, m.signal.SIG_IGN)


if __name__ == '__main__':
    unittest.main()
