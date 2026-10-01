import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { promisify } from 'node:util';
import { Client } from 'pg';
import {
  createW3RunId,
  w3RunEnvironment,
  W3_ACCEPTANCE_PARTICIPANTS,
} from './load-harness/w3/run-contract';
import {
  TraceClient,
  type TraceSnapshot,
} from './load-harness/w3/trace-client';
import {
  validateAttributionPreflight,
  validateTracePreflight,
  type ExternalCompetitorObservation,
  type W3AttributionEvidence,
} from './load-harness/w3/trace-preflight';
import {
  inspectProcfsAttribution,
  type ProcfsAttribution,
} from './load-harness/w3/procfs-attribution';

/** Bounded capture for a fixture child's streams (descriptor is small). */
const CHILD_CAPTURE_LIMIT = 64 * 1024;
const execFileAsync = promisify(execFile);
const ATTRIBUTION_SCHEMA_VERSION = 1;
const SECRET_LIKE_DESCRIPTOR_FIELDS = new Set([
  'password',
  'secret',
  'token',
  'credentialValue',
]);

export type W3FixtureChildResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type W3FixtureDescriptor = {
  runId: string;
  questionType: 'poll' | 'quiz';
  username: string;
  courseId: string;
  questionId: string;
  liveSessionId: string;
  sessionQuestionId: string;
  sessionCode: string;
  options: Array<{ id: string; optionRef: string | null; isCorrect: boolean }>;
  credentialPresent: boolean;
  credentialFile: string;
};

export type W3ExitEvidence = {
  fixture: { spawned: boolean; status: number | null };
  driver: { spawned: boolean; status: number | null };
  startedAt: string;
  finishedAt: string;
  backendPid?: number;
  attributionFailureCode?: string;
  blockedReason?: string;
  protectedBaselineBefore?: ProtectedBaseline;
  protectedBaselineAfterBackendStart?: ProtectedBaseline;
  protectedBaselineAfterRun?: ProtectedBaseline;
};

/** Read-only protected-baseline counts (§12). Exact counts, no mutation. */
export type ProtectedBaseline = {
  closedSessions: number;
  participants: number;
  submissions: number;
  deliveredEvents: number;
};

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assertSafeTarget(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'test')
    throw new Error('W3 orchestration requires NODE_ENV=test.');
  if (!env.DATABASE_URL?.includes('smartlearning_test'))
    throw new Error('DATABASE_URL must target smartlearning_test.');
  if (!env.LOAD_CORS_ORIGIN) throw new Error('LOAD_CORS_ORIGIN is required.');
}

function withApplicationName(
  databaseUrl: string,
  applicationName: string,
): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

/** PostgreSQL truncates application_name to 63 bytes; every child name obeys it. */
const APPLICATION_NAME_LIMIT = 63;

/**
 * Distinct, run-scoped PostgreSQL application_names for attribution. Each W3
 * child shares the run environment but gets its own application_name so backend,
 * fixture, and driver sessions are separable in `pg_stat_activity` — and are not
 * mistaken for external competitors. Attribution metadata only; no workload
 * semantics change. `observer` is the reserved identity for the not-yet-wired
 * DbWaitObserver (contract only).
 */
export function w3ApplicationNames(runId: string): {
  backend: string;
  fixture: string;
  driver: string;
  observer: string;
} {
  const scoped = (prefix: string): string =>
    `${prefix}-${runId}`.slice(0, APPLICATION_NAME_LIMIT);
  return {
    backend: scoped('w3-backend'),
    fixture: scoped('w3-fixture'),
    driver: scoped('w3-driver'),
    observer: scoped('w3-db-wait'),
  };
}

/**
 * Application_names owned by this run, used to exclude W3 sessions from the
 * external-competitor scan. Exact run-scoped identities only — a
 * `w3-backend-<otherRun>` session is NOT owned and remains a competitor.
 */
export function w3OwnedApplicationNames(runId: string): string[] {
  const names = w3ApplicationNames(runId);
  return [names.backend, names.fixture, names.driver, names.observer];
}

function localPort(baseUrl: string, configuredPort: string): number {
  const url = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname))
    throw new Error('W3 attribution requires a loopback LOAD_BASE_URL.');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port !== Number(configuredPort))
    throw new Error('LOAD_BASE_URL port does not match PORT.');
  return port;
}

