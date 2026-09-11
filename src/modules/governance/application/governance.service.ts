import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client';
import { hashToken, newId, normalizeUuid } from '../../../common/crypto';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../common/errors';
import { normalizePageRequest, toPage } from '../../../common/pagination';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';
import { MetricsService } from '../../metrics/metrics.service';
import { RealtimeVisibility } from '../../realtime/live-session-realtime-contract';
import type {
  AdminDeletionRequestSummaryDto,
  ArchiveDeletionDto,
  ArchiveDetailDto,
  ArchiveListQueryDto,
  ArchivePageDto,
  ArchiveSummaryDto,
  DeletionReason,
  DeletionRequestListQueryDto,
  DeletionRequestPageDto,
  DeletionRequestReceiptDto,
  DeletionRequestSummaryDto,
  DeletionResultDto,
} from '../api/dto/governance.dto';
import {
  parseArchivedResult,
  projectArchive,
} from '../domain/archive-projection';
import type { DeletionManifest } from '../domain/deletion-manifest';

const DAY = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;
const DELETED_CATEGORIES = [
  'archive_payload',
  'submissions',
  'participants',
  'session_questions',
  'realtime_target_routing',
];

type ArchiveRow = {
  id: string;
  liveSessionId: string;
  courseId: string;
  sessionLabel: string;
  startedAt: Date;
  closedAt: Date;
  purgeAt: Date;
  status: string;
  payload: Prisma.JsonValue | null;
  course: { id: string; name: string; ownerAccountId?: string };
  deletionEvents: Array<{
    id: string;
    trigger: string;
    reason: string | null;
    status: string;
    createdAt: Date;
    completedAt: Date | null;
    resolvedByEventId?: string | null;
  }>;
};

