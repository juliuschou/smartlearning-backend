import { LiveSessionAutoCloseScheduler } from './live-session-auto-close.scheduler';

describe('LiveSessionAutoCloseScheduler', () => {
  function makeScheduler(result: number | Error = 2) {
    const sessions = {
      autoCloseExpiredSessions:
        result instanceof Error
          ? jest.fn().mockRejectedValue(result)
          : jest.fn().mockResolvedValue(result),
    };
    const metrics = {
      recordJobItem: jest.fn(),
      recordJobRun: jest.fn(),
    };
    const config = {
      get: jest.fn().mockReturnValue(60_000),
    };
    const scheduler = new LiveSessionAutoCloseScheduler(
      sessions as never,
      config as never,
      metrics as never,
    );
    return { scheduler, sessions, metrics };
  }

  it('records a successful run and closed item count', async () => {
    const { scheduler, sessions, metrics } = makeScheduler(3);

    await scheduler.runOnce();

    expect(sessions.autoCloseExpiredSessions).toHaveBeenCalledTimes(1);
    expect(metrics.recordJobItem).toHaveBeenCalledWith(
      'live_session_auto_close',
      'closed',
      3,
    );
    expect(metrics.recordJobRun).toHaveBeenCalledWith(
      'live_session_auto_close',
      'success',
      expect.any(Number),
    );
  });

  it('records a failed run while preserving the scheduler swallow behavior', async () => {
    const error = new Error('sweep failure');
    const { scheduler, sessions, metrics } = makeScheduler(error);

    await expect(scheduler.runOnce()).resolves.toBeUndefined();

    expect(sessions.autoCloseExpiredSessions).toHaveBeenCalledTimes(1);
    expect(metrics.recordJobRun).toHaveBeenCalledWith(
      'live_session_auto_close',
      'failure',
      expect.any(Number),
    );
  });

  it('does not record destroyed or overlapping early returns', async () => {
    const destroyed = makeScheduler(1);
    await destroyed.scheduler.onModuleDestroy();
    await destroyed.scheduler.runOnce();
    expect(destroyed.sessions.autoCloseExpiredSessions).not.toHaveBeenCalled();
    expect(destroyed.metrics.recordJobRun).not.toHaveBeenCalled();

    const overlapping = makeScheduler(1);
    (overlapping.scheduler as unknown as { running: boolean }).running = true;
    await overlapping.scheduler.runOnce();
    expect(
      overlapping.sessions.autoCloseExpiredSessions,
    ).not.toHaveBeenCalled();
    expect(overlapping.metrics.recordJobRun).not.toHaveBeenCalled();
  });
});
