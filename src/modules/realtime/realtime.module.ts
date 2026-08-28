import { Global, Module } from '@nestjs/common';
import { LiveSessionsModule } from '../live-sessions/live-sessions.module';
import { ParticipantsModule } from '../participants/participants.module';
import { LiveGateway } from './live-gateway';
import { LiveSessionEventBus } from './live-session-event-bus';
import { LiveSessionOutboxService } from './live-session-outbox.service';
import { LiveSessionPublisher } from './live-session-publisher';
import { RealtimeRedisService } from './realtime-redis.service';

/**
 * Durable realtime wiring.
 *
 * `LiveSessionEventBus` remains a global post-commit wake boundary so the domain
 * mutation services do not depend on the gateway. The bounded publisher owns
 * durable row claiming and invokes the gateway only after a transport is ready;
 * PostgreSQL remains authoritative for event order and projections.
 */
@Global()
@Module({
  imports: [LiveSessionsModule, ParticipantsModule],
  providers: [
    LiveSessionEventBus,
    LiveSessionOutboxService,
    LiveGateway,
    LiveSessionPublisher,
    RealtimeRedisService,
  ],
  exports: [
    LiveSessionEventBus,
    LiveSessionOutboxService,
    LiveSessionPublisher,
    RealtimeRedisService,
  ],
})
export class RealtimeModule {}
