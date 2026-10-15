#!/usr/bin/env python3
"""One-shot isolated rebuild; explicit live authorization required. No source writes."""
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
import signal
import ipaddress

ROOT = Path(__file__).resolve().parents[2]
RUN = 'sl-cold-rebuild-20261015-04'
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


def run_build_command(command, build, env, timeout):
    proc = subprocess.Popen(command, cwd=build, env=env, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        return proc.wait(timeout=timeout)
    finally:
        # npm may exit while descendants remain. Own the whole session group.
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.killpg(proc.pid, 0)
            except ProcessLookupError:
                break
            time.sleep(.05)
        else:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        proc.wait(timeout=5)


def create_build_env(evidence):
    """One configuration path for production and real offline CLI regression."""
    # npm rejects loading the same file as both user and global configuration.
    for name in ['npm-user.npmrc', 'npm-global.npmrc']:
        config = evidence / name
        with config.open('x'):
            pass
        config.chmod(0o600)
    return {'PATH': os.environ['PATH'], 'HOME': str(evidence / 'npm-home'),
           'NODE_ENV': 'test', 'DATABASE_URL': 'postgresql://unused:unused@127.0.0.1:1/unused',
           'npm_config_cache': str(evidence / 'npm-cache'), 'npm_config_audit': 'false',
           'npm_config_fund': 'false', 'npm_config_userconfig': str(evidence / 'npm-user.npmrc'),
           'npm_config_globalconfig': str(evidence / 'npm-global.npmrc')}


def npm_configuration_preflight(build, env):
    """Real npm parser check; no dependency installation, DB or network access."""
    try:
        result = subprocess.run(['npm', '--version'], cwd=build, env=env,
                                capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {'status': 'BLOCKED', 'category': type(exc).__name__}
    version = result.stdout.strip()
    passed = result.returncode == 0 and version == '11.17.0'
    category = ('configuration-double-load' if 'double-loading config' in result.stderr
                else 'version-or-configuration')
    return {'status': 'PASS' if passed else 'BLOCKED', 'exitCode': result.returncode,
            'npmVersion': version if passed else None,
            'category': None if passed else category}


def prepare_build():
    """Rebuild dependencies/client/output without root node_modules or generated files."""
    build = EVIDENCE / 'build'
    build.mkdir()
    names = []
    for folder in ['src', 'prisma']:
        for path in sorted((ROOT / folder).rglob('*')):
            need(not path.is_symlink(), 'Source symlink rejected')
            if path.is_file():
                names.append(str(path.relative_to(ROOT)))
    names += ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json',
              'nest-cli.json', 'prisma.config.ts']
    manifest = {}
    for name in names:
        source = ROOT / name
        need(not source.is_symlink(), 'Source symlink rejected')
        dest = build / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
        manifest[name] = d.file_hash(source)
        need(d.file_hash(dest) == manifest[name], 'Build source copy mismatch')
    main = build / 'src/main.ts'
    text = main.read_text()
    need(text.count('await app.listen(port);') == 1, 'Loopback patch anchor mismatch')
    main.write_text(text.replace('await app.listen(port);', "await app.listen(port, '127.0.0.1');"))
    snapshot_manifest = {name: d.file_hash(build / name) for name in names}
    env = create_build_env(EVIDENCE)
    preflight = npm_configuration_preflight(build, env)
    r.record('npm-preflight.json', preflight)
    need(preflight['status'] == 'PASS', 'npm configuration/version preflight failed')
    timings = {}
    for stage, command, timeout in [
        ('install', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], 600),
        ('generate', ['npm', 'run', 'prisma:generate'], 180),
        ('build', ['npm', 'run', 'build'], 180)]:
        begin = time.monotonic()
        # Output may contain registry diagnostics: discard it, emit stage/exit only.
        receipt = {'stage': stage, 'status': 'RUNNING', 'timeoutSeconds': timeout}
        r.record('build-' + stage + '.json', receipt)
        try:
            code = run_build_command(command, build, env, timeout)
            receipt.update(status='PASS' if code == 0 else 'BLOCKED', exitCode=code)
            need(code == 0, 'Independent dependency/client/build failed: ' + stage)
        except Exception as exc:
            receipt.update(status='BLOCKED', category=type(exc).__name__)
            raise
        finally:
            receipt['elapsedSeconds'] = time.monotonic() - begin
            r.record('build-' + stage + '.json', receipt)
        timings[stage + 'Seconds'] = receipt['elapsedSeconds']
    need((build / 'dist/src/main.js').is_file(), 'Compiled entry missing')
    need(not (build / 'node_modules').is_symlink(), 'Shared dependencies forbidden')
    r.record('build-receipt.json', {'snapshot': str(build), 'manifest': manifest,
        'snapshotManifest': snapshot_manifest, 'timings': timings, 'dependencies': 'fresh npm ci --ignore-scripts; private empty cache',
        'secretContract': 'root .env.test mode0600; runtime only; never copied'})


