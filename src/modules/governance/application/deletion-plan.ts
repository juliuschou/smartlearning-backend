import type { Prisma } from '../../../../generated/prisma/client';

/**
 * Single source of truth for the governed retention deletion.
 *
 * BE-5.2 freezes the deletion inventory (see `tasks/todo.md` Checkpoint A). Every
 * governed table has exactly one predicate here, and that same predicate is what
 * both the dry-run count and the executor's deleteMany use. Keeping the count and
 * the delete on the same closure is what makes the dry-run execution-equivalent:
 * if the plan ever drifted, the dry-run proof would no longer match a real purge.
 *
 * Ordering matters: dependents are removed before their parents (submission →
 * session option → session question → participant; live session event is scoped
 * below). This mirrors the frozen inventory and the previous executor ordering.
 *
 * Layer note: this lives under `application/` (not `domain/`) because the where
 * closures are coupled to the Prisma transaction client models.
 */
export const DELETION_PLAN_VERSION = 'deletion-plan.v1' as const;

/** Category stamped into the canonical DeletionEvent for this governed deletion. */
export const DELETION_EVENT_CATEGORY = 'governed_deletion' as const;

export type GovernedTable =
  | 'Submission'
  | 'LiveSessionEvent'
  | 'SessionQuestionOption'
  | 'SessionQuestion'
  | 'Participant';

/**
 * Write-free per-session deletion plan produced by a retention dry-run. Shares its
 * predicates with the executor, so counts here equal what a real purge would delete.
 */
export type GovernedDeletionPlanDto = {
  archiveId: string;
  liveSessionId: string;
  category: typeof DELETION_EVENT_CATEGORY;
  /** Rows the executor would delete, keyed by governed table. */
  tableCounts: Record<GovernedTable, number>;
};

export type RetentionRunResult = {
  selected: number;
  deleted: number;
  failed: number;
  planned?: GovernedDeletionPlanDto[];
};

type PlanEntry =
  | {
      table: 'Submission';
      where: (sid: string) => Prisma.SubmissionWhereInput;
    }
  | {
      table: 'LiveSessionEvent';
      where: (sid: string) => Prisma.LiveSessionEventWhereInput;
    }
  | {
      table: 'SessionQuestionOption';
      where: (sid: string) => Prisma.SessionQuestionOptionWhereInput;
    }
  | {
      table: 'SessionQuestion';
      where: (sid: string) => Prisma.SessionQuestionWhereInput;
    }
  | {
      table: 'Participant';
      where: (sid: string) => Prisma.ParticipantWhereInput;
    };

/**
 * The predicates the executor applies. Checkpoint A frozen the contract to require
 * ALL session event state (routing, projection, replay, and delivery) be deleted.
 * Checkpoint D flips the LiveSessionEvent predicate from the earlier
 * participant_after_submit narrow scope to the full per-session scope, closing the
 * recorded conformance gap; the dry-run count and the executor share this predicate.
 */
export const GOVERNED_DELETION_PLAN: readonly PlanEntry[] = [
  { table: 'Submission', where: (sid) => ({ liveSessionId: sid }) },
  { table: 'LiveSessionEvent', where: (sid) => ({ liveSessionId: sid }) },
  {
    table: 'SessionQuestionOption',
    where: (sid) => ({ sessionQuestion: { liveSessionId: sid } }),
  },
  { table: 'SessionQuestion', where: (sid) => ({ liveSessionId: sid }) },
  { table: 'Participant', where: (sid) => ({ liveSessionId: sid }) },
];

/** Execute one plan entry's delete on the transaction client. */
export async function deletePlanEntry(
  t: Prisma.TransactionClient,
  sid: string,
  entry: PlanEntry,
): Promise<void> {
  switch (entry.table) {
    case 'Submission':
      await t.submission.deleteMany({ where: entry.where(sid) });
      return;
    case 'LiveSessionEvent':
      await t.liveSessionEvent.deleteMany({ where: entry.where(sid) });
      return;
    case 'SessionQuestionOption':
      await t.sessionQuestionOption.deleteMany({ where: entry.where(sid) });
      return;
    case 'SessionQuestion':
      await t.sessionQuestion.deleteMany({ where: entry.where(sid) });
      return;
    case 'Participant':
      await t.participant.deleteMany({ where: entry.where(sid) });
      return;
  }
}

/** Count one plan entry's rows on the transaction client (dry-run). */
export async function countPlanEntry(
  t: Prisma.TransactionClient,
  sid: string,
  entry: PlanEntry,
): Promise<number> {
  switch (entry.table) {
    case 'Submission':
      return t.submission.count({ where: entry.where(sid) });
    case 'LiveSessionEvent':
      return t.liveSessionEvent.count({ where: entry.where(sid) });
    case 'SessionQuestionOption':
      return t.sessionQuestionOption.count({ where: entry.where(sid) });
    case 'SessionQuestion':
      return t.sessionQuestion.count({ where: entry.where(sid) });
    case 'Participant':
      return t.participant.count({ where: entry.where(sid) });
  }
}
