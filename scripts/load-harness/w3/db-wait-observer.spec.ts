/**
 * Focused unit coverage for the W3 PostgreSQL wait observer hardening
 * (`db-wait-observer.ts`).
 *
 * Scope is intentionally narrow — it pins exactly the two hardened contracts:
 *
 *  1. A disabled observer must construct without active-only runtime
 *     prerequisites (run marker, non-empty PID scope); an enabled observer must
 *     still reject the same omissions.
 *  2. `captureOnce()` must fail-closed on PID scope: even if the catalog query
 *     returns a PID outside the configured backend set, that row may not become
 *     a sample and must not reach the downstream `pg_locks` observation scope.
 *
 * No database is touched — every client is an injected fake and every timer is
 * a manual fake. Run with `tsx scripts/load-harness/w3/db-wait-observer.spec.ts`
 * (matching the other w3 specs, which run through tsx rather than jest).
 */
import assert from 'node:assert/strict';
import {
  buildObserverConfig,
  DbWaitObserver,
  observerConstants,
  type DbWaitClient,
} from './db-wait-observer';

// ---- tiny harness ----------------------------------------------------------

async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  // eslint-disable-next-line no-console
  console.log(`  PASS  ${name}`);
}

// ---- fake timer surface ----------------------------------------------------

class FakeTimers {
  readonly setIntervalFn = ((_fn: () => void, _ms?: number) =>
    1) as unknown as typeof setInterval;
  readonly clearIntervalFn = ((_id: unknown) =>
    undefined) as unknown as typeof clearInterval;
  readonly setTimeoutFn = ((_fn: () => void, _ms?: number) =>
    2) as unknown as typeof setTimeout;
  readonly clearTimeoutFn = ((_id: unknown) =>
    undefined) as unknown as typeof clearTimeout;
}

// ---- fake client -----------------------------------------------------------

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

class FakeClient implements DbWaitClient {
  connectCalls = 0;
  endCalls = 0;
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];

  activity: ActivityRow[] = [];
  locks: LockRow[] = [];

  connect(): Promise<unknown> {
    this.connectCalls += 1;
    return Promise.resolve(undefined);
  }

  end(): Promise<void> {
    this.endCalls += 1;
    return Promise.resolve();
  }

  async query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ text, values });

    if (text.includes('current_database')) {
      return {
        rows: [{ database_name: observerConstants.authorizedDatabase }] as T[],
      };
    }
    if (text.includes('pg_stat_activity')) {
      return { rows: this.activity as T[] };
    }
    if (text.includes('pg_locks')) {
      return { rows: this.locks as T[] };
    }
    return { rows: [] as T[] };
  }

  lockQuery(): { text: string; values?: unknown[] } | undefined {
    return this.queries.find((q) => q.text.includes('pg_locks'));
  }
}

function activityRow(
  pid: number,
  over: Partial<ActivityRow> = {},
): ActivityRow {
  return {
    pid,
    state: 'active',
    wait_event_type: 'Lock',
    wait_event: 'transactionid',
    blocking_pids: [],
    ...over,
  };
}

function lockRow(pid: number, over: Partial<LockRow> = {}): LockRow {
  return {
    pid,
    locktype: 'relation',
    granted: true,
    relation: 'public.t',
    transactionid_present: false,
    ...over,
  };
}

function makeObserver(client: FakeClient, backendPids: number[]) {
  const timers = new FakeTimers();
  const observer = new DbWaitObserver({
    enabled: true,
    runMarker: 'w3-observer-spec',
    backendPids: new Set(backendPids),
    now: () => 1_700_000_000_000,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    client,
  });
  return observer;
}

// ---- tests -----------------------------------------------------------------

async function main(): Promise<void> {
  // ---- Test 1: disabled config semantics + enabled contrast ------------------

  await test('Test 1a - disabled config constructs without active prerequisites', () => {
    const resolved = buildObserverConfig({
      enabled: false,
      runMarker: '',
      backendPids: new Set<number>(),
    });

    assert.equal(resolved.enabled, false);
    // Existing defaults are retained when disabled (DEFAULT_CAPACITY = 256;
    // observerConstants.maxCapacity is the *maximum*, not the default).
    assert.equal(resolved.intervalMs, observerConstants.defaultIntervalMs);
    assert.equal(resolved.maxSamples, 256);
    assert.equal(resolved.backendPids.size, 0);
  });

  await test('Test 1b - enabled config still rejects missing prerequisites', () => {
    assert.throws(
      () =>
        buildObserverConfig({
          enabled: true,
          runMarker: '',
          backendPids: new Set([111]),
        }),
      /runMarker is required/,
      'missing runMarker must fail when enabled',
    );

    assert.throws(
      () =>
        buildObserverConfig({
          enabled: true,
          runMarker: 'w3-observer-spec',
          backendPids: new Set<number>(),
        }),
      /At least one backend PID is required/,
      'empty PID scope must fail when enabled',
    );

    assert.throws(
      () =>
        buildObserverConfig({
          enabled: true,
          runMarker: 'w3-observer-spec',
          backendPids: new Set([0]),
        }),
      /backendPids must contain positive integers/,
      'non-positive PID must fail when enabled',
    );
  });

  // ---- Test 2: normal in-scope sampling --------------------------------------

  await test('Test 2 - in-scope PIDs are sampled and locks scoped to them', async () => {
    const client = new FakeClient();
    client.activity = [activityRow(111), activityRow(222)];
    client.locks = [lockRow(111), lockRow(222, { relation: 'public.other' })];

    const observer = makeObserver(client, [111, 222]);
    await observer.start();
    await observer.stop();

    const report = observer.report();
    assert.deepEqual(
      report.samples.map((s) => s.pid).sort((a, b) => a - b),
      [111, 222],
      'both in-scope PIDs become samples',
    );

    const lockQuery = client.lockQuery();
    assert.ok(lockQuery, 'pg_locks query issued');
    assert.deepEqual(lockQuery.values?.[0], [111, 222]);
    assert.equal(report.observerErrorCount, 0);
  });

  // ---- Test 3: out-of-scope PID post-filter (fail-closed) --------------------

  await test('Test 3 - out-of-scope PID is filtered before sampling and locks', async () => {
    const client = new FakeClient();
    // The catalog query anomalously returns a PID outside the configured scope.
    client.activity = [activityRow(111), activityRow(222), activityRow(999)];
    client.locks = [lockRow(111), lockRow(222), lockRow(999)];

    const observer = makeObserver(client, [111, 222]);
    await observer.start();
    await observer.stop();

    const report = observer.report();
    const sampledPids = report.samples.map((s) => s.pid);
    assert.deepEqual(
      sampledPids.slice().sort((a, b) => a - b),
      [111, 222],
      'samples contain only configured PIDs',
    );
    assert.ok(
      !sampledPids.includes(999),
      'out-of-scope PID 999 must never become a sample',
    );

    const lockQuery = client.lockQuery();
    assert.ok(lockQuery, 'pg_locks query issued');
    assert.deepEqual(
      lockQuery.values?.[0],
      [111, 222],
      'pg_locks receives only the post-filtered observed PIDs',
    );
    assert.ok(
      !(lockQuery.values?.[0] as number[]).includes(999),
      'out-of-scope PID 999 must not enter the lock observation scope',
    );
  });

  // eslint-disable-next-line no-console
  console.log('\nobserver focused spec: PASS');
}

void main().catch((error) => {
  console.error('\nobserver focused spec: FAIL');
  console.error(error);
  process.exit(1);
});