def allow_forwarded_peer(cid):
    """Use only the peer PostgreSQL observes at the already-pinned loopback target."""
    r.metadata(cid)
    need(r.identity(cid)['cluster'] == RUN, 'Restore cluster proof failed')
    script = r"""
const fs=require('node:fs'); const req=require('node:module').createRequire(require('node:path').resolve('artifacts/local-env/sl-cold-rebuild-20261015-04/build/package.json')); const {Client}=req('pg');
const env=req('dotenv').parse(fs.readFileSync('.env.test'));
const url=require('./tools/dev/cold-rebuild-config.cjs').isolatedURL(env);
const role=decodeURIComponent(url.username);
const client=new Client({connectionString:url.toString(),ssl:false,connectionTimeoutMillis:5000,query_timeout:5000});
(async()=>{try {await client.connect();const p=(await client.query("SELECT current_setting('cluster_name') AS cluster,current_database() AS db,current_user AS role")).rows[0];console.log(JSON.stringify({ok:true,...p}));}
catch(e){const match=e.message.match(/host "([0-9.]+)"/);console.log(JSON.stringify({ok:false,sqlstate:e.code,peer:match?match[1]:null,role}));}
finally{await client.end().catch(()=>{});}})();
"""
    def probe():
        result = subprocess.run(['node', '-e', script], cwd=ROOT, env={'PATH': os.environ['PATH']}, capture_output=True, timeout=15)
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
        r.docker('exec', '-i', cid, 'bash', '-ceu', 'cat >> /var/lib/postgresql/data/pg_hba.conf',
               data=(f'host {r.DB} {role} {peer}/32 trust\n').encode())
        need(r.dbsql(cid, r.DB, 'SELECT pg_reload_conf();') == 't', 'Restore HBA reload failed')
        time.sleep(.3)
        r.record('restore-forwarding-policy.json', {'database': r.DB, 'role': role, 'peer': str(peer),
            'cidr': str(peer) + '/32', 'publishedHost': '127.0.0.1', 'sourceUnchanged': True})
        proof = probe()
    need(proof.get('ok') and proof.get('cluster') == RUN and proof.get('db') == r.DB,
         'Restored app connection identity proof failed')


def assert_closed_port(port):
    """Post-stop listener check; strict bind remains the preflight collision guard.

    TIME_WAIT can prevent bind even after all listeners and owned processes exit.
    Accept only an explicitly refused connection, never timeout or other errors.
    """
    import errno
    import socket
    with socket.socket() as sock:
        sock.settimeout(2)
        need(sock.connect_ex(('127.0.0.1', port)) == errno.ECONNREFUSED,
             'Owned port listener closure unconfirmed')


