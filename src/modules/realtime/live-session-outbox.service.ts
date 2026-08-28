import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { isUuid, newId, normalizeUuid } from '../../common/crypto';
import { LiveSessionStatus } from '../live-sessions/domain';
import { TransactionService } from '../../prisma/transaction.service';
import {
  REALTIME_SCHEMA_VERSION,
  parseSafeRealtimeOutboxInput,
  isRealtimeEventName,
  RealtimeEvent,
  isRealtimeVisibility,
  RealtimeVisibility,
  type RealtimeEventName,
} from './live-session-realtime-contract';

const DEFAULT_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface AppendRealtimeEventInput {
  liveSessionId: string;
  event: RealtimeEventName;
  visibility: RealtimeVisibility;
  sessionQuestionId?: string;
  /** Routing-only identity; never placed in projectionInput or event payloads. */
  targetParticipantId?: string;
  aggregateVersion?: number;
  projectionInput?: unknown;
  serverTimestamp?: Date;
  expiresAt?: Date;
}

/**
 * Appends one durable realtime row inside the caller's transaction. Callers
 * must lock the LiveSession first and, for question events, the relevant
 * SessionQuestion rows second. Sequence allocation and the event insert then
 * commit or roll back with the domain mutation.
 */
@Injectable()
export class LiveSessionOutboxService {
  constructor(private readonly transactions: TransactionService) {}

  async append(
    tx: Prisma.TransactionClient,
    input: AppendRealtimeEventInput,
  ): Promise<Prisma.LiveSessionEventGetPayload<object>> {
    if (!isRealtimeEventName(input.event)) {
      throw new TypeError(`Unknown durable realtime event: ${input.event}`);
    }
    if (!isRealtimeVisibility(input.visibility)) {
      throw new TypeError(
        `Unknown durable realtime visibility: ${input.visibility}`,
      );
    }

    const liveSessionId = normalizeUuid(input.liveSessionId);
    const safeInput = parseSafeRealtimeOutboxInput({
      ...(input.projectionInput ?? {}),
      ...(input.sessionQuestionId !== undefined
        ? { sessionQuestionId: input.sessionQuestionId }
        : {}),
      ...(input.aggregateVersion !== undefined
        ? { aggregateVersion: input.aggregateVersion }
        : {}),
      visibility: input.visibility,
    });
    this.assertEventInput(input.event, safeInput);
    const targetParticipantId =
      input.targetParticipantId === undefined
        ? undefined
        : isUuid(input.targetParticipantId)
          ? normalizeUuid(input.targetParticipantId)
          : (() => {
              throw new TypeError(
                'Realtime target participant id must be a UUID.',
              );
            })();
    if (
      safeInput.visibility === RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT &&
      !targetParticipantId
    ) {
      throw new TypeError(
        'Participant-after-submit events require a target participant.',
      );
    }
    if (
      safeInput.visibility !== RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT &&
      targetParticipantId
    ) {
      throw new TypeError(
        'Target participant routing is only valid for after-submit events.',
      );
    }
    const sessionQuestionId = safeInput.sessionQuestionId;
    if (sessionQuestionId) {
      const question = await tx.sessionQuestion.findUnique({
        where: { id: sessionQuestionId },
        select: { liveSessionId: true, aggregateVersion: true },
      });
      if (!question || question.liveSessionId !== liveSessionId) {
        throw new TypeError(
          'Realtime event question does not belong to its live session.',
        );
      }
      if (
        safeInput.aggregateVersion !== undefined &&
        input.event === RealtimeEvent.RESULT_UPDATED &&
        safeInput.aggregateVersion !== question.aggregateVersion
      ) {
        throw new TypeError(
          'Realtime result event aggregate version is not current.',
        );
      }
    }
    if (targetParticipantId) {
      const participant = await tx.participant.findUnique({
        where: { id: targetParticipantId },
        select: { liveSessionId: true },
      });
      if (!participant || participant.liveSessionId !== liveSessionId) {
        throw new TypeError(
          'Realtime target participant does not belong to its live session.',
        );
      }
    }
    const eventSeq = await this.transactions.allocateRealtimeEventSeq(
      tx,
      liveSessionId,
    );
    const serverTimestamp = input.serverTimestamp ?? new Date();
    const expiresAt =
      input.expiresAt ??
      new Date(serverTimestamp.getTime() + DEFAULT_EVENT_RETENTION_MS);
    const projectionInput =
      Object.keys(safeInput).length > 0
        ? (safeInput as Prisma.InputJsonValue)
        : undefined;

    return tx.liveSessionEvent.create({
      data: {
        id: newId(),
        liveSessionId,
        sessionQuestionId: safeInput.sessionQuestionId,
        targetParticipantId,
        eventName: input.event,
        schemaVersion: REALTIME_SCHEMA_VERSION,
        eventSeq,
        aggregateVersion: safeInput.aggregateVersion ?? 0,
        serverTimestamp,
        visibility: input.visibility,
        projectionInput,
        deliveryState: 'pending',
        attemptCount: 0,
        nextAttemptAt: serverTimestamp,
        expiresAt,
      },
    });
  }

  private assertEventInput(
    event: RealtimeEventName,
    input: ReturnType<typeof parseSafeRealtimeOutboxInput>,
  ): void {
    const sessionStatuses = [
      LiveSessionStatus.WAITING,
      LiveSessionStatus.ACTIVE,
      LiveSessionStatus.CLOSED,
      LiveSessionStatus.CANCELLED,
    ];
    if (
      event === RealtimeEvent.SESSION_STATE_CHANGED &&
      (!input.status ||
        !sessionStatuses.includes(input.status as LiveSessionStatus))
    ) {
      throw new TypeError(
        'Session state event requires a valid LiveSession status.',
      );
    }
    if (
      event === RealtimeEvent.SESSION_CLOSED &&
      input.status !== LiveSessionStatus.CLOSED
    ) {
      throw new TypeError('Session closed event requires closed status.');
    }
    if (
      (event === RealtimeEvent.QUESTION_OPENED ||
        event === RealtimeEvent.QUESTION_CLOSED ||
        event === RealtimeEvent.RESULT_UPDATED) &&
      !input.sessionQuestionId
    ) {
      throw new TypeError(`${event} requires a session question id.`);
    }
    if (
      event === RealtimeEvent.RESULT_UPDATED &&
      input.aggregateVersion === undefined
    ) {
      throw new TypeError(
        'Result updated event requires an aggregate version.',
      );
    }
  }
}
