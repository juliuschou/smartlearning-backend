#!/usr/bin/env python3
"""Single-use, separately authorized SQL-only lifecycle; default is pure review."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import time

import importlib.util

_spec = importlib.util.spec_from_file_location('checkpoint_n_m', Path(__file__).with_name('checkpoint-m.py'))
m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(m)
f = m.f
require = f.require
SOURCE_FILES = ('checkpoint-n.py', 'checkpoint-m.py', 'checkpoint-f.py', 'checkpoint-e.py', 'checkpoint-roles.py')
SOURCE_SNAPSHOT = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in SOURCE_FILES}
APPROVAL = 'single-use-fresh-sql-initdb-secret-helper-independent-roles-eight-negative-cases-retain-volumes-evidence'


def plan():
    require(all(hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() == digest
                for name, digest in SOURCE_SNAPSHOT.items()), 'Loaded source drift')
    value = m.plan()
    value.update(liveEnabled=True, approval=APPROVAL,
                 exclusivity='serialized-runtime-port-5433', retention='volumes-and-evidence',
                 adapterSourceSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    return value


def contract_hash():
    return hashlib.sha256(json.dumps(plan(), sort_keys=True).encode()).hexdigest()


class Evidence:
    """Exclusive, durable sanitized JSONL; directory existence consumes identity."""
    EVENTS = frozenset({'begin', 'preflight', 'create-intent', 'created', 'initialized',
                        'diagnostic', 'stop', 'stop-blocked', 'blocked', 'complete'})

    def __init__(self, root, run_id, digest):
        require(run_id == m.RUN and re.fullmatch('[a-f0-9]{64}', digest or ''), 'Invalid evidence identity')
        root = Path(root)
        require(root.is_absolute(), 'Evidence root must be absolute')
        for parent in (root, *root.parents):
            require(not parent.is_symlink(), 'Evidence ancestor symlink')
            if parent.exists():
                info = parent.stat()
                require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, os.getuid()) and
                        (not info.st_mode & 0o022 or bool(info.st_mode & stat.S_ISVTX)), 'Unsafe evidence ancestor')
        root.mkdir(parents=True, exist_ok=True)
        root_info = root.stat()
        require(not root.is_symlink() and root_info.st_uid == os.getuid() and not root_info.st_mode & 0o022, 'Unsafe evidence root')
        self.lock = os.open(root / '.sql-lifecycle-port-5433.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(self.lock)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and
                    stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1, 'Unsafe lock file')
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.path = root / run_id
            self.path.mkdir(mode=0o700)
            require(stat.S_IMODE(self.path.stat().st_mode) == 0o700, 'Unsafe evidence directory mode')
            self.fd = os.open(self.path / 'lifecycle.jsonl', os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            file_info = os.fstat(self.fd)
            require(stat.S_IMODE(file_info.st_mode) == 0o600 and file_info.st_uid == os.getuid() and file_info.st_nlink == 1, 'Unsafe evidence file')
            self.sequence = 0
            self.append('begin', contractSha256=digest)
            self._sync_dir(self.path)
            self._sync_dir(root)
        except BaseException:
            if hasattr(self, 'fd'):
                os.close(self.fd)
            os.close(self.lock)
            raise

    @staticmethod
    def _sync_dir(path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def append(self, event, **fields):
        require(event in self.EVENTS, 'Unknown evidence event')
        allowed = {'contractSha256', 'resource', 'id', 'result', 'checks', 'classification', 'errors', 'unresolvedCreates', 'recordingFailed'}
        require(set(fields) <= allowed, 'Unknown evidence field')
        if 'resource' in fields:
            require(fields['resource'] in ('helper', 'pg', 'secret-volume', 'data-volume'), 'Unknown resource')
        if 'id' in fields:
            require(re.fullmatch('[a-f0-9]{64}', fields['id']), 'Invalid resource ID')
        if 'contractSha256' in fields:
            require(re.fullmatch('[a-f0-9]{64}', fields['contractSha256']), 'Invalid digest')
        if 'result' in fields:
            require(fields['result'] in ('SYNTHETIC_VERIFIED', 'BLOCKED', 'STOPPED', 'UNRESOLVED'), 'Invalid result')
        if 'classification' in fields:
            require(fields['classification'] in m.SQLSTATES | {'UNKNOWN', 'TRANSPORT_UNAVAILABLE', 'INVALID_RESULT', 'INVALID_CREDENTIAL'}, 'Invalid classification')
        if 'recordingFailed' in fields:
            require(type(fields['recordingFailed']) is bool, 'Invalid recording flag')
        if 'errors' in fields:
            require(set(fields['errors']) <= {'lifecycle-blocked', 'recording-blocked', 'pg-stop-blocked', 'helper-stop-blocked'}, 'Invalid error')
        if 'unresolvedCreates' in fields:
            require(set(fields['unresolvedCreates']) <= {'pg', 'helper', 'secret-volume', 'data-volume'}, 'Invalid unresolved resource')
        if 'checks' in fields:
            for check in fields['checks']:
                require(check.get('check') in m.CHECKS and set(check) <= {'check', 'result', 'matched', 'classification'}, 'Invalid check')
                require(all(type(check[k]) is bool for k in ('result', 'matched') if k in check), 'Invalid boolean')
                if 'classification' in check:
                    require(check['classification'] in m.SQLSTATES | {'UNKNOWN', 'TRANSPORT_UNAVAILABLE', 'INVALID_RESULT', 'INVALID_CREDENTIAL'}, 'Invalid classification')
        self.sequence += 1
        data = (json.dumps({'event': event, 'sequence': self.sequence,
                            'timeUtc': datetime.now(timezone.utc).isoformat(), **fields}, sort_keys=True) + '\n').encode()
        offset = 0
        while offset < len(data):
            written = os.write(self.fd, data[offset:])
            require(written > 0, 'Evidence write blocked')
            offset += written
        os.fsync(self.fd)

    def close(self):
        os.close(self.fd)
        os.close(self.lock)


class Adapter(m.SQLTransport):
    def __init__(self, *, runner=m.diagnostic_run, environment=None,
                 port_probe=f.local_port, sleep=time.sleep, evidence_root=None,
                 credential_factory=secrets.token_hex):
        # Inspect inherited overrides without reading any environment file.
        inherited = dict(os.environ if environment is None else environment)
        require(not any(k.startswith(('DOCKER_', 'PG', 'PRISMA_')) or k in
                        ('DIRECT_URL', 'DATABASE_URL', 'NODE_OPTIONS', 'NODE_PATH') for k in inherited),
                'Inherited connection/runtime override')
        super().__init__(runner=runner, environment={})
        self.environment = {'PATH': '/usr/local/bin:/usr/bin:/bin:/mnt/c/Windows/System32/WindowsPowerShell/v1.0'}
        self.port_probe = port_probe
        self.sleep = sleep
        require(evidence_root is None or runner is not m.diagnostic_run, 'Production evidence root override prohibited')
        self.evidence_root = Path(evidence_root) if evidence_root is not None else f.contract.REPO / 'artifacts/local-env'
        self.credential_factory = credential_factory
        self.evidence = None
        self.digest = None
        self.unresolved = []
        self.recording_failed = False

    def record(self, event, **fields):
        try:
            self.evidence.append(event, **fields)
        except BaseException:
            self.recording_failed = True
            raise

    def disabled(self, *args, **kwargs):
        raise ValueError('Excluded SQL-only operation')

    tcp = disabled
    application_url = disabled
    migration_url = disabled
    rollback = disabled
    separate_roles = disabled
    migrate = disabled

    def guard(self):
        require(self.p == m.plan(), 'Lifecycle identity drift')
        require(self.digest == contract_hash(), 'Adapter contract drift')
        self.runtime_identity()

    def preflight(self):
        self.guard()
        image = self.inspect('image', self.p['imageId'])
        config = image['Config']
        require(config['Entrypoint'] == ['docker-entrypoint.sh'] and config.get('User', '') in ('', '0', 'root')
                and config.get('Cmd') == ['postgres'] and set(config.get('Volumes', {})) == {'/var/lib/postgresql/data'}, 'Unsupported image')
        names = set(self.docker('ps', '-a', '--format', '{{.Names}}').splitlines())
        require(not names.intersection({self.p['container'], self.p['helper']}), 'Container collision')
        names = set(self.docker('volume', 'ls', '--format', '{{.Name}}').splitlines())
        require(not names.intersection({self.p['dataVolume'], self.p['secretVolume']}), 'Volume collision')
        self.port_probe()
        require(self.command(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', f.WINDOWS]).strip() == 'PORT_AVAILABLE', 'Windows port unavailable')
        self.record('preflight')

    def verify_container(self, cid, helper=False):
        c = super().verify_container(cid, helper)
        binds = [self.p['secretVolume'] + ':/secret'] if helper else [
            self.p['dataVolume'] + ':/var/lib/postgresql/data', self.p['secretVolume'] + ':/run/secrets:ro']
        mounts = [{'Type': 'tmpfs', 'Target': '/var/lib/postgresql/data', 'ReadOnly': True,
                   'TmpfsOptions': {'SizeBytes': 1048576, 'Mode': 448}}] if helper else []
        require(c['HostConfig'].get('Binds') == binds and c['HostConfig'].get('Mounts', []) == mounts,
                'Configured mount mismatch')
        return c

    def volume(self, name):
        self.guard()
        return f.Executor.volume(self, name)

    def create_volume(self, resource, name):
        self.guard()
        self.record('create-intent', resource=resource, result='UNRESOLVED')
        self.unresolved.append(resource)
        self.volume(name)
        self.record('created', resource=resource)
        self.unresolved.remove(resource)

    def create_container(self, resource, args):
        self.guard()
        require(self.p['helper' if resource == 'helper' else 'container'] not in
                set(self.docker('ps', '-a', '--format', '{{.Names}}').splitlines()), 'Container collision before create')
        self.record('create-intent', resource=resource, result='UNRESOLVED')
        self.unresolved.append(resource)
        cid = self.docker(*args).strip()
        require(re.fullmatch('[a-f0-9]{64}', cid), 'Invalid container ID')
        self.ids[resource] = cid
        self.verify_container(cid, resource == 'helper')
        self.record('created', resource=resource, id=cid)
        self.unresolved.remove(resource)
        return cid

    def provision(self):
        self.guard()
        passwords = [self.credential_factory(32) for _ in range(3)]
        require(all(isinstance(p, str) and re.fullmatch('[a-f0-9]{64}', p) for p in passwords)
                and len(set(passwords)) == 3, 'Invalid independent credentials')
        self.password, self.migration_password, self.application_password = passwords
        self.create_volume('secret-volume', self.p['secretVolume'])
        helper = self.create_container('helper', ['create', '-i', '--name', self.p['helper'], '--label', self.p['label'],
            '--restart', 'no', '--network', 'none', '--user', '0:0', '--entrypoint', 'sh',
            '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data,readonly,tmpfs-size=1048576,tmpfs-mode=0700',
            '-v', self.p['secretVolume'] + ':/secret', self.p['imageId'], '-ceu', f.HELPER_SCRIPT])
        self.guard()
        self.verify_container(helper, True)
        self.docker('start', '-ai', helper, data=self.password.encode())
        c = self.verify_container(helper, True)
        require(c['State']['Status'] == 'exited' and c['State']['ExitCode'] == 0, 'Helper failed')
        self.create_volume('data-volume', self.p['dataVolume'])
        args = ['create', '--name', self.p['container'], '--label', self.p['label'], '--restart', 'no',
                '-p', self.p['publish'], '-v', self.p['dataVolume'] + ':/var/lib/postgresql/data',
                '-v', self.p['secretVolume'] + ':/run/secrets:ro']
        for value in ('POSTGRES_PASSWORD_FILE=' + f.SECRET_PATH, 'POSTGRES_DB=' + self.p['database'],
                      'POSTGRES_USER=' + self.p['role'], 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256'):
            args.extend(['-e', value])
        pg = self.create_container('pg', [*args, self.p['imageId']])
        self.guard()
        self.verify_container(pg)
        self.docker('start', pg)
        # Readiness is a bounded health probe, never a retry of SQL diagnostics.
        for attempt in range(30):
            self.guard()
            self.verify_container(pg)
            state = self.docker('exec', pg, 'sh', '-c', 'pg_isready -q -U smartlearning_dev_owner -d smartlearning_dev; printf "%s" "$?"').strip()
            require(state in ('0', '1', '2'), 'Invalid readiness result')
            if state == '0':
                break
            require(attempt < 29, 'Readiness unavailable')
            self.sleep(1)
        require(self.sql("SELECT to_json(current_database()='smartlearning_dev' AND current_user='smartlearning_dev_owner' AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')); ") is True, 'Wrong/nonempty target')
        self.record('initialized')

    def sql(self, query):
        self.guard()
        return super().sql(query)

    def stop_owned(self):
        errors = []
        for resource in ('pg', 'helper'):
            if resource not in self.ids:
                continue
            try:
                self.guard()
                c = self.verify_container(self.ids[resource], resource == 'helper')
                if c['State'].get('Running'):
                    self.docker('stop', self.ids[resource])
                    require(not self.verify_container(self.ids[resource], resource == 'helper')['State'].get('Running'), 'Stop incomplete')
                self.record('stop', resource=resource, id=self.ids[resource], result='STOPPED')
            except BaseException:
                errors.append(resource + '-stop-blocked')
                try:
                    self.record('stop-blocked', resource=resource, result='BLOCKED')
                except BaseException:
                    errors.append('recording-blocked')
        return errors

    def execute(self, approval, expected_hash, exclusive=False):
        require(not self.used and approval == APPROVAL and exclusive is True and expected_hash == contract_hash(), 'Authorization/hash/exclusivity blocked')
        self.used = True
        self.digest = expected_hash
        result = {'status': 'BLOCKED', 'checks': []}
        errors = []
        try:
            try:
                self.evidence = Evidence(self.evidence_root, self.p['runId'], self.digest)
            except BaseException:
                self.recording_failed = True
                raise
            self.preflight()
            self.provision()
            result = m.diagnose(self.sql, self.migration_password, self.application_password)
            self.record('diagnostic', result=result['status'], checks=result['checks'])
        except BaseException as error:
            errors.append('lifecycle-blocked')
            classification = error.classification if isinstance(error, m.DiagnosticFailure) else 'UNKNOWN'
            if classification not in m.SQLSTATES | {'UNKNOWN', 'TRANSPORT_UNAVAILABLE', 'INVALID_RESULT'}:
                classification = 'UNKNOWN'
            result['classification'] = classification
            if self.evidence is not None:
                try:
                    self.record('blocked', classification=classification)
                except BaseException:
                    errors.append('recording-blocked')
        finally:
            if self.evidence is not None:
                errors.extend(self.stop_owned())
                if self.recording_failed:
                    errors.append('recording-blocked')
                try:
                    self.record('complete', result='BLOCKED' if errors else result['status'],
                                         errors=sorted(set(errors)), unresolvedCreates=list(self.unresolved),
                                         recordingFailed='recording-blocked' in errors)
                except BaseException:
                    errors.append('recording-blocked')
                try:
                    self.evidence.close()
                except BaseException:
                    errors.append('recording-blocked')
            if self.recording_failed:
                errors.append('recording-blocked')
            self.password = self.migration_password = self.application_password = None
        return {**result, 'status': 'BLOCKED' if errors else result['status'],
                'errors': sorted(set(errors)), 'unresolvedCreates': list(self.unresolved),
                'retained': True, 'recordingFailed': 'recording-blocked' in errors}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--approve')
    parser.add_argument('--contract-sha256')
    parser.add_argument('--exclusive', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        if args.approve or args.contract_sha256 or args.exclusive:
            parser.error('execution gates require --execute')
        print(json.dumps({'status': 'REVIEW_ONLY', 'runId': m.RUN, 'liveEnabled': True,
                          'contractSha256': contract_hash(), 'approval': APPROVAL}, sort_keys=True))
    else:
        try:
            outcome = Adapter().execute(args.approve, args.contract_sha256, args.exclusive)
        except Exception:
            outcome = {'status': 'BLOCKED', 'classification': 'UNKNOWN'}
        print(json.dumps(outcome, sort_keys=True))
        raise SystemExit(0 if outcome['status'] == 'SYNTHETIC_VERIFIED' else 1)
