import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
} from '@nestjs/common';
import { RealtimeTraceService } from './realtime-trace.service';
import type {
  RealtimeTraceFilter,
  RealtimeTraceSnapshot,
} from './realtime-trace.types';

const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Flag-gated W3 realtime delivery diagnostic endpoint.
 *
 * Registered only when `REALTIME_TRACE_ENABLED=1` (see `RealtimeModule`); the
 * handler additionally refuses outside a non-production runtime. Records are
 * in-memory only, read-only, and scoped to one `runId` — a caller can never read
 * another run's trace.
 *
 * This endpoint exists so a W3 diagnostic run can prove which room/socket the
 * gateway actually emitted to. A 404 (disabled / production / not registered)
 * or an empty record list must never be read as "the server did not emit"; the
 * completeness fields (`droppedCount`, `dispatchedEventCount`) are returned with
 * the records for exactly that reason.
 *
 * Note: the global exception filter normalizes these statuses to the stable
 * envelope (`NOT_FOUND` / `VALIDATION_FAILED`), so callers key off the HTTP
 * status, not a custom error code.
 */
@Controller({ path: 'diagnostics', version: '1' })
export class RealtimeTraceController {
  constructor(private readonly trace: RealtimeTraceService) {}

  @Get('realtime-trace')
  get(
    @Query('runId') runId?: string,
    @Query('eventId') eventId?: string,
    @Query('eventSeq') eventSeq?: string,
    @Query('eventType') eventType?: string,
    @Query('liveSessionId') liveSessionId?: string,
  ): RealtimeTraceSnapshot {
    // Deliberately a 404 (not an empty 200) so a caller cannot mistake a
    // disabled trace for evidence that no emit occurred.
    if (process.env.NODE_ENV === 'production' || !this.trace.enabled) {
      throw new NotFoundException(
        'Realtime trace diagnostics are not enabled.',
      );
    }
    const trimmed = runId?.trim();
    if (!trimmed || !RUN_ID_PATTERN.test(trimmed)) {
      throw new BadRequestException(
        'A valid runId query parameter is required.',
      );
    }
    const filter: RealtimeTraceFilter = {
      ...(eventId ? { eventId } : {}),
      ...(eventSeq ? { eventSeq } : {}),
      ...(eventType ? { eventType } : {}),
      ...(liveSessionId ? { liveSessionId } : {}),
    };
    return this.trace.snapshot(trimmed, filter);
  }
}
