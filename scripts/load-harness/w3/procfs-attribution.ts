import { readFile, readlink, readdir, realpath } from 'node:fs/promises';

export type ProcfsProcessIdentity = {
  pid: number;
  command: string[];
  cwd: string;
  executable: string;
  startIso: string;
};

export type ProcfsAttribution = {
  port: number;
  listenerPids: number[];
  process: ProcfsProcessIdentity;
  /** Other-user processes whose fd dirs could not be inspected (skipped, non-fatal). */
  inaccessibleFdCount: number;
};

export type ProcfsAdapter = {
  readFile: typeof readFile;
  readlink: typeof readlink;
  readdir: typeof readdir;
  realpath: typeof realpath;
  platform: NodeJS.Platform;
};

const defaultAdapter: ProcfsAdapter = {
  readFile,
  readlink,
  readdir,
  realpath,
  platform: process.platform,
};

function isEnoent(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT',
  );
}

function errnoCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code?: unknown }).code);
  }
  return undefined;
}

/** Skip-class errors: ENOENT (process/fd disappeared) and ELOOP (deleted target). */
function isSkipClass(error: unknown): boolean {
  const code = errnoCode(error);
  return code === 'ENOENT' || code === 'ELOOP';
}

/** Permission-class errors: skip the process, record it as inaccessible. */
function isAccessDenied(error: unknown): boolean {
  const code = errnoCode(error);
  return code === 'EACCES' || code === 'EPERM';
}

export function parseListeningSocketInodes(
  content: string,
  port: number,
): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('PROCFS_PORT_INVALID');
  const expectedPort = port.toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set<string>();
  for (const line of content.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const local = fields[1]?.split(':');
    if (local?.length !== 2) throw new Error('PROCFS_TCP_MALFORMED');
    if (local[1]?.toUpperCase() !== expectedPort || fields[3] !== '0A')
      continue;
    const inode = fields[9];
    if (!inode || !/^\d+$/.test(inode))
      throw new Error('PROCFS_TCP_INODE_MALFORMED');
    inodes.add(inode);
  }
  return [...inodes].sort();
}

export function parseProcStatStartTicks(content: string): bigint {
  const end = content.lastIndexOf(')');
  if (!content.startsWith('(') && !/^\d+\s+\(/.test(content))
    throw new Error('PROCFS_PROCESS_STAT_MALFORMED');
  if (end < 0) throw new Error('PROCFS_PROCESS_STAT_MALFORMED');
  const tail = content
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  // tail[0] is field 3 (state); field 22 is therefore tail[19].
  const raw = tail[19];
  if (!raw || !/^\d+$/.test(raw))
    throw new Error('PROCFS_PROCESS_START_MALFORMED');
  return BigInt(raw);
}

export function parseBootTimeSeconds(content: string): bigint {
  const match = /^btime\s+(\d+)$/m.exec(content);
  if (!match?.[1]) throw new Error('PROCFS_BOOT_TIME_MISSING');
  return BigInt(match[1]);
}

export function processStartIso(
  bootSeconds: bigint,
  startTicks: bigint,
  clockTicksPerSecond: number,
): string {
  if (!Number.isInteger(clockTicksPerSecond) || clockTicksPerSecond <= 0)
    throw new Error('PROCFS_CLOCK_TICKS_INVALID');
  const millis =
    Number(bootSeconds) * 1_000 +
    (Number(startTicks) * 1_000) / clockTicksPerSecond;
  if (!Number.isFinite(millis)) throw new Error('PROCFS_PROCESS_START_INVALID');
  return new Date(millis).toISOString();
}

async function readRequired(
  path: string,
  adapter: ProcfsAdapter,
): Promise<string> {
  try {
    return await adapter.readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `${isEnoent(error) ? 'PROCFS_STATE_DISAPPEARED' : 'PROCFS_READ_FAILED'}:${path}`,
    );
  }
}