def require_authorization():
    need(not any(os.environ.get(key) for key in ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD']), 'Runtime injection rejected')
    need(os.environ.get('SL_COLD_REBUILD_AUTHORIZATION') == RUN,
         'Explicit isolated rebuild authorization missing')


def controlled_signal(signum, frame):
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise RuntimeError('Controlled interruption')


def main():
    require_authorization()
    started = time.monotonic()
    signal.signal(signal.SIGTERM, controlled_signal)
    signal.signal(signal.SIGINT, controlled_signal)
    need(not EVIDENCE.exists(), 'One-shot evidence collision; no replay')
    EVIDENCE.mkdir(parents=True, mode=0o700)
    os.umask(0o077)
    owned = None
    status = 'BLOCKED'
    stage = 'daily-integrity'
    reason = None
    timings = {}
    cleanup = []
    create_attempted = False
    try:
        need(subprocess.check_output(['node', '--version'], timeout=10).strip() == b'v26.5.1', 'Node pin mismatch')
        need(subprocess.check_output(['npm', '--version'], timeout=10).strip() == b'11.17.0', 'npm pin mismatch')
        signal.signal(signal.SIGALRM, controlled_signal)
        signal.alarm(1500)
        r.record('intake.json', {'launcherPid': os.getpid(), 'run': RUN, 'deadlineSeconds': 1500,
            'scope': 'isolated dependency/DB/app rebuild; existing OS and engine',
            'sourceMutation': False, 'sourceStop': False})
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
        original = json.loads((backup / 'source-manifest.json').read_text(encoding='utf-8-sig'))
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
        stage = 'configuration'
        config_receipt = {'stage': stage, 'status': 'BLOCKED'}
        try:
            role = json.loads(subprocess.check_output(['node', 'tools/dev/cold-rebuild-config.cjs'], cwd=ROOT, stderr=subprocess.DEVNULL, timeout=10))
            config_receipt['status'] = 'PASS'
        except Exception:
            config_receipt['category'] = 'CONFIGURATION_REJECTED'
            raise RuntimeError('CONFIGURATION_REJECTED') from None
        finally:
            r.record('configuration.json', config_receipt)
        stage = 'fresh-restore'
        begin = time.monotonic()
        r.docker('network', 'create', '--label', r.LABEL, r.NETWORK)
        network = json.loads(r.docker('network', 'inspect', r.NETWORK))[0]
        need(network['Labels'].get('smartlearning.checkpoint') == RUN and network['Driver'] == 'bridge', 'Network ownership mismatch')
        gateway = network['IPAM']['Config'][0]['Gateway']
        import ipaddress
        ipaddress.IPv4Address(gateway)

        need(re.fullmatch(r'[a-z_][a-z0-9_]*', role), 'App role rejected')
        r.docker('volume', 'create', '--label', r.LABEL, r.VOLUME)
        script = ('test -z "$(ls -A /var/lib/postgresql/data)"; '
            'initdb -D /var/lib/postgresql/data -U full_restore_admin --auth-local=trust --auth-host=reject >/tmp/initdb.log; '
            f"printf 'local all all trust\\nhost {r.DB} {role} {gateway}/32 trust\\n' > /var/lib/postgresql/data/pg_hba.conf; "
            f"exec postgres -D /var/lib/postgresql/data -c listen_addresses='*' -c unix_socket_directories=/tmp -c cluster_name={RUN}")
        create_attempted = True
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
        print('COLD_REBUILD_SNAPSHOT_RESTORE_COMPARE_PASS', flush=True)
        stage = 'compiled-runtime'
        allow_forwarded_peer(owned)
        credential = subprocess.run(['node', 'tools/dev/cold-rebuild-credentials.cjs'], cwd=ROOT,
            env={'PATH': os.environ['PATH'], 'RESTORE_ID': owned},
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30)
        need(credential.returncode == 0 and credential.stdout.strip() == b'SCRAM_RECOVERY_PASS', 'Credential recovery failed')
        r.record('credential.json', {'scram': True, 'wrongPasswordRejected': True, 'secretsPrinted': False})
        begin = time.monotonic()
        proc = subprocess.Popen(['node', 'tools/dev/cold-rebuild-runtime.cjs'], cwd=ROOT,
            env={'PATH': os.environ['PATH'], 'HOME': os.environ['HOME'], 'RESTORE_ID': owned}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
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
        r.record('runtime.json', {'exitCode': proc.returncode, 'output': safe, 'diagnostic': 'suppressed'})
        need(proc.returncode == 0 and 'FUNCTION_SMOKE_PASS' in safe and 'COMPILED_READINESS_PASS' in safe and 'APP_CLEANUP_PASS' in safe, 'Compiled runtime verification failed')
        timings['runtimeIncludingCleanupSeconds'] = time.monotonic() - begin
        for line in safe.splitlines():
            if line.startswith('TIMING '):
                timings.update(json.loads(line[7:]))
        timings['serviceReadySeconds'] = begin - started + timings['serviceReadyOffsetSeconds']
        d.verify_run(backup)
        d.acl(backup.name, 'Published')
        need(d.file_hash(backup / 'success.json') == manifest_hash, 'Final manifest changed')
        status = 'PASS'
    except Exception as exc:
        reason = str(exc) if isinstance(exc, (RuntimeError, d.Blocked, r.local.Blocked)) else type(exc).__name__
        print('COLD_REBUILD_RUNTIME_BLOCKED stage=' + stage + ' reason=' + reason, flush=True)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if not owned and create_attempted:
            try:
                candidate = r.local.inspect(r.CONTAINER)['id']
                r.metadata(candidate)
                owned = candidate
            except Exception:
                cleanup.append('partial-create-inspection-required')
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
        port_closure = {}
        for port in [3001, 55433]:
            try:
                assert_closed_port(port)
                port_closure[str(port)] = {'status': 'PASS', 'connection': 'ECONNREFUSED'}
            except Exception as exc:
                # Never persist raw exception text, which may contain private context.
                port_closure[str(port)] = {'status': 'BLOCKED',
                    'category': 'listener-closure-unconfirmed', 'errorType': type(exc).__name__}
        if any(value['status'] != 'PASS' for value in port_closure.values()):
            cleanup.append('ports-not-closed')
        if cleanup and reason is None:
            reason = 'Cleanup verification failed'
        timings['totalSeconds'] = time.monotonic() - started
        result = {'status': status if not cleanup else 'BLOCKED', 'stage': stage, 'reason': reason,
            'cleanupFailures': cleanup, 'portClosure': port_closure, 'ownedContainer': owned, 'restoreStopped': bool(owned) and 'restore-stop-unconfirmed' not in cleanup,
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
