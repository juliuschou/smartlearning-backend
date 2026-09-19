import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  parseConfig,
  scenarioNames,
  type HarnessConfig,
  type ScenarioName,
} from './config';
import { LoadHttpClient } from './http-client';
import { createOperation, operationReport } from './metrics';
import { LoadSocketClient } from './socket-client';
import { createW1Fixture, type W1Fixture } from './fixture';
import { W1DiagnosticsCollector } from './diagnostics';

interface ScenarioReport {
  name: ScenarioName;
  status: 'passed' | 'failed' | 'blocked';
  durationMs: number;
  operations: ReturnType<typeof operationReport>[];
  correctness: Record<string, number>;
  blockedReason?: string;
}
interface HarnessReport {
  schemaVersion: 1;
  run: {
    runId: string;
    startedAt: string;
    finishedAt: string;
    baseUrl: string;
    scenarios: ScenarioName[];
    participantCount: number;
    fixtureMode: string;
  };
  scenarios: ScenarioReport[];
  fixture?: Omit<W1Fixture, 'sessionCode'> & { sessionCode: string };
  safety: { secretsRedacted: true; destructiveCleanup: false };
  diagnostics?: ReturnType<W1DiagnosticsCollector['report']>;
}

function usage(): void {
  process.stdout.write(
    `W1-W8 load harness\n\nScenarios: ${scenarioNames.join(', ')}\n\nRequired for execution:\n  LOAD_BASE_URL=http://127.0.0.1:3000\n  LOAD_SESSION_CODE=<existing active session code>\n  LOAD_PARTICIPANT_TOKENS_JSON='["token..."]' for W2-W4\n\nExamples:\n  npm run load:test -- --list\n  LOAD_BASE_URL=http://127.0.0.1:3000 LOAD_SESSION_CODE=ABC npm run load:test -- --scenarios W1 --participants 5\n`,
  );
}

function blocked(name: ScenarioName, reason: string): ScenarioReport {
  return {
    name,
    status: 'blocked',
    durationMs: 0,
    operations: [],
    correctness: {},
    blockedReason: reason,
  };
}
function allExpectedTokens(config: HarnessConfig): string[] {
  return config.participantTokens.slice(0, config.participants);
}

async function runW1(
  config: HarnessConfig,
  http: LoadHttpClient,
): Promise<ScenarioReport> {
  const operation = createOperation('join', 'http');
  const started = performance.now();
  const joined = await Promise.all(
    Array.from({ length: config.participants }, (_, index) =>
      http.join(
        operation,
        config.sessionCode!,
        `Load User ${String(index + 1).padStart(3, '0')}`,
      ),
    ),
  );
  const successful = joined.filter(
    (result) => result.status === 201 && result.data?.participantId,
  );
  const ids = new Set(successful.map((result) => result.data!.participantId));
  return {
    name: 'W1',
    status:
      operation.unexpectedErrorCount === 0 && ids.size === successful.length
        ? 'passed'
        : 'failed',
    durationMs: performance.now() - started,
    operations: [operationReport(operation)],
    correctness: {
      joined: successful.length,
      duplicateParticipantIds: successful.length - ids.size,
    },
  };
}

async function runW2(
  config: HarnessConfig,
  http: LoadHttpClient,
): Promise<ScenarioReport> {
  if (
    !config.liveSessionId ||
    !config.sessionQuestionId ||
    allExpectedTokens(config).length < config.participants
  )
    return blocked(
      'W2',
      'LOAD_LIVE_SESSION_ID, LOAD_SESSION_QUESTION_ID, and one token per participant are required.',
    );
  const operation = createOperation('submit', 'http');
  const started = performance.now();
  const results = await Promise.all(
    allExpectedTokens(config).map((token) =>
      http.submit(
        operation,
        config.liveSessionId!,
        config.sessionQuestionId!,
        token,
        { selectedOptionRefs: ['source'] },
      ),
    ),
  );
  const ids = new Set(
    results
      .filter((result) => result.status === 201 && result.data)
      .map((result) => result.data!.id),
  );
  return {
    name: 'W2',
    status:
      operation.unexpectedErrorCount === 0 &&
      ids.size === results.filter((result) => result.status === 201).length
        ? 'passed'
        : 'failed',
    durationMs: performance.now() - started,
    operations: [operationReport(operation)],
    correctness: {
      successfulSubmissions: results.filter((result) => result.status === 201)
        .length,
      duplicateSubmissionIds:
        results.filter((result) => result.status === 201).length - ids.size,
    },
  };
}