async function resolveListenerPids(
  inodes: Set<string>,
  childPid: number,
  adapter: ProcfsAdapter,
): Promise<{ pids: number[]; inaccessibleFdCount: number }> {
  let entries: string[];
  try {
    entries = await adapter.readdir('/proc');
  } catch {
    throw new Error('PROCFS_ENUMERATION_FAILED');
  }
  const pids = new Set<number>();
  let inaccessibleFdCount = 0;
  for (const entry of entries.filter((value) => /^\d+$/.test(value))) {
    const fdDir = `/proc/${entry}/fd`;
    let fds: string[];
    try {
      fds = await adapter.readdir(fdDir);
    } catch (error) {
      // The child's own fd directory must be provable; anything else is
      // skip-class (disappeared) or a permission skip for another user.
      if (Number(entry) === childPid || isEnoent(error)) {
        if (isEnoent(error)) continue;
        throw new Error(`PROCFS_FD_ENUMERATION_FAILED:${entry}`);
      }
      if (isSkipClass(error)) continue;
      if (isAccessDenied(error)) {
        inaccessibleFdCount += 1;
        continue;
      }
      throw new Error(`PROCFS_FD_ENUMERATION_FAILED:${entry}`);
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = await adapter.readlink(`${fdDir}/${fd}`);
      } catch (error) {
        if (isSkipClass(error)) continue;
        if (isAccessDenied(error)) {
          inaccessibleFdCount += 1;
          break;
        }
        throw new Error(`PROCFS_FD_READ_FAILED:${entry}`);
      }
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match?.[1] && inodes.has(match[1])) pids.add(Number(entry));
    }
  }
  return { pids: [...pids].sort((a, b) => a - b), inaccessibleFdCount };
}

export async function inspectProcfsAttribution(
  childPid: number,
  port: number,
  clockTicksPerSecond: number,
  adapter: ProcfsAdapter = defaultAdapter,
): Promise<ProcfsAttribution> {
  if (adapter.platform !== 'linux')
    throw new Error('PROCFS_PLATFORM_UNSUPPORTED');
  if (!Number.isInteger(childPid) || childPid <= 0)
    throw new Error('BACKEND_PID_MISSING');

  const [tcp, tcp6] = await Promise.all([
    readRequired('/proc/net/tcp', adapter),
    readRequired('/proc/net/tcp6', adapter),
  ]);
  const inodes = new Set([
    ...parseListeningSocketInodes(tcp, port),
    ...parseListeningSocketInodes(tcp6, port),
  ]);
  if (inodes.size === 0) throw new Error('LISTENER_NOT_FOUND');
  const { pids: listenerPids, inaccessibleFdCount } = await resolveListenerPids(
    inodes,
    childPid,
    adapter,
  );
  if (listenerPids.length === 0) throw new Error('LISTENER_OWNER_NOT_FOUND');
  if (listenerPids.length !== 1) throw new Error('MULTIPLE_LISTENER_PIDS');

  const [cmdlineRaw, cwd, executable, statContent, procStat] =
    await Promise.all([
      readRequired(`/proc/${childPid}/cmdline`, adapter),
      adapter.realpath(`/proc/${childPid}/cwd`).catch(() => {
        throw new Error('PROCFS_CWD_READ_FAILED');
      }),
      adapter.realpath(`/proc/${childPid}/exe`).catch(() => {
        throw new Error('PROCFS_EXE_READ_FAILED');
      }),
      readRequired(`/proc/${childPid}/stat`, adapter),
      readRequired('/proc/stat', adapter),
    ]);
  const command = cmdlineRaw.split('\0').filter(Boolean);
  if (command.length === 0) throw new Error('PROCFS_COMMAND_MISSING');

  return {
    port,
    listenerPids,
    inaccessibleFdCount,
    process: {
      pid: childPid,
      command,
      cwd,
      executable,
      startIso: processStartIso(
        parseBootTimeSeconds(procStat),
        parseProcStatStartTicks(statContent),
        clockTicksPerSecond,
      ),
    },
  };
}
