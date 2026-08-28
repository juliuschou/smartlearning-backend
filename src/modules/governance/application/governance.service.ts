import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client';
import { newId, normalizeUuid } from '../../../common/crypto';
import { ConflictError, NotFoundError } from '../../../common/errors';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';
import { normalizePageRequest, toPage } from '../../../common/pagination';
import { projectArchive } from '../domain/archive-projection';
import type {
  ArchivePageDto,
  ArchiveSummaryDto,
} from '../api/dto/governance.dto';

const DAY = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;

@Injectable()
export class GovernanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TransactionService,
  ) {}
  private get db() {
    return this.prisma.prisma;
  }
  private summary(a: {
    id: string;
    liveSessionId: string;
    courseId: string;
    closedAt: Date;
    purgeAt: Date;
    status: string;
  }): ArchiveSummaryDto {
    return {
      id: a.id,
      liveSessionId: a.liveSessionId,
      courseId: a.courseId,
      closedAt: a.closedAt.toISOString(),
      purgeAt: a.purgeAt.toISOString(),
      status: a.status,
    };
  }
  async archiveSession(id: string): Promise<ArchiveSummaryDto | null> {
    const sid = normalizeUuid(id);
    return this.tx.run(async (t) => {
      const s = await t.liveSession.findUnique({
        where: { id: sid },
        include: {
          course: true,
          questions: {
            orderBy: { position: 'asc' },
            include: { options: { orderBy: { position: 'asc' } } },
          },
          submissions: true,
        },
      });
      if (!s || s.status !== 'closed' || !s.closedAt) return null;
      const existing = await t.archivedResult.findUnique({
        where: { liveSessionId: sid },
      });
      if (existing) return this.summary(existing);
      const submissionsByQuestion = new Map<string, typeof s.submissions>();
      for (const submission of s.submissions) {
        const rows =
          submissionsByQuestion.get(submission.sessionQuestionId) ?? [];
        rows.push(submission);
        submissionsByQuestion.set(submission.sessionQuestionId, rows);
      }
      const payload = projectArchive(
        s.questions.map((q) => ({
          id: q.id,
          position: q.position,
          snapshotType: q.snapshotType,
          snapshotPrompt: q.snapshotPrompt,
          snapshotSelectionMode: q.snapshotSelectionMode,
          options: q.options.map((o) => ({
            id: o.id,
            optionRef: o.optionRef,
            text: o.text,
            isCorrect: o.isCorrect,
            position: o.position,
          })),
          submissions: (submissionsByQuestion.get(q.id) ?? []).map((x) => ({
            selectedOptionRefs: Array.isArray(x.selectedOptionRefs)
              ? x.selectedOptionRefs.filter(
                  (ref): ref is string => typeof ref === 'string',
                )
              : null,
            textAnswer: x.textAnswer,
          })),
        })),
      );
      const a = await t.archivedResult.create({
        data: {
          id: newId(),
          liveSessionId: sid,
          courseId: s.courseId,
          closedAt: s.closedAt,
          purgeAt: new Date(s.closedAt.getTime() + RETENTION_DAYS * DAY),
          payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
        },
      });
      return this.summary(a);
    });
  }
  async list(
    account: { id: string; role: string },
    rawPage: { page?: number; pageSize?: number } = {},
  ): Promise<ArchivePageDto> {
    const page = normalizePageRequest(rawPage);
    const where =
      account.role === 'admin'
        ? {}
        : { course: { ownerAccountId: account.id } };
    const [rows, total] = await Promise.all([
      this.db.archivedResult.findMany({
        where,
        orderBy: { closedAt: 'desc' },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      this.db.archivedResult.count({ where }),
    ]);
    return toPage(
      rows.map((r) => this.summary(r)),
      total,
      page,
    );
  }
  async detail(
    id: string,
    account: { id: string; role: string },
  ): Promise<
    | ArchiveSummaryDto
    | {
        id: string;
        liveSessionId: string;
        courseId: string;
        closedAt: string;
        purgeAt: string;
        status: string;
        payload: Prisma.JsonValue | null;
      }
  > {
    const a = await this.db.archivedResult.findUnique({
      where: { liveSessionId: normalizeUuid(id) },
      include: { course: true },
    });
    if (
      !a ||
      (account.role !== 'admin' && a.course.ownerAccountId !== account.id)
    )
      throw new NotFoundError('Archive not found');
    return a.status === 'deleted'
      ? this.summary(a)
      : { ...this.summary(a), payload: a.payload };
  }
  async request(id: string, accountId: string, role: string, reason?: string) {
    const sid = normalizeUuid(id);
    return this.tx.run(async (t) => {
      // Serialize request creation with purge so exactly one outstanding request
      // can exist for a session/requester pair, even when clients retry together.
      await this.tx.lockLiveSessionForUpdate(t, sid);
      const a = await t.archivedResult.findUnique({
        where: { liveSessionId: sid },
        include: { course: true },
      });
      if (!a || (role !== 'admin' && a.course.ownerAccountId !== accountId))
        throw new NotFoundError('Archive not found');
      const existing = await t.deletionEvent.findFirst({
        where: {
          liveSessionId: sid,
          requesterId: accountId,
          trigger: 'teacher_request',
          status: 'requested',
        },
        orderBy: { createdAt: 'asc' },
      });
      if (existing) return existing;
      return t.deletionEvent.create({
        data: {
          id: newId(),
          archivedResultId: a.id,
          liveSessionId: sid,
          courseId: a.courseId,
          requesterId: accountId,
          trigger: 'teacher_request',
          reason,
          status: 'requested',
        },
      });
    });
  }
  async delete(
    id: string,
    executorId: string,
    reason: string,
    confirmed: boolean,
  ) {
    if (!confirmed)
      throw new ConflictError('Explicit confirmation required', 'confirmed');
    return this.purgeOne(id, 'early_delete', executorId, reason);
  }

  /** Deletes one due archive, or performs an explicit early deletion. */
  async purgeOne(
    id: string,
    trigger: 'retention' | 'early_delete',
    executorId?: string,
    reason?: string,
    now = new Date(),
  ) {
    const sid = normalizeUuid(id);
    return this.tx.run(async (t) => {
      await this.tx.lockLiveSessionForUpdate(t, sid);
      const archive = await t.archivedResult.findUnique({
        where: { liveSessionId: sid },
      });
      if (!archive) throw new NotFoundError('Archive not found');
      if (archive.status === 'deleted') return { status: 'success' as const };
      if (trigger === 'early_delete') {
        const request = await t.deletionEvent.findFirst({
          where: {
            liveSessionId: sid,
            trigger: 'teacher_request',
            status: 'requested',
          },
        });
        if (!request)
          throw new ConflictError(
            'A deletion request is required.',
            'deletionRequest',
          );
      }
      if (trigger === 'retention' && archive.purgeAt > now)
        throw new ConflictError(
          'Archive retention period has not elapsed.',
          'purgeAt',
        );

      // Remove answer-bearing rows first, preserving the closed LiveSession shell
      // and a minimal, non-content tombstone for governance/audit purposes.
      await t.submission.deleteMany({ where: { liveSessionId: sid } });
      await t.sessionQuestionOption.deleteMany({
        where: { sessionQuestion: { liveSessionId: sid } },
      });
      await t.sessionQuestion.deleteMany({ where: { liveSessionId: sid } });
      await t.participant.deleteMany({ where: { liveSessionId: sid } });
      await t.archivedResult.update({
        where: { id: archive.id },
        data: { status: 'deleted', payload: Prisma.DbNull },
      });
      await t.deletionEvent.create({
        data: {
          id: newId(),
          archivedResultId: archive.id,
          liveSessionId: sid,
          courseId: archive.courseId,
          executorId,
          trigger,
          reason,
          status: 'success',
          completedAt: now,
          deletedCategories: [
            'archive_payload',
            'submissions',
            'participants',
            'session_questions',
          ],
        },
      });
      return { status: 'success' as const };
    });
  }

  async purgeDue(limit = 50, now = new Date()) {
    const archives = await this.db.archivedResult.findMany({
      where: { status: 'active', purgeAt: { lte: now } },
      orderBy: { purgeAt: 'asc' },
      take: Math.max(1, Math.min(100, Math.floor(limit))),
      select: { liveSessionId: true },
    });
    let deleted = 0;
    for (const archive of archives) {
      await this.purgeOne(
        archive.liveSessionId,
        'retention',
        undefined,
        'retention',
        now,
      );
      deleted += 1;
    }
    return { selected: archives.length, deleted };
  }
}
