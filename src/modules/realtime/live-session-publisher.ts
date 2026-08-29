import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { newId } from '../../common/crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  LiveSessionEventBus,
  type LiveSessionSignal,
} from './live-session-event-bus';
import { LiveGateway } from './live-gateway';
import {
  RealtimeDeliveryState,
  RealtimeEvent,
  RealtimeSyncReason,
  RealtimeVisibility,
} from './live-session-realtime-contract';

const BATCH_SIZE = 50;
const POLL_INTERVAL_MS = 1_000;
const LEASE_MS = 10_000;
const MAX_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 30_000;
const RECOVERY_NOTIFIED = 'recovery_notified';

type RawLiveSessionEvent = {
  id: string;
  live_session_id: string;
  session_question_id: string | null;
  target_participant_id: string | null;
  event_name: string;
  schema_version: number;
  event_seq: bigint;
  aggregate_version: number;
  server_timestamp: Date;
  created_at: Date;
  visibility: string;
  projection_input: Prisma.JsonValue | null;
  delivery_state: string;
  attempt_count: number;
  next_attempt_at: Date;
  claimed_at: Date | null;
  claim_token: string | null;
  lease_expires_at: Date | null;
  last_failure_class: string | null;
  coalesced: boolean;
  delivered_at: Date | null;
  expires_at: Date | null;
};

/**
 * Bounded PostgreSQL outbox publisher. The event bus is only a post-commit wake
 * hint; startup scanning and the poll timer recover rows after process failure.
 */
