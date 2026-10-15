#!/usr/bin/env python3
"""SQL-only diagnostic core. CLI is review-only; no lifecycle entry is enabled."""
import hashlib
import json
import re
import subprocess
from pathlib import Path

import importlib.util


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


f = load('checkpoint_m_f', 'checkpoint-f.py')
roles = f.roles
RUN = 'sl-m-20261014-01'
SQLSTATES = frozenset({'42601', '42501', '42704', '42883', '42P01', '3D000',
                       '28P01', '08006', '57014'})
SCHEMA = f"""
BEGIN;
SET LOCAL ROLE {roles.MIGRATION};
CREATE TABLE public._prisma_migrations (id text PRIMARY KEY);
CREATE SEQUENCE public.sl_diagnostic_seq;
CREATE TABLE public.sl_diagnostic (id bigint PRIMARY KEY, value text);
CREATE FUNCTION public.sl_diagnostic_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1';
COMMIT;
SELECT to_json(true);
"""
# Each mutation is rolled back even when an audit returns false. A subprocess
# failure stops the driver: no next case or automatic retry is attempted.
CASES = (
    ('missing-table-select', 'REVOKE SELECT ON public.sl_diagnostic FROM ' + roles.APPLICATION),
    ('missing-sequence-select', 'REVOKE SELECT ON SEQUENCE public.sl_diagnostic_seq FROM ' + roles.APPLICATION),
    ('forbidden-table-truncate', 'GRANT TRUNCATE ON public.sl_diagnostic TO ' + roles.APPLICATION),
    ('forbidden-sequence-update', 'GRANT UPDATE ON SEQUENCE public.sl_diagnostic_seq TO ' + roles.APPLICATION),
    ('forbidden-migration-read', 'GRANT SELECT ON public._prisma_migrations TO ' + roles.APPLICATION),
    ('forbidden-function-execute', 'GRANT EXECUTE ON FUNCTION public.sl_diagnostic_fn() TO ' + roles.APPLICATION),
    ('forbidden-schema-create', 'GRANT CREATE ON SCHEMA public TO ' + roles.APPLICATION),
    ('forbidden-database-temp', 'GRANT TEMP ON DATABASE ' + roles.DATABASE + ' TO ' + roles.APPLICATION),
)
CHECKS = frozenset({'role-setup', 'synthetic-schema', 'grants', 'positive-audit',
                    'restored-audit', *(name for name, _ in CASES)})


def plan():
    # No migration manifest or environment file is read by this contract.
    return {
        'runId': RUN, 'context': 'default', 'endpoint': 'unix:///var/run/docker.sock',
        'engineId': f.contract.ENGINE, 'imageId': f.contract.IMAGE,
        'container': RUN + '-sql-pg', 'dataVolume': RUN + '-sql-data',
        'secretVolume': RUN + '-sql-secret', 'label': f.LABEL + '=' + RUN,
        'role': roles.BOOTSTRAP, 'migrationRole': roles.MIGRATION,
        'applicationRole': roles.APPLICATION, 'database': roles.DATABASE,
        'publish': '127.0.0.1:5433:5432', 'restartPolicy': 'no',
        'helper': RUN + '-secret-helper',
        'evidence': 'artifacts/local-env/' + RUN,
        'helperTmpfs': {'target': '/var/lib/postgresql/data', 'readOnly': True,
                        'sizeBytes': 1048576, 'mode': 448},
        'schema': SCHEMA, 'audit': roles.AUDIT, 'grants': roles.GRANTS,
        'cases': CASES, 'sqlstates': sorted(SQLSTATES),
        'sourceSha256': {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                         for name in ('checkpoint-m.py', 'checkpoint-f.py', 'checkpoint-e.py', 'checkpoint-roles.py')},
        'liveEnabled': False,
        'excluded': ['migrations', 'environment files', 'application suites', 'old resources',
                     'backup publication', 'seed', 'deletion', 'retry', 'restart'],
    }


def contract_hash():
    return hashlib.sha256(json.dumps(plan(), sort_keys=True).encode()).hexdigest()


class DiagnosticFailure(ValueError):
    def __init__(self, classification):
        self.classification = classification
        super().__init__('Diagnostic blocked')


