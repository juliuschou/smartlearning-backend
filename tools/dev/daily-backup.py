#!/usr/bin/env python3
"""Retained-test backup only. Never starts services, restores, migrates or deletes."""
import argparse
import base64
import contextlib
import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import platform
import time
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DEST = Path('/mnt/d/Backups/SmartLearning/daily-v1')
ADMIN = 'sl_w3_e5560ea0'
DATABASES = ['postgres', 'smartlearning_test']
OWNER = 'smartlearning-daily-v1'
RUN_RE = re.compile(r'sl-daily-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}')


class Blocked(RuntimeError):
    pass


def need(ok, message):
    if not ok:
        raise Blocked(message)


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


local = load('daily_local', 'local-db.py')


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def fresh_id():
    return 'sl-daily-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]


def validate_id(run):
    need(bool(RUN_RE.fullmatch(run)), 'Invalid run ID')


def command(args, data=None, timeout=10, output=None):
    try:
        result = subprocess.run(args, input=data, stdout=output or subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        raise Blocked('Command unavailable or timed out') from None
    need(result.returncode == 0, 'Command failed (raw logs suppressed)')
    return result.stdout


def docker(*args, data=None, timeout=10, output=None):
    return command(['docker', '--context', 'default', *args], data, timeout, output)


def powershell(script):
    encoded = base64.b64encode(script.encode('utf-16le')).decode()
    return command(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], timeout=45)


def acl(run, action, required=2147483648):
    validate_id(run)
    script = (HERE / 'daily-backup-dir.ps1').read_text()
    result = powershell('& {\n' + script + '\n} -RunId ' + run + ' -Action ' + action
                        + ' -RequiredBytes ' + str(int(required)))
    need(b'DAILY_BACKUP_ACL_PASS' in result, 'Windows ACL verification failed')


def mount_check():
    result = json.loads(command(['findmnt', '-J', '-T', '/mnt/d', '-o', 'TARGET,FSTYPE,SOURCE']))
    mounts = result['filesystems']
    need(len(mounts) == 1 and mounts[0]['target'] == '/mnt/d'
         and mounts[0]['fstype'] in ('9p', 'drvfs')
         and mounts[0]['source'].lower().startswith('d:'), 'Refuse WSL fallback')
    for p in [Path('/mnt/d'), DEST.parent.parent, DEST.parent, DEST]:
        need(not p.is_symlink(), 'Symlink destination forbidden')


