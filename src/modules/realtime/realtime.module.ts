import { Global, Module } from '@nestjs/common';
import { LiveSessionsModule } from '../live-sessions/live-sessions.module';
import { ParticipantsModule } from '../participants/participants.module';
import { LiveGateway } from './live-gateway';
import { LiveSessionEventBus } from './live-session-event-bus';

/**
 * Realtime (R-1 lite) wiring.
 *
 * `LiveSessionEventBus` is exported as a `@Global` provider so the domain
 * mutation services (`LiveSessionService`, `ParticipantService`,
 * `SubmissionService`) inject the bus without importing this module — the bus
 * is a leaf with no service deps, so there is no cycle. The gateway imports
 * the feature modules to reach the read services; services depend only on the
 * bus, never on the gateway, so the dependency direction is one-way.
 */
@Global()
@Module({
  imports: [LiveSessionsModule, ParticipantsModule],
  providers: [LiveSessionEventBus, LiveGateway],
  exports: [LiveSessionEventBus],
})
export class RealtimeModule {}
