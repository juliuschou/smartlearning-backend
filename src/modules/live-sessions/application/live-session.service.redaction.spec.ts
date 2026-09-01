import { Logger } from '@nestjs/common';
import { LiveSessionService } from './live-session.service';

describe('LiveSessionService disclosure-safe publishing', () => {
  it('logs post-commit publish failures without thrown values', async () => {
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const sentinel = 'live-session-publish-secret';
    const service = Object.create(LiveSessionService.prototype) as {
      eventBus: { publish: jest.Mock };
      logger: Logger;
      publish: (signal: unknown) => void;
    };
    service.eventBus = { publish: jest.fn().mockRejectedValue(sentinel) };
    service.logger = new Logger(LiveSessionService.name);

    try {
      service.publish({
        type: 'session.state_changed',
        liveSessionId: 'safe-session-id',
        status: 'closed',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(JSON.stringify(loggerError.mock.calls)).not.toContain(sentinel);
      expect(loggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          signalType: 'session.state_changed',
          liveSessionId: 'safe-session-id',
          errorType: 'string',
        }),
        expect.any(String),
      );
    } finally {
      loggerError.mockRestore();
    }
  });
});
