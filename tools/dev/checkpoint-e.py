#!/usr/bin/env python3
"""Prepare a deterministic E execution contract; never contact a runtime.

This command has no execute mode. Live provisioning requires the documented
approval and an executor reviewed against this contract.
"""
import hashlib
import json
from pathlib import Path
import re
import sys

REPO = Path(__file__).resolve().parents[2]
RUN = 'sl-i-20261014-01'
IMAGE = 'sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54'
ENGINE = '8820f44b-5227-4afe-8eff-245fcc9e8a31'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def migration_manifest(root):
    require(root.is_dir() and not root.is_symlink(), 'Invalid migration root')
    result = []
    for directory in sorted(root.iterdir()):
        require(not directory.is_symlink(), 'Symlink in migration tree')
        if directory.name == 'migration_lock.toml':
            require(directory.is_file(), 'Invalid migration lock')
            continue
        require(directory.is_dir() and re.fullmatch(r'\d{14}_[a-z0-9_]+', directory.name),
                'Unexpected migration entry')
        sql = directory / 'migration.sql'
        require(sql.is_file() and not sql.is_symlink(), 'Invalid migration SQL')
        require(list(directory.iterdir()) == [sql], 'Unexpected migration files')
        result.append({'name': directory.name,
                       'sha256': hashlib.sha256(sql.read_bytes()).hexdigest()})
    require(bool(result), 'Empty migration tree')
    lock = root / 'migration_lock.toml'
    require(lock.is_file(), 'Missing migration lock')
    return {'sql': result, 'lockSha256': hashlib.sha256(lock.read_bytes()).hexdigest()}


def replace_connections(content, url):
    """Pure transform for a future protected/atomic env writer; no file I/O."""
    require(url.startswith('postgresql://') and '\n' not in url and '\r' not in url,
            'Invalid proposed URL')
    lines = content.splitlines(keepends=True)
    counts = {'DATABASE_URL': 0, 'DIRECT_URL': 0}
    for index, line in enumerate(lines):
        match = re.match(r'^(DATABASE_URL|DIRECT_URL)=', line)
        if match:
            key = match.group(1)
            counts[key] += 1
            newline = '\r\n' if line.endswith('\r\n') else '\n'
            lines[index] = key + '=' + url + newline
        else:
            require(not re.match(r'^\s*(?:export\s+)?(?:DATABASE_URL|DIRECT_URL)\s*=', line),
                    'Unsupported connection assignment')
    require(counts['DATABASE_URL'] == 1 and counts['DIRECT_URL'] <= 1,
            'Missing or duplicate connection assignments')
    return ''.join(lines)


def plan(repo=REPO):
    role_policy = repo / 'tools/dev/checkpoint-roles.py'
    require(role_policy.is_file() and not role_policy.is_symlink(), 'Invalid role policy')
    return {
        'status': 'PREPARED_NOT_AUTHORIZED_FOR_EXECUTION',
        'runId': RUN, 'context': 'default', 'engineId': ENGINE,
        'endpoint': 'unix:///var/run/docker.sock', 'imageId': IMAGE,
        'container': RUN + '-dev-pg', 'dataVolume': RUN + '-dev-data',
        'secretVolume': RUN + '-dev-secret',
        'imageVolumes': ['/var/lib/postgresql/data'],
        'helperTmpfs': {'target': '/var/lib/postgresql/data', 'readOnly': True, 'sizeBytes': 1048576, 'mode': 448},
        'database': 'smartlearning_dev', 'role': 'smartlearning_dev_owner',
        'migrationRole': 'smartlearning_dev_migrator', 'applicationRole': 'smartlearning_dev_app',
        'rolePolicySha256': hashlib.sha256(role_policy.read_bytes()).hexdigest(),
        'publish': '127.0.0.1:5433:5432', 'restartPolicy': 'no',
        'label': 'smartlearning.checkpoint=' + RUN,
        'migrations': migration_manifest(repo / 'prisma/migrations'),
        'gates': [
            'Explicit approval: fresh initdb/start, three named resources plus temporary owned secret helper, migrations, env backup/update',
            'Revalidate context/endpoint/engine/image, reject Docker overrides and every name collision',
            'Prove WSL and Windows port availability immediately before create; unavailable probe blocks',
            'Protect external POSIX credential/backup directory: owner=current user, mode=0700, no symlinks',
            'Create secret volume, verify labels/options/consumers; stream generated password by stdin via exact owned helper',
            'Secret file readable only by verified postgres UID; remove host staging after verified copy',
            'Create data volume; verify ownership/options/no consumers before mount',
            'Create container with POSTGRES_PASSWORD_FILE, loopback publication, scram host auth and no restart',
            'Record exact IDs and verify image/mounts/labels/ports/no other consumers before start',
            'Verify SQL database/role/empty public schema and host password auth via TCP; never rely on local trust',
            'Create distinct non-superuser migration/application roles with independent credentials; migration owns DB/public schema; revoke PUBLIC database privileges on new cluster databases',
            'Recheck SQL/role-policy manifest; migrate deploy with migration-only child DATABASE_URL override, no URL in argv/logs',
            'Verify all migration names/checksums completed, no failed rows, zero application rows',
            'Grant application table DML and sequence usage/select only; exclude migration metadata; audit effective privileges and TCP role identity before env write',
            'Verify env original hash/owner/permissions/no symlink; exclusive mode=0600 backup outside Git',
            'Write same-directory mode=0600 temp, fsync, compare original again, atomic replace and directory fsync',
            'Verify host authentication using updated env; record sanitized evidence and stop at checkpoint gate',
        ],
        'excluded': ['old resources', 'seed', 'db push', 'DB-backed tests',
                     'backend/Redis start', 'deletion', 'historical data recovery'],
        'rollback': ['match exact container ID/image/ownership then stop only it',
                     'restore protected env backup atomically only if current hash matches E-written hash',
                     'retain all volumes and sanitized evidence; never down -v or prune'],
    }


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 1, 'No execution mode or arguments supported')
        print(json.dumps(plan(), indent=2) )
    except (ValueError, OSError):
        print('BLOCKED: invalid preparation inputs', file=sys.stderr)
        sys.exit(1)
