#!/usr/bin/env python3
"""One authorized recovery run. No source writes, migration, deletion or retries.

Run only after Windows backup-directory ACL setup and explicit C authorization.
This intentionally pins reviewed identities; it is not a generic recovery tool.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

RUN = 'sl-c-20261013-01'
IMAGE = 'sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54'
ENGINE = '8820f44b-5227-4afe-8eff-245fcc9e8a31'
SOURCE = 'smartlearning-pg-recovery-20261008'
SOURCE_ID = 'b5c787348b867b34e73ae32e6c11640a38184b8fca5362c8808c99e88db22078'
ROLE = 'sl_w3_e5560ea0'  # A inventory, linked W3 source; SQL must verify.
BACKUP = Path('/mnt/d/Backups/SmartLearning') / RUN
REPO = Path(__file__).resolve().parents[2]
EVIDENCE = REPO / 'artifacts/local-env' / RUN
LABEL = 'smartlearning.checkpoint=' + RUN
WORK = RUN + '-work-pg'
RESTORE = RUN + '-restore-pg'
WORK_VOLUME = RUN + '-work-data'
RESTORE_VOLUME = RUN + '-restore-data'
OWNED = []


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def docker(*args, data=None, timeout=30):
    # Do not include raw stderr (SQL/commands can contain sensitive contents).
    result = subprocess.run(['docker', '--context', 'default', *args], input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout)
    require(result.returncode == 0, 'Docker operation failed: ' + args[0])
    return result.stdout


def inspect(kind, name):
    return json.loads(docker(kind, 'inspect', name))[0]


def record(name, value):
    (EVIDENCE / name).write_text(json.dumps(value, indent=2, ensure_ascii=True) + '\n')


def source_check():
    require(not os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT'),
            'Docker overrides forbidden')
    require(subprocess.check_output(['docker', 'context', 'show'], timeout=10).strip() == b'default',
            'Context mismatch')
    require(docker('info', '--format', '{{.ID}}').decode().strip() == ENGINE, 'Engine mismatch')
    endpoint = docker('context', 'inspect', 'default', '--format', '{{.Endpoints.docker.Host}}')
    require(endpoint.strip() == b'unix:///var/run/docker.sock', 'Endpoint mismatch')
    source = inspect('container', SOURCE)
    require(source['Id'] == SOURCE_ID and source['Image'] == IMAGE, 'Source identity mismatch')
    require(source['State']['Status'] == 'exited', 'Source is not stopped')
    require(len(source['Mounts']) == 1, 'Unexpected source mounts')
    mount = source['Mounts'][0]
    require(mount['Type'] == 'volume' and mount['Name'] == SOURCE
            and mount['Destination'] == '/var/lib/postgresql/data', 'Source mount mismatch')
    require(not docker('ps', '--filter', 'volume=' + SOURCE, '--format', '{{.ID}}').strip(),
            'Source has a running consumer')
    volume = inspect('volume', SOURCE)
    require(volume['Driver'] == 'local' and not volume.get('Options'), 'Unsupported source driver')
    require(volume['Labels'].get('source') == 'w3-env-20261005T143441Z-e5560ea0',
            'Source provenance changed')
    return source


MANIFEST = r'''
set -o pipefail
shopt -s inherit_errexit
manifest() {
    (
        set -euo pipefail
        cd "$1" || exit 1
        test -z "$(find . -type l -print -quit)" || exit 1
        test -z "$(find . ! -type d ! -type f -print -quit)" || exit 1
        { find . -printf '%P|%y|%m|%U|%G|%n|%T@\n' | LC_ALL=C sort
          find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
        } | sha256sum | cut -d ' ' -f 1
    )
}
'''


def owned_volume(volume):
    obj = inspect('volume', volume)
    require(obj['Name'] == volume and obj['Driver'] == 'local' and not obj.get('Options')
            and (obj.get('Labels') or {}).get('smartlearning.checkpoint') == RUN,
            'New volume ownership mismatch')
    require(not docker('ps', '--filter', 'volume=' + volume, '--format', '{{.ID}}').strip(),
            'New volume already has a running consumer')


def helper(name, script, readonly=False):
    owned_volume(WORK_VOLUME)
    owned_volume(RESTORE_VOLUME)
    mode = ':ro' if readonly else ''
    cid = docker('create', '--name', name, '--label', LABEL, '--network', 'none',
                 '--restart', 'no', '--user', '0:0', '--entrypoint', 'bash',
                 '-v', SOURCE + ':/source:ro',
                 '-v', WORK_VOLUME + ':/var/lib/postgresql/data' + mode,
                 '-v', RESTORE_VOLUME + ':/restore' + mode,
                 IMAGE, '-ceu', MANIFEST + script).decode().strip()
    OWNED.append(cid)
    # Helper has no secret arguments. Source is mounted RO, PostgreSQL never runs here.
    output = docker('start', '-a', cid, timeout=300)
    require(inspect('container', cid)['State']['ExitCode'] == 0, 'Copy/manifest helper failed')
    return output.decode().strip().splitlines()


def server(name, volume, initialize=False):
    owned_volume(volume)
    command = ['postgres', '-D', '/var/lib/postgresql/data', '-c', 'listen_addresses=',
               '-c', 'unix_socket_directories=/tmp']
    entry = 'postgres'
    if initialize:
        entry = 'bash'
        command = ['-ceu', 'initdb -D /var/lib/postgresql/data -U c_restore_admin '
                   '--auth-local=trust --auth-host=reject >/tmp/initdb.log; '
                   'exec postgres -D /var/lib/postgresql/data -c listen_addresses= '
                   '-c unix_socket_directories=/tmp']
    else:
        command = command[1:]
    cid = docker('create', '--name', name, '--label', LABEL, '--network', 'none',
                 '--restart', 'no', '--user', '999:999', '--entrypoint', entry,
                 '-v', volume + ':/var/lib/postgresql/data', IMAGE, *command).decode().strip()
    OWNED.append(cid)
    docker('start', cid)
    return ready(cid)


def ready(cid):
    for _ in range(30):
        state = inspect('container', cid)
        require(state['State']['Running'], 'Isolated PostgreSQL exited before ready')
        result = subprocess.run(['docker', '--context', 'default', 'exec', cid,
                                 'pg_isready', '-h', '/tmp'], stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=10)
        if result.returncode == 0:
            require(state['HostConfig']['NetworkMode'] == 'none'
                    and not state['HostConfig'].get('PortBindings'), 'Isolation mismatch')
            return cid
        time.sleep(1)
    raise RuntimeError('Isolated PostgreSQL readiness timeout')


def sql(container, role, database, query):
    return docker('exec', '-i', container, 'psql', '-X', '-w', '-h', '/tmp',
                  '-U', role, '-d', database, '-v', 'ON_ERROR_STOP=1', '-qAt',
                  data=("SET statement_timeout='60s'; SET default_transaction_read_only=on;\n"
                        + query + '\n').encode(), timeout=90).decode().splitlines()


def json_sql(container, role, database, query):
    lines = sql(container, role, database, query)
    require(bool(lines), 'Unexpected SQL result shape')
    # json_agg(record) may render its single JSON value over multiple lines.
    return json.loads('\n'.join(lines))


def ident(value):
    return '"' + value.replace('"', '""') + '"'


def inventory(container, role, database):
    objects = json_sql(container, role, database, """
