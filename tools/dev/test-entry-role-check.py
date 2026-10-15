#!/usr/bin/env python3
"""Exact isolated continuation + read-only audit. No migration/truncate/grants."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import socket

ROOT = Path(__file__).resolve().parents[2]
RUN = 'sl-test-entry-20261015-01'
OLD = 'sl-daily-runtime-20261015-01'
IMAGE = 'sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54'
OWNED = 'c84516909a3aa04bc05da7c4dd818f9256e1e7d06178adf46657dc0e1ee6516c'
ENGINE = '8820f44b-5227-4afe-8eff-245fcc9e8a31'
NAME = RUN + '-pg'


def need(ok):
    if not ok:
        raise RuntimeError('Precondition rejected')


def docker(*args):
    p = subprocess.run(['docker', '--context', 'default', *args], capture_output=True, timeout=30)
    need(p.returncode == 0)
    return p.stdout


def inspect(resource):
    return json.loads(docker('inspect', resource))[0]


def shape(obj, label):
    need(obj['Image'] == IMAGE and obj['Config']['Labels'].get('smartlearning.checkpoint') == label)
    need(obj['HostConfig']['RestartPolicy']['Name'] == 'no')
    need(obj['Config']['User'] == '999:999' and not obj['HostConfig']['Privileged'])
    need(obj['HostConfig']['PortBindings'] == {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '55433'}]})
    mounts = obj['Mounts']
    need(len(mounts) == 1 and mounts[0]['Type'] == 'volume' and mounts[0]['RW'])
    need(mounts[0]['Name'] == OLD + '-data' and mounts[0]['Destination'] == '/var/lib/postgresql/data')
    need(set(obj['NetworkSettings']['Networks']) == {OLD + '-net'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--digest', required=True)
    args = parser.parse_args()
    need(os.environ.get('TEST_ENTRY_LIFECYCLE_AUTHORIZATION') == RUN)
    file = Path(args.contract)
    need(file.is_absolute() and not file.is_symlink() and file.is_file())
    need(file.stat().st_mode & 0o777 == 0o600)
    need(hashlib.sha256(file.read_bytes()).hexdigest() == args.digest)
    need(docker('info', '--format', '{{.ID}}').decode().strip() == ENGINE)
    original = inspect(OWNED)
    need(original['Id'] == OWNED and original['State']['Status'] == 'exited')
    shape(original, OLD)
    volume = json.loads(docker('volume', 'inspect', OLD + '-data'))[0]
    need(volume['Driver'] == 'local' and not volume.get('Options'))
    need(volume['Labels'].get('smartlearning.checkpoint') == OLD)
    network = json.loads(docker('network', 'inspect', OLD + '-net'))[0]
    need(network['Driver'] == 'bridge' and network['Labels'].get('smartlearning.checkpoint') == OLD)
    need(not docker('ps', '--filter', 'volume=' + OLD + '-data', '--format', '{{.ID}}').strip())
    need(NAME not in docker('ps', '-a', '--format', '{{.Names}}').decode().splitlines())
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 55433))
    evidence = ROOT / 'artifacts/local-env' / RUN
    evidence.mkdir()  # one-shot; collision rejects, never replay
    created = None
    result = {'status': 'BLOCKED', 'scope': 'continuation-and-readonly-role-audit'}
    try:
        created = docker('create', '--name', NAME, '--label', 'smartlearning.checkpoint=' + RUN,
            '--network', OLD + '-net', '--restart', 'no', '--user', '999:999',
            '--entrypoint', 'postgres', '-p', '127.0.0.1:55433:5432',
            '-v', OLD + '-data:/var/lib/postgresql/data', IMAGE,
            '-D', '/var/lib/postgresql/data', '-c', 'listen_addresses=*',
            '-c', 'unix_socket_directories=/tmp', '-c', 'cluster_name=' + OLD).decode().strip()
        shape(inspect(created), RUN)
        docker('start', created)
        # pg_isready -t bounds each probe, no arbitrary long sleeps.
        for _ in range(20):
            p = subprocess.run(['docker', '--context', 'default', 'exec', created,
                'pg_isready', '-h', '/tmp', '-t', '1'], capture_output=True, timeout=5)
            if p.returncode == 0:
                break
        else:
            raise RuntimeError('Readiness rejected')
        shape(inspect(created), RUN)
        p = subprocess.run(['node', 'tools/dev/test-role-audit.cjs'], cwd=ROOT,
            env={'PATH': os.environ['PATH'], 'NODE_ENV': 'test',
                 'TEST_DB_CONTRACT': str(file), 'TEST_DB_CONTRACT_SHA256': args.digest},
            capture_output=True, timeout=45)
        result['auditExitCode'] = p.returncode
        if p.returncode in (0, 2):
            audit = json.loads(p.stdout)
            need(audit['status'] in ['CAPABILITIES_PASS', 'BLOCKED_CAPABILITIES'])
            result['audit'] = audit
            result['status'] = audit['status']
    finally:
        if created:
            need(inspect(created)['Config']['Labels'].get('smartlearning.checkpoint') == RUN)
            docker('stop', '--time', '10', created)
            need(not inspect(created)['State']['Running'])
            result['ownedContainer'] = created
        result['noRunningVolumeConsumers'] = not bool(docker('ps', '--filter',
            'volume=' + OLD + '-data', '--format', '{{.ID}}').strip())
        (evidence / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
    return 0 if result['status'] == 'CAPABILITIES_PASS' else 2


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('BLOCKED: isolated continuation/role audit failed; preserve resources.', file=sys.stderr)
        sys.exit(1)
