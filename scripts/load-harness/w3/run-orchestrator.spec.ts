import assert from 'node:assert/strict';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  orchestrateW3,
  type W3FixtureChildResult,
} from '../../../scripts/run-w3';
import { W3_ACCEPTANCE_PARTICIPANTS } from './run-contract';
import type { TraceSnapshot } from './trace-client';
import type { ProcfsAttribution } from './procfs-attribution';
import type { ExternalCompetitorObservation } from './trace-preflight';

function sourceEnv(dir: string, overrides: NodeJS.ProcessEnv = {}) {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused/smartlearning_test',
    LOAD_CORS_ORIGIN: 'http://localhost:3000',
    LOAD_BASE_URL: 'http://127.0.0.1:3999',
    PORT: '3999',
    W3_RUN_ID: 'run-123',
    W3_FIXTURE_PATH: join(dir, 'fixture.json'),
    W3_OUTPUT_PATH: join(dir, 'report.json'),
    W3_CREDENTIAL_OUT: join(dir, 'credential'),
    LOCAL_W1_PROVISION_CREATED_BY: 'unit-test',
    PRESERVED_PARENT_VALUE: 'preserved',
    ...overrides,
  };
}

const validDescriptor = () => ({
  runId: 'run-123',
  questionType: 'poll',
  username: 'local-w1-w3-teacher',
  courseId: 'course-1',
  questionId: 'question-1',
  liveSessionId: 'session-1',
  sessionQuestionId: 'sq-1',
  sessionCode: 'ABC123',
  options: [
    { id: 'o1', optionRef: 'alpha', isCorrect: false },
    { id: 'o2', optionRef: 'beta', isCorrect: false },
    { id: 'o3', optionRef: 'gamma', isCorrect: true },
  ],
  credentialPresent: true,
});

const processStartIso = new Date().toISOString();

function validProcfs(): ProcfsAttribution {
  return {
    port: 3999,
    listenerPids: [4242],
    inaccessibleFdCount: 0,
    process: {
      pid: 4242,
      command: ['/usr/bin/node', 'dist/src/main.js'],
      cwd: '/repo',
      executable: '/usr/bin/node',
      startIso: processStartIso,
    },
  };
}

function clearExternalObservation(): ExternalCompetitorObservation {
  return {
    observedAtIso: new Date().toISOString(),
    externalPublisherExclusivity: 'observational',
    competingProcesses: [],
    competingContainers: [],
    competingDatabaseSessions: [],
    activeOutboxClaims: [],
    conflictingAdvisoryLocks: [],
  };
}

function gateDependencies() {
  return {
    expectedCwd: '/repo',
    expectedExecutable: '/usr/bin/node',
    fetchMismatchTrace: async () => ({
      ...validTrace(),
      records: [],
      timings: [],
    }),
    inspectProcfs: async () => validProcfs(),
    observeExternalCompetitors: async () => clearExternalObservation(),
  };
}

type Deps = {
  calls: string[];
  fixtureCalls: number;
  driverCalls: number;
  backendStartCalls: number;
  backendStopCalls: number;
  driverEnvs: NodeJS.ProcessEnv[];
};

async function runScenario(
  env: NodeJS.ProcessEnv,
  options: {
    fixtureStdout?: string;
    fixtureStatus?: number;
    fixtureCreatesCredential?: boolean;
    credentialMode?: number;
    driverStatus?: number;
    backendStartError?: Error;
    evidenceWriteError?: Error;
    beforeDescriptorPersist?: (path: string) => Promise<void>;
    lstat?: typeof lstat;
    procfs?: ProcfsAttribution;
    trace?: TraceSnapshot;
    externalObservation?: ExternalCompetitorObservation;
    attributionWriteError?: Error;
    beforeAttributionPersist?: (path: string) => Promise<void>;
    captureError?: (error: unknown) => void;
  } = {},
): Promise<Deps> {
  const deps: Deps = {
    calls: [],
    fixtureCalls: 0,
    driverCalls: 0,
    backendStartCalls: 0,
    backendStopCalls: 0,
    driverEnvs: [],
  };
  const backend = { pid: 4242 } as ChildProcess;
  try {
    await orchestrateW3(env, {
      ...gateDependencies(),
      writeEvidence: options.evidenceWriteError
        ? async () => {
            throw options.evidenceWriteError;
          }
        : undefined,
      writeAttribution: options.attributionWriteError
        ? async () => {
            throw options.attributionWriteError;
          }
        : undefined,
      beforeAttributionPersist: options.beforeAttributionPersist,
      beforeDescriptorPersist: options.beforeDescriptorPersist,
      lstat: options.lstat,
      startBackend: async () => {
        deps.calls.push('startBackend');
        deps.backendStartCalls += 1;
        if (options.backendStartError) throw options.backendStartError;
        return backend;
      },
      waitForHealth: async () => {
        deps.calls.push('waitForHealth');
      },
      fetchTrace: async () => {
        deps.calls.push('fetchTrace');
        return options.trace ?? validTrace();
      },
      fetchMismatchTrace: async () => {
        deps.calls.push('fetchMismatchTrace');
        return { ...validTrace(), records: [], timings: [] };
      },
      inspectProcfs: async () => {
        deps.calls.push('inspectProcfs');
        return options.procfs ?? validProcfs();
      },
      observeExternalCompetitors: async () => {
        deps.calls.push('observeExternalCompetitors');
        return options.externalObservation ?? clearExternalObservation();
      },
      runFixture: async (childEnv) => {
        deps.calls.push('runFixture');
        deps.fixtureCalls += 1;
        // The real create-fixture writes the credential file itself.
        if (options.fixtureCreatesCredential ?? true) {
          await writeFile(childEnv.W3_CREDENTIAL_OUT!, 'fake-secret-value', {
            mode: options.credentialMode ?? 0o600,
          });
        }
        const stdout = options.fixtureStdout?.replace(
          '%CREDENTIAL_PATH%',
          childEnv.W3_CREDENTIAL_OUT!,
        );
        return {
          status: options.fixtureStatus ?? 0,
          stdout: stdout ?? '',
          stderr: options.fixtureStatus ? 'fixture child failed' : '',
        } satisfies W3FixtureChildResult;
      },
      runDriver: async (childEnv) => {
        deps.calls.push('runDriver');
        deps.driverCalls += 1;
        deps.driverEnvs.push(childEnv);
        return options.driverStatus ?? 0;
      },
      stopBackend: async () => {
        deps.calls.push('stopBackend');
        deps.backendStopCalls += 1;
      },
    });
  } catch (error) {
    if (options.captureError) options.captureError(error);
    else throw error;
  }
  return deps;
}