SELECT coalesce(json_agg(x ORDER BY x.schema,x.name), '[]') FROM (
 SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,
        pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS acl,
        c.relrowsecurity AS rls,
        CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true)
             WHEN c.relkind IN ('i','I') THEN pg_get_indexdef(c.oid)
             WHEN c.relkind='p' THEN pg_get_partkeydef(c.oid) END AS definition,
        (SELECT coalesce(json_agg(a ORDER BY a.position),'[]') FROM (
          SELECT att.attnum AS position,att.attname AS name,
                 format_type(att.atttypid,att.atttypmod) AS type,
                 att.attnotnull AS not_null,att.attidentity AS identity,att.attgenerated AS generated,
                 pg_get_expr(d.adbin,d.adrelid) AS default_expression
          FROM pg_attribute att LEFT JOIN pg_attrdef d ON d.adrelid=att.attrelid AND d.adnum=att.attnum
          WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped
        ) a) AS columns,
        (SELECT coalesce(json_agg(k ORDER BY k.name),'[]') FROM (
          SELECT conname AS name,contype AS type,pg_get_constraintdef(oid,true) AS definition
          FROM pg_constraint WHERE conrelid=c.oid
        ) k) AS constraints
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname NOT IN ('pg_catalog','information_schema')
 AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
) x;
""")
    require(not any(x['kind'] == 'f' for x in objects), 'Foreign tables unsupported')
    extensions = json_sql(container, role, database,
                          "SELECT coalesce(json_agg(x ORDER BY extname),'[]') FROM "
                          "(SELECT extname,extversion FROM pg_extension) x;")
    tables = []
    sequences = []
    for obj in objects:
        qualified = ident(obj['schema']) + '.' + ident(obj['name'])
        if obj['kind'] in ('r', 'm'):
            # Sorting canonical JSON text includes duplicates and needs no assumed primary key.
            # Hash the stream inside the isolated container; rows never enter host evidence.
            digest = docker('exec', '-i', container, 'bash', '-o', 'pipefail', '-c',
                              'psql "$@" | sha256sum', '--', '-X', '-q', '-w', '-h', '/tmp',
                              '-U', role, '-d', database, '-v', 'ON_ERROR_STOP=1', '-At',
                              data=("SET default_transaction_read_only=on; SET statement_timeout='60s'; "
                                    "COPY (SELECT serialized FROM ("
                                    f"SELECT row_to_json(t)::text AS serialized FROM ONLY {qualified} t"
                                    ") rows ORDER BY serialized COLLATE \"C\") TO STDOUT;\n").encode(), timeout=90)
            count = sql(container, role, database, f'SELECT count(*) FROM ONLY {qualified};')
            require(len(count) == 1, 'Unexpected table count result')
            tables.append({'schema': obj['schema'], 'name': obj['name'],
                           'count': int(count[0]), 'sha256': digest.decode().split()[0]})
        elif obj['kind'] == 'S':
            value = json_sql(container, role, database,
                             f'SELECT row_to_json(x) FROM (SELECT last_value,is_called FROM {qualified}) x;')
            sequences.append({'schema': obj['schema'], 'name': obj['name'], **value})
    # Unsupported large objects must not be silently excluded from data verification.
    require(sql(container, role, database, 'SELECT count(*) FROM pg_largeobject_metadata;') == ['0'],
            'Large objects require expanded verification')
    return {'objects': objects, 'extensions': extensions, 'tables': tables, 'sequences': sequences}


def export(container, arguments, destination):
    require(not destination.exists(), 'Backup file collision')
    with destination.open('xb') as stream:
        proc = subprocess.run(['docker', '--context', 'default', 'exec', container, *arguments],
                              stdout=stream, stderr=subprocess.PIPE, timeout=300)
    require(proc.returncode == 0 and destination.stat().st_size > 0, 'Backup export failed')


def restore_file(container, arguments, path):
    with path.open('rb') as stream:
        result = subprocess.run(['docker', '--context', 'default', 'exec', '-i', container, *arguments],
                                stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
    require(result.returncode == 0, 'Restore command failed: ' + arguments[0])
    return result.stdout


def backup_hashes():
    hashes = {}
    for path in sorted(BACKUP.iterdir()):
        require(path.is_file() and not path.is_symlink(), 'Unexpected backup entry')
        with path.open('rb') as stream:
            hashes[path.name] = hashlib.file_digest(stream, 'sha256').hexdigest()
    (BACKUP / 'sha256.json').write_text(json.dumps(hashes, indent=2) + '\n')
    record('backup-hashes.json', hashes)


def complete_preservation_check():
    """Finish only the preserved-source check after the known ordering failure.

    No PostgreSQL restart or SQL write: restore/data comparisons already passed.
    """
    source_check()
    previous = json.loads((EVIDENCE / 'result.json').read_text())
    require(previous == {'status': 'BLOCKED', 'reason': 'New volume already has a running consumer',
                         'sourceWrites': False}, 'Unexpected continuation reason')
    record('initial-final-check-failure.json', previous)
    final = json.loads((EVIDENCE / 'final-state.json').read_text())
    require(not final['stopFailures'] and final['lifecycleCaptureStayedAlive'], 'Previous stop/capture failed')
    for name in [WORK, RESTORE]:
        obj = inspect('container', name)
        require(obj['Id'] in final['ownedContainerIds'] and obj['Image'] == IMAGE
                and obj['Config']['Labels'].get('smartlearning.checkpoint') == RUN
                and obj['State']['Status'] == 'exited' and obj['State']['ExitCode'] == 0,
                'Finalization owned server mismatch')
    original = json.loads((EVIDENCE / 'source-sql-manifest.json').read_text())
    restored = json.loads((EVIDENCE / 'restore-sql-manifest.json').read_text())
    require(original == restored, 'Recorded restore manifest mismatch')
    databases = json.loads((EVIDENCE / 'sql-identity.json').read_text())['databases']
    expected_files = {'globals.sql'} | {f'database-{i:03d}.{suffix}'
                                       for i in range(len(databases)) for suffix in ['dump', 'toc']}
    require({p.name for p in BACKUP.iterdir()} == expected_files, 'Backup inventory mismatch')
    require(RUN + '-verify' not in docker('ps', '-a', '--format', '{{.Names}}').decode().splitlines(),
            'Final helper collision')
    with (EVIDENCE / 'events.jsonl').open('ab') as output:
        events = subprocess.Popen(['docker', '--context', 'default', 'events', '--filter', 'label=' + LABEL,
                                   '--format', '{"time":{{.TimeNano}},"type":{{json .Type}},'
                                   '"action":{{json .Action}},"id":{{json .Actor.ID}}}'],
                                  stdout=output, stderr=subprocess.DEVNULL)
        try:
            time.sleep(1)
            require(events.poll() is None, 'Lifecycle capture unavailable')
            actual = helper(RUN + '-verify', 'manifest /source\n', readonly=True)
            expected = json.loads((EVIDENCE / 'physical-copy.json').read_text())['output'][-2].split('=', 1)[1]
            require(actual == [expected], 'Preserved source content/metadata changed')
            record('preserved-source.json', {'manifest': expected, 'unchanged': True})
            backup_hashes()
            source_check()
            require(events.poll() is None, 'Final lifecycle capture failed')
            verify = inspect('container', RUN + '-verify')
            require(not verify['State']['Running'] and verify['State']['ExitCode'] == 0, 'Final helper failed')
            final['ownedContainerIds'].append(verify['Id'])
            record('final-state.json', final)
            record('result.json', {'status': 'PASS', 'sourcePreserved': True, 'isolatedRestore': True,
                                   'developmentAuthority': 'NOT PROVEN (W3 provenance)',
                                   'backup': str(BACKUP), 'rolePasswords': 'excluded',
                                   'databaseProperties': 'PASS before initial final-check ordering failure'})
        finally:
            events.terminate()
            try:
                events.wait(timeout=10)
            except subprocess.TimeoutExpired:
                events.kill()
                events.wait(timeout=10)
    print('CHECKPOINT_C_BACKUP_RESTORE_PASS; DEVELOPMENT_AUTHORITY_NOT_PROVEN', flush=True)


def main():
    if sys.argv[1:] == ['--authorized-run', RUN, '--complete-preservation-check']:
        return complete_preservation_check()
    resume = sys.argv[1:] == ['--authorized-run', RUN, '--continue-after-parser-fix']
    require(resume or sys.argv[1:] == ['--authorized-run', RUN], 'Exact authorized-run argument required')
    source = source_check()
    require(BACKUP.is_dir() and not list(BACKUP.iterdir()), 'Protected empty backup directory required')
    if resume:
        previous = json.loads((EVIDENCE / 'result.json').read_text())
        require(previous['status'] == 'BLOCKED' and previous['reason'] == 'Unexpected SQL result shape',
                'Continuation allowed only for the diagnosed SQL parser failure')
        record('initial-parser-failure.json', previous)
        final = json.loads((EVIDENCE / 'final-state.json').read_text())
        require(not final['stopFailures'], 'Previous stop was not proven')
        OWNED.extend(final['ownedContainerIds'])
        work_obj = inspect('container', WORK)
        require(work_obj['Id'] in OWNED and work_obj['Image'] == IMAGE
                and work_obj['Config']['Labels'].get('smartlearning.checkpoint') == RUN
                and work_obj['Config']['User'] == '999:999'
                and work_obj['HostConfig']['NetworkMode'] == 'none'
                and not work_obj['HostConfig'].get('PortBindings')
                and work_obj['State']['Status'] == 'exited' and work_obj['State']['ExitCode'] == 0
                and len(work_obj['Mounts']) == 1 and work_obj['Mounts'][0]['Name'] == WORK_VOLUME,
                'Continuation work identity mismatch')
        owned_volume(WORK_VOLUME)
        owned_volume(RESTORE_VOLUME)
    else:
        require(not EVIDENCE.exists(), 'Evidence collision')
    existing_containers = docker('ps', '-a', '--format', '{{.Names}}').decode().splitlines()
    existing_volumes = docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines()
    forbidden = [RESTORE, RUN + '-verify'] if resume else [WORK, RESTORE, RUN + '-copy', RUN + '-verify']
    require(not any(x in existing_containers for x in forbidden),
            'Container collision')
    require(resume or (WORK_VOLUME not in existing_volumes and RESTORE_VOLUME not in existing_volumes),
            'Volume collision')
    if not resume:
        EVIDENCE.mkdir(parents=True)
    record('preflight.json', {'engine': ENGINE, 'sourceId': source['Id'], 'image': IMAGE,
                             'provenance': 'W3 recovery copy; development authority NOT PROVEN'})
    events_file = (EVIDENCE / 'events.jsonl').open('ab' if resume else 'wb')
    events = subprocess.Popen(['docker', '--context', 'default', 'events', '--filter', 'label=' + LABEL,
                               '--format', '{"time":{{.TimeNano}},"type":{{json .Type}},'
                               '"action":{{json .Action}},"id":{{json .Actor.ID}}}'],
                              stdout=events_file, stderr=subprocess.DEVNULL)
    success = False
    try:
        time.sleep(1)
        require(events.poll() is None, 'Lifecycle capture unavailable')
        if resume:
            outputs = json.loads((EVIDENCE / 'physical-copy.json').read_text())['output']
        else:
            for volume in [WORK_VOLUME, RESTORE_VOLUME]:
                docker('volume', 'create', '--label', LABEL, volume)
                owned_volume(volume)
            source_check()
            outputs = helper(RUN + '-copy', r'''
test "$(cat /source/PG_VERSION)" = 16
test -s /source/global/pg_control
test -d /source/base
test -d /source/pg_wal
test -z "$(ls -A /var/lib/postgresql/data)"
test -z "$(ls -A /restore)"
test "$(id -u postgres):$(id -g postgres)" = 999:999
postgres --version
du -sb /source | cut -f1
required=$(du -sb /source | cut -f1)
available=$(df -PB1 /var/lib/postgresql/data | awk 'NR==2 {print $4}')
test "$available" -gt "$((required * 4 + 1073741824))"
before=$(manifest /source)
cp -a /source/. /var/lib/postgresql/data/
after=$(manifest /source)
copy=$(manifest /var/lib/postgresql/data)
test "$before" = "$after"
test "$before" = "$copy"
printf 'source_manifest=%s\ncopy_manifest=%s\n' "$before" "$copy"
chown 999:999 /restore
chmod 700 /restore
''')
        record('physical-copy.json', {'output': outputs, 'helperRootException':
                                     'Read all source files, preserve numeric ownership, prepare only new restore volume'})
        source_check()
        if resume:
            work = work_obj['Id']
            # Prior stop was intentional after a parser failure, not runtime loss.
            # Reuse only the exact C-owned server, with current verified configuration.
            docker('start', work)
            ready(work)
        else:
            work = server(WORK, WORK_VOLUME)
        # Explicitly read-only SQL; role from known source metadata must exist and be superuser.
        identity = json_sql(work, ROLE, 'postgres',
                            "SELECT json_build_object('version',version(),'user',current_user,"
                            "'system_identifier',(SELECT system_identifier::text FROM pg_control_system()),"
                            "'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user));")
        require(identity['user'] == ROLE and identity['superuser'], 'SQL role proof failed')
        databases = json_sql(work, ROLE, 'postgres', """
