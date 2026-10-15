#!/usr/bin/env python3
"""Authorized one-shot daily restore drill. No backup export or source writes."""
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
RUN = 'sl-daily-runtime-20261015-01'
EVIDENCE = ROOT / 'artifacts/local-env' / RUN


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools/dev' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Reuse audited pure helpers only; never invoke the historical lifecycle driver.
r = load('recovery_helpers', 'full-recovery.py')
d = load('daily_helpers', 'daily-backup.py')
r.RUN = RUN
r.EVIDENCE = EVIDENCE
r.CONTAINER = RUN + '-pg'
r.CONTINUATION = RUN + '-unused'
r.VOLUME = RUN + '-data'
r.NETWORK = RUN + '-net'
r.LABEL = 'smartlearning.checkpoint=' + RUN
need = r.need


def prepare_build():
    """Persistent source copy, local compile, no .env files or dependency traversal."""
    build = EVIDENCE / 'build'
    build.mkdir()
    names = []
    for folder in ['src', 'generated']:
        for p in sorted((ROOT / folder).rglob('*')):
            need(not p.is_symlink(), 'Source symlink rejected')
            if p.is_file():
                names.append(str(p.relative_to(ROOT)))
    names += ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'nest-cli.json']
    manifest = {}
    for name in names:
        dest = build / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, dest)
        manifest[name] = d.file_hash(ROOT / name)
        need(d.file_hash(dest) == manifest[name], 'Build source copy mismatch')
    (build / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    with (EVIDENCE / 'build.log').open('xb') as log:
        result = subprocess.run(['npm', 'run', 'build'], cwd=build, stdout=log, stderr=subprocess.STDOUT, timeout=180)
    need(result.returncode == 0, 'Persistent build failed; see bounded build.log')
    need((build / 'dist/src/main.js').is_file(), 'Compiled entry missing')
    need(not any(p.name.startswith('.env') for p in build.iterdir()), 'Build env file forbidden')
    r.record('build-receipt.json', {'snapshot': str(build), 'manifest': manifest,
        'buildExitCode': result.returncode, 'dependencies': 'existing root node_modules; no install',
        'secretContract': 'mode-0600 .env.test read only by runtime; sanitized explicit environment; restore-only URL'})


def main():
    started = time.monotonic()
    need(not EVIDENCE.exists(), 'One-shot evidence collision; no replay')
    EVIDENCE.mkdir(parents=True)
    owned = None
    status = 'BLOCKED'
    stage = 'daily-integrity'
    reason = None
    timings = {}
    cleanup = []
    try:
        d.mount_check()
        paths = sorted(p for p in d.DEST.iterdir() if d.RUN_RE.fullmatch(p.name))
        need(bool(paths), 'No formal daily generation')
        backup = paths[-1]  # Never silently fall back from a damaged newest generation.
        manifest_hash = d.file_hash(backup / 'success.json')
        manifest = d.verify_run(backup)
        d.acl(backup.name, 'Published')
        source = r.source_check()
        source_identity = r.identity(r.SOURCE_ID)
        need(manifest['engine'] == r.local.ENGINE and manifest['image'] == r.local.IMAGE
             and manifest['volume'] == r.local.VOLUME, 'Daily source contract mismatch')
        need(all(source_identity[k] == value for k, value in manifest['source'].items()), 'Daily source identity mismatch')
        original = json.loads((backup / 'source-manifest.json').read_text())
        need(set(original['databases']) == set(d.DATABASES)
             and original['snapshotUTC'] == manifest['snapshotUTC'], 'Snapshot baseline mismatch')
        ages = {}
        for db, stamp in manifest['snapshotUTC'].items():
            value = dt.datetime.fromisoformat(stamp)
            need(value.tzinfo is not None, 'Snapshot timezone missing')
            ages[db] = (dt.datetime.now(dt.timezone.utc) - value).total_seconds()
            need(ages[db] >= 0, 'Future snapshot rejected')
        r.record('daily-integrity.json', {'generation': backup.name, 'manifestSHA256': manifest_hash,
            'payloadsVerified': len(manifest['files']), 'acl': 'PASS', 'sourceIdentity': source_identity,
            'snapshotUTC': manifest['snapshotUTC'], 'snapshotAgeSecondsAtValidation': ages,
            'consistency': manifest['consistency'], 'sourceContainer': source['id']})
        for kind, name in [('container', r.CONTAINER), ('volume', r.VOLUME), ('network', r.NETWORK)]:
            names = r.docker(kind, 'ls', *(['-a'] if kind == 'container' else []), '--format', '{{.Names}}' if kind == 'container' else '{{.Name}}')
            need(name not in names.decode().splitlines(), 'Resource collision')
        r.free_port(55433)
        r.free_port(3001)
        stage = 'persistent-build'
        prepare_build()
        stage = 'fresh-restore'
        begin = time.monotonic()
        r.docker('network', 'create', '--label', r.LABEL, r.NETWORK)
        network = json.loads(r.docker('network', 'inspect', r.NETWORK))[0]
        need(network['Labels'].get('smartlearning.checkpoint') == RUN and network['Driver'] == 'bridge', 'Network ownership mismatch')
        gateway = network['IPAM']['Config'][0]['Gateway']
        import ipaddress
        ipaddress.IPv4Address(gateway)
        role = json.loads(subprocess.check_output(['node', '-e', "const fs=require('fs');const e=require('dotenv').parse(fs.readFileSync('.env.test'));console.log(JSON.stringify(decodeURIComponent(new URL(e.DATABASE_URL).username)))"], cwd=ROOT, timeout=10))
        need(re.fullmatch(r'[a-z_][a-z0-9_]*', role), 'App role rejected')
        r.docker('volume', 'create', '--label', r.LABEL, r.VOLUME)
        script = ('test -z "$(ls -A /var/lib/postgresql/data)"; '
            'initdb -D /var/lib/postgresql/data -U full_restore_admin --auth-local=trust --auth-host=reject >/tmp/initdb.log; '
            f"printf 'local all all trust\\nhost {r.DB} {role} {gateway}/32 trust\\n' > /var/lib/postgresql/data/pg_hba.conf; "
            f"exec postgres -D /var/lib/postgresql/data -c listen_addresses='*' -c unix_socket_directories=/tmp -c cluster_name={RUN}")
        owned = r.docker('create', '--name', r.CONTAINER, '--label', r.LABEL, '--network', r.NETWORK,
            '--restart', 'no', '--user', '999:999', '--entrypoint', 'bash', '-p', '127.0.0.1:55433:5432',
            '-v', r.VOLUME + ':/var/lib/postgresql/data', r.local.IMAGE, '-ceu', script).decode().strip()
        r.record('owned.json', {'id': owned, 'volume': r.VOLUME, 'network': r.NETWORK})
        r.metadata(owned)
        r.docker('start', owned)
        for _ in range(40):
            need(r.metadata(owned)['state'] == 'running', 'Restore exited before ready')
            p = subprocess.run(['docker', '--context', 'default', 'exec', owned, 'pg_isready', '-h', '/tmp', '-U', 'full_restore_admin'], capture_output=True, timeout=10)
            if p.returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError('Restore readiness timeout')
        r.restore(owned, ['psql', '-X', '-q', '-w', '-h', '/tmp', '-U', 'full_restore_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], backup / 'globals.sql')
        for db in d.DATABASES:
            listing = r.restore(owned, ['pg_restore', '--list'], backup / (db + '.dump'))
            d.validate_toc(listing, db)
            need(listing == (backup / (db + '.toc')).read_bytes(), 'Archive TOC changed')
            args = ['pg_restore', '-h', '/tmp', '-U', 'full_restore_admin', '-w', '--exit-on-error']
            args += ['--dbname', 'postgres'] if db == 'postgres' else ['--create', '--dbname', 'postgres']
            r.restore(owned, args, backup / (db + '.dump'))
            actual = r.legacy.inventory(owned, r.ADMIN, db)
            need(actual == original['databases'][db], 'Same-snapshot inventory mismatch: ' + db)
            need(not actual['sequences'], 'Sequences unsupported')
        props = next(x for x in original['properties'] if x['name'] == 'postgres')
        need(props['acl'] is None, 'Nondefault postgres ACL unsupported')
        r.dbsql(owned, 'postgres', 'ALTER DATABASE postgres OWNER TO ' + r.legacy.ident(props['owner']) + '; ALTER DATABASE postgres CONNECTION LIMIT ' + str(int(props['connection_limit'])) + ';')
        need(r.properties(owned) == original['properties'], 'Database properties mismatch')
        restored = r.identity(owned)
        need(restored['system'] != source_identity['system'] and restored['cluster'] == RUN
             and restored['database'] == r.DB and restored['role'] == r.ADMIN
             and restored['schema'] == 'public' and restored['recovery'] is False, 'Independent identity mismatch')
        d.verify_run(backup)
        need(d.file_hash(backup / 'success.json') == manifest_hash, 'Manifest changed')
        timings['restoreAndCompareSeconds'] = time.monotonic() - begin
        r.record('restore.json', {'equal': True, 'databasePropertiesEqual': True,
            'sourceIdentity': source_identity, 'restoreIdentity': restored,
            'tables': {db: len(x['tables']) for db, x in original['databases'].items()},
            'coverage': 'same exported snapshot data hashes/counts, structure, constraints, indexes, extensions, ACL; zero sequences and zero large objects required by inventory'})
        print('DAILY_SNAPSHOT_RESTORE_COMPARE_PASS', flush=True)
        stage = 'compiled-runtime'
        r.allow_forwarded_peer(owned)
        begin = time.monotonic()
        proc = subprocess.Popen(['node', 'tools/dev/daily-runtime.cjs'], cwd=ROOT,
            env={**os.environ, 'RESTORE_ID': owned}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            out, err = proc.communicate(timeout=120)
        except subprocess.TimeoutExpired:
            r.record('runtime.json', {'status': 'TIMEOUT', 'cleanup': 'driver SIGTERM requested'})
            raise RuntimeError('Runtime deadline exceeded; inspect cleanup evidence')
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.communicate(timeout=25)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
                    cleanup.append('runtime-cleanup-unconfirmed')
        safe = out.decode()
        r.record('runtime.json', {'exitCode': proc.returncode, 'output': safe, 'diagnostic': err.decode()[-1000:]})
        need(proc.returncode == 0 and 'COMPILED_READINESS_PASS' in safe and 'APP_CLEANUP_PASS' in safe, 'Compiled runtime verification failed')
        timings['runtimeIncludingCleanupSeconds'] = time.monotonic() - begin
        for line in safe.splitlines():
            if line.startswith('TIMING '):
                timings.update(json.loads(line[7:]))
        d.verify_run(backup)
        d.acl(backup.name, 'Published')
        need(d.file_hash(backup / 'success.json') == manifest_hash, 'Final manifest changed')
        status = 'PASS'
    except Exception as exc:
        reason = str(exc) if isinstance(exc, (RuntimeError, d.Blocked, r.local.Blocked)) else type(exc).__name__
        print('DAILY_RUNTIME_BLOCKED stage=' + stage + ' reason=' + reason, flush=True)
    finally:
        if owned:
            try:
                r.metadata(owned)
                r.docker('stop', '--time', '30', owned, timeout=45)
                need(r.metadata(owned)['state'] == 'exited', 'Restore stop failed')
            except Exception:
                cleanup.append('restore-stop-unconfirmed')
        try:
            r.source_check()
        except Exception:
            cleanup.append('source-health-unconfirmed')
        timings['totalSeconds'] = time.monotonic() - started
        result = {'status': status if not cleanup else 'BLOCKED', 'stage': stage, 'reason': reason,
            'cleanupFailures': cleanup, 'ownedContainer': owned, 'restoreStopped': bool(owned) and 'restore-stop-unconfirmed' not in cleanup,
            'sourceRetainedRunning': 'source-health-unconfirmed' not in cleanup, 'timings': timings, 'resourcesRetained': True}
        r.record('result.json', result)
        print(json.dumps(result), flush=True)
    return 0 if status == 'PASS' and not cleanup else 1


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--check-restore':
        obj = r.metadata(sys.argv[2])
        proof = r.identity(sys.argv[2])
        need(proof['cluster'] == RUN and not proof['recovery'], 'Restore cluster mismatch')
        print(json.dumps({'id': obj['id'], 'state': obj['state'], 'cluster': proof['cluster'], 'restart': obj['restart']}))
    elif len(sys.argv) == 1:
        sys.exit(main())
    else:
        raise SystemExit('Invalid arguments')
