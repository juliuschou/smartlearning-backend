import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../../../config/env.validation';
import { LiveSessionService } from './live-session.service';
import { MetricsService } from '../../metrics/metrics.service';

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
    @Optional() private readonly metrics?: MetricsService,
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
    const startedAt = process.hrtime.bigint();
    let outcome: 'success' | 'failure' = 'failure';
    try {
      const closed = await this.sessions.autoCloseExpiredSessions();
      outcome = 'success';
      this.recordItems('closed', closed);
    } catch (error) {
      this.logger.error(
        `Auto-close sweep failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    } finally {
      const durationSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      try {
        this.metrics?.recordJobRun(
          'live_session_auto_close',
          outcome,
          durationSeconds,
        );
      } catch {
        // Metrics must not change scheduler shutdown or error semantics.
      }
      this.running = false;
    }
  }

  private recordItems(result: 'closed', count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    try {
      this.metrics?.recordJobItem('live_session_auto_close', result, count);
    } catch {
      // Metrics must not change a successful auto-close sweep.
    }
  }
}