SELECT coalesce(json_agg(x ORDER BY name),'[]') FROM (
 SELECT datname AS name,datallowconn AS connectable,pg_get_userbyid(datdba) AS owner,
        pg_encoding_to_char(encoding) AS encoding,datcollate AS collate,datctype AS ctype,
        datacl::text AS acl,datconnlimit AS connection_limit
 FROM pg_database WHERE NOT datistemplate
) x;
""")
        require(all(x['connectable'] for x in databases), 'Non-connectable database unsupported')
        record('sql-identity.json', {'identity': identity, 'databases': databases})
        original = {}
        for index, db in enumerate(databases):
            original[db['name']] = inventory(work, ROLE, db['name'])
            print('SQL inventory verified for database index', index, flush=True)
        record('source-sql-manifest.json', original)
        export(work, ['pg_dumpall', '-h', '/tmp', '-U', ROLE, '-w', '--globals-only',
                      '--no-role-passwords'], BACKUP / 'globals.sql')
        for index, db in enumerate(databases):
            path = BACKUP / f'database-{index:03d}.dump'
            export(work, ['pg_dump', '-h', '/tmp', '-U', ROLE, '-w', '-Fc', '--create',
                          '--dbname', db['name']], path)
        restore = server(RESTORE, RESTORE_VOLUME, initialize=True)
        restore_file(restore, ['psql', '-X', '-q', '-w', '-h', '/tmp', '-U',
                     'c_restore_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], BACKUP / 'globals.sql')
        for index, db in enumerate(databases):
            # Existing initdb postgres is empty and exclusively run-owned. Drop it only here.
            if db['name'] == 'postgres':
                docker('exec', restore, 'dropdb', '-h', '/tmp', '-U', 'c_restore_admin', 'postgres')
            dump = BACKUP / f'database-{index:03d}.dump'
            listing = restore_file(restore, ['pg_restore', '--list'], dump)
            # TOC may contain sensitive object names: save outside the repository.
            (BACKUP / f'database-{index:03d}.toc').write_bytes(listing)
            restore_file(restore, ['pg_restore', '-h', '/tmp', '-U', 'c_restore_admin',
                         '-w', '--exit-on-error', '--create', '--dbname', 'template1'], dump)
            actual = inventory(restore, ROLE, db['name'])
            require(actual == original[db['name']], 'Restored SQL manifest mismatch')
            print('Restore content/count/sequence verification PASS for database index', index, flush=True)
        record('restore-sql-manifest.json', {db['name']: inventory(restore, ROLE, db['name']) for db in databases})
        restored_databases = json_sql(restore, ROLE, 'postgres', """
