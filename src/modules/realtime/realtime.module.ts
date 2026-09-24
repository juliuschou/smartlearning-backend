import { Global, Module } from '@nestjs/common';
import { LiveSessionsModule } from '../live-sessions/live-sessions.module';
import { ParticipantsModule } from '../participants/participants.module';
import { LiveGateway } from './live-gateway';
import { LiveSessionEventBus } from './live-session-event-bus';
import { LiveSessionOutboxService } from './live-session-outbox.service';
import { LiveSessionPublisher } from './live-session-publisher';
import { RealtimeRedisService } from './realtime-redis.service';
import { RealtimeTraceController } from './diagnostics/realtime-trace.controller';
import { RealtimeTraceService } from './diagnostics/realtime-trace.service';

/**
 * Durable realtime wiring.
 *
 * `LiveSessionEventBus` remains a global post-commit wake boundary so the domain
 * mutation services do not depend on the gateway. The bounded publisher owns
 * durable row claiming and invokes the gateway only after a transport is ready;
 * PostgreSQL remains authoritative for event order and projections.
 *
 * `RealtimeTraceService` is a diagnostic-only sink, OFF by default. The trace
 * controller is registered only when `REALTIME_TRACE_ENABLED=1` so a disabled
 * deployment exposes no diagnostics route at all.
 */
const traceEnabled =
  process.env.REALTIME_TRACE_ENABLED === '1' &&
  process.env.NODE_ENV !== 'production';

@Global()
@Module({
  imports: [LiveSessionsModule, ParticipantsModule],
  controllers: traceEnabled ? [RealtimeTraceController] : [],
  providers: [
    LiveSessionEventBus,
    LiveSessionOutboxService,
    LiveGateway,
    LiveSessionPublisher,
    RealtimeRedisService,
    RealtimeTraceService,
  ],
  exports: [
    LiveSessionEventBus,
    LiveSessionOutboxService,
    LiveSessionPublisher,
    RealtimeRedisService,
    RealtimeTraceService,
  ],
})
export class RealtimeModule {}
