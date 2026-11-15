import integrationTarget from '../../tools/test-db/assert-integration-ready.cjs';

const { assertRunRecord } = integrationTarget as {
  assertRunRecord: (runId: string, record: unknown) => void;
};

describe('test database integration run guard', () => {
  const runId = '20261114123000-a1b2c3d4';
  const exactRun = {
    runId,
    project: `sltest-${runId}`,
    database: 'smartlearning_test',
    schema: 'app',
    port: 5432,
    state: 'running-clean',
  };

  it('accepts only the exact recorded clean disposable test run', () => {
    expect(() => assertRunRecord(runId, exactRun)).not.toThrow();
  });

  it.each([
    ['', exactRun],
    [runId, { ...exactRun, project: 'smartlearning-dev-db' }],
    [runId, { ...exactRun, database: 'smartlearning_dev' }],
    [runId, { ...exactRun, schema: 'public' }],
    [runId, { ...exactRun, port: 5433 }],
    [runId, { ...exactRun, state: 'stopped' }],
    [runId, null],
  ])('refuses an invalid run identity or state', (candidateId, record) => {
    expect(() => assertRunRecord(candidateId, record)).toThrow();
  });
});
