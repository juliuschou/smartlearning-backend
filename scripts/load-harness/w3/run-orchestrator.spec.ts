import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import {
  orchestrateW3,
  type W3OrchestratorDependencies,
} from '../../../scripts/run-w3';
import type { TraceSnapshot } from './trace-client';

const sourceEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://unused/smartlearning_test',
  LOAD_CORS_ORIGIN: 'http://localhost:3000',
  LOAD_BASE_URL: 'http://127.0.0.1:3999',
  PORT: '3999',
  W3_RUN_ID: 'run-123',
  W3_FIXTURE_PATH: '/unused/fixture.json',
  W3_OUTPUT_PATH: '/unused/output.json',
  W3_CREDENTIAL_OUT: '/unused/credential.json',
  LOCAL_W1_PROVISION_CREATED_BY: 'unit-test',
  PRESERVED_PARENT_VALUE: 'preserved',
};

const validTrace = (): TraceSnapshot => ({
  enabled: true,
  runId: 'run-123',
  stats: {
    schemaVersion: 1,
    enabled: true,
    instanceId: 'instance-1',
    runId: 'run-123',
    bufferSize: 20_000,
    recordedCount: 0,
    droppedCount: 0,
    dispatchedEventCount: 0,
  },
  records: [],
  timings: [],
  fetchedAtMs: 0,
});

function dependencies(
  trace: TraceSnapshot,
  calls: string[],
  environments: NodeJS.ProcessEnv[],
): W3OrchestratorDependencies {
  const backend = {} as ChildProcess;
  return {
    startBackend: async (env) => {
      calls.push('startBackend');
      environments.push(env);
      return backend;
    },
    waitForHealth: async () => {
      calls.push('waitForHealth');
    },
    fetchTrace: async () => {
      calls.push('fetchTrace');
      return trace;
    },
    runFixture: async (env) => {
      calls.push('runFixture');
      environments.push(env);
      return 0;
    },
    runDriver: async (env) => {
      calls.push('runDriver');
      environments.push(env);
      return 0;
    },
    stopBackend: async () => {
      calls.push('stopBackend');
    },
  };
}

async function main(): Promise<void> {
  {
    const calls: string[] = [];
    const environments: NodeJS.ProcessEnv[] = [];
    await orchestrateW3(
      sourceEnv,
      dependencies(validTrace(), calls, environments),
    );
    assert.deepEqual(calls, [
      'startBackend',
      'waitForHealth',
      'fetchTrace',
      'runFixture',
      'runDriver',
      'stopBackend',
    ]);
    assert.equal(environments.length, 3);
    for (const env of environments) {
      assert.equal(env.W3_RUN_ID, 'run-123');
      assert.equal(env.REALTIME_TRACE_RUN_ID, 'run-123');
      assert.equal(env.W3_TRACE_REQUIRED, '1');
      assert.equal(env.REALTIME_TRACE_BUFFER_SIZE, '20000');
      assert.equal(env.PRESERVED_PARENT_VALUE, 'preserved');
    }
  }

  for (const trace of [
    { enabled: false, unavailableReason: 'disabled' },
    {
      enabled: true,
      runId: 'wrong-run',
      stats: { ...validTrace().stats!, runId: 'wrong-run' },
    },
    {
      ...validTrace(),
      stats: { ...validTrace().stats!, bufferSize: 5_000 },
    },
    {
      ...validTrace(),
      stats: { ...validTrace().stats!, droppedCount: 1 },
    },
  ] as TraceSnapshot[]) {
    const calls: string[] = [];
    const environments: NodeJS.ProcessEnv[] = [];
    await assert.rejects(
      orchestrateW3(sourceEnv, dependencies(trace, calls, environments)),
      /W3 trace preflight blocked:/,
    );
    assert.deepEqual(calls, [
      'startBackend',
      'waitForHealth',
      'fetchTrace',
      'stopBackend',
    ]);
    assert.equal(calls.includes('runFixture'), false);
    assert.equal(calls.includes('runDriver'), false);
  }
}

void main().then(
  () => console.log('W3 orchestrator tests passed.'),
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
