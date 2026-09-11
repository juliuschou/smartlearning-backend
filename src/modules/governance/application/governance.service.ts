import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../../../config/env.validation';
import { Prisma } from '../../../../generated/prisma/client';
import { hashToken, newId, normalizeUuid } from '../../../common/crypto';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../common/errors';
import { normalizePageRequest, toPage } from '../../../common/pagination';
import {
  countPlanEntry,
  deletePlanEntry,
  DELETION_EVENT_CATEGORY,
  GOVERNED_DELETION_PLAN,
  type GovernedDeletionPlanDto,
  type RetentionRunResult,
} from './deletion-plan';
import {
  LeaseLostError,
  classifyPurgeFailure,
  decidePurgeFailure,
  type PurgeFailureCode,
} from './purge-failure-policy';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';
import { MetricsService } from '../../metrics/metrics.service';
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

/** Durable lease / retry budget for the retention worker (Checkpoint D/E defaults). */
export const PURGE_LEASE_MS_DEFAULT = 10_000;
export const PURGE_MAX_ATTEMPTS_DEFAULT = 5;

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
  private readonly purgeLeaseMs: number;
  private readonly purgeMaxAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TransactionService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly config?: ConfigService<EnvConfig>,
  ) {
    // Coerce env values to Number here (ConfigService does NOT string-convert);
    // fall back to defaults that match the pre-Checkpoint-E hardcoded values.
    this.purgeLeaseMs =
      Number(this.config?.get('RETENTION_PURGE_LEASE_MS', { infer: true })) ||
      PURGE_LEASE_MS_DEFAULT;
    this.purgeMaxAttempts =
      Number(
        this.config?.get('RETENTION_PURGE_MAX_ATTEMPTS', { infer: true }),
      ) || PURGE_MAX_ATTEMPTS_DEFAULT;
  }

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
    const purgeAt = new Date(s.closedAt.getTime() + RETENTION_DAYS * DAY);
    const archive = await t.archivedResult.create({
      data: {
        id: newId(),
        liveSessionId: sid,
        courseId: s.courseId,
        sessionLabel: startedAt.toISOString(),
        startedAt,
        closedAt: s.closedAt,
        purgeAt,
        purgeState: 'pending',
        nextPurgeAttemptAt: purgeAt,
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
      await this.deleteRowsByPlanInTransaction(t, sid);
      await t.archivedResult.update({
        where: { id: archiveId },
        data: {
          status: 'deleted',
          payload: Prisma.DbNull,
          purgeState: 'deleted',
          purgeLeaseToken: null,
          purgeLeaseExpiresAt: null,
          lastPurgeFailureCode: null,
          lastPurgeFailedAt: null,
          quarantinedAt: null,
        },
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

    await this.deleteRowsByPlanInTransaction(t, sid);
    await t.archivedResult.update({
      where: { id: archiveId },
      data: {
        status: 'deleted',
        payload: Prisma.DbNull,
        purgeState: 'deleted',
        purgeLeaseToken: null,
        purgeLeaseExpiresAt: null,
        lastPurgeFailureCode: null,
        lastPurgeFailedAt: null,
        quarantinedAt: null,
      },
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

  /**
   * Execute the governed deletion plan for one session on the transaction client.
   * This is the single delete path both the retention/early-delete executor and the
   * manifest apply use, so the LiveSessionEvent predicate (current
   * PARTICIPANT_AFTER_SUBMIT scope) can never drift between callers.
   */
  private async deleteRowsByPlanInTransaction(
    t: Prisma.TransactionClient,
    sid: string,
  ): Promise<void> {
    for (const entry of GOVERNED_DELETION_PLAN) {
      await deletePlanEntry(t, sid, entry);
    }
  }

  /**
   * Execution-equivalent, write-free deletion plan for one session. Uses the same
   * governed predicates as the executor (so count === delete), then additionally
   * reports the reconciled all-event LiveSessionEvent count for the BE-5.2
   * conformance gap without applying it. Returns per-table counts, no mutations.
   */
  async planDeletionInTransaction(
    t: Prisma.TransactionClient,
    sid: string,
    archiveId: string,
  ): Promise<GovernedDeletionPlanDto> {
    const tableCounts: Record<string, number> = {};
    for (const entry of GOVERNED_DELETION_PLAN) {
      tableCounts[entry.table] = await countPlanEntry(t, sid, entry);
    }
    return {
      archiveId,
      liveSessionId: sid,
      category: DELETION_EVENT_CATEGORY,
      tableCounts,
    };
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

    return this.finalizePurgeInTransaction(
      t,
      archive,
      sid,
      trigger,
      executorId,
      reason,
      now,
      request,
    );
  }

  /**
   * Run the governed deletion + tombstone (DeletionEvent) + outbox (DeletionManifest
   * Outbox) + request resolution atomically. Shared by the admin early-delete /
   * deterministic single-session purge path (`purgeOneInTransaction`) and the
   * durable-lease retention executor (`executePurgeOneInTransaction`), so the two
   * paths can never drift in what they delete or emit.
   */
  private async finalizePurgeInTransaction(
    t: Prisma.TransactionClient,
    archive: { id: string; liveSessionId: string; courseId: string },
    sid: string,
    trigger: 'retention' | 'early_delete',
    executorId: string | undefined,
    reason: DeletionReason | 'retention',
    now: Date,
    request?: { id: string } | null,
  ): Promise<DeletionResultDto> {
    await this.deleteRowsByPlanInTransaction(t, sid);
    await t.archivedResult.update({
      where: { id: archive.id },
      data: {
        status: 'deleted',
        payload: Prisma.DbNull,
        purgeState: 'deleted',
        purgeLeaseToken: null,
        purgeLeaseExpiresAt: null,
        lastPurgeFailureCode: null,
        lastPurgeFailedAt: null,
        quarantinedAt: null,
      },
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

  /**
   * Run one bounded, restart-safe retention sweep.
   *
   * Checkpoint D replaces the earlier invocation-local claim (a `NOT IN (failedIds)`
   * exclusion held only for the lifetime of one call) with durable leases. A claim
   * transaction assigns a UUID v7 lease and increments `purgeAttempts`; then each
   * item executes in its own transaction that verifies the lease; failures transition
   * (retry/backoff or quarantine) only while the lease token still matches. The public
   * signature is unchanged so the scheduler and existing callers keep working.
   */
  async purgeDue(
    limit = 50,
    now = new Date(),
    dryRun = false,
  ): Promise<RetentionRunResult> {
    const startedAt = process.hrtime.bigint();
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const planned: GovernedDeletionPlanDto[] = [];
    let selected = 0;
    let deleted = 0;
    let failed = 0;

    while (selected < boundedLimit) {
      const remaining = boundedLimit - selected;
      if (dryRun) {
        // Write-free scan + count in one transaction: same eligibility as the live
        // claim, but it never persists a lease, so dry-run remains truly side-effect
        // free while sharing the plan's predicates with execution.
        const plans = await this.tx.run(async (t) => {
          const rows = await this.scanDueInTransaction(t, now, remaining);
          const out: GovernedDeletionPlanDto[] = [];
          for (const row of rows) {
            out.push(
              await this.planDeletionInTransaction(
                t,
                row.liveSessionId,
                row.archiveId,
              ),
            );
          }
          return out;
        });
        if (plans.length === 0) break;
        planned.push(...plans);
        selected += plans.length;
        this.recordItem('selected', plans.length);
        continue;
      }

      const claimed = await this.tx.run((t) =>
        this.claimDueInTransaction(t, now, remaining),
      );
      if (claimed.length === 0) break;
      selected += claimed.length;
      this.recordItem('selected', claimed.length);

      for (const item of claimed) {
        try {
          const outcome = await this.tx.run((t) =>
            this.executePurgeOneInTransaction(
              t,
              item.liveSessionId,
              item.leaseToken,
              now,
            ),
          );
          if (outcome) {
            deleted += 1;
            this.recordItem('deleted', 1);
          }
        } catch (error) {
          failed += 1;
          this.recordItem('failed', 1);
          const code = classifyPurgeFailure(error);
          const transition = await this.tx.run((t) =>
            this.transitionFailureInTransaction(
              t,
              item.archiveId,
              item.leaseToken,
              code,
              item.purgeAttempts,
              now,
            ),
          );
          if (transition.matched) {
            this.recordItem(
              transition.quarantined ? 'quarantined' : 'retried',
              1,
            );
          }
        }
      }
    }
    this.recordRun(failed === 0 ? 'success' : 'failure', startedAt);
    if (dryRun) return { selected, deleted, failed, planned };
    return { selected, deleted, failed };
  }

  /** Scan eligible due archives write-free (lock-only), returning ids for counting. */
  private async scanDueInTransaction(
    t: Prisma.TransactionClient,
    now: Date,
    limit: number,
  ): Promise<Array<{ liveSessionId: string; archiveId: string }>> {
    const rows = await t.$queryRaw<
      Array<{ liveSessionId: string; archiveId: string }>
    >`
      SELECT archived_result.live_session_id AS "liveSessionId",
             archived_result.id AS "archiveId"
      FROM archived_result
      JOIN live_session ON live_session.id = archived_result.live_session_id
      WHERE archived_result.status = 'active'
        AND archived_result.purge_at <= ${now}
        AND (
          archived_result.purge_state = 'pending'
          OR (
            archived_result.purge_state = 'retry'
            AND archived_result.next_purge_attempt_at <= ${now}
          )
          OR (
            archived_result.purge_state = 'processing'
            AND archived_result.purge_lease_expires_at <= ${now}
          )
        )
      ORDER BY archived_result.purge_at ASC, archived_result.id ASC
      LIMIT ${limit}
      FOR UPDATE OF live_session SKIP LOCKED
    `;
    return rows.map((row) => ({
      liveSessionId: row.liveSessionId,
      archiveId: row.archiveId,
    }));
  }

  /**
   * Claim a bounded batch of due archives oldest-first and assign durable lease
   * ownership. Only rows whose lease assignment actually matched are returned, so a
   * row reclaimed by another worker (or whose eligibility just changed) is skipped
   * here and retried on the next claim instead of being double-processed.
   */
  private async claimDueInTransaction(
    t: Prisma.TransactionClient,
    now: Date,
    limit: number,
  ): Promise<
    Array<{
      liveSessionId: string;
      archiveId: string;
      leaseToken: string;
      purgeAttempts: number;
    }>
  > {
    const rows = await t.$queryRaw<
      Array<{ liveSessionId: string; archiveId: string; purgeAttempts: bigint }>
    >`
      SELECT archived_result.live_session_id AS "liveSessionId",
             archived_result.id AS "archiveId",
             archived_result.purge_attempts AS "purgeAttempts"
      FROM archived_result
      JOIN live_session ON live_session.id = archived_result.live_session_id
      WHERE archived_result.status = 'active'
        AND archived_result.purge_at <= ${now}
        AND (
          archived_result.purge_state = 'pending'
          OR (
            archived_result.purge_state = 'retry'
            AND archived_result.next_purge_attempt_at <= ${now}
          )
          OR (
            archived_result.purge_state = 'processing'
            AND archived_result.purge_lease_expires_at <= ${now}
          )
        )
      ORDER BY archived_result.purge_at ASC, archived_result.id ASC
      LIMIT ${limit}
      FOR UPDATE OF live_session SKIP LOCKED
    `;
    const leaseExpiresAt = new Date(now.getTime() + this.purgeLeaseMs);
    const claimed: Array<{
      liveSessionId: string;
      archiveId: string;
      leaseToken: string;
      purgeAttempts: number;
    }> = [];
    for (const row of rows) {
      const leaseToken = newId();
      const updated = await t.archivedResult.updateMany({
        where: {
          id: row.archiveId,
          status: 'active',
          OR: [
            { purgeState: { in: ['pending', 'retry'] } },
            { purgeState: 'processing', purgeLeaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          purgeState: 'processing',
          purgeLeaseToken: leaseToken,
          purgeLeaseExpiresAt: leaseExpiresAt,
          purgeAttempts: { increment: 1 },
          lastPurgeFailureCode: null,
          lastPurgeFailedAt: null,
        },
      });
      if (updated.count !== 1) continue;
      claimed.push({
        liveSessionId: row.liveSessionId,
        archiveId: row.archiveId,
        leaseToken,
        purgeAttempts: Number(row.purgeAttempts) + 1,
      });
    }
    return claimed;
  }

  /**
   * Execute one claimed archive under durable lease. Verifies the lease token and
   * `purgeAt` still hold, then performs the governed deletion + tombstone/outbox
   * atomically. If the lease was lost, throws so the caller's failure transition can
   * record `lease_lost` (a no-op because the token no longer matches).
   */
  private async executePurgeOneInTransaction(
    t: Prisma.TransactionClient,
    sid: string,
    leaseToken: string,
    now: Date,
  ): Promise<DeletionResultDto | null> {
    await this.tx.lockLiveSessionForUpdate(t, sid);
    const archive = await t.archivedResult.findUnique({
      where: { liveSessionId: sid },
    });
    if (!archive || archive.status !== 'active') return null;
    if (archive.purgeLeaseToken !== leaseToken) throw new LeaseLostError();
    if (archive.purgeAt > now) throw new LeaseLostError();
    return this.finalizePurgeInTransaction(
      t,
      archive,
      sid,
      'retention',
      undefined,
      'retention',
      now,
      undefined,
    );
  }

  /**
   * Fail a claimed archive via compare-and-set on its lease. Retries with bounded
   * exponential backoff for transient codes; quarantines permanent or exhausted
   * rows. Only applies when the lease token still matches, so a reclaimed row is
   * left untouched. Never alters `purgeAt`.
   */
  private async transitionFailureInTransaction(
    t: Prisma.TransactionClient,
    archiveId: string,
    leaseToken: string,
    code: PurgeFailureCode,
    attempts: number,
    now: Date,
  ): Promise<{ matched: boolean; quarantined: boolean }> {
    const decision = decidePurgeFailure(code, attempts, this.purgeMaxAttempts);
    const data = decision.quarantined
      ? {
          purgeState: 'quarantined',
          quarantinedAt: now,
          lastPurgeFailureCode: code,
          lastPurgeFailedAt: now,
          purgeLeaseToken: null,
          purgeLeaseExpiresAt: null,
        }
      : {
          purgeState: 'retry',
          nextPurgeAttemptAt: new Date(now.getTime() + decision.delayMs),
          lastPurgeFailureCode: code,
          lastPurgeFailedAt: now,
          purgeLeaseToken: null,
          purgeLeaseExpiresAt: null,
        };
    const updated = await t.archivedResult.updateMany({
      where: { id: archiveId, purgeLeaseToken: leaseToken },
      data,
    });
    return { matched: updated.count === 1, quarantined: decision.quarantined };
  }

  private recordItem(
    result: 'selected' | 'deleted' | 'failed' | 'retried' | 'quarantined',
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
      if (outcome === 'success') {
        this.metrics?.recordRetentionPurgeLastSuccess(
          Math.floor(Date.now() / 1000),
        );
      }
    } catch {
      // Metrics are observational and cannot change purge semantics.
    }
  }
}
