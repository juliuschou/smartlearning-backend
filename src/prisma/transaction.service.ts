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
  async run<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prismaService.prisma.$transaction(fn);
  }

  /**
   * Lock a session_question row FOR UPDATE within the current transaction.
   * Used by submit and close so DB commit order linearizes the race
   * (M2 §3). Throws if the row is missing/not open.
   */
  async lockSessionQuestionForUpdate(
    tx: Prisma.TransactionClient,
    sessionQuestionId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM session_question WHERE id = ${sessionQuestionId}::uuid FOR UPDATE`;
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
   * Map a Prisma error to a domain error. Application code should prefer this
   * over catching Prisma errors directly, but the global filter also maps
   * them as a safety net.
   */
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