def classify(stderr):
    # Only psql verbose error prefixes are considered, never arbitrary matches
    # in DETAIL, HINT, query text or credential-bearing messages.
    match = re.search(rb'(?:^|\n)(?:psql:[^\r\n]*?:\s*)?ERROR:\s+([0-9A-Z]{5}):', stderr)
    return match.group(1).decode('ascii') if match and match.group(1).decode('ascii') in SQLSTATES else 'UNKNOWN'


def diagnostic_run(argv, *, data=None, env=None, timeout=30):
    """Capture only in memory; never propagate stdout/stderr on failure."""
    try:
        result = subprocess.run(argv, input=data, env=env, timeout=timeout,
                                cwd=f.contract.REPO, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, check=False)
        if result.returncode:
            raise DiagnosticFailure(classify(result.stderr))
        return result.stdout.decode('utf-8')
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        raise DiagnosticFailure('TRANSPORT_UNAVAILABLE') from None


class SQLTransport(f.Executor):
    """Only an already freshly provisioned, guarded current-run container.

    Lifecycle methods are disabled here: a future separately approved adapter
    must prove preflight, fresh initdb and protected bootstrap secret injection.
    """
    def __init__(self, *, runner=diagnostic_run, environment=None):
        super().__init__(plan(), runner=runner, environment={} if environment is None else environment)
        f.require(not self.environment, 'Inherited environment prohibited')

    def preflight(self):
        raise ValueError('Live lifecycle is not enabled')

    provision = preflight
    separate_roles = preflight
    migrate = preflight
    execute = preflight

    def sql(self, query):
        f.require(self.p == plan(), 'Diagnostic contract drift')
        self.runtime_identity()
        self.verify_container(self.ids['pg'])
        output = self.docker('exec', '-i', self.ids['pg'], 'psql', '-X', '-qAt',
                             '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
                             '-U', roles.BOOTSTRAP, '-d', roles.DATABASE, data=query.encode())
        try:
            return json.loads(output)
        except (ValueError, TypeError):
            raise DiagnosticFailure('INVALID_RESULT') from None


def diagnose(sql, migration_password, application_password):
    """Injected guarded SQL transport; returned evidence is entirely allowlisted."""
    evidence = []

    def check(identifier, query, expected):
        f.require(identifier in CHECKS, 'Unknown diagnostic identifier')
        try:
            value = sql(query)
            if type(value) is not bool:
                raise DiagnosticFailure('INVALID_RESULT')
            evidence.append({'check': identifier, 'result': value,
                             'matched': value is expected})
            return value is expected
        except DiagnosticFailure as error:
            classification = error.classification
            if classification not in SQLSTATES | {'UNKNOWN', 'TRANSPORT_UNAVAILABLE', 'INVALID_RESULT'}:
                classification = 'UNKNOWN'
        except Exception:
            classification = 'UNKNOWN'
        evidence.append({'check': identifier, 'classification': classification})
        return False

    try:
        setup = roles.setup(migration_password, application_password)
    except ValueError:
        return {'status': 'BLOCKED', 'checks': [{'check': 'role-setup', 'classification': 'INVALID_CREDENTIAL'}]}
    for identifier, query in (('role-setup', setup), ('synthetic-schema', SCHEMA),
                              ('grants', roles.GRANTS), ('positive-audit', roles.AUDIT)):
        if not check(identifier, query, True):
            return {'status': 'BLOCKED', 'checks': evidence}
    for identifier, mutation in CASES:
        if not check(identifier, 'BEGIN;\n' + mutation + ';\n' + roles.AUDIT + '\nROLLBACK;', False):
            return {'status': 'BLOCKED', 'checks': evidence}
        if not check('restored-audit', roles.AUDIT, True):
            return {'status': 'BLOCKED', 'checks': evidence}
    return {'status': 'SYNTHETIC_VERIFIED', 'checks': evidence}


if __name__ == '__main__':
    import sys
    if len(sys.argv) != 1:
        print(json.dumps({'status': 'BLOCKED', 'classification': 'LIVE_NOT_ENABLED'}))
        sys.exit(1)
    print(json.dumps({'status': 'REVIEW_ONLY', 'runId': RUN,
                      'contractSha256': contract_hash(), 'liveEnabled': False}, sort_keys=True))
