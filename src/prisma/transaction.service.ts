import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { ConflictError, NotFoundError } from '../common/errors';
import { PrismaService } from './prisma.service';

/**
 * Centralized transaction + raw-SQL lock helpers.
 *
 * Why this exists (per M2 關鍵技術決策 §3, §7): submit/close races and question
 * append ordering are protected by row locks and advisory locks, not by
 * "read-then-write" application checks. Keeping these helpers in one place
 * guarantees every write path uses the same lock order and that Prisma
 * constraint errors map to stable domain errors consistently.
 *
 * Phase 1 ships the skeleton + error mapping; Phase 3/6 consume the locks.
 */
@Injectable()
export class TransactionService {
  constructor(private readonly prismaService: PrismaService) {}

  get client(): PrismaService['prisma'] {
    return this.prismaService.prisma;
  }

  /** Run a unit of work inside a Prisma interactive transaction. */
  async run<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    },
  ): Promise<T> {
    return this.prismaService.prisma.$transaction(fn, options);
  }

  /**
   * Lock an existing session_question row FOR UPDATE within the current
   * transaction. Submit and close enforce session/status transitions after the
   * lock so DB commit order linearizes their race (M2 §3).
   */
  async lockSessionQuestionForUpdate(
    tx: Prisma.TransactionClient,
    sessionQuestionId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM session_question
      WHERE id = ${sessionQuestionId}::uuid
      FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new NotFoundError('SessionQuestion not found', 'sessionQuestionId');
    }
  }

  /**
   * Take a transaction-scoped advisory lock keyed on the course id, so
   * concurrent question appends/reorders serialize per course (M2 §7).
   */
  async lockCourseForAppend(
    tx: Prisma.TransactionClient,
    courseId: string,
  ): Promise<void> {
    // pg_advisory_xact_lock takes bigint; hash the course key to a stable int.
    // The function returns PostgreSQL `void`, so executeRaw avoids Prisma's
    // result deserialization path for SELECT queries.
    const key = `qdef:${courseId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  /**
   * Generic transaction-scoped advisory lock keyed by an arbitrary string.
   * Used to serialize idempotency-key processing for batch confirm so that
   * two concurrent confirms with the same key cannot both write.
   */
  async lockAdvisoryKey(
    tx: Prisma.TransactionClient,
    key: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  /** Lock a Course row so archive/session/question writes re-check one state. */
  async lockCourseForUpdate(
    tx: Prisma.TransactionClient,
    courseId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM course WHERE id = ${courseId}::uuid FOR UPDATE`;
  }

  /** Lock a LiveSession row while joining or changing its lifecycle. */
  async lockLiveSessionForUpdate(
    tx: Prisma.TransactionClient,
    sessionId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM live_session WHERE id = ${sessionId}::uuid FOR UPDATE`;
  }

  /**
   * Map a Prisma error to a domain error. Application code should prefer this
   * over catching Prisma errors directly, but the global filter also maps
   * them as a safety net.
   */
  /** Lock an account row so password/status transitions serialize. */
  async lockAccountForUpdate(
    tx: Prisma.TransactionClient,
    accountId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM account WHERE id = ${accountId}::uuid FOR UPDATE`;
  }

  mapError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002')
        throw new ConflictError('Resource already exists');
      if (error.code === 'P2025') throw new NotFoundError('Resource not found');
    }
    // Re-throw non-Prisma or unmapped errors unchanged.
    throw error;
  }
}
