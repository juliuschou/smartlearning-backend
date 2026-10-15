#!/usr/bin/env python3
"""Isolated mutation acceptance lifecycle. Requires exact independent live authorization."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import socket
import signal
import ipaddress
import re

ROOT = Path(__file__).resolve().parents[2]
RUN = 'sl-test-runtime-20261015-02'
OLD = 'sl-daily-runtime-20261015-01'
IMAGE = 'sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54'
OWNED = 'c84516909a3aa04bc05da7c4dd818f9256e1e7d06178adf46657dc0e1ee6516c'
ENGINE = '8820f44b-5227-4afe-8eff-245fcc9e8a31'
NAME = RUN + '-pg'
SOURCE_ID = 'd053acc4d005b7484ca06dfe5b2d73a7908265e8c9edb580638c99eb26601c4d'


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


def executor_hba(original_hba, role):
    need(re.fullmatch(r'[a-z_][a-z0-9_]*', role) is not None)
    additions = []
    private = [ipaddress.ip_network(x) for x in ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']]
    for line in original_hba.decode().splitlines():
        fields = line.split()
        if len(fields) == 5 and fields[:3] == ['host', 'smartlearning_test', role]:
            network = ipaddress.ip_network(fields[3], strict=True)
            need(network.version == 4 and network.prefixlen == 32
                 and any(network.subnet_of(x) for x in private))
            need(fields[4] in ('trust', 'scram-sha-256'))
            additions.append('host smartlearning_test sl_isolated_test_executor ' + fields[3] + ' scram-sha-256')
    need(bool(additions))
    return original_hba + ('\n' + '\n'.join(additions) + '\n').encode()


def interrupted(signum, frame):
    # Ignore repeated soft interrupts while finally restores/stops owned resources.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    raise RuntimeError('Interrupted; cleanup required')


def main():
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--digest', required=True)
    args = parser.parse_args()
    need(os.environ.get('ISOLATED_MUTATION_AUTHORIZATION') == RUN)
    file = Path(args.contract)
    need(file.is_absolute() and not file.is_symlink() and file.is_file())
    need(file.stat().st_mode & 0o777 == 0o600)
    need(hashlib.sha256(file.read_bytes()).hexdigest() == args.digest)
    need(docker('info', '--format', '{{.ID}}').decode().strip() == ENGINE)
    source = inspect(SOURCE_ID)
    need(source['Id'] == SOURCE_ID and source['State']['Running'] and source['State']['Health']['Status'] == 'healthy')
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
    worker = None
    original_hba = None
    result = {'status': 'BLOCKED', 'scope': 'isolated-executor-migrate-truncate-app'}
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
        contract = json.loads(file.read_text())
        role = contract['role']
        need(re.fullmatch(r'[a-z_][a-z0-9_]*', role) is not None)
        def put_hba(data):
            p = subprocess.run(['docker', '--context', 'default', 'exec', '-i', created,
                'sh', '-c', 'cat > /var/lib/postgresql/data/pg_hba.conf'],
                input=data, capture_output=True, timeout=10)
            need(p.returncode == 0)
            docker('exec', created, 'pg_ctl', '-D', '/var/lib/postgresql/data', 'reload')
        original_hba = docker('exec', created, 'cat', '/var/lib/postgresql/data/pg_hba.conf')
        (evidence / 'original-pg_hba.conf').write_bytes(original_hba)
        put_hba(executor_hba(original_hba, role))
        need(docker('ps', '--no-trunc', '--filter', 'volume=' + OLD + '-data', '--format', '{{.ID}}').decode().strip() == created)
        worker = subprocess.Popen(['node', 'tools/dev/isolated-live.cjs', created,
            str(file), args.digest, str(evidence)], cwd=ROOT,
            env={**os.environ, 'NODE_ENV': 'test'}, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, start_new_session=True)
        try:
            stdout, _ = worker.communicate(timeout=420)
        finally:
            try:
                os.killpg(worker.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            worker.wait(timeout=10)
        result['acceptanceExitCode'] = worker.returncode
        if worker.returncode == 0:
            acceptance = json.loads(stdout)
            need(acceptance == {'status': 'PASS', 'sharedHelpers': True, 'readiness': True, 'skipped': 0})
            result['acceptance'] = acceptance
            result['status'] = 'PASS'
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        cleanup_errors = []
        if worker is not None:
            try:
                try:
                    os.killpg(worker.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                worker.wait(timeout=10)
            except Exception:
                cleanup_errors.append('worker-group-stop')
        if created:
            try:
                need(inspect(created)['Config']['Labels'].get('smartlearning.checkpoint') == RUN)
                try:
                    if original_hba is not None:
                        put_hba(original_hba)
                        result['hbaRestored'] = True
                finally:
                    docker('stop', '--time', '10', created)
                need(not inspect(created)['State']['Running'])
                result['ownedContainer'] = created
            except Exception:
                cleanup_errors.append('owned-stop-or-hba-restore')
        try:
            result['noRunningVolumeConsumers'] = not bool(docker('ps', '--filter',
                'volume=' + OLD + '-data', '--format', '{{.ID}}').strip())
            source = inspect(SOURCE_ID)
            result['sourceRunningHealthy'] = source['State']['Running'] and source['State']['Health']['Status'] == 'healthy'
            need(result['sourceRunningHealthy'] and result['noRunningVolumeConsumers'])
            with socket.socket() as sock:
                sock.settimeout(1)
                need(sock.connect_ex(('127.0.0.1', 55433)) != 0)
            result['isolatedPortClosed'] = True
        except Exception:
            cleanup_errors.append('postcheck')
        result['cleanupErrors'] = cleanup_errors
        if cleanup_errors:
            result['status'] = 'BLOCKED_CLEANUP'
        (evidence / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
    return 0 if result['status'] == 'PASS' else 2


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('BLOCKED: isolated mutation acceptance failed; preserve resources.', file=sys.stderr)
        sys.exit(1)
