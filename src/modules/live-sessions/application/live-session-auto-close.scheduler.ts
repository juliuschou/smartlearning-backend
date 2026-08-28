import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../../../config/env.validation';
import { LiveSessionService } from './live-session.service';

@Injectable()
export class LiveSessionAutoCloseScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(LiveSessionAutoCloseScheduler.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private destroyed = false;

  constructor(
    private readonly sessions: LiveSessionService,
    private readonly config: ConfigService<EnvConfig>,
  ) {}

  onModuleInit(): void {
    this.destroyed = false;
    void this.runOnce();
    const interval =
      this.config.get<number>('LIVE_SESSION_AUTO_CLOSE_TICK_MS', {
        infer: true,
      }) ?? 60_000;
    this.timer = setInterval(() => void this.runOnce(), interval);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) await new Promise((resolve) => setImmediate(resolve));
  }

  async runOnce(): Promise<void> {
    if (this.destroyed || this.running) return;
    this.running = true;
    try {
      await this.sessions.autoCloseExpiredSessions();
    } catch (error) {
      this.logger.error(
        `Auto-close sweep failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    } finally {
      this.running = false;
    }
  }
}
