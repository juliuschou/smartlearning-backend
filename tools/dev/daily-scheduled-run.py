#!/usr/bin/env python3
"""Pinned noninteractive launcher; preserves only the WSL interop transport."""
import os
from pathlib import Path
import sys

ROOT = Path('/home/user/projects/smartLearning/smartLearning-backend')
if Path(__file__).resolve().parents[2] != ROOT or os.getuid() != 1000:
    raise SystemExit('Pinned repository/user mismatch')
if sys.argv[1:] not in ([], ['--safe-preflight-failure']):
    raise SystemExit('Unsupported scheduled arguments')
environment = {'HOME': '/home/user', 'USER': 'user', 'LANG': 'C.UTF-8',
               'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/mnt/c/Windows/System32/WindowsPowerShell/v1.0/:/mnt/c/Users/USER/AppData/Local/Programs/Rancher Desktop/resources/resources/linux/bin'}
for key in ('WSL_INTEROP', 'WSL_DISTRO_NAME'):
    if key in os.environ:
        environment[key] = os.environ[key]
os.chdir(ROOT)
os.execve('/usr/bin/python3', ['/usr/bin/python3', '-B', 'tools/dev/daily-backup.py', 'run', *sys.argv[1:]], environment)
