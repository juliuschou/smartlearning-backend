import { Logger } from '@nestjs/common';
import { AccountLifecycleBus } from './account-lifecycle.bus';

describe('AccountLifecycleBus', () => {
  it('isolates listener failures and logs only safe metadata', async () => {
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const errorSentinel = 'account-lifecycle-error-secret';
    const stringSentinel = 'account-lifecycle-string-secret';
    const bus = new AccountLifecycleBus();
    const seen: string[] = [];

    try {
      bus.subscribe(() => {
        throw new Error(errorSentinel);
      });
      bus.subscribe(() => {
        throw stringSentinel;
      });
      bus.subscribe((signal) => {
        seen.push(signal.accountId);
      });

      await bus.publish({
        type: 'account.disabled',
        accountId: 'safe-account-id',
        timestamp: '2026-09-01T00:00:00.000Z',
      });

      const calls = JSON.stringify(loggerError.mock.calls);
      expect(seen).toEqual(['safe-account-id']);
      expect(calls).not.toContain(errorSentinel);
      expect(calls).not.toContain(stringSentinel);
      expect(loggerError).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          signalType: 'account.disabled',
          accountId: 'safe-account-id',
          errorType: 'Error',
        }),
        expect.any(String),
      );
      expect(loggerError).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ errorType: 'string' }),
        expect.any(String),
      );
    } finally {
      loggerError.mockRestore();
    }
  });
});