SELECT coalesce(json_agg(x ORDER BY name),'[]') FROM (
 SELECT datname AS name,datallowconn AS connectable,pg_get_userbyid(datdba) AS owner,
        pg_encoding_to_char(encoding) AS encoding,datcollate AS collate,datctype AS ctype,
        datacl::text AS acl,datconnlimit AS connection_limit
 FROM pg_database WHERE NOT datistemplate
) x;
""")
        require(restored_databases == databases, 'Restored database properties mismatch')
        record('restored-database-properties.json', restored_databases)
        docker('stop', '--time', '30', work, timeout=45)
        docker('stop', '--time', '30', restore, timeout=45)
        source_check()
        final_manifest = helper(RUN + '-verify', 'manifest /source\n', readonly=True)
        require(final_manifest == [outputs[-2].split('=', 1)[1]], 'Source changed during run')
        record('preserved-source.json', {'manifest': final_manifest[0], 'unchanged': True})
        backup_hashes()
        record('result.json', {'status': 'PASS', 'sourcePreserved': True, 'isolatedRestore': True,
                               'developmentAuthority': 'NOT PROVEN (W3 provenance)',
                               'backup': str(BACKUP), 'rolePasswords': 'excluded'})
        success = True
    except Exception as exc:
        record('result.json', {'status': 'BLOCKED', 'reason': str(exc), 'sourceWrites': False})
        print('BLOCKED:', str(exc), flush=True)
    finally:
        # Only exact IDs created here, with current owner verification, may be stopped.
        failures = []
        for cid in OWNED:
            try:
                obj = inspect('container', cid)
                require(obj['Config']['Labels'].get('smartlearning.checkpoint') == RUN,
                        'Owned container label mismatch')
                if obj['State']['Running']:
                    docker('stop', '--time', '30', cid, timeout=45)
                require(not inspect('container', cid)['State']['Running'], 'Stop not proven')
            except Exception:
                failures.append(cid)
        event_alive = events.poll() is None
        events.terminate()
        try:
            events.wait(timeout=10)
        except subprocess.TimeoutExpired:
            events.kill()
            events.wait(timeout=10)
        events_file.close()
        record('final-state.json', {'ownedContainerIds': OWNED, 'stopFailures': failures,
                                    'lifecycleCaptureStayedAlive': event_alive,
                                    'volumesAndContainersRetained': True})
        require(not failures and event_alive, 'Final stop/lifecycle verification failed')
    require(success, 'Checkpoint C did not pass; retained evidence/resources')
    print('CHECKPOINT_C_BACKUP_RESTORE_PASS; DEVELOPMENT_AUTHORITY_NOT_PROVEN', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print subprocess command input or raw database diagnostics.
        print(str(error), file=sys.stderr)
        sys.exit(1)
