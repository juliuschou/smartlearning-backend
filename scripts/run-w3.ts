import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, open, unlink, writeFile } from 'node:fs/promises';
import {
  createW3RunId,
  w3RunEnvironment,
  W3_ACCEPTANCE_PARTICIPANTS,
} from './load-harness/w3/run-contract';
import {
  TraceClient,
  type TraceSnapshot,
} from './load-harness/w3/trace-client';
import { validateTracePreflight } from './load-harness/w3/trace-preflight';

/** Bounded capture for a fixture child's streams (descriptor is small). */
const CHILD_CAPTURE_LIMIT = 64 * 1024;
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
  blockedReason?: string;
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
  beforeDescriptorPersist?: (path: string) => Promise<void>;
  lstat?: typeof lstat;
  startBackend: (env: NodeJS.ProcessEnv) => Promise<ChildProcess>;
  waitForHealth: (baseUrl: string) => Promise<void>;
  fetchTrace: (baseUrl: string, runId: string) => Promise<TraceSnapshot>;
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
  required('LOCAL_W1_PROVISION_CREATED_BY', sourceEnv);
  const inspectPath = dependencies.lstat ?? lstat;
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
  const env = {
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
  };
  try {
    await guards();
  } catch (error) {
    await writeEvidencePreserving('ARTIFACT_PATH_CONFLICT', error);
  }

  let backend: ChildProcess | undefined;
  try {
    try {
      backend = await dependencies.startBackend(env);
      if (backend.pid !== undefined) evidence.backendPid = backend.pid;
    } catch (error) {
      await writeEvidencePreserving('BACKEND_START_FAILED', error);
    }
    await dependencies.waitForHealth(baseUrl);
    const preflight = validateTracePreflight(
      await dependencies.fetchTrace(baseUrl, runId),
      runId,
    );
    if (!preflight.ok)
      throw new Error(
        `W3 trace preflight blocked: ${preflight.reason} (${preflight.detail})`,
      );

    // ---- fixture child: exactly one, captured stdout, no retry ------------
    evidence.fixture.spawned = true;
    const fixtureChild = await dependencies.runFixture(env);
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
    const driverStatus = await dependencies.runDriver(env);
    evidence.driver.status = driverStatus;
    if (driverStatus !== 0) {
      await writeEvidencePreserving(
        'DRIVER_CHILD_FAILED',
        new Error(`W3 driver failed with status ${driverStatus}.`),
      );
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
  await orchestrateW3(sourceEnv, {
    startBackend: async (env) => {
      const backend = spawn('node', ['dist/src/main.js'], {
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