function boundedIdentity(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Ancestry of process.pid via /proc/<pid>/stat PPID chain. These processes
 * (tsx runner, npm, shell) legitimately contain harness path strings in their
 * argv and must not be classified as competitors.
 */
async function ownAncestry(): Promise<Set<number>> {
  const ancestry = new Set<number>([process.pid]);
  let current = process.pid;
  for (let depth = 0; depth < 32; depth += 1) {
    let statContent: string;
    try {
      statContent = await readFile(`/proc/${current}/stat`, 'utf8');
    } catch {
      break;
    }
    const end = statContent.lastIndexOf(')');
    if (end < 0) break;
    const fields = statContent
      .slice(end + 1)
      .trim()
      .split(/\s+/);
    const ppid = Number(fields[1]);
    if (!Number.isInteger(ppid) || ppid <= 0 || ancestry.has(ppid)) break;
    ancestry.add(ppid);
    current = ppid;
  }
  return ancestry;
}

async function inspectHostCompetitors(childPid: number): Promise<string[]> {
  const competitors: string[] = [];
  const excluded = await ownAncestry();
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    throw new Error('Host process inventory is unavailable.');
  }
  for (const entry of entries.filter((value) => /^\d+$/.test(value))) {
    const pid = Number(entry);
    if (pid === childPid || excluded.has(pid)) continue;
    let command: string;
    try {
      command = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      )
        continue;
      throw new Error(`Host process inventory failed for PID ${pid}.`);
    }
    const argv = command.split('\0').filter(Boolean);
    const rendered = argv.join(' ');
    // Anchor matching on argv path tokens, not anywhere-in-line, to reduce
    // false positives from incidental substring matches.
    const isBackend =
      argv.some((token) => /(?:^|\/)dist\/src\/main(?:\.js)?$/.test(token)) ||
      argv.some(
        (token) =>
          /(?:^|\/)run-w3\.ts$/.test(token) ||
          token.endsWith('scripts/run-w3.ts'),
      );
    if (isBackend) competitors.push(`${pid}:${boundedIdentity(rendered)}`);
  }
  return competitors.slice(0, 8);
}

async function inspectDockerCompetitors(): Promise<string[]> {
  let ids: string[];
  try {
    const { stdout } = await execFileAsync('docker', [
      'ps',
      '--no-trunc',
      '--format',
      '{{.ID}}',
    ]);
    ids = stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    throw new Error('Docker competitor inventory is unavailable.');
  }
  if (ids.length === 0) return [];
  const testDbContainer =
    process.env.W3_TEST_DB_CONTAINER ?? 'smart-learning-pg-test';
  const { stdout: testNetworksRaw } = await execFileAsync('docker', [
    'inspect',
    testDbContainer,
    '--format',
    '{{json .NetworkSettings.Networks}}',
  ]);
  const testNetworks = new Set(
    Object.keys(JSON.parse(testNetworksRaw.trim()) as Record<string, unknown>),
  );
  const competitors: string[] = [];
  for (const id of ids) {
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      id,
      '--format',
      '{{json .Name}}|{{json .Config.Cmd}}|{{json .NetworkSettings.Networks}}',
    ]);
    const first = stdout.indexOf('|');
    const second = stdout.indexOf('|', first + 1);
    if (first < 0 || second < 0)
      throw new Error('Docker competitor inventory returned malformed data.');
    const name = JSON.parse(stdout.slice(0, first)) as string;
    const command = JSON.parse(stdout.slice(first + 1, second)) as
      string[] | null;
    const networks = Object.keys(
      JSON.parse(stdout.slice(second + 1).trim()) as Record<string, unknown>,
    );
    if (
      (command ?? []).join(' ').includes('dist/src/main') &&
      networks.some((network) => testNetworks.has(network))
    )
      competitors.push(boundedIdentity(name));
  }
  return competitors.slice(0, 8);
}

/**
 * Read-only protected-baseline counts (§12). Exact counts only; the values are
 * recorded before the run and again after the run so a baseline-side-effect can
 * be distinguished from cleanup. This never mutates the database.
 */
export async function readProtectedBaseline(
  databaseUrl: string,
): Promise<ProtectedBaseline> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const one = async (sql: string): Promise<number> =>
      Number((await client.query<{ n: string }>(sql)).rows[0].n);
    return {
      closedSessions: await one(
        `SELECT count(*)::int AS n FROM live_session WHERE status = 'closed'`,
      ),
      participants: await one(`SELECT count(*)::int AS n FROM participant`),
      submissions: await one(`SELECT count(*)::int AS n FROM submission`),
      deliveredEvents: await one(
        `SELECT count(*)::int AS n FROM live_session_event WHERE delivery_state = 'delivered'`,
      ),
    };
  } finally {
    await client.end();
  }
}

