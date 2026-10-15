#!/usr/bin/env python3
"""Single authorized fresh backup/restore/runtime run; retain all created resources."""
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import select
import signal
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
RUN = 'sl-full-recovery-20261015-01'
BACKUP = Path('/mnt/d/Backups/SmartLearning') / RUN
EVIDENCE = ROOT / 'artifacts/local-env' / RUN
CONTAINER = RUN + '-pg'
CONTINUATION = RUN + '-resume-pg'
VOLUME = RUN + '-data'
NETWORK = RUN + '-net'
SOURCE_ID = 'd053acc4d005b7484ca06dfe5b2d73a7908265e8c9edb580638c99eb26601c4d'
ADMIN = 'sl_w3_e5560ea0'
DB = 'smartlearning_test'
LABEL = 'smartlearning.checkpoint=' + RUN


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


local = load('local_db', ROOT / 'tools/dev/local-db.py')
legacy = load('inventory', ROOT / 'tools/dev/checkpoint-c.py')
SNAPSHOTS = {}
STAGE = 'preflight'


def need(ok, message):
    if not ok:
        raise RuntimeError(message)


def docker(*args, data=None, timeout=60):
    result = subprocess.run(['docker', '--context', 'default', *args], input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    need(result.returncode == 0, 'Docker operation failed: ' + args[0])
    return result.stdout


def record(name, value):
    (EVIDENCE / name).write_text(json.dumps(value, indent=2) + '\n')


def source_check():
    source = local.preflight()
    need(source['id'] == SOURCE_ID and source['state'] == 'running'
         and source['health'] == 'healthy', 'Source identity/health mismatch')
    return source


def metadata(cid):
    obj = local.inspect(cid)
    need(obj['id'] == cid and obj['name'] in ['/' + CONTAINER, '/' + CONTINUATION]
         and obj['image'] == local.IMAGE and obj['labels'].get('smartlearning.checkpoint') == RUN,
         'Restore ownership mismatch')
    need(obj['restart'] == 'no' and not obj['privileged'] and obj['user'] == '999:999',
         'Restore execution drift')
    need(len(obj['mounts']) == 1 and obj['mounts'][0]['Name'] == VOLUME
         and obj['mounts'][0]['Type'] == 'volume' and obj['mounts'][0]['RW']
         and obj['mounts'][0]['Destination'] == '/var/lib/postgresql/data', 'Restore mount drift')
    need(obj['ports'] == {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '55433'}]}
         and obj['network'] == NETWORK, 'Restore target drift')
    consumers = docker('ps', '--no-trunc', '--filter', 'volume=' + VOLUME,
                       '--format', '{{.ID}}').decode().splitlines()
    need(all(item == cid for item in consumers), 'Unexpected restore volume consumer')
    volume = json.loads(docker('volume', 'inspect', VOLUME))[0]
    need(volume['Driver'] == 'local' and not volume.get('Options')
         and volume['Labels'].get('smartlearning.checkpoint') == RUN, 'Restore volume ownership drift')
    return obj


def acl(verify=False):
    # Exact destination is encoded in reviewed PowerShell; no caller-controlled path.
    script = (ROOT / 'tools/dev/full-recovery-backup-dir.ps1').read_text()
    encoded = __import__('base64').b64encode(
        ('& {\n' + script + '\n}' + (' -VerifyOnly' if verify else '')).encode('utf-16le')).decode()
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
                            capture_output=True, timeout=45)
    need(result.returncode == 0 and b'BACKUP_DIRECTORY_ACL_PASS' in result.stdout,
         'Windows backup ACL/space check failed')


def mount_check():
    result = subprocess.run(['findmnt', '-J', '-T', '/mnt/d', '-o', 'TARGET,FSTYPE,SOURCE'],
                            capture_output=True, timeout=10)
    need(result.returncode == 0, 'Windows D mount unavailable')
    mounts = json.loads(result.stdout)['filesystems']
    need(len(mounts) == 1 and mounts[0]['target'] == '/mnt/d'
         and mounts[0]['fstype'] in ('9p', 'drvfs')
         and mounts[0]['source'].lower().startswith('d:'), 'Refuse WSL backup fallback')
    need(not BACKUP.exists(), 'Backup destination collision')
    need(not any(p.is_symlink() for p in [BACKUP.parent, BACKUP.parent.parent, Path('/mnt/d')]),
         'Backup parent symlink forbidden')


