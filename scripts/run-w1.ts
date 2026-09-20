import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { config as loadDotenv } from 'dotenv';
const PROTECTED_TEACHER = 'local-w1-w1-20260915-final';
const STAGES = [20, 100, 300] as const;
const SMOKE_PARTICIPANTS = 1;

type ChildResult = { status: number; stdout: string; stderr: string };

function fail(message: string): never {
  throw new Error(message);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is required.`);
  return value;
}

function runId(): string {
  return randomUUID();
}

function safeOutput(output: string, secret?: string): string {
  const redacted = secret ? output.split(secret).join('[REDACTED]') : output;
  return redacted
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-8)
    .join('\n');
}

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<ChildResult> {
  const child = spawn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [status] = (await new Promise<
    [number] | [number, NodeJS.Signals | null]
  >((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve([code ?? 1, signal]));
  })) as [number, NodeJS.Signals | null];
  return { status, stdout, stderr };
}

function assertTarget(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'test') fail('W1 orchestration requires NODE_ENV=test.');
  if (env.LOCAL_W1_PROVISIONING_ENABLED !== '1')
    fail('LOCAL_W1_PROVISIONING_ENABLED=1 is required.');
  if (env.LOCAL_PROVISION_TARGET !== 'disposable')
    fail('LOCAL_PROVISION_TARGET=disposable is required.');
  if (env.LOAD_DISPOSABLE_TARGET !== '1')
    fail('LOAD_DISPOSABLE_TARGET=1 is required.');
  if (!env.DATABASE_URL?.includes('smartlearning_test'))
    fail('DATABASE_URL must target smartlearning_test.');
  if (!env.LOAD_CORS_ORIGIN)
    fail('LOAD_CORS_ORIGIN is required for exact-Origin preflight.');
  if (env.LOCAL_W1_TEACHER_USERNAME === PROTECTED_TEACHER)
    fail('The protected W1 teacher cannot be used by this orchestrator.');
}

async function healthCheck(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/health/live`);
  if (!response.ok) fail(`Backend health failed: HTTP ${response.status}.`);
}

type SmokeFixture = {
  courseId: string;
  questionId?: string;
  liveSessionId: string;
  sessionQuestionId: string;
  sessionCode: string;
};

async function runHarness(
  baseUrl: string,
  username: string,
  password: string,
  participants: number,
  outputPath: string,
  runIdValue: string,
  fixtureOnly = false,
  fixture?: SmokeFixture,
): Promise<ChildResult> {
  const env = {
    ...process.env,
    LOAD_BASE_URL: baseUrl,
    LOAD_FIXTURE_MODE: fixture ? 'existing' : 'create',
    LOAD_ALLOW_FIXTURE_WRITES: fixture ? '0' : '1',
    LOAD_DISPOSABLE_TARGET: '1',
    LOAD_TEACHER_USERNAME: username,
    LOAD_TEACHER_PASSWORD: password,
    LOAD_RUN_ID: runIdValue,
    LOAD_OUTPUT: outputPath,
    LOAD_SCENARIOS: 'W1',
    LOAD_PARTICIPANTS: String(participants),
    ...(fixture
      ? {
          LOAD_SESSION_CODE: fixture.sessionCode,
          LOAD_LIVE_SESSION_ID: fixture.liveSessionId,
          LOAD_SESSION_QUESTION_ID: fixture.sessionQuestionId,
        }
      : {}),
    ...(fixtureOnly ? { LOAD_FIXTURE_ONLY: '1' } : {}),
  };
  if (!env.LOAD_TEACHER_USERNAME || !env.LOAD_TEACHER_PASSWORD)
    fail('W1 harness credentials are missing; refusing to start workload.');
  return run(
    'npm',
    [
      'run',
      'load:test',
      '--',
      '--scenarios',
      'W1',
      '--participants',
      String(participants),
      '--output',
      outputPath,
    ],
    env,
  );
}

