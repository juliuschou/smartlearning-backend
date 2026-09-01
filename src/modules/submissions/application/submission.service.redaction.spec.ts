import { Logger } from '@nestjs/common';
import { SubmissionService } from './submission.service';

describe('SubmissionService disclosure-safe publishing', () => {
  it('logs publish failures without thrown values', async () => {
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const sentinel = 'submission-publish-secret';
    const service = Object.create(SubmissionService.prototype) as {
      eventBus: { publish: jest.Mock };
      logger: Logger;
      publish: (signal: unknown) => void;
    };
    service.eventBus = {
      publish: jest.fn().mockRejectedValue(new Error(sentinel)),
    };
    service.logger = new Logger(SubmissionService.name);

    try {
      service.publish({
        type: 'submission.committed',
        liveSessionId: 'safe-session-id',
        sessionQuestionId: 'safe-question-id',
        participantId: 'safe-participant-id',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(JSON.stringify(loggerError.mock.calls)).not.toContain(sentinel);
      expect(loggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          signalType: 'submission.committed',
          liveSessionId: 'safe-session-id',
          errorType: 'Error',
        }),
        expect.any(String),
      );
    } finally {
      loggerError.mockRestore();
    }
  });
});
