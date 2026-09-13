import { randomUUID } from 'node:crypto';

export type ScenarioName = `W${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
export type FixtureMode = 'existing' | 'create';

export interface HarnessConfig {
  baseUrl: string;
  scenarios: ScenarioName[];
  participants: number;
  arrivalWindowMs: number;
  timeoutMs: number;
  durationMs: number;
  sessionCode?: string;
  liveSessionId?: string;
  sessionQuestionId?: string;
  participantTokens: string[];
  fixtureMode: FixtureMode;
  outputPath?: string;
  runId: string;
  teacherUsername?: string;
  teacherPassword?: string;
  allowFixtureWrites: boolean;
  listOnly: boolean;
}

const SCENARIOS: ScenarioName[] = [
  'W1',
  'W2',
  'W3',
  'W4',
  'W5',
  'W6',
  'W7',
  'W8',
];

function readNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${name} must be a non-negative number.`);
  return parsed;
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseScenarios(value: string | undefined): ScenarioName[] {
  const names = (value ?? SCENARIOS.join(','))
    .split(',')
    .map((item) => item.trim().toUpperCase());
  if (names.some((name) => !SCENARIOS.includes(name as ScenarioName))) {
    throw new Error(
      `LOAD_SCENARIOS must contain only ${SCENARIOS.join(', ')}.`,
    );
  }
  return [...new Set(names)] as ScenarioName[];
}

function parseTokens(): string[] {
  const raw = process.env.LOAD_PARTICIPANT_TOKENS_JSON;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('LOAD_PARTICIPANT_TOKENS_JSON must be valid JSON.');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((token) => typeof token !== 'string' || token.length === 0)
  ) {
    throw new Error(
      'LOAD_PARTICIPANT_TOKENS_JSON must be a non-empty string array.',
    );
  }
  return parsed;
}

export function parseConfig(argv = process.argv.slice(2)): HarnessConfig {
  const listOnly = flag(argv, '--list');
  const baseUrl = option(argv, '--base-url') ?? process.env.LOAD_BASE_URL;
  if (!listOnly && !baseUrl)
    throw new Error('Set LOAD_BASE_URL or pass --base-url.');
  if (baseUrl) {
    const parsedUrl = new URL(baseUrl);
    if (
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.search ||
      parsedUrl.hash
    )
      throw new Error(
        'LOAD_BASE_URL must not contain credentials, query, or fragment.',
      );
  }
  const scenarios = parseScenarios(
    option(argv, '--scenarios') ?? process.env.LOAD_SCENARIOS,
  );
  const participantTokens = parseTokens();
  const participants = Number(
    option(argv, '--participants') ?? readNumber('LOAD_PARTICIPANTS', 300),
  );
  if (!Number.isInteger(participants) || participants < 1)
    throw new Error('participants must be a positive integer.');
  const fixtureMode = (process.env.LOAD_FIXTURE_MODE ??
    'existing') as FixtureMode;
  if (!['existing', 'create'].includes(fixtureMode)) {
    throw new Error('LOAD_FIXTURE_MODE must be existing or create.');
  }
  const allowFixtureWrites = process.env.LOAD_ALLOW_FIXTURE_WRITES === '1';
  const teacherUsername = process.env.LOAD_TEACHER_USERNAME;
  const teacherPassword = process.env.LOAD_TEACHER_PASSWORD;
  if (fixtureMode === 'create') {
    if (!allowFixtureWrites) {
      throw new Error('Create mode requires LOAD_ALLOW_FIXTURE_WRITES=1.');
    }
    if (process.env.LOAD_DISPOSABLE_TARGET !== '1') {
      throw new Error('Create mode requires LOAD_DISPOSABLE_TARGET=1.');
    }
    if (
      !baseUrl ||
      !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl)
    ) {
      throw new Error(
        'Create mode is restricted to a localhost or loopback base URL.',
      );
    }
    if (!teacherUsername || !teacherPassword) {
      throw new Error(
        'Create mode requires LOAD_TEACHER_USERNAME and LOAD_TEACHER_PASSWORD.',
      );
    }
    if (!scenarios.every((name) => name === 'W1')) {
      throw new Error('Create mode currently supports only the W1 scenario.');
    }
  }
  const arrivalWindowMs = Number(
    option(argv, '--arrival-window-ms') ??
      readNumber('LOAD_ARRIVAL_WINDOW_MS', 10_000),
  );
  const timeoutMs = Number(
    option(argv, '--timeout-ms') ?? readNumber('LOAD_TIMEOUT_MS', 10_000),
  );
  const durationMs = Number(
    option(argv, '--duration-ms') ??
      readNumber('LOAD_DURATION_MS', 30 * 60_000),
  );
  for (const [name, value] of Object.entries({
    arrivalWindowMs,
    timeoutMs,
    durationMs,
  })) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`${name} must be a non-negative number.`);
  }
  const config: HarnessConfig = {
    baseUrl: baseUrl ? new URL(baseUrl).toString().replace(/\/$/, '') : '',
    scenarios,
    participants,
    arrivalWindowMs,
    timeoutMs,
    durationMs,
    sessionCode: process.env.LOAD_SESSION_CODE,
    liveSessionId: process.env.LOAD_LIVE_SESSION_ID,
    sessionQuestionId: process.env.LOAD_SESSION_QUESTION_ID,
    participantTokens,
    fixtureMode,
    outputPath: option(argv, '--output') ?? process.env.LOAD_OUTPUT,
    runId: process.env.LOAD_RUN_ID ?? randomUUID(),
    teacherUsername,
    teacherPassword,
    allowFixtureWrites,
    listOnly,
  };
  if (
    !listOnly &&
    fixtureMode === 'existing' &&
    scenarios.some((name) => name !== 'W8') &&
    !config.sessionCode
  ) {
    throw new Error(
      'LOAD_SESSION_CODE is required for existing-fixture scenarios.',
    );
  }
  return config;
}

export const scenarioNames = SCENARIOS;
