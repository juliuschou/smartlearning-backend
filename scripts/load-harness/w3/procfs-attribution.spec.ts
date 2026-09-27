import assert from 'node:assert/strict';
import {
  inspectProcfsAttribution,
  parseBootTimeSeconds,
  parseListeningSocketInodes,
  parseProcStatStartTicks,
  processStartIso,
  type ProcfsAdapter,
} from './procfs-attribution';

const tcp = (portHex: string, inode: string, state = '0A') =>
  `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:${portHex} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode}\n`;

assert.deepEqual(parseListeningSocketInodes(tcp('0F9F', '123'), 3999), ['123']);
assert.deepEqual(
  parseListeningSocketInodes(tcp('0F9F', '123', '01'), 3999),
  [],
);
assert.deepEqual(
  parseListeningSocketInodes(
    `${tcp('0F9F', '123')}   1: 00000000000000000000000000000000:0F9F 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 123\n`,
    3999,
  ),
  ['123'],
);
assert.equal(
  parseProcStatStartTicks(
    '42 (node worker (x)) S ' + Array(18).fill('0').join(' ') + ' 250 0',
  ),
  250n,
);
assert.equal(parseBootTimeSeconds('cpu 1 2 3\nbtime 1000\n'), 1000n);
assert.equal(processStartIso(1000n, 250n, 100), '1970-01-01T00:16:42.500Z');

const files = new Map<string, string>([
  ['/proc/net/tcp', tcp('0F9F', '123')],
  ['/proc/net/tcp6', tcp('0000', '999')],
  ['/proc/42/cmdline', '/usr/bin/node\0dist/src/main.js\0'],
  [
    '/proc/42/stat',
    '42 (node worker (x)) S ' + Array(18).fill('0').join(' ') + ' 250 0',
  ],
  ['/proc/stat', 'cpu 1 2 3\nbtime 1000\n'],
]);
const adapter: ProcfsAdapter = {
  platform: 'linux',
  readFile: (async (path: string) => {
    const value = files.get(path);
    if (value === undefined)
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return value;
  }) as ProcfsAdapter['readFile'],
  readdir: (async (path: string) => {
    if (path === '/proc') return ['1', '42', '7', 'self'];
    if (path === '/proc/1/fd') return [];
    if (path === '/proc/42/fd') return ['5'];
    // PID 7 simulates another user's fd dir denied by permission.
    if (path === '/proc/7/fd')
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }) as ProcfsAdapter['readdir'],
  readlink: (async (path: string) => {
    if (path === '/proc/42/fd/5') return 'socket:[123]';
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }) as ProcfsAdapter['readlink'],
  realpath: (async (path: string) => {
    if (path === '/proc/42/cwd') return '/repo';
    if (path === '/proc/42/exe') return '/usr/bin/node';
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }) as ProcfsAdapter['realpath'],
};

async function main(): Promise<void> {
  const observed = await inspectProcfsAttribution(42, 3999, 100, adapter);
  assert.deepEqual(observed.listenerPids, [42]);
  assert.deepEqual(observed.process.command, [
    '/usr/bin/node',
    'dist/src/main.js',
  ]);
  assert.equal(observed.process.cwd, '/repo');
  assert.equal(observed.process.startIso, '1970-01-01T00:16:42.500Z');
  // Permission-denied fd dirs of other processes are skipped and counted,
  // not fatal: the child is same-user and cannot be hidden by them.
  assert.equal(observed.inaccessibleFdCount, 1);

  // A permission failure on the child's own fd directory IS fatal.
  const childDenied: ProcfsAdapter = {
    ...adapter,
    readdir: (async (path: string) => {
      if (path === '/proc/42/fd')
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (path === '/proc') return ['42'];
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }) as ProcfsAdapter['readdir'],
  };
  await assert.rejects(
    inspectProcfsAttribution(42, 3999, 100, childDenied),
    /PROCFS_FD_ENUMERATION_FAILED/,
  );

  await assert.rejects(
    inspectProcfsAttribution(42, 3999, 100, { ...adapter, platform: 'darwin' }),
    /PROCFS_PLATFORM_UNSUPPORTED/,
  );
  await assert.rejects(
    inspectProcfsAttribution(42, 4000, 100, adapter),
    /LISTENER_NOT_FOUND/,
  );

  console.log('W3 procfs attribution tests passed.');
}

void main().then(undefined, (error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