async function observeExternalCompetitors(
  childPid: number,
  databaseUrl: string,
  runId: string,
): Promise<ExternalCompetitorObservation> {
  const applicationName = `w3-orchestrator-${runId}`.slice(0, 63);
  const client = new Client({
    connectionString: withApplicationName(databaseUrl, applicationName),
  });
  await client.connect();
  try {
    const [sessions, claims, locks, processes, containers] = await Promise.all([
      // W3-owned sessions (this run's backend/fixture/driver/observer) are not
      // competitors. Ownership is exact to this runId — never prefix-based, so a
      // `w3-backend-<otherRun>` session stays a competitor.
      client.query<{
        pid: number;
        application_name: string;
        client_addr: string | null;
      }>(
        `SELECT pid, application_name, client_addr::text
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND application_name <> ALL($1::text[])
          ORDER BY pid`,
        // The orchestrator's own observer session is self-excluded by
        // `pid <> pg_backend_pid()`; the reserved observer identity is included
        // so wiring DbWaitObserver later stays a competitor-free no-op.
        [w3OwnedApplicationNames(runId)],
      ),
      client.query<{ id: string; claim_token: string | null }>(
        `SELECT id, claim_token
           FROM live_session_event
          WHERE delivery_state = 'processing'
          ORDER BY id
          LIMIT 9`,
      ),
      client.query<{ pid: number; classid: string; objid: string }>(
        `SELECT pid, classid::text, objid::text
           FROM pg_locks
          WHERE locktype = 'advisory' AND granted
          ORDER BY pid, classid, objid
          LIMIT 9`,
      ),
      inspectHostCompetitors(childPid),
      inspectDockerCompetitors(),
    ]);
    return {
      observedAtIso: new Date().toISOString(),
      externalPublisherExclusivity: 'observational',
      competingProcesses: processes,
      competingContainers: containers,
      competingDatabaseSessions: sessions.rows
        .slice(0, 8)
        .map((row) =>
          boundedIdentity(
            `${row.pid}:${row.application_name || '<empty>'}:${row.client_addr ?? '<local>'}`,
          ),
        ),
      activeOutboxClaims: claims.rows
        .slice(0, 8)
        .map((row) =>
          boundedIdentity(
            `${row.id}:${row.claim_token ? 'claimed' : 'missing-token'}`,
          ),
        ),
      conflictingAdvisoryLocks: locks.rows
        .slice(0, 8)
        .map((row) =>
          boundedIdentity(`${row.pid}:${row.classid}:${row.objid}`),
        ),
    };
  } finally {
    await client.end();
  }
}