@Injectable()
export class LiveSessionPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveSessionPublisher.name);
  private readonly claimToken = newId();
  private unsubscribe?: () => void;
  private timer?: NodeJS.Timeout;
  private active = false;
  private stopped = false;
  private processing = false;
  private wakeQueued = false;
  private drainPromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private outstandingLeaseCount = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: LiveSessionEventBus,
    private readonly gateway: LiveGateway,
  ) {}

  onModuleInit(): void {
    if (this.active) return;

    this.active = true;
    this.stopped = false;
    this.unsubscribe = this.bus.subscribe((signal) => {
      this.queueWake(signal);
    });
    this.timer = setInterval(() => this.queueWake(), POLL_INTERVAL_MS);
    this.queueWake();
  }

  onModuleDestroy(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this.active) return Promise.resolve();

    this.shutdownPromise = this.shutdown().finally(() => {
      this.shutdownPromise = undefined;
    });
    return this.shutdownPromise;
  }

  private async shutdown(): Promise<void> {
    this.active = false;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.wakeQueued = false;

    const activeDrain = this.drainPromise;
    await activeDrain;
    try {
      if (this.outstandingLeaseCount > 0) {
        await this.releaseLeases();
      }
    } finally {
      this.outstandingLeaseCount = 0;
    }
  }

  private queueWake(_signal?: LiveSessionSignal): void {
    if (this.stopped) return;
    this.wakeQueued = true;
    if (!this.processing) {
      this.drainPromise = this.drain();
    }
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (!this.stopped && this.wakeQueued) {
        this.wakeQueued = false;
        let claimed = await this.processBatch();
        while (!this.stopped && claimed === BATCH_SIZE) {
          claimed = await this.processBatch();
        }
      }
    } catch (error) {
      this.logger.error(
        {
          err: error instanceof Error ? error.name : String(error),
        },
        'Durable realtime publisher cycle failed',
      );
    } finally {
      this.processing = false;
      this.drainPromise = undefined;
    }
  }

  /** Process one bounded claim/dispatch/ack cycle. */
  async processBatch(now = new Date()): Promise<number> {
    if (!this.gateway.isTransportReady()) return 0;
    await this.expireRows(now);
    await this.coalescePendingResults(now);
    await this.recoverDeadRows();
    await this.cleanupExpiredDeliveredRows(now);
    const claimed = await this.claimDueRows(now);
    this.outstandingLeaseCount += claimed.length;
    for (const row of claimed) {
      try {
        await this.gateway.dispatchDurableEvent(this.toEvent(row));
        if (await this.markDelivered(row.id, new Date())) {
          this.outstandingLeaseCount -= 1;
        }
      } catch (error) {
        if (await this.markFailure(row, error, new Date())) {
          this.outstandingLeaseCount -= 1;
        }
      }
    }
    return claimed.length;
  }

  private async claimDueRows(now: Date): Promise<RawLiveSessionEvent[]> {
    return this.prisma.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<RawLiveSessionEvent[]>`
        WITH eligible AS (
          SELECT event.id
          FROM live_session_event AS event
          WHERE (
            (
              event.delivery_state IN (${RealtimeDeliveryState.PENDING}, ${RealtimeDeliveryState.RETRY})
              AND event.next_attempt_at <= ${now}
            )
            OR (
              event.delivery_state = ${RealtimeDeliveryState.PROCESSING}
              AND event.lease_expires_at IS NOT NULL
              AND event.lease_expires_at <= ${now}
            )
          )
          AND (event.expires_at IS NULL OR event.expires_at > ${now})
          AND NOT EXISTS (
            SELECT 1
            FROM live_session_event AS previous
            WHERE previous.live_session_id = event.live_session_id
              AND previous.event_seq < event.event_seq
              AND (
                previous.delivery_state IN (
                  ${RealtimeDeliveryState.PENDING},
                  ${RealtimeDeliveryState.RETRY},
                  ${RealtimeDeliveryState.PROCESSING}
                )
                OR (
                  previous.delivery_state = ${RealtimeDeliveryState.DEAD}
                  AND COALESCE(previous.last_failure_class, '') <> ${RECOVERY_NOTIFIED}
                )
              )
          )
          ORDER BY event.live_session_id, event.event_seq
          FOR UPDATE SKIP LOCKED
          LIMIT ${BATCH_SIZE}
        )
        UPDATE live_session_event AS event
        SET delivery_state = ${RealtimeDeliveryState.PROCESSING},
            attempt_count = event.attempt_count + 1,
            claimed_at = ${now},
            claim_token = ${this.claimToken}::uuid,
            lease_expires_at = ${new Date(now.getTime() + LEASE_MS)}
        FROM eligible
        WHERE event.id = eligible.id
        RETURNING event.*
      `;
      return rows;
    });
  }

  private async markDelivered(id: string, now: Date): Promise<boolean> {
    const updated = await this.prisma.prisma.liveSessionEvent.updateMany({
      where: {
        id,
        deliveryState: RealtimeDeliveryState.PROCESSING,
        claimToken: this.claimToken,
      },
      data: {
        deliveryState: RealtimeDeliveryState.DELIVERED,
        deliveredAt: now,
        claimedAt: null,
        claimToken: null,
        leaseExpiresAt: null,
        lastFailureClass: null,
      },
    });
    return updated.count === 1;
  }

  private async markFailure(
    row: RawLiveSessionEvent,
    error: unknown,
    now: Date,
  ): Promise<boolean> {
    const failureClass = this.classifyFailure(error);
    const shouldDeadLetter =
      failureClass === 'permanent' || row.attempt_count >= MAX_ATTEMPTS;
    const deliveryState = shouldDeadLetter
      ? RealtimeDeliveryState.DEAD
      : RealtimeDeliveryState.RETRY;
    const backoff = Math.min(
      MAX_BACKOFF_MS,
      INITIAL_BACKOFF_MS * 2 ** Math.max(0, row.attempt_count - 1),
    );
    const updated = await this.prisma.prisma.liveSessionEvent.updateMany({
      where: {
        id: row.id,
        deliveryState: RealtimeDeliveryState.PROCESSING,
        claimToken: this.claimToken,
      },
      data: {
        deliveryState,
        nextAttemptAt: new Date(
          now.getTime() + (shouldDeadLetter ? 0 : backoff),
        ),
        claimedAt: null,
        claimToken: null,
        leaseExpiresAt: null,
        lastFailureClass: shouldDeadLetter ? failureClass : 'transient',
      },
    });
    if (updated.count === 1 && shouldDeadLetter) {
      await this.notifyDeadRecovery(row.live_session_id);
    }
    this.logger.warn(
      {
        eventName: row.event_name,
        liveSessionId: row.live_session_id,
        attempt: row.attempt_count,
        state: deliveryState,
        failureClass,
        error: error instanceof Error ? error.name : 'unknown',
      },
      'Durable realtime event dispatch failed',
    );
    return updated.count === 1;
  }

  private classifyFailure(error: unknown): 'permanent' | 'transient' {
    return error instanceof TypeError || error instanceof RangeError
      ? 'permanent'
      : 'transient';
  }

  private async notifyDeadRecovery(liveSessionId: string): Promise<void> {
    await this.notifyRecovery(liveSessionId, RealtimeSyncReason.DEAD);
  }

  private async notifyRecovery(
    liveSessionId: string,
    reason: RealtimeSyncReason,
  ): Promise<void> {
    let notified = false;
    try {
      notified = await this.gateway.notifySyncRequiredForSession(
        liveSessionId,
        reason,
      );
    } catch (error) {
      this.logger.warn(
        {
          liveSessionId,
          reason,
          err: error instanceof Error ? error.name : 'unknown',
        },
        'Could not notify realtime recovery',
      );
    }
    if (notified) await this.markRecoveryNotified(liveSessionId);
  }

  private async recoverDeadRows(): Promise<void> {
    // Recovery is maintenance work; cap each pass so a large dead-letter
    // backlog cannot starve the normal claim/dispatch cycle.
    const rows = await this.prisma.prisma.liveSessionEvent.findMany({
      where: {
        deliveryState: RealtimeDeliveryState.DEAD,
        OR: [
          { lastFailureClass: null },
          { lastFailureClass: { not: RECOVERY_NOTIFIED } },
        ],
      },
      orderBy: [{ liveSessionId: 'asc' }, { id: 'asc' }],
      take: BATCH_SIZE,
      select: { liveSessionId: true },
    });
    for (const liveSessionId of [
      ...new Set(rows.map((row) => row.liveSessionId)),
    ]) {
      await this.notifyDeadRecovery(liveSessionId);
    }
  }

  private async markRecoveryNotified(liveSessionId: string): Promise<void> {
    await this.prisma.prisma.liveSessionEvent.updateMany({
      where: {
        liveSessionId,
        deliveryState: RealtimeDeliveryState.DEAD,
        OR: [
          { lastFailureClass: null },
          { lastFailureClass: { not: RECOVERY_NOTIFIED } },
        ],
      },
      data: { lastFailureClass: RECOVERY_NOTIFIED },
    });
  }

  private async expireRows(now: Date): Promise<void> {
    // Select and transition only one bounded maintenance batch. The ID
    // predicate prevents a broad update from rewriting rows discovered after
    // this pass began.
    const expired = await this.prisma.prisma.liveSessionEvent.findMany({
      where: {
        expiresAt: { lte: now },
        OR: [
          {
            deliveryState: {
              in: [RealtimeDeliveryState.PENDING, RealtimeDeliveryState.RETRY],
            },
          },
          {
            deliveryState: RealtimeDeliveryState.PROCESSING,
            leaseExpiresAt: { lte: now },
          },
        ],
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: BATCH_SIZE,
      select: { id: true, liveSessionId: true },
    });
    if (expired.length === 0) return;
    await this.prisma.prisma.liveSessionEvent.updateMany({
      where: {
        id: { in: expired.map((row) => row.id) },
        expiresAt: { lte: now },
        OR: [
          {
            deliveryState: {
              in: [RealtimeDeliveryState.PENDING, RealtimeDeliveryState.RETRY],
            },
          },
          {
            deliveryState: RealtimeDeliveryState.PROCESSING,
            leaseExpiresAt: { lte: now },
          },
        ],
      },
      data: {
        deliveryState: RealtimeDeliveryState.DEAD,
        claimedAt: null,
        claimToken: null,
        leaseExpiresAt: null,
        lastFailureClass: 'expired',
      },
    });
    for (const sessionId of [
      ...new Set(expired.map((row) => row.liveSessionId)),
    ]) {
      await this.notifyRecovery(sessionId, RealtimeSyncReason.EXPIRED);
    }
  }

  /**
   * Remove only already-delivered expired evidence in bounded batches. Dead
   * rows remain until recovery is notified so replay can detect the loss.
   */
  private async cleanupExpiredDeliveredRows(now: Date): Promise<void> {
    const rows = await this.prisma.prisma.liveSessionEvent.findMany({
      where: {
        expiresAt: { lte: now },
        OR: [
          { deliveryState: RealtimeDeliveryState.DELIVERED },
          {
            deliveryState: RealtimeDeliveryState.DEAD,
            lastFailureClass: RECOVERY_NOTIFIED,
          },
        ],
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: BATCH_SIZE,
      select: { id: true },
    });
    if (rows.length === 0) return;
    await this.prisma.prisma.liveSessionEvent.deleteMany({
      where: {
        id: { in: rows.map((row) => row.id) },
        expiresAt: { lte: now },
        OR: [
          { deliveryState: RealtimeDeliveryState.DELIVERED },
          {
            deliveryState: RealtimeDeliveryState.DEAD,
            lastFailureClass: RECOVERY_NOTIFIED,
          },
        ],
      },
    });
  }

  private async coalescePendingResults(now: Date): Promise<void> {
    await this.prisma.prisma.$executeRaw`
      WITH stale AS (
        SELECT older.id
        FROM live_session_event AS older
        WHERE older.event_name = ${RealtimeEvent.RESULT_UPDATED}
          AND older.delivery_state IN (
            ${RealtimeDeliveryState.PENDING},
            ${RealtimeDeliveryState.RETRY}
          )
          AND older.coalesced = FALSE
          AND older.session_question_id IS NOT NULL
          AND older.visibility IN (
            ${RealtimeVisibility.TEACHER},
            ${RealtimeVisibility.PARTICIPANT}
          )
          AND EXISTS (
            SELECT 1
            FROM live_session_event AS newer
            WHERE newer.live_session_id = older.live_session_id
              AND newer.session_question_id = older.session_question_id
              AND newer.visibility = older.visibility
              AND newer.event_name = ${RealtimeEvent.RESULT_UPDATED}
              AND newer.visibility IN (
                ${RealtimeVisibility.TEACHER},
                ${RealtimeVisibility.PARTICIPANT}
              )
              AND newer.delivery_state IN (
                ${RealtimeDeliveryState.PENDING},
                ${RealtimeDeliveryState.RETRY}
              )
              AND newer.coalesced = FALSE
              AND newer.event_seq > older.event_seq
              AND newer.aggregate_version >= older.aggregate_version
          )
        ORDER BY older.live_session_id, older.event_seq
        LIMIT ${BATCH_SIZE}
      )
      UPDATE live_session_event AS event
      SET delivery_state = ${RealtimeDeliveryState.DELIVERED},
          coalesced = TRUE,
          delivered_at = ${now},
          claimed_at = NULL,
          claim_token = NULL,
          lease_expires_at = NULL,
          last_failure_class = 'coalesced'
      FROM stale
      WHERE event.id = stale.id
    `;
  }

  private async releaseLeases(): Promise<void> {
    await this.prisma.prisma.liveSessionEvent.updateMany({
      where: {
        deliveryState: RealtimeDeliveryState.PROCESSING,
        claimToken: this.claimToken,
      },
      data: {
        deliveryState: RealtimeDeliveryState.RETRY,
        nextAttemptAt: new Date(),
        claimedAt: null,
        claimToken: null,
        leaseExpiresAt: null,
        lastFailureClass: 'lease_expired',
      },
    });
  }

  private toEvent(
    row: RawLiveSessionEvent,
  ): Prisma.LiveSessionEventGetPayload<object> {
    return {
      id: row.id,
      liveSessionId: row.live_session_id,
      sessionQuestionId: row.session_question_id,
      targetParticipantId: row.target_participant_id,
      eventName: row.event_name,
      schemaVersion: row.schema_version,
      eventSeq: row.event_seq,
      aggregateVersion: row.aggregate_version,
      serverTimestamp: row.server_timestamp,
      createdAt: row.created_at,
      visibility: row.visibility,
      projectionInput: row.projection_input,
      deliveryState: row.delivery_state,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      claimedAt: row.claimed_at,
      claimToken: row.claim_token,
      leaseExpiresAt: row.lease_expires_at,
      lastFailureClass: row.last_failure_class,
      coalesced: row.coalesced,
      deliveredAt: row.delivered_at,
      expiresAt: row.expires_at,
    };
  }
}
