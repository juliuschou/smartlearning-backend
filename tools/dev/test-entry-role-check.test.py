import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('entry_check', Path(__file__).with_name('test-entry-role-check.py'))
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


if __name__ == '__main__':
    unittest.main()
