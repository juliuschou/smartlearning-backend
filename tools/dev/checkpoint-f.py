#!/usr/bin/env python3
"""Fresh baseline executor. CLI is review-only until separately scoped approval.

No import/default invocation contacts Docker or reads an environment file.
Injected runners must return stdout only; subprocess diagnostics are suppressed.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import time


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


contract = load('checkpoint_e', 'checkpoint-e.py')
roles = load('checkpoint_roles', 'checkpoint-roles.py')
require = contract.require
LABEL = 'smartlearning.checkpoint'
SECRET_PATH = '/run/secrets/password'
HELPER_SCRIPT = ('test "$(id -u postgres):$(id -g postgres)" = 999:999; '
                 'test ! -e /secret/password; umask 077; cat > /secret/password; '
                 'chown 999:999 /secret/password; chmod 0400 /secret/password; '
                 'test "$(stat -c %u:%g:%a /secret/password)" = 999:999:400')
APPROVAL = 'fresh-initdb-start-secret-helper-tmpfs-separated-roles-grants-20-migrations-env-backup-update'


def run(argv, *, data=None, env=None, timeout=30):
    try:
        result = subprocess.run(argv, input=data, env=env, cwd=contract.REPO,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=timeout, check=False)
        require(result.returncode == 0, 'Subprocess blocked')
        return result.stdout.decode()
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        raise ValueError('Subprocess unavailable') from None


def local_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 5433))


WINDOWS = r'''
$ErrorActionPreference = 'Stop'
$ranges = & netsh interface ipv4 show excludedportrange protocol=tcp
if ($LASTEXITCODE -ne 0) { throw 'exclusion probe failed' }
$parsed = 0
foreach ($line in $ranges) {
 if ($line -match '^\s*(\d+)\s+(\d+)\s*\*?\s*$') {
  $parsed++; if (5433 -ge [int]$matches[1] -and 5433 -le [int]$matches[2]) { throw 'excluded' }
 }
}
if ($parsed -eq 0) { throw 'unrecognized exclusion output' }
$s = [System.Net.Sockets.Socket]::new([System.Net.Sockets.AddressFamily]::InterNetwork,[System.Net.Sockets.SocketType]::Stream,[System.Net.Sockets.ProtocolType]::Tcp)
try { $s.ExclusiveAddressUse = $true; $s.Bind([System.Net.IPEndPoint]::new([System.Net.IPAddress]::Loopback,5433)); 'PORT_AVAILABLE' } finally { $s.Dispose() }
'''

# pg receives the credential only over stdin; never argv, environment or output.
TCP = r'''
const {Client} = require('pg'); let input='';
process.stdin.setEncoding('utf8'); process.stdin.on('data', s=>input+=s);
process.stdin.on('end', async()=>{
 const x=JSON.parse(input); const client=new Client({host:'127.0.0.1',port:5433,
 database:'smartlearning_dev',user:x.role,password:x.password,
 connectionTimeoutMillis:5000});
 try { await client.connect(); const r=await client.query('SELECT current_database() AS db, current_user AS role');
 if(x.reject) process.exitCode=1; else process.stdout.write(JSON.stringify(r.rows[0]));
 } catch(e) { if(x.reject && e.code==='28P01') process.stdout.write('AUTH_REJECTED'); else process.exitCode=1;
 } finally { await client.end().catch(()=>{}); }
});
'''


class Executor:
    def __init__(self, expected, *, runner=run, port_probe=local_port,
                 environment=None, sleep=time.sleep, transaction=None):
        self.p = expected
        self.runner = runner
        self.port_probe = port_probe
        self.environment = dict(os.environ if environment is None else environment)
        self.sleep = sleep
        self.transaction = transaction
        self.ids = {}
        self.stages = []
        self.password = None
        self.migration_password = None
        self.application_password = None
        self.used = False

    def command(self, argv, data=None, timeout=30, env=None):
        return self.runner(argv, data=data, timeout=timeout,
                           env=self.environment if env is None else env)

    def docker(self, *args, data=None):
        return self.command(['docker', '--context', self.p['context'], *args], data)

    def inspect(self, kind, name):
        value = json.loads(self.docker(kind, 'inspect', name))
        require(isinstance(value, list) and len(value) == 1, 'Inspection shape')
        return value[0]

    def runtime_identity(self):
        require(self.docker('context', 'show').strip() == self.p['context'], 'Context mismatch')
        context = self.inspect('context', self.p['context'])
        require(context['Endpoints']['docker']['Host'] == self.p['endpoint'], 'Endpoint mismatch')
        require(self.docker('info', '--format', '{{.ID}}').strip() == self.p['engineId'], 'Engine mismatch')
        require(self.inspect('image', self.p['imageId'])['Id'] == self.p['imageId'], 'Image mismatch')

    def preflight(self):
        require(self.p == contract.plan(), 'Contract drift')
        require(not any(k.startswith(('DOCKER_', 'PG')) or k in ('DIRECT_URL', 'DATABASE_URL', 'NODE_OPTIONS', 'NODE_PATH') or k.startswith('PRISMA_')
                        for k in self.environment), 'Inherited connection/runtime override')
        # CLI configuration must keep explicit process DATABASE_URL authoritative.
        config = (contract.REPO / 'prisma.config.ts').read_text()
        require('dotenv.config({ path: envFile });' in config and
                'url: process.env["DATABASE_URL"]' in config and 'override' not in config,
                'Prisma routing changed')
        require(self.docker('context', 'show').strip() == self.p['context'], 'Context mismatch')
        context = self.inspect('context', self.p['context'])
        require(context['Endpoints']['docker']['Host'] == self.p['endpoint'], 'Endpoint mismatch')
        require(self.docker('info', '--format', '{{.ID}}').strip() == self.p['engineId'], 'Engine mismatch')
        image = self.inspect('image', self.p['imageId'])
        require(image['Id'] == self.p['imageId'] and image['Config']['Entrypoint'] == ['docker-entrypoint.sh']
                and image['Config'].get('User', '') in ('', '0', 'root'), 'Unsupported image entrypoint/user')
        require(image['Config'].get('Cmd') == ['postgres'], 'Unsupported image command')
        require(set(image['Config'].get('Volumes', {})) == {'/var/lib/postgresql/data'}, 'Unsupported image volumes')
        names = set(self.docker('ps', '-a', '--format', '{{.Names}}').splitlines())
        require(not names.intersection({self.p['container'], self.p['runId'] + '-secret-helper'}), 'Container collision')
        volumes = set(self.docker('volume', 'ls', '--format', '{{.Name}}').splitlines())
        require(not volumes.intersection({self.p['dataVolume'], self.p['secretVolume']}), 'Volume collision')
        self.port_probe()
        require(self.command(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', WINDOWS]).strip()
                == 'PORT_AVAILABLE', 'Windows port unavailable')
        self.stages.append('preflight')

    def volume(self, name):
        self.runtime_identity()
        require(name not in set(self.docker('volume', 'ls', '--format', '{{.Name}}').splitlines()), 'Volume collision before create')
        self.docker('volume', 'create', '--label', self.p['label'], name)
        self.check_volume(name, allowed=())

    def check_volume(self, name, allowed):
        v = self.inspect('volume', name)
        require(v['Name'] == name and v.get('Labels') == {LABEL: self.p['runId']}
                and v.get('Driver') == 'local' and not v.get('Options'), 'Volume ownership mismatch')
        consumers = set(self.docker('ps', '-a', '--filter', 'volume=' + name, '--format', '{{.ID}}', '--no-trunc').splitlines())
        require(consumers <= set(allowed), 'Unexpected volume consumer')

    def verify_container(self, cid, helper=False):
        c = self.inspect('container', cid)
        require(c['Id'] == cid and c['Image'] == self.p['imageId'] and
                c['Config'].get('Labels') == {LABEL: self.p['runId']}, 'Container ownership mismatch')
        name = self.p['runId'] + '-secret-helper' if helper else self.p['container']
        require(c['Name'] == '/' + name and c['HostConfig']['RestartPolicy']['Name'] == 'no', 'Container identity mismatch')
        expected = {(self.p['secretVolume'], '/secret' if helper else '/run/secrets', helper)}
        if not helper:
            expected.add((self.p['dataVolume'], '/var/lib/postgresql/data', True))
        mounts = {(m['Name'], m['Destination'], m['RW']) for m in c['Mounts'] if m['Type'] == 'volume'}
        tmpfs = [m for m in c['Mounts'] if m['Type'] == 'tmpfs']
        require(len(c['Mounts']) == len(expected) + int(helper) and mounts == expected, 'Mount mismatch')
        require(len(tmpfs) == int(helper) and (not helper or
                (tmpfs[0]['Destination'] == '/var/lib/postgresql/data' and tmpfs[0]['RW'] is False)), 'Helper tmpfs mismatch')
        expected_config = [{'Type': 'tmpfs', 'Target': '/var/lib/postgresql/data', 'ReadOnly': True,
                            'TmpfsOptions': {'SizeBytes': 1048576, 'Mode': 448}}] if helper else []
        configured = [m for m in c['HostConfig'].get('Mounts', []) if m.get('Type') == 'tmpfs']
        require(configured == expected_config and not c['HostConfig'].get('Tmpfs'), 'Tmpfs configuration mismatch')
        env = c['Config'].get('Env', [])
        require(not any(e.startswith('POSTGRES_PASSWORD=') or any(p and p in e for p in
                    (self.password, self.migration_password, self.application_password)) for e in env), 'Metadata secret')
        host = c['HostConfig']
        require(not host.get('Privileged') and not host.get('CapAdd') and not host.get('Devices')
                and not host.get('VolumesFrom'), 'Unsafe container privilege/bind')
        if helper:
            require(c['Config'].get('User') == '0:0' and c['Config'].get('Entrypoint') == ['sh']
                    and c['Config'].get('Cmd') == ['-ceu', HELPER_SCRIPT]
                    and host.get('NetworkMode') == 'none', 'Helper command/user/network mismatch')
        else:
            require(host.get('NetworkMode') in ('default', 'bridge'), 'PG network mismatch')
            require(c['Config'].get('User', '') in ('', 'root', '0')
                    and c['Config'].get('Entrypoint') == ['docker-entrypoint.sh']
                    and c['Config'].get('Cmd') == ['postgres'], 'PG entrypoint mismatch')
            required = {'POSTGRES_PASSWORD_FILE=' + SECRET_PATH, 'POSTGRES_DB=' + self.p['database'],
                        'POSTGRES_USER=' + self.p['role'], 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256'}
            require(required <= set(env), 'Initialization environment mismatch')
            require(c['HostConfig']['PortBindings'] == {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '5433'}]}, 'Publication mismatch')
            if c['State'].get('Running'):
                require(c['NetworkSettings']['Ports'] == host['PortBindings'], 'Actual publication mismatch')
        for volume, _, _ in expected:
            self.check_volume(volume, tuple(self.ids.values()) if volume == self.p['secretVolume'] else (cid,))
        return c

    def sql(self, query):
        self.verify_container(self.ids['pg'])
        output = self.docker('exec', '-i', self.ids['pg'], 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                             '-U', self.p['role'], '-d', self.p['database'], data=query.encode())
        return json.loads(output)

    def tcp(self, reject=False, role=None):
        role = self.p['role'] if role is None else role
        credentials = {self.p['role']: self.password, self.p['migrationRole']: self.migration_password,
                       self.p['applicationRole']: self.application_password}
        require(role in credentials and credentials[role], 'Missing role credential')
        password = secrets.token_hex(32) if reject else credentials[role]
        require(not reject or password != credentials[role], 'Invalid negative credential')
        result = self.command(['node', '-e', TCP], json.dumps({'password': password, 'reject': reject, 'role': role}).encode())
        require(result.strip() == 'AUTH_REJECTED' if reject else json.loads(result) ==
                {'db': self.p['database'], 'role': role}, 'TCP authentication mismatch')

    def separate_roles(self):
        require(self.p['role'] == roles.BOOTSTRAP and self.p['migrationRole'] == roles.MIGRATION
                and self.p['applicationRole'] == roles.APPLICATION and self.p['database'] == roles.DATABASE,
                'Role contract mismatch')
        self.runtime_identity()
        require(contract.plan() == self.p, 'Role policy drift')
        self.migration_password = secrets.token_hex(32)
        self.application_password = secrets.token_hex(32)
        require(self.password not in (self.migration_password, self.application_password), 'Duplicate bootstrap credential')
        require(self.sql(roles.setup(self.migration_password, self.application_password)) is True, 'Role setup blocked')
        self.tcp(role=self.p['migrationRole'])
        self.tcp(True, role=self.p['migrationRole'])
        self.stages.append('roles-separated')

    def application_url(self):
        require(isinstance(self.application_password, str) and re.fullmatch('[0-9a-f]{64}', self.application_password),
                'Invalid application credential')
        return f"postgresql://{self.p['applicationRole']}:{self.application_password}@127.0.0.1:5433/{self.p['database']}"

    def migration_url(self):
        require(isinstance(self.migration_password, str) and re.fullmatch('[0-9a-f]{64}', self.migration_password),
                'Missing migration credential')
        return f"postgresql://{self.p['migrationRole']}:{self.migration_password}@127.0.0.1:5433/{self.p['database']}"

    def provision(self):
        self.password = secrets.token_hex(32)
        self.volume(self.p['secretVolume'])
        # Root exception limited to new secret-file ownership; no PGDATA mounted.
        self.runtime_identity()
        helper = self.docker('create', '-i', '--name', self.p['runId'] + '-secret-helper', '--label', self.p['label'],
                             '--restart', 'no', '--network', 'none', '--user', '0:0', '--entrypoint', 'sh',
                             '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data,readonly,tmpfs-size=1048576,tmpfs-mode=0700',
                             '-v', self.p['secretVolume'] + ':/secret', self.p['imageId'], '-ceu', HELPER_SCRIPT).strip()
        require(re.fullmatch('[a-f0-9]{64}', helper), 'Invalid helper ID')
        self.ids['helper'] = helper
        self.verify_container(helper, True)
        self.runtime_identity()
        self.docker('start', '-ai', helper, data=self.password.encode())
        c = self.verify_container(helper, True)
        require(c['State']['Status'] == 'exited' and c['State']['ExitCode'] == 0, 'Secret helper failed')
        self.volume(self.p['dataVolume'])
        args = ['create', '--name', self.p['container'], '--label', self.p['label'], '--restart', 'no',
                '-p', self.p['publish'], '-v', self.p['dataVolume'] + ':/var/lib/postgresql/data',
                '-v', self.p['secretVolume'] + ':/run/secrets:ro']
        for value in ('POSTGRES_PASSWORD_FILE=' + SECRET_PATH, 'POSTGRES_DB=' + self.p['database'],
                      'POSTGRES_USER=' + self.p['role'], 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256'):
            args.extend(['-e', value])
        self.runtime_identity()
        pg = self.docker(*args, self.p['imageId']).strip()
        require(re.fullmatch('[a-f0-9]{64}', pg), 'Invalid PG ID')
        self.ids['pg'] = pg
        self.verify_container(pg)
        self.runtime_identity()
        self.docker('start', pg)
        for attempt in range(30):
            try:
                result = self.sql("SELECT json_build_object('db',current_database(),'role',current_user,'tables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')); ")
                break
            except ValueError:
                if attempt == 29:
                    raise
                self.sleep(1)
        require(result == {'db': self.p['database'], 'role': self.p['role'], 'tables': 0}, 'Wrong/nonempty SQL target')
        self.tcp()
        self.tcp(True)
        self.stages.append('initialized-authenticated')

    def migrate(self):
        self.runtime_identity()
        require(contract.plan() == self.p, 'Migration drift')
        self.verify_container(self.ids['pg'])
        url = self.migration_url()
        env = dict(self.environment, DATABASE_URL=url, NODE_ENV='development')
        self.command(['node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'], env=env, timeout=180)
        require(contract.plan() == self.p, 'Migration drift after deploy')
        rows = self.sql('SELECT coalesce(json_agg(row_to_json(m)),\'[]\'::json) FROM (SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back FROM "_prisma_migrations") m;')
        expected = {(m['name'], m['sha256']) for m in self.p['migrations']['sql']}
        require(len(rows) == len(expected) and {(m['migration_name'], m['checksum']) for m in rows} == expected
                and all(m['finished'] and not m['rolled_back'] for m in rows), 'Migration completion mismatch')
        # Quoted table identifiers generated server-side, zero-row invariant for all application tables.
        count = self.sql("CREATE TEMP TABLE sl_counts(n bigint); DO $$ DECLARE t record; n bigint; BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' LOOP EXECUTE format('SELECT count(*) FROM public.%I',t.tablename) INTO n; INSERT INTO sl_counts VALUES(n); END LOOP; END $$; SELECT coalesce(sum(n),0)::bigint FROM sl_counts;")
        require(count == 0, 'Unexpected application data')
        require(self.sql(roles.GRANTS) is True, 'Application grants blocked')
        require(self.sql(roles.AUDIT) is True, 'Effective role privileges mismatch')
        self.tcp(role=self.p['applicationRole'])
        self.tcp(True, role=self.p['applicationRole'])
        self.stages.append('migrated-empty')
        return self.application_url()

    def rollback(self):
        errors = []
        if self.transaction is not None:
            try:
                self.transaction.restore()
            except (ValueError, OSError):
                errors.append('env-restore-blocked')
        for key in ('pg', 'helper'):
            if key in self.ids:
                try:
                    self.runtime_identity()
                    self.verify_container(self.ids[key], key == 'helper')
                    self.docker('stop', self.ids[key])
                except (ValueError, OSError, KeyError):
                    errors.append(key + '-stop-blocked')
        return errors

    def execute(self, approval, exclusive_env_access=False):
        require(not self.used, 'Executor is single-use')
        require(approval == APPROVAL and exclusive_env_access, 'Explicit scoped approval/exclusive env access required')
        require(self.transaction is not None, 'Protected env transaction required')
        require(self.transaction.path == contract.REPO / '.env.development' and
                self.transaction.backup_dir == Path('/home/user/.local/share/smartlearning') / self.p['runId'],
                'Unexpected env/backup target')
        self.used = True
        try:
            self.preflight()
            self.provision()
            self.separate_roles()
            url = self.migrate()
            self.transaction.prepare(url, migration_url=self.migration_url())
            self.transaction.commit()
            self.transaction.verify_written(url)
            require(self.sql(roles.AUDIT) is True, 'Final role privileges mismatch')
            self.tcp(role=self.p['applicationRole'])
            self.stages.append('env-updated')
            return {'status': 'VERIFIED', 'stages': self.stages, 'ids': self.ids}
        except Exception:
            errors = self.rollback()
            raise ValueError('Execution blocked; retained resources; rollback=' + ','.join(errors)) from None
        finally:
            self.password = None
            self.migration_password = None
            self.application_password = None


if __name__ == '__main__':
    # Intentionally no live CLI: mock review and privilege decision precede enabling it.
    print(json.dumps({'status': 'REVIEW_ONLY_NO_LIVE_CLI', 'approvalScope': APPROVAL,
                      'runId': contract.RUN, 'bootstrapRoleIsSuperuser': True,
                      'credentialDecision': 'separated-roles', 'applicationRoleIsSuperuser': False}))
