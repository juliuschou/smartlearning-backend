import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createW3RunId,
  w3RunEnvironment,
} from './load-harness/w3/run-contract';
import {
  TraceClient,
  type TraceSnapshot,
} from './load-harness/w3/trace-client';
import { validateTracePreflight } from './load-harness/w3/trace-preflight';

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

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
}

export type W3OrchestratorDependencies = {
  startBackend: (env: NodeJS.ProcessEnv) => Promise<ChildProcess>;
  waitForHealth: (baseUrl: string) => Promise<void>;
  fetchTrace: (baseUrl: string, runId: string) => Promise<TraceSnapshot>;
  runFixture: (env: NodeJS.ProcessEnv) => Promise<number>;
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
  required('W3_CREDENTIAL_OUT', sourceEnv);
  required('LOCAL_W1_PROVISION_CREATED_BY', sourceEnv);
  const runId = (dependencies.createRunId ?? createW3RunId)(
    sourceEnv.W3_RUN_ID ?? randomUUID(),
  );
  const env = {
    ...w3RunEnvironment(runId, sourceEnv),
    NODE_ENV: 'test',
    PORT: sourceEnv.PORT ?? '3001',
    LOAD_BASE_URL: baseUrl,
    W3_FIXTURE_PATH: fixturePath,
    W3_OUTPUT_PATH: outputPath,
    REALTIME_TRACE_ENABLED: '1',
    REALTIME_TRACE_BUFFER_SIZE: '20000',
  };
  const backend = await dependencies.startBackend(env);
  try {
    await dependencies.waitForHealth(baseUrl);
    const preflight = validateTracePreflight(
      await dependencies.fetchTrace(baseUrl, runId),
      runId,
    );
    if (!preflight.ok)
      throw new Error(
        `W3 trace preflight blocked: ${preflight.reason} (${preflight.detail})`,
      );

    const fixtureStatus = await dependencies.runFixture(env);
    if (fixtureStatus !== 0)
      throw new Error(
        `W3 fixture provisioning failed with status ${fixtureStatus}.`,
      );
    const driverStatus = await dependencies.runDriver(env);
    if (driverStatus !== 0)
      throw new Error(`W3 driver failed with status ${driverStatus}.`);
  } finally {
    await dependencies.stopBackend(backend);
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
      runChild(
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
