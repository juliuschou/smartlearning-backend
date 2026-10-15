#!/usr/bin/env python3
"""Gated fresh-baseline entry. Default invocation is repository-only review."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys

import importlib.util
_spec = importlib.util.spec_from_file_location('checkpoint_f', Path(__file__).with_name('checkpoint-f.py'))
f = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(f)
env_module = f.load('checkpoint_f_env', 'checkpoint-f-env.py')
require = f.require
CREDENTIAL_DECISION = 'separated-roles'
PRIVILEGE = 'separate-bootstrap-migration-application-roles'
BACKUP = Path('/home/user/.local/share/smartlearning') / f.contract.RUN
EVIDENCE = f.contract.REPO / 'artifacts/local-env' / f.contract.RUN


def contract_hash(plan):
    return hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def timestamp():
    return datetime.now(timezone.utc).isoformat()


class Journal:
    """Exclusive protected files; each event is durable before proceeding."""
    def __init__(self, directory):
        directory = Path(directory)
        env_module.parents_safe(directory)
        os.mkdir(directory, 0o700)
        self.events_fd = self.outcome_fd = None
        self.sequence = 0
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
            self.events_fd = os.open(directory / 'lifecycle.jsonl', flags, 0o600)
            self.outcome_fd = os.open(directory / 'outcome.json', flags, 0o600)
            env_module.sync_dir(directory)
            env_module.sync_dir(directory.parent)
        except Exception:
            self.close()
            raise

    @staticmethod
    def write(fd, value):
        data = (json.dumps(value, sort_keys=True) + '\n').encode()
        while data:
            count = os.write(fd, data)
            require(count > 0, 'Evidence write blocked')
            data = data[count:]
        os.fsync(fd)

    def event(self, event, *, operation='none', ids=None, contract_sha256=None):
        require(event in {'begin', 'before', 'after', 'failed', 'recovered', 'rollback', 'docker-event'}, 'Invalid event')
        require(operation in {'none', 'query', 'create', 'start', 'stop', 'volume-create', 'sql', 'migration', 'events', 'create-failed', 'start-failed', 'stop-failed', 'die', 'kill', 'destroy'}, 'Invalid operation')
        ids = ids or {}
        require(all(k in ('helper', 'pg') and re.fullmatch('[a-f0-9]{64}', v) for k, v in ids.items()), 'Invalid evidence ID')
        require(contract_sha256 is None or re.fullmatch('[a-f0-9]{64}', contract_sha256), 'Invalid contract hash')
        self.sequence += 1
        self.write(self.events_fd, {'sequence': self.sequence, 'at': timestamp(), 'event': event,
                                    'operation': operation, 'ids': dict(ids), 'contractSha256': contract_sha256})

    def outcome(self, value):
        self.write(self.outcome_fd, value)

    def close(self):
        for name in ('events_fd', 'outcome_fd'):
            fd = getattr(self, name, None)
            if fd is not None:
                os.close(fd)
                setattr(self, name, None)


class RecordedExecutor(f.Executor):
    def __init__(self, expected, *, journal, **kwargs):
        super().__init__(expected, **kwargs)
        self.journal = journal
        self.recording_failed = False
        self.rolling_back = False
        self.rollback_errors = []
        self.rollback_attempted = False
        self.unresolved = []
        self.since = str(int(datetime.now(timezone.utc).timestamp()))

    def record(self, event, operation='none'):
        try:
            self.journal.event(event, operation=operation, ids=self.ids)
        except Exception:
            self.recording_failed = True
            if not self.rolling_back:
                raise ValueError('Lifecycle recording blocked') from None

    def command(self, argv, data=None, timeout=30, env=None):
        operation = 'query'
        if argv[0] == 'docker':
            verb = argv[3]
            operation = verb if verb in ('create', 'start', 'stop') else 'query'
            if argv[3:5] == ['volume', 'create']:
                operation = 'volume-create'
            if verb == 'exec':
                operation = 'sql'
            if verb == 'events':
                operation = 'events'
        elif 'deploy' in argv:
            operation = 'migration'
        self.record('before', operation)
        try:
            result = super().command(argv, data, timeout, env)
        except Exception:
            self.record('failed', operation)
            raise
        # Docker create may have succeeded even if its response or recorder fails.
        if operation == 'create' and re.fullmatch('[a-f0-9]{64}', result.strip()):
            key = 'helper' if argv[argv.index('--name') + 1].endswith('-secret-helper') else 'pg'
            self.ids[key] = result.strip()
        self.record('after', operation)
        return result

    def docker(self, *args, data=None):
        if not args or args[0] != 'create':
            return super().docker(*args, data=data)
        key = 'helper' if args[args.index('--name') + 1].endswith('-secret-helper') else 'pg'
        try:
            result = super().docker(*args, data=data)
            require(re.fullmatch('[a-f0-9]{64}', result.strip()), 'Invalid create response')
            return result
        except Exception:
            # Recover only the exact reserved name, pinned runtime and fully checked resource.
            was_rollback = self.rolling_back
            self.rolling_back = True
            try:
                self.runtime_identity()
                c = self.inspect('container', args[args.index('--name') + 1])
                cid = c['Id']
                require(re.fullmatch('[a-f0-9]{64}', cid), 'Invalid recovered ID')
                self.ids[key] = cid
                self.verify_container(cid, key == 'helper')
                self.record('recovered', 'create')
            except Exception:
                self.unresolved.append(key)
            finally:
                self.rolling_back = was_rollback
            raise ValueError('Create response blocked; recovery required') from None

    def rollback(self):
        self.rolling_back = True
        self.rollback_attempted = True
        try:
            self.record('rollback')
            self.rollback_errors = super().rollback()
            return self.rollback_errors
        finally:
            self.rolling_back = False

    def capture_events(self):
        self.runtime_identity()
        until = str(int(datetime.now(timezone.utc).timestamp()) + 1)
        output = self.docker('events', '--since', self.since, '--until', until,
                             '--filter', 'label=' + self.p['label'], '--format', '{{json .}}')
        for line in output.splitlines():
            item = json.loads(line)
            action = item.get('Action')
            cid = item.get('Actor', {}).get('ID')
            if item.get('Type') == 'container' and cid in self.ids.values() and action in ('create', 'start', 'stop', 'die', 'kill', 'destroy'):
                self.record('docker-event', action)


def execute(plan, *, approval, privilege, exclusive, expected_hash, journal, executor_factory=RecordedExecutor):
    require(approval == f.APPROVAL and privilege == PRIVILEGE and exclusive, 'Scoped approval/privilege/exclusivity required')
    require(expected_hash == contract_hash(plan) and plan == f.contract.plan(), 'Reviewed contract drift')
    transaction = env_module.EnvTransaction(f.contract.REPO / '.env.development', BACKUP)
    executor = executor_factory(plan, journal=journal, transaction=transaction)
    status = 'BLOCKED'
    try:
        journal.event('begin', contract_sha256=expected_hash)
        executor.execute(approval, exclusive_env_access=True)
        executor.capture_events()
        require(executor.verify_container(executor.ids['pg'])['State']['Running'], 'Final PG not running')
        require(not executor.recording_failed, 'Recording failed')
        status = 'VERIFIED'
    except Exception:
        # F already rolls back execution errors. Event-capture errors occur afterwards.
        if not executor.rollback_attempted:
            executor.rollback()
        try:
            executor.capture_events()
        except Exception:
            executor.recording_failed = True
    finally:
        value = {'status': status, 'contractSha256': expected_hash, 'ids': dict(executor.ids),
                 'stages': list(executor.stages), 'recordingFailed': executor.recording_failed,
                 'rollback': executor.rollback_errors, 'unresolvedCreate': executor.unresolved,
                 'at': timestamp()}
        try:
            journal.outcome(value)
        except Exception:
            executor.rollback()
            raise ValueError('Outcome persistence blocked; review retained resources') from None
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--approval')
    parser.add_argument('--privilege')
    parser.add_argument('--contract-sha256')
    parser.add_argument('--exclusive-env-and-resources', action='store_true')
    args = parser.parse_args()
    plan = f.contract.plan()
    if not args.execute:
        print(json.dumps({'status': 'REVIEW_ONLY', 'contractSha256': contract_hash(plan),
                          'credentialDecision': CREDENTIAL_DECISION, 'liveEnabled': CREDENTIAL_DECISION == 'separated-roles',
                          'privilegeRequired': PRIVILEGE, 'approvalScope': f.APPROVAL}))
        return 0
    # Gate before any evidence/env/runtime access; Python arguments never prove human approval.
    require(CREDENTIAL_DECISION == 'separated-roles', 'Credential decision pending')
    require(args.approval == f.APPROVAL and args.privilege == PRIVILEGE and
            args.exclusive_env_and_resources and args.contract_sha256 == contract_hash(plan), 'Live gate blocked')
    journal = Journal(EVIDENCE)
    try:
        result = execute(plan, approval=args.approval, privilege=args.privilege,
                         exclusive=args.exclusive_env_and_resources,
                         expected_hash=args.contract_sha256, journal=journal)
        print(json.dumps(result))
        return 0 if result['status'] == 'VERIFIED' else 1
    finally:
        journal.close()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('BLOCKED: gated entry or evidence failure; inspect retained evidence', file=sys.stderr)
        sys.exit(1)
