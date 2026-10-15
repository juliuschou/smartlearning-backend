"""Repository-only discovery preparation. No production lookup/attestation adapter."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat

RUN = 'sl-v-discovery-20261014-01'
DOMAIN = '/usr/local/bin:/usr/bin:/bin:/mnt/c/Windows/System32/WindowsPowerShell/v1.0'
RETENTION = 'retain-created-evidence'
SOURCE_NAMES = ('checkpoint-y.py', 'checkpoint-v-discovery-contract.md',
                'checkpoint-x-environment-contract.md')
CAUSES = ('AVAILABLE', 'NOT_FOUND', 'PERMISSION_DENIED', 'OS_ERROR', 'UNKNOWN',
          'INVALID_RESULT', 'GUARD_BLOCKED', 'RECORDING_FAILED', 'MISSING_ATTESTATION')
FIELDS = {'contractId', 'runId', 'phase', 'event', 'status', 'cause', 'available',
          'evidenceStarted', 'recordingFailed', 'retentionPolicy'}


def require(condition):
    if not condition:
        raise ValueError('Blocked')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def hashes(value):
    return (type(value) is dict and bool(value) and
            all(type(k) is str and bool(k) and type(v) is str and
                re.fullmatch('[a-f0-9]{64}', v) for k, v in value.items()))


def validate_manifest(m):
    """Validate supplied review inputs; this does not authenticate a deployment."""
    require(type(m) is dict and set(m) == {
        'implementation', 'version', 'osName', 'platform', 'pathModule', 'pathsep',
        'filesystemEncoding', 'interpreter', 'upstreamCommit', 'sourceArchiveSha256',
        'buildConfiguration', 'artifacts', 'repositorySources', 'bootstrap',
        'supervisorAttestation', 'immutableClosureAttestation'})
    for key, value in {'implementation': 'CPython', 'version': '3.12.0',
                       'osName': 'posix', 'platform': 'linux', 'pathModule': 'posixpath',
                       'pathsep': ':', 'filesystemEncoding': 'utf-8'}.items():
        require(m[key] == value)
    require(type(m['interpreter']) is str and m['interpreter'].startswith('/'))
    require(type(m['upstreamCommit']) is str and
            re.fullmatch('[a-f0-9]{40}', m['upstreamCommit']))
    require(hashes({'archive': m['sourceArchiveSha256']}))
    require(type(m['buildConfiguration']) is dict and bool(m['buildConfiguration']))
    require(hashes(m['artifacts']) and hashes(m['repositorySources']))
    require(set(m['repositorySources']) == set(SOURCE_NAMES))
    # The reviewed external verifier must attest this full deployment closure.
    require(set(m['artifacts']) == {'executableBuild', 'stdlibImportClosure',
                                    'loaderSharedLibraries', 'trustedLauncher',
                                    'reviewedStartupSources', 'reviewedLookupSources'})
    require(canonical(m['bootstrap']) == canonical({'environment': {'LC_ALL': 'C.UTF-8'},
                              'options': ['-I', '-S', '-B', '-X', 'utf8'],
                              'cwd': 'fixed-repository', 'excludeLoaderInjection': True}))
    for key in ('supervisorAttestation', 'immutableClosureAttestation'):
        require(hashes({'attestation': m[key]}))


def contract_digest(manifest):
    validate_manifest(manifest)
    return sha(canonical({'manifest': manifest, 'runId': RUN, 'lookup': 'docker',
                          'path': DOMAIN, 'schema': sorted(FIELDS),
                          'causes': list(CAUSES), 'retentionPolicy': RETENTION}))


def result(status='REVIEW_ONLY', cause='MISSING_ATTESTATION', available=None,
           started=False, failed=False):
    return {'status': status, 'cause': cause, 'available': available,
            'evidenceStarted': started, 'recordingFailed': failed,
            'retentionPolicy': RETENTION}


def validate_event(record):
    require(type(record) is dict and set(record) == FIELDS)
    require(record['runId'] == RUN and hashes({'contract': record['contractId']}))
    require(record['phase'] in ('guard', 'lookup', 'evidence'))
    require(record['event'] in ('begin', 'intent', 'outcome', 'complete'))
    require(record['status'] in ('REVIEW_ONLY', 'READY', 'AVAILABLE', 'NOT_FOUND', 'BLOCKED'))
    require(record['cause'] in CAUSES)
    require(record['available'] is None or type(record['available']) is bool)
    require(type(record['evidenceStarted']) is bool and type(record['recordingFailed']) is bool)
    require(record['retentionPolicy'] == RETENTION)


class Evidence:
    """Exclusive POSIX fixture recorder. Retain even partially initialized artifacts."""
    def __init__(self, root):
        self.root = Path(root)
        self.fd = None
        self.started = False

    def open(self):
        require(self.root.is_absolute())
        # Only parent/state checks, never inspect the reserved run directory.
        for parent in (self.root, *self.root.parents):
            info = parent.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, os.getuid()) and
                    (not info.st_mode & 0o022 or bool(info.st_mode & stat.S_ISVTX)))
        info = self.root.lstat()
        require(info.st_uid == os.getuid() and not info.st_mode & 0o022)
        directory = self.root / RUN
        directory.mkdir(mode=0o700)  # Existing identity blocks atomically.
        self.started = True
        self.fd = os.open(directory / 'discovery.jsonl',
                          os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        os.fchmod(self.fd, 0o600)
        for path in (directory, self.root):
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)

    def append(self, record):
        validate_event(record)
        data = canonical(record) + b'\n'
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


class Discovery:
    """Only injected preparation. Callables are mandatory and never default to live tools.

    verify(manifest) must authenticate externally reviewed immutable artifacts,
    loaded implementation/import/platform identities, bootstrap and serialization.
    Supplying a manifest or returning True is not itself human authorization.
    Y intentionally supplies no real verifier or executable lookup implementation.
    """
    def __init__(self, *, lookup, verify, loaded_sources, recorder):
        self.lookup, self.verify = lookup, verify
        self.loaded_sources, self.recorder = loaded_sources, recorder
        self.used = False

    def guard(self, manifest, digest, scope):
        validate_manifest(manifest)
        require(type(scope) is dict and canonical(scope) == canonical({
            'humanApproved': True, 'externallySerialized': True,
            'runId': RUN, 'contractId': digest}))
        require(digest == contract_digest(manifest))
        loaded = self.loaded_sources()
        require(type(loaded) is dict and set(loaded) == set(SOURCE_NAMES))
        require(all(type(data) is bytes and sha(data) == manifest['repositorySources'][name]
                    for name, data in loaded.items()))
        require(self.verify(manifest) is True)
        require(digest == contract_digest(manifest))

    def execute(self, *, manifest=None, digest=None, scope=None):
        if self.used:
            return result('BLOCKED', 'GUARD_BLOCKED')
        if manifest is None or digest is None or scope is None:
            return result()
        self.used = True
        # Freeze nested caller inputs before verification, intent and lookup.
        try:
            manifest, scope = json.loads(canonical(manifest)), json.loads(canonical(scope))
            self.guard(manifest, digest, scope)
        except BaseException:
            return result('BLOCKED', 'GUARD_BLOCKED')
        outcome = result('BLOCKED', 'RECORDING_FAILED')
        evidence = None

        def append(event, phase):
            evidence.append({'contractId': digest, 'runId': RUN, 'phase': phase,
                             'event': event, **outcome})

        try:
            evidence = self.recorder()
            evidence.open()
            outcome = result('READY', 'GUARD_BLOCKED', started=evidence.started)
            append('begin', 'evidence')
            append('intent', 'lookup')
            try:
                self.guard(manifest, digest, scope)
            except BaseException:
                outcome = result('BLOCKED', 'GUARD_BLOCKED', started=evidence.started)
            else:
                try:
                    value = self.lookup('docker', path=DOMAIN)
                    if value is None:
                        outcome = result('NOT_FOUND', 'NOT_FOUND', False, evidence.started)
                    elif type(value) is str and value:
                        outcome = result('AVAILABLE', 'AVAILABLE', True, evidence.started)
                    else:
                        outcome = result('BLOCKED', 'INVALID_RESULT', started=evidence.started)
                except PermissionError:
                    outcome = result('BLOCKED', 'PERMISSION_DENIED', started=evidence.started)
                except OSError:
                    outcome = result('BLOCKED', 'OS_ERROR', started=evidence.started)
                except BaseException:
                    outcome = result('BLOCKED', 'UNKNOWN', started=evidence.started)
            append('outcome', 'lookup' if outcome['cause'] != 'GUARD_BLOCKED' else 'guard')
            append('complete', 'evidence')
        except BaseException:
            outcome = result('BLOCKED', 'RECORDING_FAILED', outcome['available'],
                             bool(evidence is not None and evidence.started), True)
        finally:
            if evidence is not None:
                try:
                    evidence.close()
                except BaseException:
                    outcome = result('BLOCKED', 'RECORDING_FAILED', outcome['available'],
                                     evidence.started, True)
        return outcome


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--approve')
    parser.add_argument('--contract-sha256')
    parser.add_argument('--exclusive', action='store_true')
    parser.parse_args(argv)
    # CLI has no attestation, lookup or filesystem adapter. Flags cannot grant scope.
    print(json.dumps(result(), sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
