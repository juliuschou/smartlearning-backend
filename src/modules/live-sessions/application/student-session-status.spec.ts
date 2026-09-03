import { Logger } from '@nestjs/common';
import { LiveSessionService } from './live-session.service';
import {
  EnrollmentRemovedError,
  EnrollmentRequiredError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors';
import { LiveSessionStatus } from '../domain';

describe('LiveSessionService.getStudentLiveSessionStatus', () => {
  const SESSION_ID = '0198c7a2-0000-7000-8000-000000000001';
  const ACCOUNT_ID = '0198c7a2-0000-7000-8000-000000000002';
  const COURSE_ID = '0198c7a2-0000-7000-8000-000000000003';

  function makeService(overrides?: {
    sessionRow?: Record<string, unknown> | null;
    accountRow?: Record<string, unknown> | null;
    enrollmentRow?: Record<string, unknown> | null;
  }): {
    service: LiveSessionService;
    transactions: { run: jest.Mock };
    tx: {
      liveSession: { findUnique: jest.Mock };
      account: { findUnique: jest.Mock };
      courseEnrollment: { findUnique: jest.Mock };
      participant: { findUnique: jest.Mock; create: jest.Mock };
    };
  } {
    const tx = {
      liveSession: { findUnique: jest.fn() },
      account: { findUnique: jest.fn() },
      courseEnrollment: { findUnique: jest.fn() },
      participant: { findUnique: jest.fn(), create: jest.fn() },
    };
    const transactions = {
      run: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(tx),
      ) as jest.Mock,
      lockLiveSessionForUpdate: jest.fn().mockResolvedValue(undefined),
      lockCourseForUpdate: jest.fn().mockResolvedValue(undefined),
      lockAccountForUpdate: jest.fn().mockResolvedValue(undefined),
    };
    const service = Object.create(LiveSessionService.prototype) as {
      transactions: unknown;
      logger: Logger;
      getStudentLiveSessionStatus: (
        sessionId: string,
        accountId: string,
      ) => Promise<unknown>;
    };
    service.transactions = transactions as unknown;
    service.logger = new Logger(LiveSessionService.name);

    tx.liveSession.findUnique.mockImplementation(() =>
      overrides?.sessionRow !== undefined
        ? overrides.sessionRow
        : {
            id: SESSION_ID,
            status: LiveSessionStatus.CLOSED,
            startedAt: new Date('2026-09-01T01:00:00Z'),
            closedAt: new Date('2026-09-01T02:00:00Z'),
            courseId: COURSE_ID,
          },
    );
    tx.account.findUnique.mockImplementation(() =>
      overrides?.accountRow !== undefined
        ? overrides.accountRow
        : { role: 'student', status: 'active' },
    );
    tx.courseEnrollment.findUnique.mockImplementation(() =>
      overrides?.enrollmentRow !== undefined
        ? overrides.enrollmentRow
        : { status: 'active' },
    );
    return {
      service: service as unknown as LiveSessionService,
      transactions,
      tx,
    };
  }

  it('returns the lifecycle receipt for every status without touching Participant', async () => {
    for (const status of [
      LiveSessionStatus.WAITING,
      LiveSessionStatus.ACTIVE,
      LiveSessionStatus.CLOSED,
      LiveSessionStatus.CANCELLED,
    ]) {
      const { service, tx } = makeService({
        sessionRow: {
          id: SESSION_ID,
          status,
          startedAt:
            status === LiveSessionStatus.WAITING ||
            status === LiveSessionStatus.CANCELLED
              ? null
              : new Date('2026-09-01T01:00:00Z'),
          closedAt: status === LiveSessionStatus.CLOSED ? new Date() : null,
          courseId: COURSE_ID,
        },
      });

      const receipt = (await service.getStudentLiveSessionStatus(
        SESSION_ID,
        ACCOUNT_ID,
      )) as {
        id: string;
        status: string;
        startedAt: Date | null;
        closedAt: Date | null;
      };

      expect(receipt.id).toBe(SESSION_ID);
      expect(receipt.status).toBe(status);
      expect(tx.participant.findUnique).not.toHaveBeenCalled();
      expect(tx.participant.create).not.toHaveBeenCalled();
    }
  });

  it('runs under READ COMMITTED', async () => {
    const { service, transactions } = makeService();

    await service.getStudentLiveSessionStatus(SESSION_ID, ACCOUNT_ID);

    expect(transactions.run).toHaveBeenCalledTimes(1);
    const options = transactions.run.mock.calls[0][1] as {
      isolationLevel?: unknown;
    };
    expect(options.isolationLevel).toBe('ReadCommitted');
  });

  it('rejects a malformed account id before any transaction', async () => {
    const { service, transactions } = makeService();

    await expect(
      service.getStudentLiveSessionStatus(SESSION_ID, 'not-a-uuid'),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(transactions.run).not.toHaveBeenCalled();
  });

  it('throws NotFoundError for an unknown session', async () => {
    const { service } = makeService({ sessionRow: null });

    await expect(
      service.getStudentLiveSessionStatus(SESSION_ID, ACCOUNT_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('maps missing enrollment to ENROLLMENT_REQUIRED', async () => {
    const { service } = makeService({ enrollmentRow: null });

    await expect(
      service.getStudentLiveSessionStatus(SESSION_ID, ACCOUNT_ID),
    ).rejects.toBeInstanceOf(EnrollmentRequiredError);
  });

  it('maps removed enrollment to ENROLLMENT_REMOVED', async () => {
    const { service } = makeService({ enrollmentRow: { status: 'removed' } });

    await expect(
      service.getStudentLiveSessionStatus(SESSION_ID, ACCOUNT_ID),
    ).rejects.toBeInstanceOf(EnrollmentRemovedError);
  });

  it('rejects disabled accounts and non-student roles with FORBIDDEN', async () => {
    for (const accountRow of [
      { role: 'student', status: 'disabled' },
      { role: 'teacher', status: 'active' },
      { role: 'admin', status: 'active' },
    ]) {
      const { service } = makeService({ accountRow });

      await expect(
        service.getStudentLiveSessionStatus(SESSION_ID, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});
