import { Client } from 'pg';

export const W3_DB_WAIT_TRACE_ENABLED = 'W3_DB_WAIT_TRACE_ENABLED';

const AUTHORIZED_DATABASE = 'smartlearning_test';
const DEFAULT_INTERVAL_MS = 200;
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 250;
const DEFAULT_DURATION_MS = 5_000;
const MAX_DURATION_MS = 60_000;
const DEFAULT_CAPACITY = 256;
const MAX_CAPACITY = 10_000;

type QueryResult<T> = { rows: T[] };

export interface DbWaitClient {
  connect(): Promise<unknown>;
  query<T>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  end(): Promise<void>;
}

export interface DbWaitObserverConfig {
  enabled?: boolean;
  databaseUrl?: string;
  runMarker: string;
  backendPids: ReadonlySet<number>;
  applicationName?: string;
  intervalMs?: number;
  maxDurationMs?: number;
  maxSamples?: number;
  client?: DbWaitClient;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface DbWaitSample {
  timestamp: string;
  pid: number;
  runMarker: string;
  state: string | null;
  waitEventType: string | null;
  waitEvent: string | null;
  lockType: string | null;
  granted: boolean | null;
  relation: string | null;
  transactionIdPresent: boolean;
  blockingPids: number[];
}

export interface DbWaitObserverReport {
  enabled: boolean;
  runMarker: string;
  samples: DbWaitSample[];
  droppedCount: number;
  observerErrorCount: number;
}

type ActivityRow = {
  pid: number;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  blocking_pids: number[] | null;
};

type LockRow = {
  pid: number;
  locktype: string | null;
  granted: boolean;
  relation: string | null;
  transactionid_present: boolean;
};

type DatabaseRow = {
  database_name: string;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export function buildObserverConfig(config: DbWaitObserverConfig) {
  const enabled =
    config.enabled ?? process.env[W3_DB_WAIT_TRACE_ENABLED] === '1';

  // A disabled observer never connects, queries, or installs a timer, so its
  // runtime prerequisites (run marker, PID scope, sampling bounds) are not
  // required. Validate them only when the observer is actually enabled.
  if (!enabled) {
    return {
      enabled: false,
      runMarker: config.runMarker,
      backendPids: config.backendPids,
      applicationName: config.applicationName,
      intervalMs: config.intervalMs ?? DEFAULT_INTERVAL_MS,
      maxDurationMs: config.maxDurationMs ?? DEFAULT_DURATION_MS,
      maxSamples: config.maxSamples ?? DEFAULT_CAPACITY,
    };
  }

  if (!config.runMarker.trim()) {
    throw new Error('runMarker is required.');
  }

  if (config.backendPids.size === 0) {
    throw new Error('At least one backend PID is required.');
  }

  for (const pid of config.backendPids) {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error('backendPids must contain positive integers.');
    }
  }

  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (
    !Number.isInteger(intervalMs) ||
    intervalMs < MIN_INTERVAL_MS ||
    intervalMs > MAX_INTERVAL_MS
  ) {
    throw new Error(
      `intervalMs must be ${MIN_INTERVAL_MS}-${MAX_INTERVAL_MS}.`,
    );
  }

  const maxDurationMs = config.maxDurationMs ?? DEFAULT_DURATION_MS;
  if (
    !Number.isInteger(maxDurationMs) ||
    maxDurationMs <= 0 ||
    maxDurationMs > MAX_DURATION_MS
  ) {
    throw new Error(`maxDurationMs must be 1-${MAX_DURATION_MS}.`);
  }

  const maxSamples = config.maxSamples ?? DEFAULT_CAPACITY;
  if (
    !Number.isInteger(maxSamples) ||
    maxSamples <= 0 ||
    maxSamples > MAX_CAPACITY
  ) {
    throw new Error(`maxSamples must be 1-${MAX_CAPACITY}.`);
  }

  return {
    enabled: config.enabled ?? process.env[W3_DB_WAIT_TRACE_ENABLED] === '1',
    runMarker: config.runMarker,
    backendPids: config.backendPids,
    applicationName: config.applicationName,
    intervalMs,
    maxDurationMs,
    maxSamples,
  };
}

export class DbWaitObserver {
  private readonly config: ReturnType<typeof buildObserverConfig>;
  private readonly client: DbWaitClient;
  private readonly now: () => number;
  private readonly samples: DbWaitSample[] = [];
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private timer: TimerHandle | undefined;
  private deadlineTimer: TimerHandle | undefined;
  private inFlight: Promise<void> | undefined;
  private started = false;
  private stopped = false;
  private finalized = false;
  private connected = false;
  private droppedCount = 0;
  private observerErrorCount = 0;

  constructor(config: DbWaitObserverConfig) {
    this.config = buildObserverConfig(config);
    this.client =
      config.client ?? new Client({ connectionString: config.databaseUrl });
    this.now = config.now ?? Date.now;
    this.setIntervalFn = config.setIntervalFn ?? setInterval;
    this.clearIntervalFn = config.clearIntervalFn ?? clearInterval;
    this.setTimeoutFn = config.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = config.clearTimeoutFn ?? clearTimeout;
  }