async function runW3(config: HarnessConfig): Promise<ScenarioReport> {
  if (
    !config.liveSessionId ||
    allExpectedTokens(config).length < config.participants
  )
    return blocked(
      'W3',
      'LOAD_LIVE_SESSION_ID and one token per participant are required.',
    );
  const operation = createOperation('socket-connect', 'socket');
  const clients: LoadSocketClient[] = [];
  try {
    for (const token of allExpectedTokens(config)) {
      const client = new LoadSocketClient(
        config.baseUrl,
        config.sessionCode!,
        token,
        config.timeoutMs,
      );
      await client.connect(operation);
      clients.push(client);
    }
    return {
      name: 'W3',
      status: operation.unexpectedErrorCount === 0 ? 'passed' : 'failed',
      durationMs: 0,
      operations: [operationReport(operation)],
      correctness: { connected: clients.length },
    };
  } finally {
    clients.forEach((client) => client.disconnect());
  }
}

async function runScenario(
  name: ScenarioName,
  config: HarnessConfig,
  http: LoadHttpClient,
): Promise<ScenarioReport> {
  switch (name) {
    case 'W1':
      return runW1(config, http);
    case 'W2':
      return runW2(config, http);
    case 'W3':
      return runW3(config);
    case 'W4':
      return blocked(
        'W4',
        'Reconnect orchestration requires a completed W3 socket cohort and is not enabled in this safe first harness slice.',
      );
    case 'W5':
      return blocked(
        'W5',
        'Thirty-minute sustained execution is intentionally not enabled in the first harness slice.',
      );
    case 'W6':
      return blocked(
        'W6',
        'Submit/close race requires teacher credentials and explicit fixture lifecycle control.',
      );
    case 'W7':
      return blocked(
        'W7',
        'Idempotency retry requires an explicit existing session/question fixture and is not enabled without a verified fixture answer contract.',
      );
    case 'W8':
      return blocked(
        'W8',
        'No external controlled-clock adapter is configured; never wait eight hours in a load run.',
      );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    usage();
    return;
  }
  const config = parseConfig(args);
  if (config.listOnly) {
    usage();
    return;
  }
  const startedAt = new Date().toISOString();
  const diagnostics = new W1DiagnosticsCollector();
  const http = new LoadHttpClient(
    config.baseUrl,
    config.timeoutMs,
    diagnostics,
    config.runId,
  );
  let fixture: W1Fixture | undefined;
  if (config.fixtureMode === 'create') {
    fixture = await createW1Fixture(
      http,
      config.runId,
      config.teacherUsername!,
      config.teacherPassword!,
    );
    config.sessionCode = fixture.sessionCode;
    config.liveSessionId = fixture.liveSessionId;
    config.sessionQuestionId = fixture.sessionQuestionId;
  }
  const scenarios: ScenarioReport[] = [];
  if (process.env.LOAD_FIXTURE_ONLY !== '1')
    for (const name of config.scenarios)
      scenarios.push(await runScenario(name, config, http));
  const report: HarnessReport = {
    schemaVersion: 1,
    run: {
      runId: config.runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      baseUrl: config.baseUrl,
      scenarios: config.scenarios,
      participantCount: config.participants,
      fixtureMode: config.fixtureMode,
    },
    scenarios,
    ...(fixture
      ? {
          fixture: {
            runId: fixture.runId,
            marker: fixture.marker,
            courseId: fixture.courseId,
            questionId: fixture.questionId,
            liveSessionId: fixture.liveSessionId,
            sessionQuestionId: fixture.sessionQuestionId,
            sessionCode: fixture.sessionCode,
          },
        }
      : {}),
    safety: { secretsRedacted: true, destructiveCleanup: false },
    ...(diagnostics.report() ? { diagnostics: diagnostics.report() } : {}),
  };
  const json = JSON.stringify(report, null, 2);
  if (config.outputPath)
    await writeFile(config.outputPath, `${json}\n`, 'utf8');
  process.stdout.write(
    `${scenarios.map((scenario) => `${scenario.name}: ${scenario.status}${scenario.blockedReason ? ` (${scenario.blockedReason})` : ''}`).join('\n')}\n`,
  );
  if (config.outputPath)
    process.stdout.write(`Report written to ${config.outputPath}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Harness failed.'}\n`,
  );
  process.exitCode = 2;
});