@contextlib.contextmanager
def lock():
    # All supported entry points, including Windows launcher via WSL, use this lock.
    # Permanent lock file avoids unlink/recreate races; locks release on process exit.
    fd = os.open(DEST / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Blocked('Another backup operation holds the lock') from None
        yield
    finally:
        os.close(fd)


def write_json(path, value):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def file_hash(path):
    need(path.is_file() and not path.is_symlink(), 'Invalid backup file')
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_run(path):
    validate_id(path.name)
    need(path.is_dir() and not path.is_symlink(), 'Invalid published directory')
    need((path / 'success.json').is_file() and not (path / 'success.json').is_symlink(), 'Invalid manifest file')
    manifest = json.loads((path / 'success.json').read_text())
    need(manifest['owner'] == OWNER and manifest['version'] == 1
         and manifest['run'] == path.name and manifest['status'] == 'backup-verified', 'Invalid manifest')
    expected = {'globals.sql', 'source-manifest.json', 'postgres.dump', 'postgres.toc',
                'smartlearning_test.dump', 'smartlearning_test.toc'}
    need(set(manifest['files']) == expected, 'Unexpected manifest files')
    need({p.name for p in path.iterdir()} == expected | {'success.json'}, 'Unexpected published entries')
    for name, entry in manifest['files'].items():
        file = path / name
        need(file.stat().st_size == entry['bytes'] and file_hash(file) == entry['sha256'], 'Backup hash mismatch')
    return manifest


def validate_toc(listing, db):
    need(b'Format: CUSTOM' in listing and b'Dumped from database version:' in listing, 'Invalid archive header')
    match = re.search(rb'^;\s+dbname:\s+([^\r\n]+)', listing, re.MULTILINE)
    need(match and match[1].decode().strip() == db, 'Archive database mismatch')


def publish(run):
    validate_id(run)
    # Directory.Move fails if destination exists; no overwrite even for an empty directory.
    root = 'D:/Backups/SmartLearning/daily-v1/'
    powershell("$ErrorActionPreference='Stop'; [System.IO.Directory]::Move('" + root + run
               + ".partial','" + root + run + "')")


def update_index(run):
    index_temp = DEST / (run + '.index.partial')
    write_json(index_temp, {'owner': OWNER, 'run': run, 'updatedUTC': utc()})
    need(not (DEST / 'last-success.json').is_symlink(), 'Index symlink forbidden')
    os.replace(index_temp, DEST / 'last-success.json')


class Source:
    def __init__(self):
        record = local.preflight()
        need(record and record['state'] == 'running' and record['health'] == 'healthy', 'Source unavailable')
        self.cid = record['id']
        self.tokens = {}
        self.inventory = load('daily_inventory', 'checkpoint-c.py')
        self.inventory.docker = self.inventory_docker

    def sql(self, db, query):
        return docker('exec', '-i', self.cid, 'psql', '-X', '-w', '-h', '/var/run/postgresql',
                      '-U', ADMIN, '-d', db, '-qAt', '-v', 'ON_ERROR_STOP=1',
                      data=("BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; " + query + '; COMMIT;').encode()).decode().strip()

    def identity(self):
        value = json.loads(self.sql(DATABASES[1], "SELECT json_build_object('database',current_database(),"
            "'role',current_user,'schema',current_schema(),'recovery',pg_is_in_recovery(),"
            "'system',(SELECT system_identifier::text FROM pg_control_system()))"))
        need(value['database'] == DATABASES[1] and value['role'] == ADMIN
             and value['schema'] == 'public' and value['recovery'] is False, 'Source SQL identity mismatch')
        need(json.loads(self.sql('postgres', 'SELECT json_agg(datname ORDER BY datname) FROM pg_database WHERE NOT datistemplate'))
             == DATABASES, 'Unexpected database scope')
        need(self.sql('postgres', "SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')") == '0',
             'Custom tablespaces unsupported')
        return value

    def versions(self):
        return {'python': platform.python_version(), 'pgDump': docker('exec', self.cid, 'pg_dump', '--version').decode().strip(),
                'pgRestore': docker('exec', self.cid, 'pg_restore', '--version').decode().strip()}

    def properties(self):
        return json.loads(self.sql('postgres', "SELECT json_agg(x ORDER BY name) FROM (SELECT datname AS name,"
            "pg_get_userbyid(datdba) AS owner,pg_encoding_to_char(encoding) AS encoding,datcollate AS collate,"
            "datctype AS ctype,datacl::text AS acl,datconnlimit AS connection_limit FROM pg_database WHERE NOT datistemplate) x"))

    def inventory_docker(self, *args, data=None, timeout=90):
        # Reuse only the SQL inventory, never its historical run/lifecycle.
        args = ['/var/run/postgresql' if a == '/tmp' else a for a in args]
        db = args[args.index('-d') + 1]
        token = self.tokens[db]
        data = (f"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '{token}';\n".encode()
                + data + b'\nCOMMIT;\n')
        return docker(*args, data=data, timeout=timeout)

    @contextlib.contextmanager
    def snapshot(self, db):
        proc = subprocess.Popen(['docker', '--context', 'default', 'exec', '-i', self.cid,
            'psql', '-X', '-w', '-h', '/var/run/postgresql', '-U', ADMIN, '-d', db,
            '-qAt', '-v', 'ON_ERROR_STOP=1'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, bufsize=0)
        try:
            proc.stdin.write(b"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET statement_timeout='5s'; SET idle_in_transaction_session_timeout='300s'; SELECT pg_export_snapshot();\n")
            need(bool(select.select([proc.stdout], [], [], 10)[0]), 'Snapshot exporter timeout')
            token = proc.stdout.readline().decode().strip()
            need(bool(re.fullmatch(r'[0-9A-F]{8}-[0-9A-F]{8}-[0-9]+', token)), 'Invalid snapshot')
            self.tokens[db] = token
            yield token
            need(proc.poll() is None, 'Snapshot exporter expired')
        finally:
            self.tokens.pop(db, None)
            try:
                proc.communicate(b'ROLLBACK;\n', timeout=5)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=5)
                proc.stdin.close()
                proc.stdout.close()

    def export(self, path, args):
        with path.open('xb') as stream:
            # Remote bound remains effective if Docker client is interrupted.
            docker('exec', self.cid, 'timeout', '-k', '5s', '240s', *args, output=stream, timeout=250)
            stream.flush()
            os.fsync(stream.fileno())
        need(path.stat().st_size > 0, 'Empty export')

    def backup(self, directory):
        self.export(directory / 'globals.sql', ['pg_dumpall', '-h', '/var/run/postgresql',
                    '-U', ADMIN, '-w', '--globals-only', '--no-role-passwords'])
        inventory = {}
        snapshots = {}
        for db in DATABASES:
            with self.snapshot(db) as token:
                snapshots[db] = utc()
                # Sequences are not MVCC; block until a coherent policy is implemented.
                need(self.sql(db, "SELECT count(*) FROM pg_class WHERE relkind='S'") == '0', 'Sequences need expanded coverage')
                inventory[db] = self.inventory.inventory(self.cid, ADMIN, db)
                need(not inventory[db]['sequences'], 'Sequences need expanded coverage')
                self.export(directory / (db + '.dump'), ['pg_dump', '-h', '/var/run/postgresql',
                    '-U', ADMIN, '-w', '-Fc', '--create', '--lock-wait-timeout=5s', '--snapshot=' + token, '--dbname', db])
                with (directory / (db + '.dump')).open('rb') as stream:
                    # Parse without restoring. A valid empty postgres TOC is allowed.
                    result = subprocess.run(['docker', '--context', 'default', 'exec', '-i', self.cid,
                        'timeout', '-k', '5s', '30s', 'pg_restore', '--list'], stdin=stream,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40)
                need(result.returncode == 0, 'Archive cannot be parsed')
                listing = result.stdout
                validate_toc(listing, db)
                with (directory / (db + '.toc')).open('xb') as out:
                    out.write(listing)
                    out.flush()
                    os.fsync(out.fileno())
        write_json(directory / 'source-manifest.json', {'databases': inventory,
                   'properties': self.properties(), 'snapshotUTC': snapshots})
        return snapshots


def required_space(source):
    size = int(source.sql('postgres', 'SELECT sum(pg_database_size(oid)) FROM pg_database'))
    recent_size = 0
    # Only the index-selected verified generation is consulted during a run.
    index = DEST / 'last-success.json'
    if index.exists():
        need(not index.is_symlink(), 'Index symlink forbidden')
        value = json.loads(index.read_text())
        validate_id(value['run'])
        previous = verify_run(DEST / value['run'])
        recent_size = sum(item['bytes'] for item in previous['files'].values())
    return max(2147483648, size * 3, recent_size * 3)


def run_backup(run, source_factory=Source, safe_failure=False):
    validate_id(run)
    started = utc()
    begin = time.monotonic()
    stage = 'destination'
    published = False
    try:
        mount_check()
        acl(run, 'Root')
        with lock():
            directory = DEST / (run + '.partial')
            need(not directory.exists() and not (DEST / run).exists(), 'Run ID collision')
            if safe_failure:
                index = DEST / 'last-success.json'
                previous_index = file_hash(index) if index.exists() else None
                return {'status': 'FAIL', 'run': run, 'stage': stage, 'published': False,
                        'reason': 'Intentional safe preflight rejection; source not accessed',
                        'lastSuccessUnchanged': previous_index == (file_hash(index) if index.exists() else None),
                        'sourceAccessed': False, 'elapsedSeconds': round(time.monotonic() - begin, 3)}
            stage = 'source-preflight'
            source = source_factory()
            identity = source.identity()
            required = required_space(source)
            stage = 'acl-create'
            acl(run, 'Create', required)
            versions = source.versions()
            stage = 'export'
            snapshots = source.backup(directory)
            need(source.identity() == identity, 'Source identity changed')
            files = {p.name: {'bytes': p.stat().st_size, 'sha256': file_hash(p)} for p in directory.iterdir()}
            write_json(directory / 'success.json', {'version': 1, 'owner': OWNER, 'run': run,
                'status': 'backup-verified', 'restoreVerified': False, 'startedUTC': started, 'versions': versions,
                'completedUTC': utc(), 'snapshotUTC': snapshots, 'source': identity,
                'engine': local.ENGINE, 'image': local.IMAGE, 'volume': local.VOLUME,
                'consistency': 'per-database snapshot; not cluster-wide',
                'toolSHA256': {p.name: file_hash(p) for p in [Path(__file__), HERE / 'daily-backup-dir.ps1',
                    HERE / 'local-db.py', HERE / 'checkpoint-c.py']}, 'files': files})
            stage = 'validation'
            acl(run, 'Verify', required)
            # Same validation as consumers, while still in the unpublished directory.
            verify_partial(directory, run)
            stage = 'publish'
            publish(run)
            published = True
            acl(run, 'Published', required)
            verify_run(DEST / run)
            stage = 'index'
            update_index(run)
        return {'status': 'PASS', 'run': run, 'published': True, 'backupVerified': True,
                'restoreVerified': False, 'elapsedSeconds': round(time.monotonic() - begin, 3)}
    except Exception as error:
        # No raw child logs, payloads, paths or arbitrary exception strings.
        reason = str(error) if isinstance(error, (Blocked, local.Blocked)) else type(error).__name__
        result = {'status': 'FAIL', 'run': run, 'stage': stage, 'published': published,
                  'reason': reason, 'elapsedSeconds': round(time.monotonic() - begin, 3)}
        return result


def verify_partial(path, run):
    # Reuse exact published validation without renaming a directory prematurely.
    need((path / 'success.json').is_file() and not (path / 'success.json').is_symlink(), 'Invalid manifest file')
    manifest = json.loads((path / 'success.json').read_text())
    need(manifest['owner'] == OWNER and manifest['run'] == run, 'Partial manifest mismatch')
    expected = {'globals.sql', 'source-manifest.json', 'postgres.dump', 'postgres.toc',
                'smartlearning_test.dump', 'smartlearning_test.toc'}
    need(set(manifest['files']) == expected and {p.name for p in path.iterdir()} == expected | {'success.json'},
         'Partial inventory mismatch')
    for name, entry in manifest['files'].items():
        need((path / name).stat().st_size == entry['bytes'] and file_hash(path / name) == entry['sha256'], 'Partial hash mismatch')


def status():
    mount_check()
    manifests = []
    for path in sorted(DEST.iterdir()):
        if RUN_RE.fullmatch(path.name):
            acl(path.name, 'Published', 0)
            manifests.append(verify_run(path))
    need(bool(manifests), 'No verified published generations')
    # The success index is only a cache; scan recovers publication-before-index crashes.
    latest = max(manifests, key=lambda m: min(m['snapshotUTC'].values()))
    snapshot = min(dt.datetime.fromisoformat(t) for t in latest['snapshotUTC'].values())
    age = (dt.datetime.now(dt.timezone.utc) - snapshot).total_seconds()
    return {'status': 'PASS', 'run': latest['run'], 'generations': len(manifests),
            'ageHours': round(age / 3600, 3), 'stale': age > 86400,
            'backupVerified': True, 'restoreVerified': False, 'secondCopy': 'not-configured'}


def deadline(signum, frame):
    raise Blocked('Overall 15-minute deadline exceeded')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['review', 'run', 'status', 'retention'], nargs='?', default='review')
    parser.add_argument('--run-id')
    parser.add_argument('--safe-preflight-failure', action='store_true', help='Fail before any source access')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(900)
    try:
        if args.action == 'review':
            result = {'status': 'REVIEW', 'scope': 'retained-test backup only', 'destination': str(DEST),
                      'nextRunId': fresh_id(), 'scheduler': 'not-installed', 'retention': 'no deletions implemented'}
        elif args.action == 'run':
            run = args.run_id or fresh_id()
            validate_id(run)
            evidence = ROOT / 'artifacts/local-env' / run
            evidence.mkdir(parents=True, exist_ok=False)
            write_json(evidence / 'scope.json', {'run': run, 'startedUTC': utc(), 'destination': str(DEST / run),
                       'safePreflightFailure': args.safe_preflight_failure, 'timeoutSeconds': 900})
            result = run_backup(run, safe_failure=args.safe_preflight_failure)
            write_json(evidence / 'result.json', result)
        elif args.action == 'status':
            mount_check()
            acl(fresh_id(), 'Root')
            with lock():
                result = status()
        else:
            need(args.dry_run, 'Retention is dry-run only')
            mount_check()
            acl(fresh_id(), 'Root')
            with lock():
                manifests = []
                for path in sorted(DEST.iterdir()):
                    if RUN_RE.fullmatch(path.name):
                        acl(path.name, 'Published', 0)
                        manifests.append(verify_run(path))
                policy = load('daily_retention', 'daily-retention.py')
                result = policy.select(manifests, DEST, dt.datetime.now(dt.timezone.utc))
    except Exception as error:
        result = {'status': 'FAIL', 'reason': str(error) if isinstance(error, Blocked) else type(error).__name__}
    finally:
        signal.alarm(0)
    print(json.dumps(result))
    return 0 if result['status'] in ('PASS', 'REVIEW') else 1


if __name__ == '__main__':
    sys.exit(main())