async function assertFixtureSmoke(
  outputPath: string,
  result: ChildResult,
  password: string,
): Promise<SmokeFixture> {
  if (result.status !== 0)
    fail(
      `Credential/fixture smoke failed; diagnostics=${safeOutput(`${result.stdout}\n${result.stderr}`, password)}`,
    );
  await access(outputPath);
  const report = JSON.parse(await readFile(outputPath, 'utf8')) as {
    fixture?: {
      courseId?: string;
      liveSessionId?: string;
      sessionQuestionId?: string;
      sessionCode?: string;
    };
    scenarios?: unknown[];
  };
  if (
    !report.fixture?.courseId ||
    !report.fixture.liveSessionId ||
    !report.fixture.sessionQuestionId ||
    !report.fixture.sessionCode
  )
    fail('Credential/fixture smoke did not produce a complete fixture.');
  if (report.scenarios?.length)
    fail(
      'Credential/fixture smoke unexpectedly executed a participant scenario.',
    );
  return {
    courseId: report.fixture.courseId,
    liveSessionId: report.fixture.liveSessionId,
    sessionQuestionId: report.fixture.sessionQuestionId,
    sessionCode: report.fixture.sessionCode ?? '',
  };
}

async function startObserver(
  fixturePath: string,
  outputPath: string,
): Promise<ChildProcess | undefined> {
  if (process.env.W1_DIAGNOSTICS !== '1') return undefined;
  const observer = spawn(
    `${process.cwd()}/node_modules/.bin/tsx`,
    ['scripts/load-harness/pg-observer.ts'],
    {
      env: {
        ...process.env,
        W1_PG_OBSERVER_FIXTURE: fixturePath,
        W1_PG_OBSERVER_OUTPUT: outputPath,
      },
      stdio: 'ignore',
    },
  );
  await new Promise<void>((resolve, reject) => {
    observer.once('error', reject);
    observer.once('spawn', () => resolve());
  });
  return observer;
}

async function stopObserver(
  observer: ChildProcess | undefined,
  outputPath: string,
): Promise<unknown> {
  if (!observer) return undefined;
  observer.kill('SIGTERM');
  await new Promise<void>((resolve) => observer.once('close', () => resolve()));
  try {
    const text = await readFile(outputPath, 'utf8');
    const report = JSON.parse(text) as unknown;
    if (!report || typeof report !== 'object')
      throw new Error('observer report must be a JSON object');
    const candidate = report as Record<string, unknown>;
    const reconciliation = candidate.reconciliation;
    const plans = candidate.plans;
    const safety = candidate.safety;
    if (
      candidate.schemaVersion !== 4 ||
      candidate.enabled !== true ||
      candidate.target !== 'smartlearning_test' ||
      !reconciliation ||
      typeof reconciliation !== 'object' ||
      !plans ||
      typeof plans !== 'object' ||
      !safety ||
      typeof safety !== 'object'
    )
      throw new Error('observer report is missing required fields');
    const reconciliationRecord = reconciliation as Record<string, unknown>;
    const plansRecord = plans as Record<string, unknown>;
    const safetyRecord = safety as Record<string, unknown>;
    const sampling = candidate.sampling;
    const observerErrors = candidate.observerErrors;
    const connectionObservations = candidate.connectionObservations;
    if (
      typeof reconciliationRecord.liveSessionId !== 'string' ||
      typeof reconciliationRecord.sessionQuestionId !== 'string' ||
      reconciliationRecord.exactMatch !== true ||
      !('expected' in reconciliationRecord) ||
      !('persisted' in reconciliationRecord) ||
      !Array.isArray(candidate.samples) ||
      candidate.samples.length === 0 ||
      candidate.samples.some((sample) => {
        if (!sample || typeof sample !== 'object') return true;
        const record = sample as Record<string, unknown>;
        return !Array.isArray(record.blockingEdges);
      }) ||
      !sampling ||
      typeof sampling !== 'object' ||
      typeof (sampling as Record<string, unknown>).startedAt !== 'string' ||
      typeof (sampling as Record<string, unknown>).finishedAt !== 'string' ||
      typeof (sampling as Record<string, unknown>).intervalMs !== 'number' ||
      ((sampling as Record<string, unknown>).intervalMs as number) < 100 ||
      !connectionObservations ||
      !Array.isArray(connectionObservations) ||
      connectionObservations.length === 0 ||
      !Array.isArray(observerErrors) ||
      observerErrors.length > 0 ||
      !plansRecord.findByCode ||
      typeof plansRecord.findByCode !== 'object' ||
      !Array.isArray(
        (plansRecord.findByCode as Record<string, unknown>).plan,
      ) ||
      ((plansRecord.findByCode as Record<string, unknown>).plan as unknown[])
        .length === 0 ||
      !plansRecord.getSnapshot ||
      typeof plansRecord.getSnapshot !== 'object' ||
      !Array.isArray(
        (plansRecord.getSnapshot as Record<string, unknown>).plan,
      ) ||
      ((plansRecord.getSnapshot as Record<string, unknown>).plan as unknown[])
        .length === 0 ||
      safetyRecord.readOnly !== true ||
      safetyRecord.writes !== false ||
      safetyRecord.schemaChanges !== false ||
      safetyRecord.indexChanges !== false ||
      safetyRecord.poolChanges !== false ||
      safetyRecord.lockChanges !== false
    )
      throw new Error('observer report has invalid required fields');
    return report;
  } catch (error) {
    fail(
      `Observer did not produce valid JSON: ${error instanceof Error ? error.message : 'invalid report'}`,
    );
  }
}

