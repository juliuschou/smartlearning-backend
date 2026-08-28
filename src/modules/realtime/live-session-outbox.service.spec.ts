import type { Prisma } from '../../../generated/prisma/client';
import type { TransactionService } from '../../prisma/transaction.service';
import { LiveSessionStatus } from '../live-sessions/domain';
import {
  RealtimeEvent,
  RealtimeVisibility,
} from './live-session-realtime-contract';
import { LiveSessionOutboxService } from './live-session-outbox.service';

const LIVE_SESSION_ID = '0190c6b8-0000-7000-8000-000000000001';
const QUESTION_ID = '0190c6b8-0000-7000-8000-000000000002';
const PARTICIPANT_ID = '0190c6b8-0000-7000-8000-000000000003';

type FakeTransaction = {
  sessionQuestion: { findUnique: jest.Mock };
  participant: { findUnique: jest.Mock };
  liveSessionEvent: { create: jest.Mock };
};

type FakeTransactions = {
  allocateRealtimeEventSeq: jest.Mock;
};

function makeService(): {
  service: LiveSessionOutboxService;
  tx: Prisma.TransactionClient;
  fakeTx: FakeTransaction;
  transactions: FakeTransactions;
} {
  const fakeTx: FakeTransaction = {
    sessionQuestion: { findUnique: jest.fn() },
    participant: { findUnique: jest.fn() },
    liveSessionEvent: { create: jest.fn() },
  };
  const transactions: FakeTransactions = {
    allocateRealtimeEventSeq: jest.fn().mockResolvedValue(1n),
  };
  return {
    service: new LiveSessionOutboxService(
      transactions as unknown as TransactionService,
    ),
    tx: fakeTx as unknown as Prisma.TransactionClient,
    fakeTx,
    transactions,
  };
}

describe('LiveSessionOutboxService', () => {
  it('appends a safe lifecycle row with an allocated sequence', async () => {
    const { service, tx, fakeTx, transactions } = makeService();
    fakeTx.liveSessionEvent.create.mockImplementation(
      (args: { data: Record<string, unknown> }) => args.data,
    );

    const event = await service.append(tx, {
      liveSessionId: LIVE_SESSION_ID,
      event: RealtimeEvent.SESSION_STATE_CHANGED,
      visibility: RealtimeVisibility.SESSION,
      projectionInput: { status: LiveSessionStatus.ACTIVE },
    });

    expect(transactions.allocateRealtimeEventSeq).toHaveBeenCalledWith(
      tx,
      LIVE_SESSION_ID,
    );
    expect(event).toMatchObject({
      liveSessionId: LIVE_SESSION_ID,
      eventName: RealtimeEvent.SESSION_STATE_CHANGED,
      eventSeq: 1n,
      aggregateVersion: 0,
      projectionInput: {
        status: LiveSessionStatus.ACTIVE,
        visibility: RealtimeVisibility.SESSION,
      },
    });
  });

  it('requires and validates target routing for after-submit results', async () => {
    const { service, tx, fakeTx } = makeService();
    fakeTx.sessionQuestion.findUnique.mockResolvedValue({
      liveSessionId: LIVE_SESSION_ID,
      aggregateVersion: 1,
    });
    fakeTx.participant.findUnique.mockResolvedValue({
      liveSessionId: LIVE_SESSION_ID,
    });
    fakeTx.liveSessionEvent.create.mockImplementation(
      (args: { data: Record<string, unknown> }) => args.data,
    );

    const event = await service.append(tx, {
      liveSessionId: LIVE_SESSION_ID,
      sessionQuestionId: QUESTION_ID,
      targetParticipantId: PARTICIPANT_ID,
      event: RealtimeEvent.RESULT_UPDATED,
      visibility: RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT,
      aggregateVersion: 1,
      projectionInput: { status: 'open' },
    });

    expect(event.targetParticipantId).toBe(PARTICIPANT_ID);
    expect(event.projectionInput).not.toHaveProperty('targetParticipantId');
  });

  it('rejects unsafe projection input and missing event-specific fields', async () => {
    const { service, tx } = makeService();

    await expect(
      service.append(tx, {
        liveSessionId: LIVE_SESSION_ID,
        event: RealtimeEvent.SESSION_STATE_CHANGED,
        visibility: RealtimeVisibility.SESSION,
        projectionInput: { participantId: PARTICIPANT_ID },
      }),
    ).rejects.toThrow('not safe');

    await expect(
      service.append(tx, {
        liveSessionId: LIVE_SESSION_ID,
        event: RealtimeEvent.RESULT_UPDATED,
        visibility: RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT,
        aggregateVersion: 1,
      }),
    ).rejects.toThrow('session question id');
  });
});
