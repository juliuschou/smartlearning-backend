"""Protected env transaction; caller must guarantee exclusive edit access.

Hash rechecks detect prior concurrent edits; they cannot exclude a writer racing
between the final check and rename. No file contents or credentials are logged.
"""
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import stat
import tempfile

_spec = importlib.util.spec_from_file_location('checkpoint_e', Path(__file__).with_name('checkpoint-e.py'))
_e = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_e)


def digest(content):
    return hashlib.sha256(content).hexdigest()


def parents_safe(path):
    for parent in [path.parent, *path.parent.parents]:
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise ValueError('Unsafe parent directory')


def read_safe(path, protected=False):
    parents_safe(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError('Unsafe file ownership or type')
        if stat.S_IMODE(info.st_mode) & 0o077:
            raise ValueError('Unsafe file permissions')
        if protected and stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('Unsafe protected file permissions')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return stream.read()
    finally:
        os.close(fd)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class EnvTransaction:
    def __init__(self, path, backup_dir):
        self.path = Path(os.path.abspath(path))
        self.backup_dir = Path(os.path.abspath(backup_dir))
        self.backup = self.backup_dir / 'env.original'
        self.before_replace = None
        self.state = 'new'

    def _backup_safe(self):
        parents_safe(self.backup)
        info = self.backup_dir.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise ValueError('Unsafe backup directory')
        data = read_safe(self.backup, protected=True)
        if digest(data) != self.original_hash:
            raise ValueError('Backup changed')
        if hasattr(self, 'migration_hash') and digest(read_safe(self.backup_dir / 'migration.url', protected=True)) != self.migration_hash:
            raise ValueError('Migration credential changed')
        return data

    def prepare(self, url, *, migration_url=None):
        if self.state != 'new':
            raise ValueError('Transaction already prepared')
        if not isinstance(url, str) or not re.fullmatch(
                r'postgresql://smartlearning_dev_app:[0-9a-f]{64}@127\.0\.0\.1:5433/smartlearning_dev', url):
            raise ValueError('Invalid target URL')
        if migration_url is not None and (not isinstance(migration_url, str) or not re.fullmatch(
                r'postgresql://smartlearning_dev_migrator:[0-9a-f]{64}@127\.0\.0\.1:5433/smartlearning_dev', migration_url)):
            raise ValueError('Invalid migration URL')
        repo = Path(__file__).resolve().parents[2]
        if self.backup_dir == repo or repo in self.backup_dir.parents:
            raise ValueError('Backup must be outside the repository')
        original = read_safe(self.path)
        parents_safe(self.backup_dir)
        os.mkdir(self.backup_dir, 0o700)
        os.chmod(self.backup_dir, 0o700)
        fd = os.open(self.backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(original)
                stream.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
        if migration_url is not None:
            fd = os.open(self.backup_dir / 'migration.url', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, 'wb', closefd=False) as stream:
                    stream.write(migration_url.encode())
                    stream.flush()
                    os.fsync(fd)
            finally:
                os.close(fd)
            self.migration_hash = digest(migration_url.encode())
        sync_dir(self.backup_dir)
        sync_dir(self.backup_dir.parent)
        self.original_hash = digest(original)
        # Preserve literal newline style by decoding bytes directly.
        self.replacement = _e.replace_connections(original.decode('utf-8'), url).encode('utf-8')
        self.written_hash = digest(self.replacement)
        self.state = 'prepared'

    def _replace(self, data, expected_hash, state):
        parents_safe(self.path)
        fd, temporary = tempfile.mkstemp(prefix='.checkpoint-f-', dir=self.path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(data)
                stream.flush()
                os.fsync(fd)
            if self.before_replace:
                self.before_replace()
            if digest(read_safe(self.path)) != expected_hash:
                raise ValueError('Env changed; refusing replacement')
            os.replace(temporary, self.path)
            self.state = state
            sync_dir(self.path.parent)
        finally:
            os.close(fd)
            if os.path.lexists(temporary):
                os.unlink(temporary)

    def commit(self):
        if self.state != 'prepared':
            raise ValueError('Transaction not prepared')
        self._backup_safe()
        self._replace(self.replacement, self.original_hash, 'committed')
        self.state = 'committed'

    def verify_written(self, url):
        if self.state != 'committed':
            raise ValueError('Transaction not committed')
        self._backup_safe()
        data = read_safe(self.path, protected=True)
        if digest(data) != self.written_hash:
            raise ValueError('Written env changed')
        # The pure transform validates assignment syntax and uniqueness. Equality
        # requires every supported connection assignment to already match url.
        if not isinstance(url, str) or not re.fullmatch(
                r'postgresql://smartlearning_dev_app:[0-9a-f]{64}@127\.0\.0\.1:5433/smartlearning_dev', url):
            raise ValueError('Invalid target URL')
        if _e.replace_connections(data.decode('utf-8'), url).encode('utf-8') != data:
            raise ValueError('Written connection target mismatch')

    def restore(self):
        if self.state in ('new', 'prepared'):
            return
        if self.state != 'committed':
            raise ValueError('Transaction not committed')
        original = self._backup_safe()
        self._replace(original, self.written_hash, 'restored')
        self.state = 'restored'