@Injectable()
export class GovernanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TransactionService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  private get db() {
    return this.prisma.prisma;
  }

  private requestSummary(
    event: ArchiveRow['deletionEvents'][number],
  ): DeletionRequestSummaryDto {
    if (!event.reason || !['privacy', 'support'].includes(event.reason)) {
      throw new Error('Invalid deletion request state');
    }
    return {
      id: event.id,
      reason: event.reason as DeletionReason,
      status: 'requested',
      requestedAt: event.createdAt.toISOString(),
    };
  }

  private deletionSummary(
    event: ArchiveRow['deletionEvents'][number],
  ): ArchiveDeletionDto {
    if (
      !event.completedAt ||
      !['early_delete', 'retention'].includes(event.trigger) ||
      !event.reason ||
      !['privacy', 'support', 'retention'].includes(event.reason)
    ) {
      throw new Error('Invalid canonical deletion state');
    }
    return {
      trigger: event.trigger as 'early_delete' | 'retention',
      reason: event.reason as DeletionReason | 'retention',
      deletedAt: event.completedAt.toISOString(),
    };
  }

  private summary(a: ArchiveRow): ArchiveSummaryDto {
    const request = a.deletionEvents.find(
      (event) =>
        event.trigger === 'teacher_request' && event.status === 'requested',
    );
    const deletion = a.deletionEvents.find(
      (event) =>
        ['early_delete', 'retention'].includes(event.trigger) &&
        event.status === 'success',
    );
    return {
      id: a.id,
      liveSessionId: a.liveSessionId,
      course: { id: a.course.id, name: a.course.name },
      sessionLabel: a.sessionLabel,
      startedAt: a.startedAt.toISOString(),
      closedAt: a.closedAt.toISOString(),
      status: a.status as 'active' | 'deleted',
      purgeAt: a.purgeAt.toISOString(),
      deletionRequest: request ? this.requestSummary(request) : null,
      deletion: deletion ? this.deletionSummary(deletion) : null,
    };
  }

  private deletionResult(
    archive: Pick<ArchiveRow, 'id' | 'liveSessionId'>,
    event: ArchiveRow['deletionEvents'][number],
    deletionRequestId: string | null,
  ): DeletionResultDto {
    return {
      archiveId: archive.id,
      liveSessionId: archive.liveSessionId,
      deletionRequestId,
      status: 'deleted',
      deletion: this.deletionSummary(event),
    };
  }

  private archiveInclude() {
    return {
      course: { select: { id: true, name: true, ownerAccountId: true } },
      deletionEvents: {
        where: {
          OR: [
            { trigger: 'teacher_request', status: 'requested' },
            {
              trigger: { in: ['early_delete', 'retention'] },
              status: 'success',
            },
          ],
        },
        orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      },
    };
  }

  async archiveSession(id: string): Promise<ArchiveSummaryDto | null> {
    const sid = normalizeUuid(id);
    return this.tx.run(async (t) => {
      await this.tx.lockLiveSessionForUpdate(t, sid);
      return this.archiveSessionInTransaction(t, sid);
    });
  }

  async archiveSessionInTransaction(
    t: Prisma.TransactionClient,
    id: string,
  ): Promise<ArchiveSummaryDto | null> {
    const sid = normalizeUuid(id);
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
      include: this.archiveInclude(),
    });
    if (existing) {
      await this.anonymizeParticipantsInTransaction(t, sid);
      return this.summary(existing as ArchiveRow);
    }
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
    const startedAt = s.startedAt ?? s.closedAt;
    const archive = await t.archivedResult.create({
      data: {
        id: newId(),
        liveSessionId: sid,
        courseId: s.courseId,
        sessionLabel: startedAt.toISOString(),
        startedAt,
        closedAt: s.closedAt,
        purgeAt: new Date(s.closedAt.getTime() + RETENTION_DAYS * DAY),
        payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
      },
      include: this.archiveInclude(),
    });
    await this.anonymizeParticipantsInTransaction(t, sid);
    return this.summary(archive as ArchiveRow);
  }

  private async anonymizeParticipantsInTransaction(
    t: Prisma.TransactionClient,
    liveSessionId: string,
  ): Promise<void> {
    const participants = await t.participant.findMany({
      where: { liveSessionId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const participant of participants) {
      await t.participant.update({
        where: { id: participant.id },
        data: {
          accountId: null,
          displayName: 'Anonymous',
          tokenHash: hashToken(newId()),
        },
      });
    }
  }

  async list(
    account: { id: string; role: string },
    rawPage: ArchiveListQueryDto = {},
  ): Promise<ArchivePageDto> {
    const page = normalizePageRequest(rawPage);
    const where: Prisma.ArchivedResultWhereInput = {
      ...(account.role === 'admin'
        ? {}
        : { course: { ownerAccountId: account.id } }),
      ...(rawPage.courseId
        ? { courseId: normalizeUuid(rawPage.courseId) }
        : {}),
      ...(rawPage.liveSessionId
        ? { liveSessionId: normalizeUuid(rawPage.liveSessionId) }
        : {}),
      ...(rawPage.status ? { status: rawPage.status } : {}),
      ...(rawPage.closedFrom || rawPage.closedTo
        ? {
            closedAt: {
              ...(rawPage.closedFrom
                ? { gte: new Date(rawPage.closedFrom) }
                : {}),
              ...(rawPage.closedTo ? { lte: new Date(rawPage.closedTo) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.archivedResult.findMany({
        where,
        include: this.archiveInclude(),
        orderBy: [{ closedAt: 'desc' }, { id: 'desc' }],
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      this.db.archivedResult.count({ where }),
    ]);
    return toPage(
      rows.map((row) => this.summary(row as ArchiveRow)),
      total,
      page,
    );
  }

  async detail(
    id: string,
    account: { id: string; role: string },
  ): Promise<ArchiveDetailDto> {
    const archive = await this.db.archivedResult.findUnique({
      where: { liveSessionId: normalizeUuid(id) },
      include: this.archiveInclude(),
    });
    if (
      !archive ||
      (account.role !== 'admin' && archive.course.ownerAccountId !== account.id)
    ) {
      throw new NotFoundError('Archive not found');
    }
    const summary = this.summary(archive as ArchiveRow);
    if (archive.status === 'deleted') {
      if (!summary.deletion) throw new Error('Deleted archive lacks tombstone');
      return { ...summary, status: 'deleted', deletion: summary.deletion };
    }
    return {
      ...summary,
      status: 'active',
      payload: parseArchivedResult(archive.payload),
    };
  }

  async request(
    id: string,
    accountId: string,
    role: string,
    reason: DeletionReason,
  ): Promise<DeletionRequestReceiptDto> {
    if (role !== 'teacher') throw new ForbiddenError('Teacher role required');
    const sid = normalizeUuid(id);
    return this.tx.run(async (t) => {
      await this.tx.lockLiveSessionForUpdate(t, sid);
      const archive = await t.archivedResult.findUnique({
        where: { liveSessionId: sid },
        include: { course: true },
      });
      if (!archive || archive.course.ownerAccountId !== accountId) {
        throw new NotFoundError('Archive not found');
      }
      if (archive.status === 'deleted') {
        throw new ConflictError('Archive is already deleted.', 'status');
      }
      const existing = await t.deletionEvent.findFirst({
        where: {
          liveSessionId: sid,
          trigger: 'teacher_request',
          status: 'requested',
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const event =
        existing ??
        (await t.deletionEvent.create({
          data: {
            id: newId(),
            archivedResultId: archive.id,
            liveSessionId: sid,
            courseId: archive.courseId,
            requesterId: accountId,
            trigger: 'teacher_request',
            reason,
            status: 'requested',
          },
        }));
      return {
        ...this.requestSummary(event),
        liveSessionId: event.liveSessionId,
      };
    });
  }

  async listDeletionRequests(
    rawPage: DeletionRequestListQueryDto = {},
  ): Promise<DeletionRequestPageDto> {
    const page = normalizePageRequest(rawPage);
    const where: Prisma.DeletionEventWhereInput = {
      trigger: 'teacher_request',
      status: 'requested',
    };
    const [rows, total] = await Promise.all([
      this.db.deletionEvent.findMany({
        where,
        include: {
          archivedResult: {
            include: { course: { select: { id: true, name: true } } },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      this.db.deletionEvent.count({ where }),
    ]);
    const data = rows.map((row): AdminDeletionRequestSummaryDto => {
      if (!row.archivedResult)
        throw new Error('Deletion request lacks archive');
      return {
        ...this.requestSummary(row),
        liveSessionId: row.liveSessionId,
        course: {
          id: row.archivedResult.course.id,
          name: row.archivedResult.course.name,
        },
        sessionLabel: row.archivedResult.sessionLabel,
        startedAt: row.archivedResult.startedAt.toISOString(),
        closedAt: row.archivedResult.closedAt.toISOString(),
        purgeAt: row.archivedResult.purgeAt.toISOString(),
      };
    });
    return toPage(data, total, page);
  }

  async delete(
    id: string,
    executorId: string,
    deletionRequestId: string,
    reason: DeletionReason,
  ): Promise<DeletionResultDto> {
    return this.purgeOne(
      id,
      'early_delete',
      executorId,
      reason,
      new Date(),
      normalizeUuid(deletionRequestId),
    );
  }

  async purgeOne(
    id: string,
    trigger: 'retention' | 'early_delete',
    executorId?: string,
    reason: DeletionReason | 'retention' = trigger === 'retention'
      ? 'retention'
      : 'support',
    now = new Date(),
    deletionRequestId?: string,
  ): Promise<DeletionResultDto> {
    const sid = normalizeUuid(id);
    return this.tx.run(async (t) => {
      await this.tx.lockLiveSessionForUpdate(t, sid);
      return this.purgeOneInTransaction(
        t,
        sid,
        trigger,
        executorId,
        reason,
        now,
        deletionRequestId,
      );
    });
  }

  /** Apply an authoritative deletion manifest inside the caller's transaction. */
  async applyDeletionManifestInTransaction(
    t: Prisma.TransactionClient,
    manifest: DeletionManifest,
  ): Promise<DeletionResultDto> {
    const sid = normalizeUuid(manifest.liveSessionId);
    const archiveId = normalizeUuid(manifest.archivedResultId);
    const eventId = normalizeUuid(manifest.deletionEventId);
    const allowed = new Set(DELETED_CATEGORIES);
    if (manifest.trigger !== 'retention' && manifest.trigger !== 'early_delete')
      throw new ConflictError(
        'Unsupported deletion manifest trigger.',
        'trigger',
      );
    if (
      (manifest.trigger === 'retention' && manifest.reason !== 'retention') ||
      (manifest.trigger === 'early_delete' &&
        manifest.reason !== 'privacy' &&
        manifest.reason !== 'support')
    )
      throw new ConflictError(
        'Deletion manifest reason conflicts with trigger.',
        'reason',
      );
    if (
      manifest.categories.length !== allowed.size ||
      manifest.categories.some((category) => !allowed.has(category)) ||
      new Set(manifest.categories).size !== manifest.categories.length
    )
      throw new ConflictError(
        'Unsupported deletion manifest categories.',
        'categories',
      );
    const deletedAt = new Date(manifest.deletedAt);
    if (Number.isNaN(deletedAt.getTime()))
      throw new ConflictError(
        'Invalid deletion manifest timestamp.',
        'deletedAt',
      );

    const archive = await t.archivedResult.findUnique({
      where: { id: archiveId },
    });
    if (!archive || archive.liveSessionId !== sid)
      throw new ConflictError(
        'Deletion manifest archive identity conflict.',
        'archivedResultId',
      );
    const existing = await t.deletionEvent.findUnique({
      where: { id: eventId },
    });
    if (existing) {
      if (
        existing.liveSessionId !== sid ||
        existing.archivedResultId !== archiveId ||
        existing.completedAt?.toISOString() !== deletedAt.toISOString() ||
        existing.trigger !== manifest.trigger ||
        existing.reason !== manifest.reason ||
        JSON.stringify(
          Array.isArray(existing.deletedCategories)
            ? [...existing.deletedCategories].sort()
            : existing.deletedCategories,
        ) !== JSON.stringify([...manifest.categories].sort()) ||
        existing.status !== 'success'
      )
        throw new ConflictError(
          'Deletion manifest event identity conflict.',
          'deletionEventId',
        );
      await t.submission.deleteMany({ where: { liveSessionId: sid } });
      await t.liveSessionEvent.deleteMany({
        where: {
          liveSessionId: sid,
          visibility: RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT,
        },
      });
      await t.sessionQuestionOption.deleteMany({
        where: { sessionQuestion: { liveSessionId: sid } },
      });
      await t.sessionQuestion.deleteMany({ where: { liveSessionId: sid } });
      await t.participant.deleteMany({ where: { liveSessionId: sid } });
      await t.archivedResult.update({
        where: { id: archiveId },
        data: { status: 'deleted', payload: Prisma.DbNull },
      });
      return this.deletionResult(archive, existing, null);
    }
    const canonical = await t.deletionEvent.findFirst({
      where: {
        archivedResultId: archiveId,
        liveSessionId: sid,
        trigger: { in: ['early_delete', 'retention'] },
        status: 'success',
      },
    });
    if (canonical || archive.status === 'deleted')
      throw new ConflictError(
        'Deletion manifest conflicts with existing tombstone.',
        'status',
      );

    await t.submission.deleteMany({ where: { liveSessionId: sid } });
    await t.liveSessionEvent.deleteMany({
      where: {
        liveSessionId: sid,
        visibility: RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT,
      },
    });
    await t.sessionQuestionOption.deleteMany({
      where: { sessionQuestion: { liveSessionId: sid } },
    });
    await t.sessionQuestion.deleteMany({ where: { liveSessionId: sid } });
    await t.participant.deleteMany({ where: { liveSessionId: sid } });
    await t.archivedResult.update({
      where: { id: archiveId },
      data: { status: 'deleted', payload: Prisma.DbNull },
    });
    const event = await t.deletionEvent.create({
      data: {
        id: eventId,
        archivedResultId: archiveId,
        liveSessionId: sid,
        courseId: archive.courseId,
        trigger: manifest.trigger,
        reason: manifest.reason,
        status: 'success',
        completedAt: deletedAt,
        deletedCategories: [...manifest.categories].sort(),
      },
    });
    return this.deletionResult(archive, event, null);
  }

  private async purgeOneInTransaction(
    t: Prisma.TransactionClient,
    sid: string,
    trigger: 'retention' | 'early_delete',
    executorId: string | undefined,
    reason: DeletionReason | 'retention',
    now: Date,
    deletionRequestId?: string,
  ): Promise<DeletionResultDto> {
    const archive = await t.archivedResult.findUnique({
      where: { liveSessionId: sid },
    });
    if (!archive) throw new NotFoundError('Archive not found');

    const request = deletionRequestId
      ? await t.deletionEvent.findFirst({
          where: {
            id: deletionRequestId,
            liveSessionId: sid,
            trigger: 'teacher_request',
          },
          include: { resolvedByEvent: true },
        })
      : await t.deletionEvent.findFirst({
          where: {
            liveSessionId: sid,
            trigger: 'teacher_request',
            status: 'requested',
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          include: { resolvedByEvent: true },
        });

    if (trigger === 'early_delete' && !request) {
      throw new NotFoundError('Deletion request not found');
    }
    if (trigger === 'early_delete' && request?.reason !== reason) {
      throw new ConflictError(
        'Deletion confirmation reason must match the request.',
        'reason',
      );
    }
    if (request?.resolvedByEvent) {
      return this.deletionResult(archive, request.resolvedByEvent, request.id);
    }
    const canonical = await t.deletionEvent.findFirst({
      where: {
        liveSessionId: sid,
        trigger: { in: ['early_delete', 'retention'] },
        status: 'success',
      },
      orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
    });
    if (archive.status === 'deleted') {
      if (!canonical) throw new Error('Deleted archive lacks canonical event');
      if (trigger === 'early_delete') {
        throw new ConflictError(
          'Archive was deleted by another transition.',
          'deletionRequestId',
        );
      }
      return this.deletionResult(archive, canonical, null);
    }
    if (trigger === 'retention' && archive.purgeAt > now) {
      throw new ConflictError(
        'Archive retention period has not elapsed.',
        'purgeAt',
      );
    }

    await t.submission.deleteMany({ where: { liveSessionId: sid } });
    await t.liveSessionEvent.deleteMany({
      where: {
        liveSessionId: sid,
        visibility: RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT,
      },
    });
    await t.sessionQuestionOption.deleteMany({
      where: { sessionQuestion: { liveSessionId: sid } },
    });
    await t.sessionQuestion.deleteMany({ where: { liveSessionId: sid } });
    await t.participant.deleteMany({ where: { liveSessionId: sid } });
    await t.archivedResult.update({
      where: { id: archive.id },
      data: { status: 'deleted', payload: Prisma.DbNull },
    });
    const event = await t.deletionEvent.create({
      data: {
        id: newId(),
        archivedResultId: archive.id,
        liveSessionId: sid,
        courseId: archive.courseId,
        executorId: trigger === 'early_delete' ? executorId : undefined,
        trigger,
        reason: trigger === 'retention' ? 'retention' : reason,
        status: 'success',
        completedAt: now,
        deletedCategories: DELETED_CATEGORIES,
      },
    });
    await t.deletionManifestOutbox.create({
      data: {
        id: newId(),
        archivedResultId: archive.id,
        deletionEventId: event.id,
        contractVersion: 'deletion-manifest.v1',
        manifest: {
          contractVersion: 'deletion-manifest.v1',
          deletionEventId: event.id,
          archivedResultId: archive.id,
          liveSessionId: sid,
          trigger,
          reason: trigger === 'retention' ? 'retention' : reason,
          deletedAt: now.toISOString(),
          categories: [...DELETED_CATEGORIES].sort(),
        },
      },
    });
    if (request) {
      await t.deletionEvent.update({
        where: { id: request.id },
        data: {
          status: 'success',
          completedAt: now,
          resolvedByEventId: event.id,
        },
      });
    }
    return this.deletionResult(archive, event, request?.id ?? null);
  }

  async inspectDue(now = new Date(), sampleLimit = 20) {
    const where = { status: 'active', purgeAt: { lte: now } };
    const [dueCount, oldest, sample] = await Promise.all([
      this.db.archivedResult.count({ where }),
      this.db.archivedResult.findFirst({
        where,
        orderBy: [{ purgeAt: 'asc' }, { id: 'asc' }],
        select: { purgeAt: true },
      }),
      this.db.archivedResult.findMany({
        where,
        orderBy: [{ purgeAt: 'asc' }, { id: 'asc' }],
        take: Math.max(0, Math.min(100, Math.floor(sampleLimit))),
        select: { id: true, liveSessionId: true, purgeAt: true },
      }),
    ]);
    return {
      observedAt: now.toISOString(),
      dueCount,
      oldestDueAt: oldest?.purgeAt.toISOString() ?? null,
      oldestDueAgeSeconds: oldest
        ? Math.max(0, (now.getTime() - oldest.purgeAt.getTime()) / 1000)
        : 0,
      sample: sample.map((row) => ({
        id: row.id,
        liveSessionId: row.liveSessionId,
        purgeAt: row.purgeAt.toISOString(),
      })),
    };
  }

  /**
   * Manifest export lag + dead-record counts for the retention alert rules
   * (smartlearning_retention_manifest_lag_seconds / manifest_dead_records).
   * Lag is measured against the oldest un-exported outbox row's creation
   * time; dead rows are permanent failures that stopped the retry loop.
   */
  async inspectManifestDelivery(now = new Date()) {
    const unexported = await this.db.deletionManifestOutbox.findFirst({
      where: { status: { not: 'exported' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { createdAt: true },
    });
    const deadCount = await this.db.deletionManifestOutbox.count({
      where: { status: 'failed' },
    });
    return {
      observedAt: now.toISOString(),
      manifestLagSeconds: unexported
        ? Math.max(0, (now.getTime() - unexported.createdAt.getTime()) / 1000)
        : 0,
      manifestDeadRecords: deadCount,
    };
  }

  async purgeDue(limit = 50, now = new Date()) {
    const startedAt = process.hrtime.bigint();
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const failedIds = new Set<string>();
    let selected = 0;
    let deleted = 0;
    let failed = 0;

    while (selected < boundedLimit) {
      let claimedId: string | undefined;
      try {
        const outcome = await this.tx.run(async (t) => {
          const exclusion = failedIds.size
            ? Prisma.sql`AND archived_result.live_session_id NOT IN (${Prisma.join(
                [...failedIds].map((id) => Prisma.sql`${id}::uuid`),
              )})`
            : Prisma.empty;
          const rows = await t.$queryRaw<Array<{ liveSessionId: string }>>`
            SELECT archived_result.live_session_id AS "liveSessionId"
            FROM archived_result
            JOIN live_session ON live_session.id = archived_result.live_session_id
            WHERE archived_result.status = 'active'
              AND archived_result.purge_at <= ${now}
              ${exclusion}
            ORDER BY archived_result.purge_at ASC, archived_result.id ASC
            LIMIT 1
            FOR UPDATE OF live_session SKIP LOCKED
          `;
          const row = rows[0];
          if (!row) return null;
          claimedId = row.liveSessionId;
          return this.purgeOneInTransaction(
            t,
            row.liveSessionId,
            'retention',
            undefined,
            'retention',
            now,
          );
        });
        if (!claimedId) break;
        selected += 1;
        this.recordItem('selected', 1);
        if (outcome) {
          deleted += 1;
          this.recordItem('deleted', 1);
        }
      } catch {
        if (!claimedId) {
          this.recordRun('failure', startedAt);
          throw new Error('Retention claim failed');
        }
        selected += 1;
        failed += 1;
        failedIds.add(claimedId);
        this.recordItem('selected', 1);
        this.recordItem('failed', 1);
      }
    }
    this.recordRun(failed === 0 ? 'success' : 'failure', startedAt);
    return { selected, deleted, failed };
  }

  private recordItem(
    result: 'selected' | 'deleted' | 'failed',
    count: number,
  ): void {
    if (!Number.isFinite(count) || count <= 0) return;
    try {
      this.metrics?.recordJobItem('retention_purge', result, count);
    } catch {
      // Metrics must not replace retention errors or results.
    }
  }

  private recordRun(outcome: 'success' | 'failure', startedAt: bigint): void {
    const durationSeconds =
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    try {
      this.metrics?.recordJobRun('retention_purge', outcome, durationSeconds);
    } catch {
      // Metrics are observational and cannot change purge semantics.
    }
  }
}