  async start(): Promise<void> {
    if (
      !this.config.enabled ||
      this.started ||
      this.stopped ||
      this.finalized
    ) {
      return;
    }

    this.started = true;

    try {
      await this.client.connect();
      this.connected = true;

      await this.verifyDatabaseAuthority();

      if (this.stopped) {
        return;
      }

      const initialOperation = this.captureOnce(this.now());
      this.inFlight = initialOperation;

      try {
        await initialOperation;
      } finally {
        if (this.inFlight === initialOperation) {
          this.inFlight = undefined;
        }
      }

      if (this.stopped || !this.connected) {
        return;
      }

      this.timer = this.setIntervalFn(
        () => void this.capture(this.now()),
        this.config.intervalMs,
      );

      this.deadlineTimer = this.setTimeoutFn(
        () => void this.stop(),
        this.config.maxDurationMs,
      );
    } catch {
      this.observerErrorCount += 1;
      await this.cleanupConnection();
      this.started = false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;

    if (this.timer !== undefined) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }

    if (this.deadlineTimer !== undefined) {
      this.clearTimeoutFn(this.deadlineTimer);
      this.deadlineTimer = undefined;
    }

    await this.inFlight?.catch(() => undefined);
    this.inFlight = undefined;

    await this.cleanupConnection();
  }

  async finalize(): Promise<DbWaitObserverReport> {
    if (!this.finalized) {
      this.finalized = true;
      await this.stop();
    }

    return this.report();
  }

  report(): DbWaitObserverReport {
    return {
      enabled: this.config.enabled,
      runMarker: this.config.runMarker,
      samples: this.samples.map((sample) => ({
        ...sample,
        blockingPids: [...sample.blockingPids],
      })),
      droppedCount: this.droppedCount,
      observerErrorCount: this.observerErrorCount,
    };
  }

  private async verifyDatabaseAuthority(): Promise<void> {
    const result = await this.client.query<DatabaseRow>(
      'SELECT current_database() AS database_name',
    );

    if (result.rows[0]?.database_name !== AUTHORIZED_DATABASE) {
      throw new Error('UNAUTHORIZED_DATABASE');
    }
  }

  private async capture(capturedAtMs: number): Promise<void> {
    if (
      !this.config.enabled ||
      this.stopped ||
      !this.connected ||
      this.inFlight
    ) {
      return;
    }

    const operation = this.captureOnce(capturedAtMs).catch(() => {
      this.observerErrorCount += 1;
    });

    this.inFlight = operation;

    await operation;

    if (this.inFlight === operation) {
      this.inFlight = undefined;
    }
  }

  private async captureOnce(capturedAtMs: number): Promise<void> {
    const configuredPids = [...this.config.backendPids];

    const activity = await this.client.query<ActivityRow>(
      `SELECT pid, state, wait_event_type, wait_event,
              COALESCE(pg_blocking_pids(pid), ARRAY[]::integer[]) AS blocking_pids
       FROM pg_stat_activity
       WHERE datname = $1
         AND pid = ANY($2::integer[])
         AND pid <> pg_backend_pid()
         AND ($3::text IS NULL OR application_name = $3)
       ORDER BY pid`,
      [
        AUTHORIZED_DATABASE,
        configuredPids,
        this.config.applicationName ?? null,
      ],
    );

    // Defense-in-depth: the SQL already scopes to configuredPids, but the
    // observer guarantees its own scope by dropping any returned row whose PID
    // is outside the configured backend set before sampling.
    const configuredPidSet = new Set(configuredPids);
    const observedRows = activity.rows.filter((row) =>
      configuredPidSet.has(row.pid),
    );

    const observedPids = observedRows.map((row) => row.pid);

    let locks: LockRow[] = [];

    if (observedPids.length > 0) {
      const lockResult = await this.client.query<LockRow>(
        `SELECT pid, locktype, granted,
                relation::regclass::text AS relation,
                (transactionid IS NOT NULL) AS transactionid_present
         FROM pg_locks
         WHERE pid = ANY($1::integer[])
           AND pid <> pg_backend_pid()
         ORDER BY pid, locktype, granted DESC`,
        [observedPids],
      );

      locks = lockResult.rows;
    }

    const locksByPid = new Map<number, LockRow[]>();

    for (const lock of locks) {
      const rows = locksByPid.get(lock.pid) ?? [];
      rows.push(lock);
      locksByPid.set(lock.pid, rows);
    }

    const timestamp = new Date(capturedAtMs).toISOString();

    for (const activityRow of observedRows) {
      const pidLocks = locksByPid.get(activityRow.pid) ?? [];
      const rows: Array<LockRow | null> =
        pidLocks.length > 0 ? pidLocks : [null];

      for (const lock of rows) {
        this.push({
          timestamp,
          pid: activityRow.pid,
          runMarker: this.config.runMarker,
          state: activityRow.state,
          waitEventType: activityRow.wait_event_type,
          waitEvent: activityRow.wait_event,
          lockType: lock?.locktype ?? null,
          granted: lock?.granted ?? null,
          relation: lock?.relation ?? null,
          transactionIdPresent: lock?.transactionid_present ?? false,
          blockingPids: (activityRow.blocking_pids ?? []).filter(
            (pid) => Number.isInteger(pid) && pid > 0,
          ),
        });
      }
    }
  }

  private push(sample: DbWaitSample): void {
    if (this.samples.length >= this.config.maxSamples) {
      this.samples.shift();
      this.droppedCount += 1;
    }

    this.samples.push(sample);
  }

  private async cleanupConnection(): Promise<void> {
    if (!this.connected) {
      return;
    }

    this.connected = false;
    await this.client.end().catch(() => undefined);
  }
}

export const observerConstants = {
  authorizedDatabase: AUTHORIZED_DATABASE,
  defaultIntervalMs: DEFAULT_INTERVAL_MS,
  minIntervalMs: MIN_INTERVAL_MS,
  maxIntervalMs: MAX_INTERVAL_MS,
  maxDurationMs: MAX_DURATION_MS,
  maxCapacity: MAX_CAPACITY,
};