async function waitForHealth(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health/live`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('W3 backend health preflight failed.');
}

function runChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Fixture child seam: captures bounded stdout/stderr instead of inheriting
 * stdio so the descriptor JSON can be validated and persisted by the
 * orchestrator (the driver's required `W3_FIXTURE_PATH` contract).
 */
function runFixtureChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<W3FixtureChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = (stream: NodeJS.ReadableStream): Promise<string> => {
      let text = '';
      let truncated = false;
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        if (text.length < CHILD_CAPTURE_LIMIT) {
          text += chunk.slice(0, CHILD_CAPTURE_LIMIT - text.length);
        } else {
          truncated = true;
        }
      });
      return new Promise<string>((done) =>
        stream.once('end', () => {
          if (truncated)
            text += `\n[truncated at ${CHILD_CAPTURE_LIMIT} bytes]`;
          done(text);
        }),
      );
    };
    const stdoutPromise = capture(child.stdout!);
    const stderrPromise = capture(child.stderr!);
    child.once('error', reject);
    child.once('close', async (code) => {
      resolve({
        status: code ?? 1,
        stdout: await stdoutPromise,
        stderr: await stderrPromise,
      });
    });
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
}

/**
 * Bounded, secret-safe diagnostic excerpt for failure surfacing: first line
 * only, with credential-ish material (base64/hex secrets, URLs embedding
 * credentials) replaced before the length cap.
 */
function redactDiagnostic(raw: string): string {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return '';
  return firstLine
    .replace(/:\/\/[^\s]*@[^\s]*/g, '://[redacted-url]')
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, '[redacted-secret]')
    .replace(/[0-9a-f]{40,}/gi, '[redacted-secret]')
    .slice(0, 300);
}

/**
 * Orchestrator-side structural validation of the fixture descriptor.
 * Allowlist-based: required identifiers, credential presence/path binding,
 * and rejection of known secret-like fields. The driver keeps its own
 * contract; this mirrors (not replaces) it without modifying the driver file.
 */
export function validateFixtureDescriptor(
  raw: string,
  credentialOut: string,
): W3FixtureDescriptor {
  if (!raw.trim()) throw new Error('W3 fixture stdout is empty.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('W3 fixture stdout is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object')
    throw new Error('W3 fixture payload must be an object.');
  const fixture = (parsed as { fixture?: unknown }).fixture;
  if (!fixture || typeof fixture !== 'object')
    throw new Error('W3 fixture payload is missing the `fixture` object.');
  const record = fixture as Record<string, unknown>;
  const allowedTopLevel = new Set(['fixture']);
  const topLevel = parsed as Record<string, unknown>;
  for (const field of Object.keys(topLevel)) {
    if (!allowedTopLevel.has(field))
      throw new Error(`W3 fixture payload contains unknown field ${field}.`);
  }
  const allowedFixtureFields = new Set([
    'runId',
    'questionType',
    'username',
    'courseId',
    'questionId',
    'liveSessionId',
    'sessionQuestionId',
    'sessionCode',
    'options',
    'credentialPresent',
    'credentialFile',
  ]);
  for (const field of Object.keys(record)) {
    if (SECRET_LIKE_DESCRIPTOR_FIELDS.has(field))
      throw new Error(
        `W3 fixture descriptor contains forbidden field ${field}.`,
      );
    if (!allowedFixtureFields.has(field))
      throw new Error(`W3 fixture descriptor contains unknown field ${field}.`);
  }
  for (const field of [
    'runId',
    'username',
    'courseId',
    'questionId',
    'liveSessionId',
    'sessionQuestionId',
    'sessionCode',
  ]) {
    if (typeof record[field] !== 'string' || !record[field])
      throw new Error(`W3 fixture field ${field} is required.`);
  }
  if (record.questionType !== 'poll' && record.questionType !== 'quiz')
    throw new Error('W3 fixture questionType is invalid.');
  if (!Array.isArray(record.options) || record.options.length !== 3)
    throw new Error('W3 fixture options are incomplete.');
  const options = record.options.map((option, index) => {
    if (!option || typeof option !== 'object')
      throw new Error(`W3 fixture option ${index} is invalid.`);
    const optionRecord = option as Record<string, unknown>;
    for (const field of Object.keys(optionRecord)) {
      if (!['id', 'optionRef', 'isCorrect'].includes(field))
        throw new Error(
          `W3 fixture option ${index} contains unknown field ${field}.`,
        );
    }
    if (typeof optionRecord.id !== 'string' || !optionRecord.id)
      throw new Error(`W3 fixture option ${index} id is required.`);
    if (
      optionRecord.optionRef !== null &&
      typeof optionRecord.optionRef !== 'string'
    )
      throw new Error(`W3 fixture option ${index} optionRef is invalid.`);
    if (typeof optionRecord.isCorrect !== 'boolean')
      throw new Error(`W3 fixture option ${index} isCorrect is invalid.`);
    return {
      id: optionRecord.id,
      optionRef: optionRecord.optionRef,
      isCorrect: optionRecord.isCorrect,
    };
  });
  if (record.credentialPresent !== true)
    throw new Error('W3 fixture descriptor must confirm credentialPresent.');
  if (typeof record.credentialFile !== 'string' || !record.credentialFile)
    throw new Error('W3 fixture descriptor is missing credentialFile.');
  const credentialFile = record.credentialFile;
  if (!credentialFile.startsWith('/'))
    throw new Error('W3 fixture credentialFile must be an absolute path.');
  if (credentialFile !== credentialOut)
    throw new Error(
      'W3 fixture credentialFile does not match W3_CREDENTIAL_OUT.',
    );
  return {
    runId: record.runId as string,
    questionType: record.questionType,
    username: record.username as string,
    courseId: record.courseId as string,
    questionId: record.questionId as string,
    liveSessionId: record.liveSessionId as string,
    sessionQuestionId: record.sessionQuestionId as string,
    sessionCode: record.sessionCode as string,
    options,
    credentialPresent: true,
    credentialFile,
  };
}

/** Credential artifact verification: existence, type, mode 0600, non-empty. */
export async function validateCredentialArtifact(
  credentialPath: string,
): Promise<void> {
  let info;
  try {
    info = await lstat(credentialPath);
  } catch {
    throw new Error(
      `W3 credential artifact is missing after fixture provisioning: ${credentialPath}`,
    );
  }
  if (!info.isFile())
    throw new Error('W3 credential artifact is not a regular file.');
  // POSIX semantics; other platforms report the best-available approximation.
  const mode = info.mode & 0o777;
  if (mode !== 0o600)
    throw new Error(
      `W3 credential artifact mode must be 0600 (owner-only), got ${mode.toString(8)}.`,
    );
  if (info.size === 0) throw new Error('W3 credential artifact is empty.');
}

async function assertPathAbsent(
  path: string,
  label: string,
  inspect = lstat,
): Promise<void> {
  try {
    await inspect(path);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    )
      return; // Absent: fresh path, proven by ENOENT.
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    throw new Error(
      `W3 ${label} artifact path inspection failed${code ? ` (${code})` : ''}.`,
    );
  }
  throw new Error(
    `W3 ${label} artifact already exists; refusing to overwrite: ${path}`,
  );
}

/**
 * Exclusive final-path creation: O_EXCL makes the commit fail rather than
 * replace a target created after the preflight lstat. Ordinary write failures
 * remove only the file reserved by this invocation; crash recovery is not
 * claimed beyond the process-managed failure path.
 */
async function atomicWriteFile(
  target: string,
  content: string,
  mode: number,
): Promise<void> {
  let handle;
  let createdIdentity: { dev: number; ino: number } | undefined;
  try {
    handle = await open(target, 'wx', mode);
    const identity = await handle.stat();
    createdIdentity = { dev: identity.dev, ino: identity.ino };
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (createdIdentity) {
      const current = await lstat(target).catch(() => undefined);
      if (
        current &&
        current.dev === createdIdentity.dev &&
        current.ino === createdIdentity.ino
      )
        await unlink(target).catch(() => undefined);
    }
    throw error;
  }
}

export class W3EvidenceWriteError extends Error {
  constructor(cause: unknown) {
    super(
      `W3 exit evidence write failed: ${
        cause instanceof Error ? cause.message : 'unknown error'
      }`,
      { cause },
    );
    this.name = 'W3EvidenceWriteError';
  }
}

export type W3OrchestratorDependencies = {
  writeEvidence?: (path: string, content: string) => Promise<void>;
  writeAttribution?: (path: string, content: string) => Promise<void>;
  beforeAttributionPersist?: (path: string) => Promise<void>;
  beforeDescriptorPersist?: (path: string) => Promise<void>;
  lstat?: typeof lstat;
  startBackend: (env: NodeJS.ProcessEnv) => Promise<ChildProcess>;
  waitForHealth: (baseUrl: string) => Promise<void>;
  fetchTrace: (baseUrl: string, runId: string) => Promise<TraceSnapshot>;
  fetchMismatchTrace: (
    baseUrl: string,
    mismatchedRunId: string,
  ) => Promise<TraceSnapshot>;
  inspectProcfs: (pid: number, port: number) => Promise<ProcfsAttribution>;
  observeExternalCompetitors: (
    pid: number,
    databaseUrl: string,
    runId: string,
  ) => Promise<ExternalCompetitorObservation>;
  readProtectedBaseline?: (databaseUrl: string) => Promise<ProtectedBaseline>;
  expectedCwd: string;
  expectedExecutable: string;
  runFixture: (env: NodeJS.ProcessEnv) => Promise<W3FixtureChildResult>;
  runDriver: (env: NodeJS.ProcessEnv) => Promise<number>;
  stopBackend: (backend: ChildProcess) => Promise<void>;
  createRunId?: (explicit?: string) => string;
};

export async function orchestrateW3(
  sourceEnv: NodeJS.ProcessEnv,
  dependencies: W3OrchestratorDependencies,
): Promise<void> {
  assertSafeTarget(sourceEnv);
  const baseUrl = sourceEnv.LOAD_BASE_URL ?? 'http://127.0.0.1:3001';
  const fixturePath = required('W3_FIXTURE_PATH', sourceEnv);
  const outputPath = required('W3_OUTPUT_PATH', sourceEnv);
  const credentialOut = required('W3_CREDENTIAL_OUT', sourceEnv);
  const databaseUrl = required('DATABASE_URL', sourceEnv);
  required('LOCAL_W1_PROVISION_CREATED_BY', sourceEnv);
  const attributionPath = `${outputPath}.attribution.json`;
  const inspectPath = dependencies.lstat ?? lstat;
  // Baseline capture is injectable so focused unit specs stay DB-free; production
  // (`main`) omits it and reads the real protected counts.
  const readBaseline =
    dependencies.readProtectedBaseline ?? readProtectedBaseline;
  // The exit artifact is checked before evidence plumbing exists: an existing
  // evidence file is itself the conflict record and must remain untouched.
  await assertPathAbsent(
    `${outputPath}.exit.json`,
    'exit evidence',
    inspectPath,
  );

  const runId = (dependencies.createRunId ?? createW3RunId)(
    sourceEnv.W3_RUN_ID ?? randomUUID(),
  );
  // Authoritative acceptance scale unless explicitly overridden.
  const participants =
    sourceEnv.W3_PARTICIPANTS ?? String(W3_ACCEPTANCE_PARTICIPANTS);
  const env: NodeJS.ProcessEnv = {
    ...w3RunEnvironment(runId, sourceEnv),
    NODE_ENV: 'test',
    PORT: sourceEnv.PORT ?? '3001',
    LOAD_BASE_URL: baseUrl,
    W3_FIXTURE_PATH: fixturePath,
    W3_OUTPUT_PATH: outputPath,
    W3_CREDENTIAL_FILE: credentialOut,
    W3_PARTICIPANTS: participants,
    REALTIME_TRACE_ENABLED: '1',
    REALTIME_TRACE_BUFFER_SIZE: '20000',
  };

  const applicationNames = w3ApplicationNames(runId);
  // Each child gets its own DATABASE_URL clone; application_name is the only
  // field that varies. `env` retains everything else (run contract, paths,
  // participants, trace flags) and is read directly for backend-neutral values.
  const backendEnv: NodeJS.ProcessEnv = {
    ...env,
    DATABASE_URL: withApplicationName(databaseUrl, applicationNames.backend),
  };
  const fixtureEnv: NodeJS.ProcessEnv = {
    ...env,
    DATABASE_URL: withApplicationName(databaseUrl, applicationNames.fixture),
  };
  const driverEnv: NodeJS.ProcessEnv = {
    ...env,
    DATABASE_URL: withApplicationName(databaseUrl, applicationNames.driver),
  };

  const evidence: W3ExitEvidence = {
    fixture: { spawned: false, status: null },
    driver: { spawned: false, status: null },
    startedAt: new Date().toISOString(),
    finishedAt: '',
  };
  const writeEvidence = async (blockedReason?: string): Promise<void> => {
    evidence.finishedAt = new Date().toISOString();
    const payload = {
      ...evidence,
      ...(blockedReason ? { blockedReason } : {}),
    };
    const content = `${JSON.stringify(payload, null, 2)}\n`;
    try {
      if (dependencies.writeEvidence) {
        await dependencies.writeEvidence(`${outputPath}.exit.json`, content);
      } else {
        await writeFile(`${outputPath}.exit.json`, content, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
      }
    } catch (writeError) {
      throw new W3EvidenceWriteError(writeError);
    }
  };
  const writeAttribution = async (
    attribution: W3AttributionEvidence,
  ): Promise<void> => {
    const content = `${JSON.stringify(attribution, null, 2)}\n`;
    if (dependencies.writeAttribution) {
      await dependencies.writeAttribution(attributionPath, content);
      return;
    }
    await atomicWriteFile(attributionPath, content, 0o600);
  };
  const writeEvidencePreserving = async (
    blockedReason: string,
    primary: unknown,
  ): Promise<never> => {
    try {
      await writeEvidence(blockedReason);
    } catch (evidenceError) {
      if (primary instanceof Error) {
        Object.defineProperty(primary, 'evidenceFailure', {
          value: evidenceError,
          enumerable: false,
          configurable: true,
        });
        throw primary;
      }
      throw new AggregateError(
        [primary, evidenceError],
        'W3 orchestration and exit evidence writing failed.',
      );
    }
    throw primary;
  };
  // Fail-before-mutation guards: every run-owned artifact path must be fresh.
  const guards = async (): Promise<void> => {
    await assertPathAbsent(fixturePath, 'fixture descriptor', inspectPath);
    await assertPathAbsent(credentialOut, 'credential', inspectPath);
    await assertPathAbsent(outputPath, 'driver report', inspectPath);
    await assertPathAbsent(
      attributionPath,
      'attribution evidence',
      inspectPath,
    );
  };
  try {
    await guards();
  } catch (error) {
    await writeEvidencePreserving('ARTIFACT_PATH_CONFLICT', error);
  }

  let backend: ChildProcess | undefined;
  try {
    // Read-only protected-baseline snapshot before the backend is started or any
    // run-owned row exists (§12). A failure here never blocks the run.
    try {
      evidence.protectedBaselineBefore = await readBaseline(databaseUrl);
    } catch (error) {
      process.stderr.write(
        `W3 protected-baseline pre-capture skipped: ${
          error instanceof Error ? error.name : 'error'
        }\n`,
      );
    }
    const spawnStartedAtMs = Date.now();
    let spawnReadyAtMs = spawnStartedAtMs;
    try {
      backend = await dependencies.startBackend(backendEnv);
      spawnReadyAtMs = Date.now();
      if (backend.pid !== undefined) evidence.backendPid = backend.pid;
    } catch (error) {
      await writeEvidencePreserving('BACKEND_START_FAILED', error);
    }
    await dependencies.waitForHealth(baseUrl);
    // Read-only mid-point baseline after backend startup but before any fixture
    // exists, so a backend-startup side effect is separable from a workload one.
    try {
      evidence.protectedBaselineAfterBackendStart =
        await readBaseline(databaseUrl);
    } catch (error) {
      process.stderr.write(
        `W3 protected-baseline start-capture skipped: ${
          error instanceof Error ? error.name : 'error'
        }\n`,
      );
    }
    const trace = await dependencies.fetchTrace(baseUrl, runId);
    const preflight = validateTracePreflight(trace, runId);
    if (!preflight.ok) {
      evidence.attributionFailureCode = preflight.reason;
      await writeEvidencePreserving(
        'ATTRIBUTION_PREFLIGHT_FAILED',
        new Error(
          `W3 trace preflight blocked: ${preflight.reason} (${preflight.detail})`,
        ),
      );
    }
    const childPid = backend!.pid!;
    if (!childPid) {
      evidence.attributionFailureCode = 'BACKEND_PID_MISSING';
      await writeEvidencePreserving(
        'ATTRIBUTION_PREFLIGHT_FAILED',
        new Error('W3 backend child PID is unavailable.'),
      );
    }
    const port = localPort(baseUrl, env.PORT!);
    let attribution: W3AttributionEvidence;
    try {
      const procfs = await dependencies.inspectProcfs(childPid, port);
      const mismatchRunId = `w3-mismatch-${randomUUID()}`;
      const [mismatchTrace, externalObservation] = await Promise.all([
        dependencies.fetchMismatchTrace(baseUrl, mismatchRunId),
        dependencies.observeExternalCompetitors(childPid, databaseUrl, runId),
      ]);
      attribution = validateAttributionPreflight({
        childPid,
        expectedRunId: runId,
        expectedTraceRunId: env.REALTIME_TRACE_RUN_ID!,
        expectedCwd: dependencies.expectedCwd,
        expectedExecutable: dependencies.expectedExecutable,
        expectedScript: 'dist/src/main.js',
        spawnStartedAtMs,
        spawnReadyAtMs,
        procfs,
        trace,
        mismatchTrace,
        externalObservation,
      });
    } catch (error) {
      // Stable machine-readable code in the typed field; redacted diagnostic
      // stays on stderr only.
      process.stderr.write(
        `W3 attribution inspection failed: ${redactDiagnostic(
          error instanceof Error ? error.message : '',
        )}\n`,
      );
      evidence.attributionFailureCode = 'ATTRIBUTION_INSPECTION_FAILED';
      await writeEvidencePreserving('ATTRIBUTION_PREFLIGHT_FAILED', error);
    }
    try {
      await dependencies.beforeAttributionPersist?.(attributionPath);
      await writeAttribution(attribution!);
    } catch (error) {
      const conflict =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 'EEXIST';
      await writeEvidencePreserving(
        conflict
          ? 'ATTRIBUTION_EVIDENCE_CONFLICT'
          : 'ATTRIBUTION_EVIDENCE_WRITE_FAILED',
        error,
      );
    }
    if (attribution!.status !== 'passed') {
      evidence.attributionFailureCode = attribution!.failureCode;
      await writeEvidencePreserving(
        'ATTRIBUTION_PREFLIGHT_FAILED',
        new Error(
          `W3 attribution preflight blocked: ${attribution!.failureCode ?? 'unknown'}.`,
        ),
      );
    }

    // ---- fixture child: exactly one, captured stdout, no retry ------------
    // Read-only protected-baseline snapshot immediately before the run-owned
    // chain is created (§12). A failure here never blocks the run.
    try {
      evidence.protectedBaselineBefore = await readBaseline(databaseUrl);
    } catch (error) {
      process.stderr.write(
        `W3 protected-baseline pre-capture skipped: ${
          error instanceof Error ? error.name : 'error'
        }\n`,
      );
    }
    evidence.fixture.spawned = true;
    const fixtureChild = await dependencies.runFixture(fixtureEnv);
    evidence.fixture.status = fixtureChild.status;
    if (fixtureChild.status !== 0) {
      const detail = redactDiagnostic(fixtureChild.stderr);
      if (detail) {
        process.stderr.write(`W3 fixture provisioning failed: ${detail}\n`);
      }
      await writeEvidencePreserving(
        'FIXTURE_CHILD_FAILED',
        new Error(
          `W3 fixture provisioning failed with status ${fixtureChild.status}.`,
        ),
      );
    }

    // ---- descriptor: validate, then atomically persist ---------------------
    let descriptor: W3FixtureDescriptor | undefined;
    try {
      descriptor = validateFixtureDescriptor(
        fixtureChild.stdout,
        credentialOut,
      );
    } catch (error) {
      await writeEvidencePreserving('FIXTURE_DESCRIPTOR_INVALID', error);
    }
    if (!descriptor)
      throw new Error(
        'W3 fixture descriptor validation did not produce a descriptor.',
      );
    await validateCredentialArtifact(credentialOut);
    try {
      await dependencies.beforeDescriptorPersist?.(fixturePath);
      await atomicWriteFile(
        fixturePath,
        `${JSON.stringify({ fixture: descriptor }, null, 2)}\n`,
        0o600,
      );
    } catch (error) {
      const blockedReason =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 'EEXIST'
          ? 'ARTIFACT_PATH_CONFLICT'
          : 'FIXTURE_DESCRIPTOR_PERSIST_FAILED';
      await writeEvidencePreserving(blockedReason, error);
    }

    // ---- driver child: exactly one, all gates already passed --------------
    evidence.driver.spawned = true;
    const driverStatus = await dependencies.runDriver(driverEnv);
    evidence.driver.status = driverStatus;
    if (driverStatus !== 0) {
      await writeEvidencePreserving(
        'DRIVER_CHILD_FAILED',
        new Error(`W3 driver failed with status ${driverStatus}.`),
      );
    }
    // Post-run read-only baseline snapshot, captured before the exit evidence is
    // written so it is included in the artifact (§12).
    if (evidence.protectedBaselineBefore !== undefined) {
      try {
        evidence.protectedBaselineAfterRun = await readBaseline(databaseUrl);
      } catch (error) {
        process.stderr.write(
          `W3 protected-baseline post-capture skipped: ${
            error instanceof Error ? error.name : 'error'
          }\n`,
        );
      }
    }
    await writeEvidence();
  } catch (error) {
    // Failure paths that bypass the explicit evidence writes above (trace
    // preflight, health) still record that the driver was not spawned.
    if (evidence.finishedAt === '')
      await writeEvidencePreserving('ORCHESTRATION_FAILED', error);
    throw error;
  } finally {
    if (backend) await dependencies.stopBackend(backend);
  }
}

async function main(): Promise<void> {
  const sourceEnv = process.env;
  const repositoryCwd = await realpath(process.cwd());
  const expectedExecutable = await realpath(process.execPath);
  const { stdout: clockTicksRaw } = await execFileAsync('getconf', ['CLK_TCK']);
  const clockTicksPerSecond = Number(clockTicksRaw.trim());
  await orchestrateW3(sourceEnv, {
    expectedCwd: repositoryCwd,
    expectedExecutable,
    startBackend: async (env) => {
      const backend = spawn(process.execPath, ['dist/src/main.js'], {
        cwd: repositoryCwd,
        env,
        stdio: 'inherit',
      });
      await new Promise<void>((resolve, reject) => {
        backend.once('error', reject);
        backend.once('spawn', resolve);
      });
      return backend;
    },
    waitForHealth,
    fetchTrace: (baseUrl, runId) =>
      new TraceClient(baseUrl, runId, 0, 5_000).fetch(),
    fetchMismatchTrace: (baseUrl, mismatchRunId) =>
      new TraceClient(baseUrl, mismatchRunId, 0, 5_000).fetchIsolation(),
    inspectProcfs: (pid, port) =>
      inspectProcfsAttribution(pid, port, clockTicksPerSecond),
    observeExternalCompetitors,
    runFixture: (env) =>
      runFixtureChild(
        'node',
        [
          'node_modules/tsx/dist/cli.mjs',
          'scripts/load-harness/w3/create-fixture.ts',
        ],
        env,
      ),
    runDriver: (env) =>
      runChild(
        'node',
        ['node_modules/tsx/dist/cli.mjs', 'scripts/load-harness/w3/run-w3.ts'],
        env,
      ),
    stopBackend: stopChild,
  });
}

if (require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'W3 orchestration failed.'}\n`,
    );
    process.exitCode = 2;
  });
