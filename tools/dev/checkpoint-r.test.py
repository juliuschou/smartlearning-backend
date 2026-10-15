#!/usr/bin/env python3
"""Container-free probe regressions; all lookup and runtime calls are injected."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('checkpoint_r', Path(__file__).with_name('checkpoint-r.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class ProbeTests(unittest.TestCase):
    def drive(self, stage=None, failure=None, lookup='/private/docker', append_failure=None):
        p = r.plan()
        outputs = [p['context'], json.dumps([{'Endpoints': {'docker': {'Host': p['endpoint']}}}]),
                   p['engineId'], json.dumps([{'Id': p['imageId']}])]
        calls, lookups = [], []
        def runner(argv, **kwargs):
            calls.append((copy.deepcopy(argv), copy.deepcopy(kwargs)))
            index = len(calls) - 1
            if index == stage:
                if isinstance(failure, BaseException):
                    raise failure
                return failure
            return subprocess.CompletedProcess(argv, 0, outputs[index].encode(), b'private stderr')
        def which(name, **kwargs):
            lookups.append((name, kwargs))
            if isinstance(lookup, BaseException):
                raise lookup
            return lookup
        with tempfile.TemporaryDirectory() as directory:
            probe = r.Probe(runner=runner, lookup=which, evidence_root=Path(directory))
            original = r.Evidence.append
            def append(evidence, event, **fields):
                if append_failure and append_failure(event, fields):
                    raise OSError('private recorder')
                return original(evidence, event, **fields)
            with patch.object(r.Evidence, 'append', append):
                result = probe.execute(r.APPROVAL, r.contract_hash(), True)
            files = list(Path(directory).glob('*/probe.jsonl'))
            lines = [json.loads(line) for line in files[0].read_text().splitlines()] if files else []
            self.assertNotIn('private', json.dumps(result) + json.dumps(lines))
        return result, calls, lookups, lines

    def test_success_exact_commands_environment_and_durable_order(self):
        result, calls, lookups, lines = self.drive()
        self.assertEqual(result['status'], 'VERIFIED')
        self.assertFalse(result['recordingFailed'])
        self.assertTrue(result['evidenceStarted'])
        self.assertEqual(result['retentionPolicy'], 'retain-created-evidence')
        self.assertEqual([argv for argv, _ in calls], r.plan()['commands'])
        self.assertEqual(lookups, [('docker', {'path': r.PATH})])
        for _, kwargs in calls:
            self.assertEqual(kwargs, {'env': {'PATH': r.PATH}, 'timeout': 30, 'cwd': r.REPO,
                'stdin': subprocess.DEVNULL, 'stdout': subprocess.PIPE, 'stderr': subprocess.PIPE, 'check': False})
        self.assertEqual([line['event'] for line in lines], ['begin', *(['intent', 'check'] * 5), 'complete'])
        self.assertEqual([line['sequence'] for line in lines], list(range(1, 13)))

    def test_unavailable_lookup_never_calls_runtime(self):
        for lookup, cause in [(None, 'NOT_FOUND'), (PermissionError('private'), 'PERMISSION_DENIED'),
                              (OSError('private'), 'OS_ERROR'), (RuntimeError('private'), 'UNKNOWN')]:
            with self.subTest(cause=cause):
                result, calls, _, lines = self.drive(lookup=lookup)
                self.assertEqual(result['status'], 'BLOCKED')
                self.assertEqual(result['checks'], [{'phase': 'lookup', 'cause': cause,
                    **({'available': False} if lookup is None else {})}])
                self.assertFalse(calls)
                self.assertEqual(lines[-1]['event'], 'complete')

    def test_transport_failure_at_every_phase_stops_without_retry(self):
        cases = [(FileNotFoundError('private'), 'NOT_FOUND'),
                 (PermissionError('private'), 'PERMISSION_DENIED'),
                 (OSError('private'), 'OS_ERROR'),
                 (subprocess.TimeoutExpired(['private'], 30, b'private', b'private'), 'TIMEOUT'),
                 (subprocess.CompletedProcess([], 0, b'private\xff', b'private'), 'DECODE_ERROR'),
                 (subprocess.CompletedProcess([], 1, b'private', b'private'), 'NONZERO_EXIT'),
                 (RuntimeError('private'), 'UNKNOWN')]
        for stage in range(4):
            for failure, cause in cases:
                with self.subTest(stage=stage, cause=cause):
                    result, calls, _, _ = self.drive(stage, failure)
                    self.assertEqual(result['status'], 'BLOCKED')
                    self.assertEqual(len(calls), stage + 1)
                    self.assertEqual(result['checks'][-1], {'phase': r.PHASES[stage + 1], 'cause': cause})

    def test_mismatch_and_invalid_shape_stop_before_later_reads(self):
        for stage in range(4):
            invalid = 'wrong' if stage in (0, 2) else json.dumps([{'Id': 'wrong',
                'Endpoints': {'docker': {'Host': 'wrong'}}}])
            result, calls, _, _ = self.drive(stage, subprocess.CompletedProcess([], 0, invalid.encode(), b''))
            self.assertEqual(result['checks'][-1]['cause'], 'MISMATCH')
            self.assertFalse(result['checks'][-1]['matched'])
            self.assertEqual(len(calls), stage + 1)
        for stage in (1, 3):
            for output in (b'private', b'[]', b'[{}]', b'[null]', b'{}', b'[{}, {}]'):
                result, calls, _, _ = self.drive(stage, subprocess.CompletedProcess([], 0, output, b''))
                self.assertEqual(result['checks'][-1]['cause'], 'INVALID_RESULT')
                self.assertEqual(len(calls), stage + 1)

    def test_recording_failures_block_further_reads_and_remain_reported(self):
        for event in ('begin', 'intent', 'check', 'complete'):
            with self.subTest(event=event):
                result, calls, _, _ = self.drive(append_failure=lambda e, _: e == event)
                self.assertEqual(result['status'], 'BLOCKED')
                self.assertTrue(result['recordingFailed'])
                self.assertEqual(result['evidenceStarted'], event != 'begin')
                self.assertEqual(len(calls), 4 if event == 'complete' else 0)

    def test_close_failure_is_reported_without_raw_exception(self):
        original = r.Evidence.close
        def close(evidence):
            original(evidence)
            raise OSError('private close')
        with patch.object(r.Evidence, 'close', close):
            result, _, _, _ = self.drive()
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertTrue(result['recordingFailed'])

    def test_invalid_gates_and_plan_drift_never_lookup_or_create_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            probe = r.Probe(runner=lambda *a, **k: self.fail('runtime'),
                lookup=lambda *a, **k: self.fail('lookup'), evidence_root=Path(directory))
            for approval, digest, exclusive in [(None, r.contract_hash(), True),
                (r.APPROVAL, '0' * 64, True), (r.APPROVAL, r.contract_hash(), False)]:
                with self.assertRaises(ValueError):
                    probe.execute(approval, digest, exclusive)
            probe.p['commands'][0].append('private')
            with self.assertRaises(ValueError):
                probe.execute(r.APPROVAL, r.contract_hash(), True)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_loaded_source_drift_blocks_before_lookup(self):
        original = Path.read_bytes
        def drift(path):
            value = original(path)
            return value + b'\n' if path.name == 'checkpoint-r.py' else value
        with patch.object(Path, 'read_bytes', drift), self.assertRaises(ValueError):
            r.plan()

    def test_midrun_source_drift_stops_next_command(self):
        original = r.Probe.guard
        calls = []
        def guard(probe, digest):
            calls.append(1)
            if len(calls) >= 3:
                raise ValueError('private drift')
            return original(probe, digest)
        with patch.object(r.Probe, 'guard', guard):
            result, runtime, lookups, _ = self.drive()
        self.assertFalse(runtime)
        self.assertEqual(len(lookups), 1)
        self.assertEqual(result['checks'][-1], {'phase': 'guard', 'cause': 'GUARD_BLOCKED'})

    def test_identity_and_instance_are_single_use_even_after_blocked_lookup(self):
        with tempfile.TemporaryDirectory() as directory:
            kwargs = {'runner': lambda *a, **k: self.fail('runtime'),
                      'lookup': lambda *a, **k: None, 'evidence_root': Path(directory)}
            probe = r.Probe(**kwargs)
            result = probe.execute(r.APPROVAL, r.contract_hash(), True)
            self.assertEqual(result['status'], 'BLOCKED')
            with self.assertRaises(ValueError):
                probe.execute(r.APPROVAL, r.contract_hash(), True)
            with patch.object(r.shutil, 'which', side_effect=AssertionError('unexpected real lookup')):
                result = r.Probe(**kwargs).execute(r.APPROVAL, r.contract_hash(), True)
            self.assertTrue(result['recordingFailed'])
            self.assertTrue((Path(directory) / r.RUN / 'probe.jsonl').is_file())

    def test_unsafe_evidence_root_and_unapproved_overrides_block(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'link').symlink_to(root, target_is_directory=True)
            for path in (Path('relative'), root / 'link'):
                with self.assertRaises(ValueError):
                    r.Evidence(path, r.contract_hash())
            with self.assertRaises(ValueError):
                r.Probe(evidence_root=root)

    def test_evidence_rejects_arbitrary_fields_and_values(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = r.Evidence(Path(directory), r.contract_hash())
            try:
                for event, fields in [('private', {}), ('intent', {'phase': 'private'}),
                    ('check', {'check': {'phase': 'lookup', 'cause': 'private'}}),
                    ('check', {'check': {'phase': 'lookup', 'cause': 'AVAILABLE', 'available': 1}}),
                    ('check', {'check': {'phase': 'lookup', 'cause': 'AVAILABLE', 'raw': 'private'}})]:
                    with self.assertRaises(ValueError):
                        evidence.append(event, **fields)
            finally:
                evidence.close()

    def test_default_and_incomplete_cli_do_not_lookup_or_call_runtime(self):
        probe_class = r.Probe
        for argv, expected in [([], 0), (['--execute'], 1), (['--approve', 'private'], 1)]:
            with tempfile.TemporaryDirectory() as directory, \
                 patch.object(r, 'Probe', side_effect=lambda: probe_class(
                     runner=lambda *a, **k: self.fail('runtime'),
                     lookup=lambda *a, **k: self.fail('lookup'), evidence_root=Path(directory))), \
                 patch('sys.argv', ['checkpoint-r.py', *argv]), patch('builtins.print') as output:
                self.assertEqual(r.main(), expected)
                self.assertNotIn('private', output.call_args.args[0])
                self.assertEqual(list(Path(directory).iterdir()), [])
                if expected:
                    self.assertFalse(json.loads(output.call_args.args[0])['evidenceStarted'])


if __name__ == '__main__':
    unittest.main()
