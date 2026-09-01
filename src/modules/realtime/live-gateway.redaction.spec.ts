import { Logger } from '@nestjs/common';
import { LiveGateway } from './live-gateway';

describe('LiveGateway disclosure-safe logging', () => {
  it('does not log rejected handshake error details', async () => {
    const loggerWarn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const sentinel = 'handshake-secret-error';
    const gateway = Object.create(LiveGateway.prototype) as {
      redis: { acceptsTraffic: boolean };
      authenticate: jest.Mock;
      logger: Logger;
      handleConnection: (socket: unknown) => Promise<void>;
    };
    gateway.redis = { acceptsTraffic: true };
    gateway.authenticate = jest.fn().mockRejectedValue(new Error(sentinel));
    gateway.logger = new Logger(LiveGateway.name);
    const socket = {
      id: 'safe-socket-id',
      emit: jest.fn(),
      disconnect: jest.fn(),
    };

    try {
      await gateway.handleConnection(socket as never);
      expect(socket.emit).toHaveBeenCalledWith('error', {
        code: 'UNAUTHORIZED',
      });
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain(sentinel);
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          sid: 'safe-socket-id',
          code: 'UNAUTHORIZED',
          errorType: 'Error',
        }),
        'Socket connection rejected',
      );
    } finally {
      loggerWarn.mockRestore();
    }
  });
});
