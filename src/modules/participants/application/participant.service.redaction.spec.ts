import { Logger } from '@nestjs/common';
import { ParticipantService } from './participant.service';

describe('ParticipantService disclosure-safe publishing', () => {
  it('logs publish failures without thrown values', async () => {
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const sentinel = 'participant-publish-secret';
    const service = Object.create(ParticipantService.prototype) as {
      eventBus: { publish: jest.Mock };
      logger: Logger;
      publish: (signal: unknown) => void;
    };
    service.eventBus = { publish: jest.fn().mockRejectedValue(sentinel) };
    service.logger = new Logger(ParticipantService.name);

    try {
      service.publish({
        type: 'participant.joined',
        liveSessionId: 'safe-session-id',
        participantId: 'safe-participant-id',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(JSON.stringify(loggerError.mock.calls)).not.toContain(sentinel);
      expect(loggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          signalType: 'participant.joined',
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