function validTrace(): TraceSnapshot {
  return {
    enabled: true,
    runId: 'run-123',
    stats: {
      schemaVersion: 1,
      enabled: true,
      instanceId: 'instance-1',
      backendInstanceId: 'backend-1',
      processId: 4242,
      processStartIso,
      hostname: 'wsl-host',
      lifecycle: [
        {
          component: 'traceService',
          instanceId: 'instance-1',
          constructedAtIso: processStartIso,
        },
        {
          component: 'gateway',
          instanceId: 'gateway-1',
          constructedAtIso: processStartIso,
        },
        {
          component: 'publisher',
          instanceId: 'publisher-1',
          constructedAtIso: processStartIso,
        },
      ],
      runId: 'run-123',
      bufferSize: 20_000,
      recordedCount: 0,
      droppedCount: 0,
      dispatchedEventCount: 0,
    },
    records: [],
    timings: [],
    fetchedAtMs: 0,
  };
}

async function main(): Promise<void> {
  // ---- B1 happy path -------------------------------------------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-b1-'));
    try {
      const env = sourceEnv(dir);
      const deps = await runScenario(env, {
        fixtureStdout: JSON.stringify({
          fixture: {
            ...validDescriptor(),
            credentialFile: '%CREDENTIAL_PATH%',
          },
        }),
      });
      assert.equal(deps.fixtureCalls, 1);
      assert.equal(deps.driverCalls, 1);
      assert.deepEqual(deps.calls.slice(0, 8), [
        'startBackend',
        'waitForHealth',
        'fetchTrace',
        'inspectProcfs',
        'fetchMismatchTrace',
        'observeExternalCompetitors',
        'runFixture',
        'runDriver',
      ]);
      const persisted = JSON.parse(
        await readFile(env.W3_FIXTURE_PATH!, 'utf8'),
      );
      assert.equal(persisted.fixture.liveSessionId, 'session-1');
      assert.equal(persisted.fixture.credentialFile, env.W3_CREDENTIAL_OUT);
      // Attribution artifact: exclusive, schema-versioned, observational.
      const attribution = JSON.parse(
        await readFile(`${env.W3_OUTPUT_PATH}.attribution.json`, 'utf8'),
      );
      assert.equal(attribution.schemaVersion, 1);
      assert.equal(attribution.status, 'passed');
      assert.equal(attribution.externalPublisherExclusivity, 'observational');
      assert.equal(attribution.process.childPid, 4242);
      assert.deepEqual(attribution.process.listenerPids, [4242]);
      assert.equal(attribution.process.traceProcessId, 4242);
      assert.equal(attribution.runtime.mismatchRecordCount, 0);
      assert.equal(attribution.runtime.mismatchTimingCount, 0);
      const attributionMode =
        (await stat(`${env.W3_OUTPUT_PATH}.attribution.json`)).mode & 0o777;
      assert.equal(attributionMode, 0o600);
      // No secrets or environment values in attribution evidence.
      const attributionText = JSON.stringify(attribution);
      assert.equal(attributionText.includes('postgresql://'), false);
      assert.equal(attributionText.includes('fake-secret-value'), false);
      const driverEnv = deps.driverEnvs[0]!;
      assert.equal(driverEnv.W3_FIXTURE_PATH, env.W3_FIXTURE_PATH);
      assert.equal(driverEnv.W3_CREDENTIAL_FILE, env.W3_CREDENTIAL_OUT);
      assert.equal(driverEnv.W3_PARTICIPANTS, '300');
      // B12 atomic-write hygiene: no temp file remains.
      const files = await readdir(dir);
      assert.equal(
        files.some((f) => f.includes('.tmp-')),
        false,
      );
      // Exit evidence exists, records both children, no secrets.
      const evidence = JSON.parse(
        await readFile(`${env.W3_OUTPUT_PATH}.exit.json`, 'utf8'),
      );
      assert.equal(evidence.fixture.spawned, true);
      assert.equal(evidence.fixture.status, 0);
      assert.equal(evidence.driver.spawned, true);
      assert.equal(evidence.driver.status, 0);
      assert.equal(
        JSON.stringify(evidence).includes('fake-secret-value'),
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- B2 explicit participant override ------------------------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-b2-'));
    try {
      const deps = await runScenario(
        sourceEnv(dir, { W3_PARTICIPANTS: '20' }),
        {
          fixtureStdout: JSON.stringify({
            fixture: {
              ...validDescriptor(),
              credentialFile: '%CREDENTIAL_PATH%',
            },
          }),
        },
      );
      assert.equal(deps.driverEnvs[0]!.W3_PARTICIPANTS, '20');
      assert.equal(W3_ACCEPTANCE_PARTICIPANTS, 300);
      assert.equal(deps.driverEnvs[0]!.W3_PARTICIPANTS, '20');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- B3 fixture non-zero: no driver, no descriptor, evidence records it ---
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-b3-'));
    try {
      await assert.rejects(
        runScenario(sourceEnv(dir), { fixtureStatus: 2 }),
        /fixture provisioning failed with status 2/,
      );
      await assert.rejects(readFile(sourceEnv(dir).W3_FIXTURE_PATH!, 'utf8'));
      const evidence = JSON.parse(
        await readFile(`${sourceEnv(dir).W3_OUTPUT_PATH}.exit.json`, 'utf8'),
      );
      assert.equal(evidence.fixture.status, 2);
      assert.equal(evidence.driver.spawned, false);
      assert.equal(evidence.blockedReason, 'FIXTURE_CHILD_FAILED');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- B4 invalid fixture JSON: driver not spawned, descriptor absent ------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-b4-'));
    try {
      await assert.rejects(
        runScenario(sourceEnv(dir), { fixtureStdout: '{not json' }),
        /not valid JSON/,
      );
      await assert.rejects(readFile(sourceEnv(dir).W3_FIXTURE_PATH!, 'utf8'));
      const evidence = JSON.parse(
        await readFile(`${sourceEnv(dir).W3_OUTPUT_PATH}.exit.json`, 'utf8'),
      );
      assert.equal(evidence.driver.spawned, false);
      assert.equal(evidence.blockedReason, 'FIXTURE_DESCRIPTOR_INVALID');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- B5 pre-existing fixture path: fail before fixture spawn -------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-b5-'));
    try {
      const env = sourceEnv(dir);
      await writeFile(env.W3_FIXTURE_PATH!, '{"existing":true}');
      await assert.rejects(
        runScenario(env, {}),
        /fixture descriptor artifact already exists/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- B5b/B6 pre-existing credential path: fail before fixture spawn ------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-b6-'));
    try {
      const env = sourceEnv(dir);
      await writeFile(env.W3_CREDENTIAL_OUT!, 'old-secret', { mode: 0o600 });
      let spawned = false;
      const backend = {} as ChildProcess;
      await assert.rejects(
        orchestrateW3(env, {
          ...gateDependencies(),
          startBackend: async () => {
            spawned = true;
            return backend;
          },
          waitForHealth: async () => undefined,
          fetchTrace: async () => validTrace(),
          runFixture: async () => {
            spawned = false; // must never happen before the guard
            return { status: 0, stdout: '', stderr: '' };
          },
          runDriver: async () => 0,
          stopBackend: async () => undefined,
        }),
        /credential artifact already exists/,
      );
      assert.equal(spawned, false); // backend and fixture must never be invoked
      const evidence = JSON.parse(
        await readFile(`${env.W3_OUTPUT_PATH}.exit.json`, 'utf8'),
      );
      assert.equal(evidence.fixture.spawned, false);
      assert.equal(evidence.blockedReason, 'ARTIFACT_PATH_CONFLICT');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- B7 missing credential artifact: driver not spawned ------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-b7-'));
    try {
      await assert.rejects(
        runScenario(sourceEnv(dir), {
          fixtureCreatesCredential: false,
          fixtureStdout: JSON.stringify({
            fixture: {
              ...validDescriptor(),
              credentialFile: '%CREDENTIAL_PATH%',
            },
          }),
        }),
        /credential artifact is missing/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- B8 credential path mismatch: driver not spawned ---------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-b8-'));
    try {
      await assert.rejects(
        runScenario(sourceEnv(dir), {
          fixtureStdout: JSON.stringify({
            fixture: {
              ...validDescriptor(),
              credentialFile: '/other/credential-path',
            },
          }),
        }),
        /does not match W3_CREDENTIAL_OUT/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- B9 credential permissions invalid (POSIX-only mode assertion) -------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-b9-'));
    try {
      await assert.rejects(
        runScenario(sourceEnv(dir), {
          credentialMode: 0o644,
          fixtureStdout: JSON.stringify({
            fixture: {
              ...validDescriptor(),
              credentialFile: '%CREDENTIAL_PATH%',
            },
          }),
        }),
        /mode must be 0600/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- B10 driver non-zero: exactly one of each, no retry ------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-b10-'));
    try {
      const env = sourceEnv(dir);
      await assert.rejects(
        runScenario(env, {
          driverStatus: 3,
          fixtureStdout: JSON.stringify({
            fixture: {
              ...validDescriptor(),
              credentialFile: '%CREDENTIAL_PATH%',
            },
          }),
        }),
        /driver failed with status 3/,
      );
      const evidence = JSON.parse(
        await readFile(`${env.W3_OUTPUT_PATH}.exit.json`, 'utf8'),
      );
      assert.equal(evidence.fixture.spawned, true);
      assert.equal(evidence.fixture.status, 0);
      assert.equal(evidence.driver.spawned, true);
      assert.equal(evidence.driver.status, 3);
      assert.equal(evidence.blockedReason, 'DRIVER_CHILD_FAILED');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- D1 pre-existing exit evidence is preserved ---------------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-d1-'));
    try {
      const env = sourceEnv(dir);
      const sentinel = '{"sentinel":"preserve-me"}\n';
      await writeFile(`${env.W3_OUTPUT_PATH}.exit.json`, sentinel);
      const counts = { start: 0, fixture: 0, driver: 0, stop: 0 };
      await assert.rejects(
        orchestrateW3(env, {
          ...gateDependencies(),
          startBackend: async () => {
            counts.start += 1;
            return {} as ChildProcess;
          },
          waitForHealth: async () => undefined,
          fetchTrace: async () => validTrace(),
          runFixture: async () => {
            counts.fixture += 1;
            return { status: 0, stdout: '', stderr: '' };
          },
          runDriver: async () => {
            counts.driver += 1;
            return 0;
          },
          stopBackend: async () => {
            counts.stop += 1;
          },
        }),
        /exit evidence artifact already exists/,
      );
      assert.equal(
        await readFile(`${env.W3_OUTPUT_PATH}.exit.json`, 'utf8'),
        sentinel,
      );
      assert.deepEqual(counts, { start: 0, fixture: 0, driver: 0, stop: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- D2/D3 existing output paths, including empty, are conflicts ----------
  for (const [name, content] of [
    ['empty', ''],
    ['non-empty', '{"old":true}'],
  ] as const) {
    const dir = await mkdtemp(join(tmpdir(), `w3-orch-d2-${name}-`));
    try {
      const env = sourceEnv(dir);
      await writeFile(env.W3_OUTPUT_PATH!, content);
      let startCalls = 0;
      const deps = await assert.rejects(
        orchestrateW3(env, {
          ...gateDependencies(),
          startBackend: async () => {
            startCalls += 1;
            throw new Error('must not start');
          },
          waitForHealth: async () => undefined,
          fetchTrace: async () => validTrace(),
          runFixture: async () => ({ status: 0, stdout: '', stderr: '' }),
          runDriver: async () => 0,
          stopBackend: async () => undefined,
        }),
        /driver report artifact already exists/,
      );
      void deps;
      assert.equal(startCalls, 0);
      assert.equal(await readFile(env.W3_OUTPUT_PATH!, 'utf8'), content);
      assert.equal((await lstat(env.W3_OUTPUT_PATH!)).isFile(), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- D4 symlink is treated as an artifact conflict ------------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-d4-'));
    try {
      const env = sourceEnv(dir);
      const target = join(dir, 'outside.json');
      const sentinel = 'outside-sentinel';
      await writeFile(target, sentinel);
      await symlink(target, env.W3_OUTPUT_PATH!);
      let failure: unknown;
      const deps = await runScenario(env, {
        captureError: (error) => {
          failure = error;
        },
      });
      assert.match(String(failure), /driver report artifact already exists/);
      assert.equal(deps.backendStartCalls, 0);
      assert.equal(deps.fixtureCalls, 0);
      assert.equal(deps.driverCalls, 0);
      assert.equal(deps.backendStopCalls, 0);
      assert.equal(await readFile(target, 'utf8'), sentinel);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- D5 backend startup failure -------------------------------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-d5-'));
    try {
      const env = sourceEnv(dir);
      let failure: unknown;
      const deps = await runScenario(env, {
        backendStartError: new Error('backend unavailable'),
        captureError: (error) => {
          failure = error;
        },
      });
      assert.match(String(failure), /backend unavailable/);
      assert.equal(deps.backendStartCalls, 1);
      assert.equal(deps.fixtureCalls, 0);
      assert.equal(deps.driverCalls, 0);
      assert.equal(deps.backendStopCalls, 0);
      const evidence = JSON.parse(
        await readFile(`${env.W3_OUTPUT_PATH}.exit.json`, 'utf8'),
      );
      assert.equal(evidence.blockedReason, 'BACKEND_START_FAILED');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- D6 fixture failure stops backend once -------------------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-d6-'));
    try {
      let failure: unknown;
      const deps = await runScenario(sourceEnv(dir), {
        fixtureStatus: 2,
        captureError: (error) => {
          failure = error;
        },
      });
      assert.match(
        String(failure),
        /fixture provisioning failed with status 2/,
      );
      assert.equal(deps.backendStartCalls, 1);
      assert.equal(deps.fixtureCalls, 1);
      assert.equal(deps.driverCalls, 0);
      assert.equal(deps.backendStopCalls, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- D7 driver failure stops backend once ---------------------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-d7-'));
    try {
      let failure: unknown;
      const deps = await runScenario(sourceEnv(dir), {
        driverStatus: 3,
        fixtureStdout: JSON.stringify({
          fixture: {
            ...validDescriptor(),
            credentialFile: '%CREDENTIAL_PATH%',
          },
        }),
        captureError: (error) => {
          failure = error;
        },
      });
      assert.match(String(failure), /driver failed with status 3/);
      assert.equal(deps.backendStartCalls, 1);
      assert.equal(deps.fixtureCalls, 1);
      assert.equal(deps.driverCalls, 1);
      assert.equal(deps.backendStopCalls, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- D8 happy path stops backend once -------------------------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-d8-'));
    try {
      const deps = await runScenario(sourceEnv(dir), {
        fixtureStdout: JSON.stringify({
          fixture: {
            ...validDescriptor(),
            credentialFile: '%CREDENTIAL_PATH%',
          },
        }),
      });
      assert.equal(deps.backendStartCalls, 1);
      assert.equal(deps.fixtureCalls, 1);
      assert.equal(deps.driverCalls, 1);
      assert.equal(deps.backendStopCalls, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- E1 credential symlink is rejected without following its target ------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-e1-'));
    try {
      const env = sourceEnv(dir);
      const target = join(dir, 'credential-target');
      const sentinel = 'target-secret';
      await writeFile(target, sentinel, { mode: 0o600 });
      const counts = { start: 0, fixture: 0, driver: 0, stop: 0 };
      await assert.rejects(
        orchestrateW3(env, {
          ...gateDependencies(),
          startBackend: async () => {
            counts.start += 1;
            return { pid: 4242 } as ChildProcess;
          },
          waitForHealth: async () => undefined,
          fetchTrace: async () => validTrace(),
          runFixture: async (childEnv) => {
            counts.fixture += 1;
            await symlink(target, childEnv.W3_CREDENTIAL_OUT!);
            return {
              status: 0,
              stdout: JSON.stringify({
                fixture: {
                  ...validDescriptor(),
                  credentialFile: childEnv.W3_CREDENTIAL_OUT!,
                },
              }),
              stderr: '',
            };
          },
          runDriver: async () => {
            counts.driver += 1;
            throw new Error('driver must not run');
          },
          stopBackend: async () => {
            counts.stop += 1;
          },
        }),
        /not a regular file/,
      );
      assert.deepEqual(counts, { start: 1, fixture: 1, driver: 0, stop: 1 });
      assert.equal(await readFile(target, 'utf8'), sentinel);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- E2/E3 evidence-write failures preserve the primary failure ----------
  for (const [name, options, primary, counts] of [
    [
      'fixture',
      { fixtureStatus: 2, evidenceWriteError: new Error('evidence disk full') },
      'fixture provisioning failed with status 2',
      { fixture: 1, driver: 0 },
    ],
    [
      'driver',
      {
        driverStatus: 3,
        evidenceWriteError: new Error('evidence disk full'),
        fixtureStdout: JSON.stringify({
          fixture: {
            ...validDescriptor(),
            credentialFile: '%CREDENTIAL_PATH%',
          },
        }),
      },
      'driver failed with status 3',
      { fixture: 1, driver: 1 },
    ],
  ] as const) {
    const dir = await mkdtemp(join(tmpdir(), `w3-orch-e${name}-`));
    try {
      let failure: unknown;
      const deps = await runScenario(sourceEnv(dir), {
        ...options,
        captureError: (error) => {
          failure = error;
        },
      });
      assert.match(String(failure), new RegExp(primary));
      assert.match(
        String((failure as { evidenceFailure?: unknown }).evidenceFailure),
        /evidence disk full/,
      );
      assert.equal(deps.fixtureCalls, counts.fixture);
      assert.equal(deps.driverCalls, counts.driver);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- E4 successful children fail when mandatory evidence cannot persist ---
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-e4-'));
    try {
      let failure: unknown;
      const deps = await runScenario(sourceEnv(dir), {
        evidenceWriteError: new Error('evidence disk full'),
        fixtureStdout: JSON.stringify({
          fixture: {
            ...validDescriptor(),
            credentialFile: '%CREDENTIAL_PATH%',
          },
        }),
        captureError: (error) => {
          failure = error;
        },
      });
      assert.match(String(failure), /exit evidence write failed/);
      assert.equal(deps.fixtureCalls, 1);
      assert.equal(deps.driverCalls, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- B11 secret non-propagation ------------------------------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-b11-'));
    try {
      const env = sourceEnv(dir);
      const secret = 'SUPERSECRET-CREDENTIAL-CONTENT-0123456789';
      const deps: Deps = {
        calls: [],
        fixtureCalls: 0,
        driverCalls: 0,
        backendStartCalls: 0,
        backendStopCalls: 0,
        driverEnvs: [],
      };
      const backend = { pid: 4242 } as ChildProcess;
      await orchestrateW3(env, {
        ...gateDependencies(),
        startBackend: async () => backend,
        waitForHealth: async () => undefined,
        fetchTrace: async () => validTrace(),
        runFixture: async (childEnv) => {
          await writeFile(childEnv.W3_CREDENTIAL_OUT!, secret, {
            mode: 0o600,
          });
          return {
            status: 0,
            stdout: JSON.stringify({
              fixture: {
                ...validDescriptor(),
                credentialFile: childEnv.W3_CREDENTIAL_OUT!,
              },
            }),
            stderr: '',
          };
        },
        runDriver: async () => {
          deps.driverCalls += 1;
          return 0;
        },
        stopBackend: async () => undefined,
      });
      const descriptorText = await readFile(env.W3_FIXTURE_PATH!, 'utf8');
      assert.equal(descriptorText.includes(secret), false);
      const evidenceText = await readFile(
        `${env.W3_OUTPUT_PATH}.exit.json`,
        'utf8',
      );
      assert.equal(evidenceText.includes(secret), false);
      // Credential file itself still holds the secret (that is its job).
      const credential = await readFile(env.W3_CREDENTIAL_OUT!, 'utf8');
      assert.equal(credential, secret);
      const mode = (await stat(env.W3_CREDENTIAL_OUT!)).mode & 0o777;
      assert.equal(mode, 0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- B12 descriptor secret-like field rejected ---------------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-b12-'));
    try {
      await assert.rejects(
        runScenario(sourceEnv(dir), {
          fixtureStdout: JSON.stringify({
            fixture: {
              ...validDescriptor(),
              password: 'leak',
              credentialFile: '%CREDENTIAL_PATH%',
            },
          }),
        }),
        /forbidden field password/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- F1 concurrent descriptor target creation is never overwritten ------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-f1-'));
    try {
      const env = sourceEnv(dir);
      const sentinel = '{"sentinel":"created-after-preflight"}\n';
      let failure: unknown;
      const deps = await runScenario(env, {
        beforeDescriptorPersist: async (path) => {
          await writeFile(path, sentinel);
        },
        fixtureStdout: JSON.stringify({
          fixture: {
            ...validDescriptor(),
            credentialFile: '%CREDENTIAL_PATH%',
          },
        }),
        captureError: (error) => {
          failure = error;
        },
      });
      assert.match(String(failure), /EEXIST|already exists/);
      assert.equal(deps.fixtureCalls, 1);
      assert.equal(deps.driverCalls, 0);
      assert.equal(deps.backendStopCalls, 1);
      assert.equal(await readFile(env.W3_FIXTURE_PATH!, 'utf8'), sentinel);
      assert.equal(
        (await readdir(dir)).some((name) => name.includes('.tmp-')),
        false,
      );
      const evidence = JSON.parse(
        await readFile(`${env.W3_OUTPUT_PATH}.exit.json`, 'utf8'),
      );
      assert.equal(evidence.blockedReason, 'ARTIFACT_PATH_CONFLICT');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const runInvalidDescriptor = async (
    name: string,
    fixture: Record<string, unknown>,
  ): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), `w3-orch-${name}-`));
    try {
      const deps = await runScenario(sourceEnv(dir), {
        fixtureStdout: JSON.stringify({ fixture }),
        captureError: (error) => {
          assert.match(String(error), /unknown field/);
        },
      });
      assert.equal(deps.fixtureCalls, 1);
      assert.equal(deps.driverCalls, 0);
      await assert.rejects(readFile(sourceEnv(dir).W3_FIXTURE_PATH!, 'utf8'));
      const evidence = JSON.parse(
        await readFile(`${sourceEnv(dir).W3_OUTPUT_PATH}.exit.json`, 'utf8'),
      );
      assert.equal(evidence.driver.spawned, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  // ---- F2 unknown top-level field rejected -------------------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-f2-'));
    try {
      await assert.rejects(
        runScenario(sourceEnv(dir), {
          fixtureStdout: JSON.stringify({
            fixture: {
              ...validDescriptor(),
              credentialFile: '%CREDENTIAL_PATH%',
            },
            apiKey: 'should-not-persist',
          }),
        }),
        /unknown field apiKey/,
      );
      await assert.rejects(readFile(sourceEnv(dir).W3_FIXTURE_PATH!, 'utf8'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- F3 unknown fixture field rejected ---------------------------------
  await runInvalidDescriptor('f3', {
    ...validDescriptor(),
    credentialFile: '%CREDENTIAL_PATH%',
    privateKey: 'x',
  });

  // ---- F4 unknown nested option field rejected ----------------------------
  await runInvalidDescriptor('f4', {
    ...validDescriptor(),
    credentialFile: '%CREDENTIAL_PATH%',
    options: [
      { id: 'o1', optionRef: 'alpha', isCorrect: false, secret: 'x' },
      ...validDescriptor().options.slice(1),
    ],
  });

  // ---- F5 canonical descriptor persistence -------------------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-f5-'));
    try {
      const env = sourceEnv(dir);
      await runScenario(env, {
        fixtureStdout: JSON.stringify({
          fixture: {
            ...validDescriptor(),
            credentialFile: '%CREDENTIAL_PATH%',
          },
        }),
      });
      const persisted = JSON.parse(
        await readFile(env.W3_FIXTURE_PATH!, 'utf8'),
      );
      assert.deepEqual(Object.keys(persisted), ['fixture']);
      assert.deepEqual(Object.keys(persisted.fixture).sort(), [
        'courseId',
        'credentialFile',
        'credentialPresent',
        'liveSessionId',
        'options',
        'questionId',
        'questionType',
        'runId',
        'sessionCode',
        'sessionQuestionId',
        'username',
      ]);
      for (const option of persisted.fixture.options)
        assert.deepEqual(Object.keys(option).sort(), [
          'id',
          'isCorrect',
          'optionRef',
        ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- F6 arbitrary nested object rejected -------------------------------
  await runInvalidDescriptor('f6', {
    ...validDescriptor(),
    credentialFile: '%CREDENTIAL_PATH%',
    metadata: { anything: 'value' },
  });

  // ---- G1 ENOENT proves absence and preserves the happy path ---------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-g-enoent-'));
    try {
      const deps = await runScenario(sourceEnv(dir), {
        lstat: async () => {
          const error = new Error(
            'simulated absent path',
          ) as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        },
        fixtureStdout: JSON.stringify({
          fixture: {
            ...validDescriptor(),
            credentialFile: '%CREDENTIAL_PATH%',
          },
        }),
      });
      assert.equal(deps.backendStartCalls, 1);
      assert.equal(deps.fixtureCalls, 1);
      assert.equal(deps.driverCalls, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- G2–G4 artifact inspection errors fail closed ------------------------
  for (const code of ['EACCES', 'EPERM', 'EIO'] as const) {
    const dir = await mkdtemp(
      join(tmpdir(), `w3-orch-g-${code.toLowerCase()}-`),
    );
    try {
      let failure: unknown;
      const deps = await runScenario(sourceEnv(dir), {
        lstat: async () => {
          const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        },
        captureError: (error) => {
          failure = error;
        },
      });
      assert.match(String(failure), new RegExp(`inspection failed.*${code}`));
      assert.equal(deps.backendStartCalls, 0);
      assert.equal(deps.fixtureCalls, 0);
      assert.equal(deps.driverCalls, 0);
      assert.equal(deps.backendStopCalls, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- G1 attribution failure: procfs listener mismatch --------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-g1-'));
    try {
      let failure: unknown;
      const deps = await runScenario(sourceEnv(dir), {
        procfs: {
          ...validProcfs(),
          listenerPids: [9999],
        },
        fixtureStdout: JSON.stringify({
          fixture: {
            ...validDescriptor(),
            credentialFile: '%CREDENTIAL_PATH%',
          },
        }),
        captureError: (error) => {
          failure = error;
        },
      });
      assert.match(String(failure), /attribution preflight blocked/);
      assert.equal(deps.fixtureCalls, 0);
      assert.equal(deps.driverCalls, 0);
      assert.equal(deps.backendStopCalls, 1);
      const evidence = JSON.parse(
        await readFile(`${sourceEnv(dir).W3_OUTPUT_PATH}.exit.json`, 'utf8'),
      );
      assert.equal(evidence.blockedReason, 'ATTRIBUTION_PREFLIGHT_FAILED');
      assert.equal(
        evidence.attributionFailureCode,
        'CHILD_LISTENER_PID_MISMATCH',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- G2 attribution failure: external competitor observed ----------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-g2-'));
    try {
      let failure: unknown;
      const deps = await runScenario(sourceEnv(dir), {
        externalObservation: {
          ...clearExternalObservation(),
          competingDatabaseSessions: ['5551:app:10.0.0.9'],
        },
        captureError: (error) => {
          failure = error;
        },
      });
      assert.match(String(failure), /attribution preflight blocked/);
      assert.equal(deps.fixtureCalls, 0);
      assert.equal(deps.driverCalls, 0);
      assert.equal(deps.backendStopCalls, 1);
      const evidence = JSON.parse(
        await readFile(`${sourceEnv(dir).W3_OUTPUT_PATH}.exit.json`, 'utf8'),
      );
      assert.equal(
        evidence.attributionFailureCode,
        'EXTERNAL_COMPETITOR_OBSERVED',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- G4 competing trace record identity fails closed ----------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-g4-'));
    try {
      let failure: unknown;
      const base = validTrace();
      const deps = await runScenario(sourceEnv(dir), {
        trace: {
          ...base,
          records: [
            {
              ...(base.records[0] ?? {}),
              schemaVersion: 1,
              runId: 'run-123',
              instanceId: 'instance-1',
              backendInstanceId: 'backend-1',
              processId: 4242,
              processStartIso,
              hostname: 'wsl-host',
              phase: 'publisher',
              eventId: 'event-1',
              eventSeq: '1',
              eventType: 'RESULT_UPDATED',
              liveSessionId: 'session-1',
              targetType: 'room',
              targetId: 'session:1',
              payloadCorrelation: {
                eventSeq: '1',
                aggregateVersion: 1,
                visibility: 'participant',
              },
              publisherInstanceId: 'publisher-2',
            } as TraceSnapshot['records'][number],
          ],
        },
        captureError: (error) => {
          failure = error;
        },
      });
      assert.match(String(failure), /attribution preflight blocked/);
      assert.equal(deps.fixtureCalls, 0);
      assert.equal(deps.driverCalls, 0);
      assert.equal(deps.backendStopCalls, 1);
      const evidence = JSON.parse(
        await readFile(`${sourceEnv(dir).W3_OUTPUT_PATH}.exit.json`, 'utf8'),
      );
      assert.equal(
        evidence.attributionFailureCode,
        'COMPETING_RUNTIME_IDENTITY',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- G5 attribution write failure keeps fixture/driver at zero ------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-g5-'));
    try {
      let failure: unknown;
      const deps = await runScenario(sourceEnv(dir), {
        attributionWriteError: new Error('attribution disk full'),
        captureError: (error) => {
          failure = error;
        },
      });
      assert.match(
        String(failure),
        /attribution disk full|evidence write failed/,
      );
      assert.equal(deps.fixtureCalls, 0);
      assert.equal(deps.driverCalls, 0);
      assert.equal(deps.backendStopCalls, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- G6 race-created attribution artifact is never overwritten ------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-g6-'));
    try {
      const env = sourceEnv(dir);
      const sentinel = '{"sentinel":"created-after-preflight"}\n';
      let failure: unknown;
      const deps = await runScenario(env, {
        beforeAttributionPersist: async (path) => {
          await writeFile(path, sentinel);
        },
        captureError: (error) => {
          failure = error;
        },
      });
      assert.match(String(failure), /EEXIST|already exists|write failed/);
      assert.equal(deps.fixtureCalls, 0);
      assert.equal(deps.driverCalls, 0);
      assert.equal(deps.backendStopCalls, 1);
      assert.equal(
        await readFile(`${env.W3_OUTPUT_PATH}.attribution.json`, 'utf8'),
        sentinel,
      );
      const evidence = JSON.parse(
        await readFile(`${env.W3_OUTPUT_PATH}.exit.json`, 'utf8'),
      );
      assert.equal(evidence.blockedReason, 'ATTRIBUTION_EVIDENCE_CONFLICT');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- G7 pre-existing attribution artifact blocks before backend spawn -----
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-g7-'));
    try {
      const env = sourceEnv(dir);
      await writeFile(`${env.W3_OUTPUT_PATH}.attribution.json`, '{"old":true}');
      await assert.rejects(
        runScenario(env, {}),
        /attribution evidence artifact already exists/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- G8 ordering: attribution precedes fixture, follows health ------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'w3-orch-g8-'));
    try {
      const deps = await runScenario(sourceEnv(dir), {
        fixtureStdout: JSON.stringify({
          fixture: {
            ...validDescriptor(),
            credentialFile: '%CREDENTIAL_PATH%',
          },
        }),
      });
      assert.deepEqual(deps.calls, [
        'startBackend',
        'waitForHealth',
        'fetchTrace',
        'inspectProcfs',
        'fetchMismatchTrace',
        'observeExternalCompetitors',
        'runFixture',
        'runDriver',
        'stopBackend',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log('W3 orchestrator tests passed.');
}

void main().then(undefined, (error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
