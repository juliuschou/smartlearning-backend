#!/usr/bin/env python3
"""Bounded read-only transport probe; default is repository-only review."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess

_spec = importlib.util.spec_from_file_location('checkpoint_r_n', Path(__file__).with_name('checkpoint-n.py'))
n = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(n)
REPO = Path(__file__).resolve().parents[2]
RUN = 'sl-r-20261014-01'
APPROVAL = 'single-use-read-only-fixed-path-four-runtime-identities-retain-evidence'
PATH = '/usr/local/bin:/usr/bin:/bin:/mnt/c/Windows/System32/WindowsPowerShell/v1.0'
SOURCES = ('checkpoint-r.py', *n.SOURCE_FILES)
SNAPSHOT = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in SOURCES}
PHASES = ('lookup', 'context-show', 'context-inspect', 'engine-info', 'image-inspect', 'guard', 'evidence')
CAUSES = ('AVAILABLE', 'MATCH', 'MISMATCH', 'NOT_FOUND', 'PERMISSION_DENIED',
          'OS_ERROR', 'TIMEOUT', 'DECODE_ERROR', 'NONZERO_EXIT', 'INVALID_RESULT',
          'GUARD_BLOCKED', 'RECORDING_FAILED', 'UNKNOWN')


def require(value):
    if not value:
        raise ValueError('Probe blocked')


def plan():
    require(all(hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() == digest
                for name, digest in SNAPSHOT.items()))
    p = n.plan()
    prefix = ['docker', '--context', p['context']]
    return {'runId': RUN, 'environment': {'PATH': PATH}, 'timeoutSeconds': 30,
            'context': p['context'], 'endpoint': p['endpoint'],
            'engineId': p['engineId'], 'imageId': p['imageId'],
            'commands': [prefix + ['context', 'show'],
                         prefix + ['context', 'inspect', p['context']],
                         prefix + ['info', '--format', '{{.ID}}'],
                         prefix + ['image', 'inspect', p['imageId']]],
            'lookup': 'docker', 'sourceSha256': dict(SNAPSHOT),
            'evidence': 'artifacts/local-env/' + RUN,
            'approval': APPROVAL, 'liveEnabled': True,
            'excluded': ['lifecycle', 'ports', 'SQL', 'initdb', 'migrations',
                         'real env files', 'old containers/volumes', 'cleanup', 'retry']}


def contract_hash():
    return hashlib.sha256(json.dumps(plan(), sort_keys=True).encode()).hexdigest()


def validate_check(check):
    require(set(check) <= {'phase', 'cause', 'available', 'matched'})
    require(check.get('phase') in PHASES and check.get('cause') in CAUSES)
    require(all(type(check[key]) is bool for key in ('available', 'matched') if key in check))


class Evidence:
    """Exclusive identity, protected append-only sanitized evidence; never delete."""
    def __init__(self, root, digest):
        self.fd = None
        require(root.is_absolute() and re.fullmatch('[a-f0-9]{64}', digest or ''))
        for parent in (root, *root.parents):
            require(not parent.is_symlink())
            if parent.exists():
                info = parent.stat()
                require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, os.getuid()) and
                        (not info.st_mode & 0o022 or bool(info.st_mode & stat.S_ISVTX)))
        root.mkdir(parents=True, exist_ok=True)
        info = root.stat()
        require(info.st_uid == os.getuid() and not info.st_mode & 0o022)
        directory = root / RUN
        directory.mkdir(mode=0o700)  # Atomic single-use gate, even on later failure.
        try:
            self.fd = os.open(directory / 'probe.jsonl', os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            self.sequence = 0
            self.append('begin', contractSha256=digest)
            for path in (directory, root):
                fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        except BaseException:
            self.close()
            raise

    def append(self, event, **fields):
        require(event in ('begin', 'intent', 'check', 'complete'))
        expected = {'begin': {'contractSha256'}, 'intent': {'phase'},
                    'check': {'check'}, 'complete': {'status', 'recordingFailed'}}
        require(set(fields) == expected[event])
        if event == 'begin':
            require(re.fullmatch('[a-f0-9]{64}', fields['contractSha256']))
        elif event == 'intent':
            require(fields['phase'] in PHASES)
        elif event == 'check':
            validate_check(fields['check'])
        else:
            require(fields['status'] in ('VERIFIED', 'BLOCKED') and type(fields['recordingFailed']) is bool)
        self.sequence += 1
        data = (json.dumps({'event': event, 'sequence': self.sequence,
                           'timeUtc': datetime.now(timezone.utc).isoformat(), **fields}, sort_keys=True) + '\n').encode()
        offset = 0
        while offset < len(data):
            written = os.write(self.fd, data[offset:])
            require(written > 0)
            offset += written
        os.fsync(self.fd)

    def close(self):
        if self.fd is not None:
            fd, self.fd = self.fd, None
            os.close(fd)


def matches(phase, output, p):
    if phase == 'context-show':
        return output.strip() == p['context']
    if phase == 'engine-info':
        return output.strip() == p['engineId']
    value = json.loads(output)
    require(isinstance(value, list) and len(value) == 1 and isinstance(value[0], dict))
    if phase == 'context-inspect':
        return value[0]['Endpoints']['docker']['Host'] == p['endpoint']
    return value[0]['Id'] == p['imageId']


class Probe:
    def __init__(self, *, runner=subprocess.run, lookup=shutil.which, evidence_root=None):
        require(evidence_root is None or (runner is not subprocess.run and lookup is not shutil.which))
        self.p = plan()
        self.runner, self.lookup = runner, lookup
        self.root = Path(evidence_root) if evidence_root is not None else REPO / 'artifacts/local-env'
        self.used = False

    def guard(self, digest):
        require(self.p == plan() and digest == contract_hash())

    def step(self, phase, argv=None):
        try:
            if phase == 'lookup':
                available = bool(self.lookup('docker', path=self.p['environment']['PATH']))
                return {'phase': phase, 'cause': 'AVAILABLE' if available else 'NOT_FOUND', 'available': available}
            result = self.runner(argv, env=dict(self.p['environment']), timeout=self.p['timeoutSeconds'],
                                 cwd=REPO, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, check=False)
            if result.returncode:
                return {'phase': phase, 'cause': 'NONZERO_EXIT'}
            output = result.stdout.decode('utf-8')
            try:
                matched = matches(phase, output, self.p)
            except (ValueError, KeyError, TypeError, IndexError):
                return {'phase': phase, 'cause': 'INVALID_RESULT'}
            return {'phase': phase, 'cause': 'MATCH' if matched else 'MISMATCH', 'matched': matched}
        except FileNotFoundError:
            cause = 'NOT_FOUND'
        except PermissionError:
            cause = 'PERMISSION_DENIED'
        except OSError:
            cause = 'OS_ERROR'
        except subprocess.TimeoutExpired:
            cause = 'TIMEOUT'
        except UnicodeError:
            cause = 'DECODE_ERROR'
        except Exception:
            cause = 'UNKNOWN'
        return {'phase': phase, 'cause': cause}

    def execute(self, approval, digest, exclusive=False):
        require(not self.used and approval == APPROVAL and exclusive is True)
        self.guard(digest)
        self.used = True
        evidence, checks = None, []
        status, recording_failed = 'BLOCKED', False
        try:
            try:
                evidence = Evidence(self.root, digest)
            except BaseException:
                recording_failed = True
                raise
            for phase, argv in [('lookup', None), *zip(PHASES[1:5], self.p['commands'])]:
                self.guard(digest)
                evidence.append('intent', phase=phase)
                check = self.step(phase, argv)
                validate_check(check)
                checks.append(check)
                evidence.append('check', check=check)
                if check['cause'] not in ('AVAILABLE', 'MATCH'):
                    break
            else:
                self.guard(digest)
                status = 'VERIFIED'
        except BaseException:
            # Recording and guard failures are distinguished without raw messages.
            try:
                self.guard(digest)
            except BaseException:
                checks.append({'phase': 'guard', 'cause': 'GUARD_BLOCKED'})
            else:
                recording_failed = True
                checks.append({'phase': 'evidence', 'cause': 'RECORDING_FAILED'})
            if evidence is not None:
                try:
                    evidence.append('check', check=checks[-1])
                except BaseException:
                    recording_failed = True
        finally:
            if evidence is not None:
                try:
                    evidence.append('complete', status=status, recordingFailed=recording_failed)
                except BaseException:
                    recording_failed = True
                try:
                    evidence.close()
                except BaseException:
                    recording_failed = True
        return {'status': 'BLOCKED' if recording_failed else status, 'checks': checks,
                'recordingFailed': recording_failed, 'evidenceStarted': evidence is not None,
                'retentionPolicy': 'retain-created-evidence'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--approve')
    parser.add_argument('--contract-sha256')
    parser.add_argument('--exclusive', action='store_true')
    args = parser.parse_args()
    try:
        if not args.execute:
            require(not (args.approve or args.contract_sha256 or args.exclusive))
            result = {'status': 'REVIEW_ONLY', 'contractSha256': contract_hash(), 'plan': plan()}
        else:
            result = Probe().execute(args.approve, args.contract_sha256, args.exclusive)
    except BaseException:
        result = {'status': 'BLOCKED', 'checks': [{'phase': 'guard', 'cause': 'GUARD_BLOCKED'}],
                  'recordingFailed': False, 'evidenceStarted': False,
                  'retentionPolicy': 'retain-created-evidence'}
    print(json.dumps(result, sort_keys=True))
    return 0 if result['status'] in ('REVIEW_ONLY', 'VERIFIED') else 1


if __name__ == '__main__':
    raise SystemExit(main())