def dbsql(cid, db, query):
    host = '/var/run/postgresql' if cid == SOURCE_ID else '/tmp'
    return docker('exec', '-i', cid, 'psql', '-X', '-w', '-h', host, '-U', ADMIN,
                  '-d', db, '-qAt', '-v', 'ON_ERROR_STOP=1', data=query.encode()).decode().strip()


def properties(cid):
    return json.loads(dbsql(cid, 'postgres', "SELECT json_agg(x ORDER BY name) FROM ("
        "SELECT datname AS name,pg_get_userbyid(datdba) AS owner,pg_encoding_to_char(encoding) AS encoding,"
        "datcollate AS collate,datctype AS ctype,datacl::text AS acl,datconnlimit AS connection_limit "
        "FROM pg_database WHERE NOT datistemplate) x;"))


def identity(cid):
    return json.loads(dbsql(cid, DB, "BEGIN READ ONLY; SELECT json_build_object("
        "'database',current_database(),'role',current_user,'system',"
        "(SELECT system_identifier::text FROM pg_control_system()),'recovery',pg_is_in_recovery(),"
        "'cluster',current_setting('cluster_name'),'schema',current_schema()); COMMIT;"))


def snapshot(cid, db):
    proc = subprocess.Popen(['docker', '--context', 'default', 'exec', '-i', cid,
        'psql', '-X', '-w', '-h', '/var/run/postgresql', '-U', ADMIN, '-d', db,
        '-qAt', '-v', 'ON_ERROR_STOP=1'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, bufsize=0)
    proc.stdin.write(b"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET statement_timeout='60s'; SET idle_in_transaction_session_timeout='300s'; SELECT pg_export_snapshot();\n")
    ready, _, _ = select.select([proc.stdout], [], [], 15)
    if not ready:
        proc.terminate()
        proc.wait(timeout=10)
        raise RuntimeError('Snapshot exporter timeout')
    token = proc.stdout.readline().decode().strip()
    if not re.fullmatch(r'[0-9A-F]{8}-[0-9A-F]{8}-[0-9]+', token):
        proc.terminate()
        raise RuntimeError('Snapshot export failed')
    return proc, token


def inventory_docker(*args, data=None, timeout=60):
    args = list(args)
    if len(args) > 2 and args[0] == 'exec' and SOURCE_ID in args:
        # C's pure SQL inventory uses /tmp; current source uses stock socket path.
        args = ['/var/run/postgresql' if x == '/tmp' else x for x in args]
        if data and SNAPSHOTS:
            database = args[args.index('-d') + 1]
            token = SNAPSHOTS.get(database)
            if token:
                data = (f"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '{token}';\n".encode()
                        + data + b'\nCOMMIT;\n')
    return docker(*args, data=data, timeout=timeout)


legacy.docker = inventory_docker


def write_export(args, destination):
    need(not destination.exists(), 'Backup collision')
    with destination.open('xb') as stream:
        proc = subprocess.run(['docker', '--context', 'default', 'exec', SOURCE_ID, *args],
                              stdout=stream, stderr=subprocess.PIPE, timeout=240)
    need(proc.returncode == 0 and destination.stat().st_size > 0, 'Backup export failed')


def restore(cid, args, source):
    with source.open('rb') as stream:
        proc = subprocess.run(['docker', '--context', 'default', 'exec', '-i', cid, *args],
                              stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=240)
    need(proc.returncode == 0, 'Restore operation failed: ' + args[0])
    return proc.stdout


def backup_hashes():
    hashes = {}
    for path in sorted(BACKUP.iterdir()):
        need(path.is_file() and not path.is_symlink(), 'Unexpected backup entry')
        if path.name != 'sha256.json':
            with path.open('rb') as stream:
                hashes[path.name] = hashlib.file_digest(stream, 'sha256').hexdigest()
    return hashes


def check_build():
    receipt = json.loads(Path('/tmp/smartlearning-current-build.json').read_text())
    build = Path(receipt['snapshot'])
    need(str(build).startswith('/tmp/smartlearning-start-prod-verify-'), 'Unexpected build path')
    for name, expected in receipt['manifest'].items():
        for base in [ROOT, build]:
            need(hashlib.sha256((base / name).read_bytes()).hexdigest() == expected, 'Stale build')
    need((build / 'dist/src/main.js').is_file(), 'Compiled entry missing')
    need(not any(p.name.startswith('.env') for p in build.iterdir()), 'Snapshot contains env files')
    return len(receipt['manifest'])


def free_port(port):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', port))


def validate_toc(listing):
    need(re.search(rb';\s+Format: CUSTOM', listing) and re.search(rb';\s+Dumped from database version:', listing),
         'Invalid custom dump archive header')


def run(resume=False):
    global STAGE
    started = time.monotonic()
    timings = {}
    owned = None
    status = 'BLOCKED'
    reason = None
    source_check()
    check_build()
    free_port(55433)
    free_port(3001)
    if resume:
        previous = json.loads((EVIDENCE / 'result.json').read_text())
        need(previous['status'] == 'BLOCKED' and previous['stage'] == 'restore-create'
             and previous['reason'] == 'Resume restore exited' and not previous['cleanupFailures']
             and previous['restoreStopped'], 'Resume state mismatch')
        owned = previous['ownedContainer']
        need(metadata(owned)['state'] == 'exited', 'Resume restore must be stopped')
        hashes = json.loads((BACKUP / 'sha256.json').read_text())
        need(backup_hashes() == hashes, 'Resume backup hashes changed')
        acl(True)
        record('attempt-2.json', previous)
        first = json.loads((EVIDENCE / 'attempt-1.json').read_text())
        need(first['reason'] == 'Dump TOC lacks database' and first['ownedContainer'] == owned, 'Original resume provenance mismatch')
    else:
        mount_check()
        need(not EVIDENCE.exists(), 'Evidence collision')
    for kind, name in [('container', CONTAINER), ('volume', VOLUME), ('network', NETWORK)]:
        names = docker(kind, 'ls', '-a', '--format', '{{.Names}}') if kind == 'container' else docker(kind, 'ls', '--format', '{{.Name}}')
        need(resume or name not in names.decode().splitlines(), 'Resource collision')
    EVIDENCE.mkdir(parents=True, exist_ok=resume)
    try:
        if not resume:
            STAGE = 'backup-acl'
            acl()
            need(BACKUP.is_dir() and not list(BACKUP.iterdir()), 'Protected empty directory required')
            record('scope.json', {'run': RUN, 'source': SOURCE_ID, 'engine': local.ENGINE,
                'image': local.IMAGE, 'backup': str(BACKUP), 'container': CONTAINER,
                'volume': VOLUME, 'network': NETWORK, 'port': 55433,
                'sourceHashes': check_build(), 'startedUTC': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
            STAGE = 'source-identity'
            source_identity = identity(SOURCE_ID)
            need(source_identity['database'] == DB and source_identity['role'] == ADMIN
                 and source_identity['schema'] == 'public' and not source_identity['recovery'], 'Source SQL identity mismatch')
            databases = json.loads(dbsql(SOURCE_ID, 'postgres', "SELECT json_agg(datname ORDER BY datname) FROM pg_database WHERE NOT datistemplate;"))
            need(databases == ['postgres', DB], 'Unexpected database scope')
            db_properties = properties(SOURCE_ID)
            need(dbsql(SOURCE_ID, 'postgres', "SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global');") == '0', 'Custom tablespaces unsupported')
            size = int(dbsql(SOURCE_ID, DB, 'SELECT sum(pg_database_size(oid)) FROM pg_database;'))
            need(os.statvfs(BACKUP).f_bavail * os.statvfs(BACKUP).f_frsize > max(size * 4, 2147483648), 'Backup space insufficient')
            STAGE = 'backup'
            begin = time.monotonic()
            original = {}
            write_export(['pg_dumpall', '-h', '/var/run/postgresql', '-U', ADMIN, '-w',
                          '--globals-only', '--no-role-passwords'], BACKUP / 'globals.sql')
            for database in databases:
                holder, token = snapshot(SOURCE_ID, database)
                SNAPSHOTS[database] = token
                try:
                    original[database] = legacy.inventory(SOURCE_ID, ADMIN, database)
                    write_export(['pg_dump', '-h', '/var/run/postgresql', '-U', ADMIN, '-w',
                        '-Fc', '--create', '--snapshot=' + token, '--dbname', database], BACKUP / (database + '.dump'))
                    need(holder.poll() is None, 'Snapshot exporter exited early')
                    # Sequences are non-MVCC: reject any change rather than compare unrelated times.
                    for seq in original[database]['sequences']:
                        value = json.loads(dbsql(SOURCE_ID, database,
                            'SELECT row_to_json(x) FROM (SELECT last_value,is_called FROM '
                            + legacy.ident(seq['schema']) + '.' + legacy.ident(seq['name']) + ') x;'))
                        need(value == {k: seq[k] for k in ['last_value', 'is_called']}, 'Sequence changed during backup')
                finally:
                    SNAPSHOTS.pop(database, None)
                    holder.stdin.close()
                    try:
                        holder.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        holder.terminate()
                        holder.wait(timeout=10)
            timings['backupSeconds'] = time.monotonic() - begin
            # Detailed object metadata stays with sensitive backup; repo retains digests/counts only.
            (BACKUP / 'source-manifest.json').write_text(json.dumps(original, sort_keys=True))
            hashes = backup_hashes()
            (BACKUP / 'sha256.json').write_text(json.dumps(hashes, indent=2) + '\n')
            need(backup_hashes() == hashes, 'Backup hash verification failed')
            acl(True)
            record('backup.json', {'hashes': hashes, 'rolePasswords': 'excluded', 'acl': 'PASS', 'snapshotPerDatabase': True})
            print('FRESH_EXTERNAL_BACKUP_PASS', flush=True)
        else:
            original = json.loads((BACKUP / 'source-manifest.json').read_text())
            databases = sorted(original)
            source_identity = json.loads((EVIDENCE / 'restore-source-identity.json').read_text()) if (EVIDENCE / 'restore-source-identity.json').exists() else identity(SOURCE_ID)
            db_properties = properties(SOURCE_ID)
            timings.update(previous['timings'])
            need(source_identity['database'] == DB and not source_identity['recovery'], 'Resume source proof failed')
        initial_hashes = hashes.copy()
        record('restore-source-identity.json', source_identity)
        STAGE = 'restore-create'
        begin = time.monotonic()
        source_check()
        if not resume:
            docker('network', 'create', '--label', LABEL, NETWORK)
            network = json.loads(docker('network', 'inspect', NETWORK))[0]
            need(network['Labels'].get('smartlearning.checkpoint') == RUN and network['Driver'] == 'bridge', 'Network ownership mismatch')
            gateway = network['IPAM']['Config'][0]['Gateway']
            need(re.fullmatch(r'\d+\.\d+\.\d+\.\d+', gateway), 'Invalid gateway')
            app_role = json.loads(subprocess.check_output(['node', '-e',
                "const fs=require('fs'); const d=require('dotenv').parse(fs.readFileSync('.env.test')); console.log(JSON.stringify(decodeURIComponent(new URL(d.DATABASE_URL).username)));"], cwd=ROOT, timeout=10))
            need(re.fullmatch(r'[a-z_][a-z0-9_]*', app_role), 'Invalid app role')
            docker('volume', 'create', '--label', LABEL, VOLUME)
            volume = json.loads(docker('volume', 'inspect', VOLUME))[0]
            need(volume['Labels'].get('smartlearning.checkpoint') == RUN and volume['Driver'] == 'local'
                 and not volume.get('Options'), 'New volume ownership mismatch')
            # Image entrypoint handles ownership of this brand-new volume, then initdb as postgres.
            # No environment secrets or password changes; restored roles are password-free.
            script = "test -z \"$(ls -A /var/lib/postgresql/data)\"; " \
                "initdb -D /var/lib/postgresql/data -U full_restore_admin --auth-local=trust --auth-host=reject >/tmp/initdb.log; " \
                f"printf 'local all all trust\\nhost {DB} {app_role} {gateway}/32 trust\\n' > /var/lib/postgresql/data/pg_hba.conf; " \
                f"exec postgres -D /var/lib/postgresql/data -c listen_addresses='*' -c unix_socket_directories=/tmp -c cluster_name={RUN}"
            # Run as postgres; Docker's fresh named-volume copy-up supplies image-owned PGDATA (999:999).
            cid = docker('create', '--name', CONTAINER, '--label', LABEL, '--network', NETWORK,
                '--restart', 'no', '--user', '999:999', '--entrypoint', 'bash',
                '-p', '127.0.0.1:55433:5432', '-v', VOLUME + ':/var/lib/postgresql/data',
                local.IMAGE, '-ceu', script).decode().strip()
            owned = cid
            metadata(cid)
            docker('start', cid)
            for _ in range(40):
                need(metadata(cid)['state'] == 'running', 'Restore PostgreSQL exited before ready')
                result = subprocess.run(['docker', '--context', 'default', 'exec', cid, 'pg_isready', '-h', '/tmp', '-U', 'full_restore_admin'], capture_output=True, timeout=10)
                if result.returncode == 0:
                    break
                time.sleep(.5)
            else:
                raise RuntimeError('Restore PostgreSQL readiness timeout')
        else:
            # Original one-shot init container is preserved stopped; use a fresh direct-server
            # container, with no initialization or overlapping volume writer.
            need(metadata(owned)['state'] == 'exited', 'Original restore not stopped')
            need(not docker('ps', '--filter', 'volume=' + VOLUME, '--format', '{{.ID}}').strip(), 'Restore volume has running consumer')
            need(CONTINUATION not in docker('ps', '-a', '--format', '{{.Names}}').decode().splitlines(), 'Continuation collision')
            cid = docker('create', '--name', CONTINUATION, '--label', LABEL, '--network', NETWORK,
                '--restart', 'no', '--user', '999:999', '--entrypoint', 'postgres',
                '-p', '127.0.0.1:55433:5432', '-v', VOLUME + ':/var/lib/postgresql/data',
                local.IMAGE, '-D', '/var/lib/postgresql/data', '-c', "listen_addresses=*",
                '-c', 'unix_socket_directories=/tmp', '-c', 'cluster_name=' + RUN).decode().strip()
            owned = cid
            metadata(cid)
            docker('start', cid)
            for _ in range(40):
                need(metadata(cid)['state'] == 'running', 'Resume restore exited')
                result = subprocess.run(['docker', '--context', 'default', 'exec', cid, 'pg_isready', '-h', '/tmp', '-U', 'full_restore_admin'], capture_output=True, timeout=10)
                if result.returncode == 0:
                    break
                time.sleep(.5)
            else:
                raise RuntimeError('Resume readiness timeout')
        STAGE = 'restore'
        if not resume:
            restore(cid, ['psql', '-X', '-q', '-w', '-h', '/tmp', '-U', 'full_restore_admin',
                          '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], BACKUP / 'globals.sql')
        actual = {}
        for database in databases:
            dump = BACKUP / (database + '.dump')
            listing = restore(cid, ['pg_restore', '--list'], dump)
            validate_toc(listing)
            (BACKUP / (database + '.toc')).write_bytes(listing)
            # Restore postgres objects into initdb's empty postgres without dropping any database.
            args = ['pg_restore', '-h', '/tmp', '-U', 'full_restore_admin', '-w', '--exit-on-error']
            args += ['--dbname', 'postgres'] if database == 'postgres' else ['--create', '--dbname', 'postgres']
            restore(cid, args, dump)
            actual[database] = legacy.inventory(cid, ADMIN, database)
            need(actual[database] == original[database], 'Restored inventory mismatch: ' + database)
        # postgres already existed from initdb; retain it and restore its owner/limit without deletion.
        postgres_props = next(item for item in db_properties if item['name'] == 'postgres')
        need(postgres_props['acl'] is None, 'Nondefault postgres database ACL requires expanded restore')
        docker('exec', '-i', cid, 'psql', '-X', '-q', '-h', '/tmp', '-U', 'full_restore_admin',
               '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', data=(
                   'ALTER DATABASE postgres OWNER TO ' + legacy.ident(postgres_props['owner']) + '; '
                   'ALTER DATABASE postgres CONNECTION LIMIT ' + str(postgres_props['connection_limit']) + ';').encode())
        need(properties(cid) == db_properties, 'Restored database properties mismatch')
        restored_identity = identity(cid)
        need(restored_identity['system'] != source_identity['system'] and restored_identity['cluster'] == RUN
             and restored_identity['schema'] == 'public' and not restored_identity['recovery'], 'Independent restore identity failed')
        (BACKUP / 'restore-manifest.json').write_text(json.dumps(actual, sort_keys=True))
        hashes = backup_hashes()
        need(all(hashes.get(name) == value for name, value in initial_hashes.items()), 'Backup changed during restore')
        (BACKUP / 'sha256.json').write_text(json.dumps(hashes, indent=2) + '\n')
        need(backup_hashes() == hashes, 'Final backup hash check failed')
        acl(True)
        timings['restoreAndCompareSeconds'] = time.monotonic() - begin
        record('restore.json', {'sourceIdentity': source_identity, 'restoreIdentity': restored_identity,
            'equal': True, 'databasePropertiesEqual': True, 'databaseDigests': {db: hashlib.sha256(json.dumps(original[db], sort_keys=True).encode()).hexdigest() for db in databases},
            'tables': {db: len(original[db]['tables']) for db in databases},
            'sequences': {db: len(original[db]['sequences']) for db in databases}, 'backupHashes': hashes})
        print('INDEPENDENT_RESTORE_SQL_PASS', flush=True)
        STAGE = 'compiled-runtime'
        begin = time.monotonic()
        allow_forwarded_peer(cid)
        runtime = subprocess.Popen(['node', 'tools/dev/full-recovery-runtime.cjs'], cwd=ROOT,
            env={**os.environ, 'RESTORE_ID': cid}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            stdout, stderr = runtime.communicate(timeout=120)
        except subprocess.TimeoutExpired:
            runtime.terminate()
            stdout, stderr = runtime.communicate(timeout=20)
            raise RuntimeError('Runtime timed out; cleanup signal sent to driver')
        finally:
            if runtime.poll() is None:
                runtime.terminate()
                runtime.communicate(timeout=20)
        safe = stdout.decode()
        # Runtime prints only selected metadata, readiness JSON and fixed markers; never child logs.
        record('runtime.json', {'exitCode': runtime.returncode, 'output': safe,
                               'diagnostic': stderr.decode()[-1000:]})
        need(runtime.returncode == 0 and 'COMPILED_READINESS_PASS' in safe and 'APP_CLEANUP_PASS' in safe,
             'Compiled restore-target readiness failed; see sanitized runtime evidence')
        timings['runtimeIncludingCleanupSeconds'] = time.monotonic() - begin
        for line in safe.splitlines():
            if line.startswith('TIMING '):
                timings.update(json.loads(line[7:]))
        print('RESTORED_COMPILED_READINESS_PASS', flush=True)
        status = 'PASS'
    except Exception as exc:
        reason = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print('RECOVERY_BLOCKED stage=' + STAGE + ' reason=' + reason, flush=True)
    finally:
        cleanup = []
        if owned:
            try:
                metadata(owned)
                docker('stop', '--time', '30', owned, timeout=45)
                need(metadata(owned)['state'] == 'exited', 'Restore not stopped')
            except Exception:
                cleanup.append('restore-stop-unconfirmed')
        try:
            source_check()
        except Exception:
            cleanup.append('source-health-unconfirmed')
        timings['totalSeconds'] = time.monotonic() - started + (previous['timings']['totalSeconds'] if resume else 0)
        record('result.json', {'status': status if not cleanup else 'BLOCKED', 'stage': STAGE,
            'reason': reason, 'cleanupFailures': cleanup, 'timings': timings,
            'ownedContainer': owned, 'originalRestoreContainer': previous['ownedContainer'] if resume else owned, 'sourceRetainedRunning': 'source-health-unconfirmed' not in cleanup,
            'restoreStopped': owned is not None and 'restore-stop-unconfirmed' not in cleanup,
            'backup': str(BACKUP), 'resourcesRetained': True})
        print(json.dumps({'status': status if not cleanup else 'BLOCKED', 'timings': timings,
                          'cleanupFailures': cleanup}), flush=True)
    return 0 if status == 'PASS' and not cleanup else 1


def allow_forwarded_peer(cid):
    """Use only the peer PostgreSQL observes at the already-pinned loopback target."""
    metadata(cid)
    need(identity(cid)['cluster'] == RUN, 'Restore cluster proof failed')
    script = r"""
const fs=require('node:fs'); const {Client}=require('pg');
const env=require('dotenv').parse(fs.readFileSync('.env.test'));
const url=new URL(env.DATABASE_URL); url.hostname='127.0.0.1'; url.port='55433';
const role=decodeURIComponent(url.username);
const client=new Client({connectionString:url.toString(),ssl:false,connectionTimeoutMillis:5000,query_timeout:5000});
(async()=>{try {await client.connect();const p=(await client.query("SELECT current_setting('cluster_name') AS cluster,current_database() AS db,current_user AS role")).rows[0];console.log(JSON.stringify({ok:true,...p}));}
catch(e){const match=e.message.match(/host "([0-9.]+)"/);console.log(JSON.stringify({ok:false,sqlstate:e.code,peer:match?match[1]:null,role}));}
finally{await client.end().catch(()=>{});}})();
"""
    def probe():
        result = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, timeout=15)
        need(result.returncode == 0, 'Forwarded peer probe failed')
        return json.loads(result.stdout)
    proof = probe()
    if not proof['ok']:
        need(proof.get('sqlstate') == '28000', 'Unexpected restore authentication failure')
        peer = ipaddress.IPv4Address(proof.get('peer'))
        need(any(peer in ipaddress.ip_network(cidr) for cidr in ['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16']),
             'Forwarded peer outside private IPv4 ranges')
        role = proof['role']
        need(re.fullmatch(r'[a-z_][a-z0-9_]*', role), 'Unexpected restore app role')
        docker('exec', '-i', cid, 'bash', '-ceu', 'cat >> /var/lib/postgresql/data/pg_hba.conf',
               data=(f'host {DB} {role} {peer}/32 trust\n').encode())
        need(dbsql(cid, DB, 'SELECT pg_reload_conf();') == 't', 'Restore HBA reload failed')
        time.sleep(.3)
        record('restore-forwarding-policy.json', {'database': DB, 'role': role, 'peer': str(peer),
            'cidr': str(peer) + '/32', 'publishedHost': '127.0.0.1', 'sourceUnchanged': True})
        proof = probe()
    need(proof.get('ok') and proof.get('cluster') == RUN and proof.get('db') == DB,
         'Restored app connection identity proof failed')


def resume_runtime():
    """Continue only after completed data equivalence and pre-app SQL failure."""
    previous = json.loads((EVIDENCE / 'result.json').read_text())
    need(previous['status'] == 'BLOCKED' and previous['stage'] == 'compiled-runtime'
         and previous['reason'] == 'Compiled restore-target readiness failed; see sanitized runtime evidence'
         and not previous['cleanupFailures'] and previous['restoreStopped'], 'Runtime resume state mismatch')
    cid = previous['ownedContainer']
    need(metadata(cid)['state'] == 'exited', 'Runtime resume requires stopped restore')
    source_check()
    check_build()
    acl(True)
    need(backup_hashes() == json.loads((BACKUP / 'sha256.json').read_text()), 'Runtime resume backup hash mismatch')
    free_port(3001)
    free_port(55433)
    record('attempt-runtime-' + str(time.time_ns()) + '.json', previous)
    begin = time.monotonic()
    cleanup = []
    status = 'BLOCKED'
    reason = None
    try:
        docker('start', cid)
        for _ in range(40):
            need(metadata(cid)['state'] == 'running', 'Restore exited')
            ready = subprocess.run(['docker', '--context', 'default', 'exec', cid, 'pg_isready', '-h', '/tmp', '-U', ADMIN], capture_output=True, timeout=10)
            if ready.returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError('Restore readiness timeout')
        original = json.loads((BACKUP / 'source-manifest.json').read_text())
        for db in original:
            need(legacy.inventory(cid, ADMIN, db) == original[db], 'Pre-runtime inventory changed')
        allow_forwarded_peer(cid)
        runtime = subprocess.Popen(['node', 'tools/dev/full-recovery-runtime.cjs'], cwd=ROOT,
            env={**os.environ, 'RESTORE_ID': cid}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            stdout, stderr = runtime.communicate(timeout=120)
        finally:
            if runtime.poll() is None:
                runtime.terminate()
                runtime.communicate(timeout=20)
        safe = stdout.decode()
        record('runtime.json', {'exitCode': runtime.returncode, 'output': safe, 'diagnostic': stderr.decode()[-1000:]})
        need(runtime.returncode == 0 and 'COMPILED_READINESS_PASS' in safe and 'APP_CLEANUP_PASS' in safe,
             'Compiled restore-target readiness failed; see sanitized runtime evidence')
        for line in safe.splitlines():
            if line.startswith('TIMING '):
                previous['timings'].update(json.loads(line[7:]))
        print('RESTORED_COMPILED_READINESS_PASS', flush=True)
        status = 'PASS'
    except Exception as exc:
        reason = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print('RECOVERY_BLOCKED stage=compiled-runtime reason=' + reason, flush=True)
    finally:
        try:
            metadata(cid)
            docker('stop', '--time', '30', cid, timeout=45)
            need(metadata(cid)['state'] == 'exited', 'Restore not stopped')
        except Exception:
            cleanup.append('restore-stop-unconfirmed')
        try:
            source_check()
        except Exception:
            cleanup.append('source-health-unconfirmed')
        previous.update(status=status if not cleanup else 'BLOCKED', reason=reason, cleanupFailures=cleanup)
        elapsed = time.monotonic() - begin
        previous['timings']['runtimeResumeIncludingVerificationSeconds'] = elapsed
        previous['timings']['totalSeconds'] += elapsed
        record('result.json', previous)
        print(json.dumps({'status': previous['status'], 'timings': previous['timings'], 'cleanupFailures': cleanup}), flush=True)
    return 0 if status == 'PASS' and not cleanup else 1


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--check-restore':
            obj = metadata(sys.argv[2])
            proof = identity(sys.argv[2])
            need(obj['state'] == 'running' and proof['cluster'] == RUN, 'Restore not ready')
            print(json.dumps({'id': obj['id'], 'state': obj['state'], 'restart': obj['restart'], 'cluster': proof['cluster']}))
        else:
            need(sys.argv[1:] in (['--authorized-run', RUN], ['--authorized-run', RUN, '--resume-toc-fix'], ['--authorized-run', RUN, '--resume-runtime']), 'Exact run authorization required')
            def interrupted(signum, frame):
                raise RuntimeError('Interrupted; cleanup required')
            signal.signal(signal.SIGTERM, interrupted)
            signal.signal(signal.SIGINT, interrupted)
            sys.exit(resume_runtime() if '--resume-runtime' in sys.argv else run(resume='--resume-toc-fix' in sys.argv))
    except Exception as exc:
        print('RECOVERY_PREFLIGHT_BLOCKED ' + (str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__), file=sys.stderr)
        sys.exit(1)
