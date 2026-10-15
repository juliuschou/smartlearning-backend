#!/usr/bin/env python3
"""Manage only the reviewed retained test cluster. No SQL or application launch."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

ENGINE = '8820f44b-5227-4afe-8eff-245fcc9e8a31'
ORIGINAL = 'b0068d3ee1f6fc6b2fe3fa64a9789d523782b5cd77e24f5336e2ca51f9333d8a'
IMAGE = 'sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54'
VOLUME = 'sl-w3-w3-env-20261005T143441Z-e5560ea0-pgdata'
NAME = 'smartlearning-local-db'
LABEL = 'io.smartlearning.local-db'
COMPOSE = Path(__file__).with_name('compose.local-db.yml')
# Updated only after reviewing the exact deployment file.
COMPOSE_SHA256 = 'c8b3424ff5996c17649f55dd5feae19a85eb8a3e48b2a1dec8803422f391c465'


class Blocked(RuntimeError):
    pass


def require(ok, message):
    if not ok:
        raise Blocked(message)


def docker(*args, timeout=15):
    try:
        result = subprocess.run(['docker', '--context', 'default', *args],
                                capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise Blocked('Docker CLI unavailable') from None
    except subprocess.TimeoutExpired:
        raise Blocked('Docker operation timed out; inspect owned resource before retry') from None
    require(result.returncode == 0, 'Docker operation failed; check daemon/access and resource prerequisites')
    return result.stdout.strip()


def inspect(container):
    # Read only selected fields; never retrieve container environment/secrets.
    template = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"state":{{json .State.Status}},"health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}},"mounts":{{json .Mounts}},"ports":{{json .HostConfig.PortBindings}},"restart":{{json .HostConfig.RestartPolicy.Name}},"labels":{{json .Config.Labels}},"user":{{json .Config.User}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"network":{{json .HostConfig.NetworkMode}},"privileged":{{json .HostConfig.Privileged}}}'
    return json.loads(docker('container', 'inspect', '--format', template, container))


def validate_owned(record, allow_disabled=False):
    labels = record.get('labels') or {}
    require(record['name'] == '/' + NAME and len(record['id']) == 64,
            'Container identity mismatch')
    require(labels.get(LABEL) == 'retained-test-v1'
            and labels.get('com.docker.compose.project') == NAME
            and labels.get('com.docker.compose.service') == 'db', 'Container ownership mismatch')
    require(record['image'] == IMAGE and record['user'] == 'postgres'
            and record['entrypoint'] == ['postgres']
            and record['cmd'] == ['-D', '/var/lib/postgresql/data'], 'Container execution configuration drift')
    mounts = record['mounts']
    require(len(mounts) == 1 and mounts[0]['Type'] == 'volume'
            and mounts[0]['Name'] == VOLUME and mounts[0]['RW'] is True
            and mounts[0]['Destination'] == '/var/lib/postgresql/data', 'Data mount mismatch')
    require(record['ports'] == {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '5432'}]},
            'Loopback port configuration mismatch')
    require(record['restart'] in (['unless-stopped', 'no'] if allow_disabled else ['unless-stopped']),
            'Restart policy drift')
    require(record['network'] == NAME + '_default' and record['privileged'] is False,
            'Network or privilege drift')


def port_free():
    with socket.socket() as probe:
        try:
            probe.bind(('127.0.0.1', 5432))
        except OSError:
            raise Blocked('Host port 5432 is unavailable') from None


def preflight(allow_disabled=False):
    require(not any(os.environ.get(k) for k in
                    ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
                     'DOCKER_CONFIG', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES')),
            'Unset Docker/Compose environment overrides')
    require(hashlib.sha256(COMPOSE.read_bytes()).hexdigest() == COMPOSE_SHA256,
            'Compose file drift; review before use')
    require(docker('context', 'show') == 'default', 'Active Docker context mismatch')
    require(docker('info', '--format', '{{.ID}}') == ENGINE, 'Docker engine mismatch')
    require(docker('volume', 'inspect', '--format', '{{.Name}}', VOLUME) == VOLUME,
            'Required retained volume missing')
    require(docker('image', 'inspect', '--format', '{{.Id}}', IMAGE) == IMAGE,
            'Required local image missing')
    original = inspect(ORIGINAL)
    require(original['id'] == ORIGINAL and original['state'] == 'exited',
            'Original container must remain stopped')
    ids = docker('ps', '-a', '--no-trunc', '--filter', 'name=^/' + NAME + '$',
                 '--format', '{{.ID}}').splitlines()
    require(len(ids) <= 1, 'Ambiguous container identity')
    owned = inspect(ids[0]) if ids else None
    if owned:
        validate_owned(owned, allow_disabled)
    consumers = docker('ps', '--no-trunc', '--filter', 'volume=' + VOLUME,
                       '--format', '{{.ID}}').splitlines()
    require(all(owned and item == owned['id'] for item in consumers),
            'Another running container uses retained data')
    if not owned or owned['state'] != 'running':
        port_free()
    return owned


def compose(*args):
    # No implicit .env loading or root Compose merging.
    return docker('compose', '--env-file', '/dev/null', '-f', str(COMPOSE),
                  '--project-name', NAME, *args, timeout=90)


def wait_healthy(container_id):
    for _ in range(30):
        record = inspect(container_id)
        validate_owned(record)
        require(record['state'] == 'running', 'Owned DB exited during startup')
        if record['health'] == 'healthy':
            return record
        require(record['health'] != 'unhealthy', 'Owned DB health check failed')
        time.sleep(2)
    raise Blocked('Owned DB health timeout')


def stop_owned(record):
    # Recheck identity and shared-volume exclusion before every mutation.
    fresh = preflight(allow_disabled=True)
    require(fresh and fresh['id'] == record['id'], 'Owned identity changed before stop')
    docker('update', '--restart=no', fresh['id'])
    fresh = preflight(allow_disabled=True)
    require(fresh and fresh['id'] == record['id'], 'Owned identity changed before stop')
    docker('stop', '--time', '20', fresh['id'], timeout=35)
    require(inspect(fresh['id'])['state'] == 'exited', 'Stop not confirmed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', default='review',
                        choices=['review', 'status', 'up', 'stop', 'start', 'restart'])
    args = parser.parse_args()
    if args.action == 'review':
        require(hashlib.sha256(COMPOSE.read_bytes()).hexdigest() == COMPOSE_SHA256,
                'Compose file drift')
        print('REVIEW: pinned retained test DB only; up/start/restart write existing data.')
        print('No SQL/runtime acceptance implied. No migration, initialization or volume deletion.')
        return
    record = preflight(allow_disabled=True)
    if args.action == 'status':
        print(json.dumps({'id': record['id'], 'state': record['state'],
                          'health': record['health'], 'restart': record['restart']}
                         if record else {'state': 'absent'}))
        return
    if args.action == 'stop':
        require(record is not None, 'Owned DB not created')
        stop_owned(record)
        print('STOPPED: owned DB only; retained data preserved')
        return
    require(args.action == 'up' or record is not None, 'Use up to create reviewed service')
    # Validate effective Compose configuration before creating anything.
    config = json.loads(compose('config', '--format', 'json'))
    require(list(config['services']) == ['db'], 'Unexpected Compose services')
    owned_id = record['id'] if record else None
    try:
        fresh = preflight(allow_disabled=True)
        require((fresh['id'] if fresh else None) == owned_id, 'Container identity changed')
        if fresh:
            docker('update', '--restart=unless-stopped', owned_id)
            fresh = preflight()
            require(fresh['id'] == owned_id, 'Container identity changed')
            docker('restart' if args.action == 'restart' else 'start', owned_id, timeout=40)
        else:
            compose('up', '-d', '--no-deps', '--pull', 'never', 'db')
            created = preflight()
            require(created is not None, 'Created container not resolved')
            owned_id = created['id']
        final = wait_healthy(owned_id)
        print(json.dumps({'id': final['id'], 'health': final['health'],
                          'sql': 'NOT VERIFIED', 'runtime': 'NOT VERIFIED'}))
    except (Blocked, ValueError, KeyError):
        # An up timeout can leave a new resource behind. Resolve its exact labels
        # and ID before any cleanup; never remove containers or volumes.
        try:
            candidate = preflight(allow_disabled=True)
            if candidate and owned_id is not None and candidate['id'] == owned_id:
                stop_owned(candidate)
                print('FAILURE CLEANUP: verified owned DB stopped', file=sys.stderr)
            elif candidate:
                print('Creation ownership unresolved; manual exact-ID review required', file=sys.stderr)
        except (Blocked, ValueError, KeyError):
            print('Cleanup unconfirmed; inspect exact owned service before retry', file=sys.stderr)
        raise


if __name__ == '__main__':
    try:
        main()
    except Blocked as error:
        print('BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except (ValueError, KeyError, OSError):
        # Never print raw subprocess/config errors or credential-bearing values.
        print('BLOCKED: prerequisite/configuration/operation failed; no automatic retry. '
              'Check Docker availability, pinned resources and reviewed configuration.', file=sys.stderr)
        sys.exit(1)