async function assertStage(
  outputPath: string,
  participants: number,
  result: ChildResult,
  password: string,
): Promise<void> {
  if (result.status !== 0)
    fail(
      `W1 stage ${participants} failed before acceptance; diagnostics=${safeOutput(`${result.stdout}\n${result.stderr}`, password)}`,
    );
  await access(outputPath);
  const report = JSON.parse(await readFile(outputPath, 'utf8')) as {
    scenarios?: Array<{
      name: string;
      status: string;
      correctness?: Record<string, number>;
    }>;
  };
  const scenario = report.scenarios?.find((entry) => entry.name === 'W1');
  if (scenario?.status !== 'passed')
    fail(`W1 stage ${participants} did not pass its harness gate.`);
  if (scenario.correctness?.joined !== participants)
    fail(`W1 stage ${participants} joined-count gate failed.`);
  if ((scenario.correctness?.duplicateParticipantIds ?? 0) !== 0)
    fail(`W1 stage ${participants} duplicate-participant gate failed.`);
}

async function main(): Promise<void> {
  loadDotenv({ path: '.env.test', override: false });
  const environment = process.env;
  assertTarget(environment);
  const smokeOnly = process.argv.includes('--smoke-only');
  const stageArg = process.argv.find((arg) => arg.startsWith('--stage='));
  const maxStageArg = process.argv.find((arg) =>
    arg.startsWith('--max-stage='),
  );
  const selectedStage = stageArg
    ? Number(stageArg.slice('--stage='.length))
    : undefined;
  const maxStage = maxStageArg
    ? Number(maxStageArg.slice('--max-stage='.length))
    : 300;
  if (
    (selectedStage !== undefined &&
      !STAGES.includes(selectedStage as (typeof STAGES)[number])) ||
    (selectedStage === undefined &&
      !STAGES.includes(maxStage as (typeof STAGES)[number]))
  )
    fail('--stage/--max-stage must be one of 20, 100, or 300.');
  const baseUrl = required('LOAD_BASE_URL');
  const createdBy = required('LOCAL_W1_PROVISION_CREATED_BY');
  const username = `local-w1-${Date.now()}-${randomUUID().slice(0, 8)}`;
  let password = randomBytes(32).toString('base64');
  const id = runId();
  const outputDir = environment.W1_OUTPUT_DIR ?? 'artifacts';
  const prefix = `${outputDir}/w1-${id}`;
  let provisioned = false;
  let keepTeacher = true;
  let observer: ChildProcess | undefined;
  let observerOutputPath: string | undefined;

  try {
    await healthCheck(baseUrl);
    if (!environment.DATABASE_URL?.includes('smartlearning_test'))
      fail('Database target verification failed.');

    const provisionEnv = {
      ...environment,
      LOCAL_W1_PROVISION_CREATED_BY: createdBy,
      LOCAL_W1_TEACHER_USERNAME: username,
      LOCAL_W1_TEACHER_PASSWORD: password,
    };
    const provision = await run(
      'npm',
      ['run', 'bootstrap:w1-teacher', '--', 'provision'],
      provisionEnv,
    );
    if (provision.status !== 0)
      fail(
        `Fresh teacher provisioning failed: ${safeOutput(`${provision.stdout}\n${provision.stderr}`, password)}`,
      );
    provisioned = true;

    const smokePath = `${prefix}-credential-smoke.json`;
    const smoke = await runHarness(
      baseUrl,
      username,
      password,
      SMOKE_PARTICIPANTS,
      smokePath,
      id,
      true,
    );
    const smokeFixture = await assertFixtureSmoke(smokePath, smoke, password);
    const stageFixturePath = `${prefix}-stage-fixture.json`;
    await writeFile(
      stageFixturePath,
      `${JSON.stringify(
        { fixture: { ...smokeFixture, expectedParticipants: STAGES[0] } },
        null,
        2,
      )}\n`,
      'utf8',
    );
    process.stdout.write(
      `Credential smoke passed: runId=${id} teacher=${username}\n`,
    );
    if (smokeOnly) return;

    const stages = selectedStage
      ? [selectedStage as (typeof STAGES)[number]]
      : STAGES.filter((stage) => stage <= maxStage);
    for (const participants of stages) {
      const outputPath = `${prefix}-${participants}.json`;
      const observerPath = `${prefix}-pg-observer-${participants}.json`;
      observerOutputPath = observerPath;
      await writeFile(
        stageFixturePath,
        `${JSON.stringify({ fixture: { ...smokeFixture, expectedParticipants: participants } }, null, 2)}\n`,
        'utf8',
      );
      observer = await startObserver(stageFixturePath, observerPath);
      const result = await runHarness(
        baseUrl,
        username,
        password,
        participants,
        outputPath,
        id,
        false,
        smokeFixture,
      );
      await assertStage(outputPath, participants, result, password);
      const observerReport = await stopObserver(observer, observerPath);
      observer = undefined;
      observerOutputPath = undefined;
      const parsedStage: unknown = JSON.parse(
        await readFile(outputPath, 'utf8'),
      );
      if (!parsedStage || typeof parsedStage !== 'object')
        fail('W1 stage report must be a JSON object.');
      const stageReport = parsedStage as Record<string, unknown>;
      if (!Array.isArray(stageReport.scenarios) || !stageReport.schemaVersion)
        fail('W1 stage report is missing required fields.');
      stageReport.postgresObserver = observerReport;
      await writeFile(
        outputPath,
        `${JSON.stringify(stageReport, null, 2)}\n`,
        'utf8',
      );
      process.stdout.write(
        `W1 stage passed: participants=${participants} runId=${id}\n`,
      );
    }
    keepTeacher = false;
  } finally {
    if (observer && observerOutputPath)
      await stopObserver(observer, observerOutputPath);
    if (provisioned && keepTeacher)
      process.stderr.write(
        `Cleanup candidate retained: teacher=${username} runId=${id}\n`,
      );
    if (provisioned && process.env.W1_AUTO_CLEANUP === '1' && !keepTeacher) {
      const cleanupEnv = {
        ...environment,
        LOCAL_W1_PROVISION_CREATED_BY: createdBy,
        LOCAL_W1_TEACHER_USERNAME: username,
      };
      await run(
        'npm',
        ['run', 'bootstrap:w1-teacher', '--', 'cleanup'],
        cleanupEnv,
      );
    }
    password = '';
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'W1 orchestration failed.'}\n`,
  );
  process.exitCode = 2;
});
