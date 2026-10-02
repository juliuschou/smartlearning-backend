/**
 * Deterministic W3 submission cohort.
 *
 * The W3 BDD acceptance contract (docs/智學互動平台/00_專案規劃/MVP 效能目標.md, W3)
 * requires 300 participants where EVERY participant submits one valid answer and
 * the submission burst completes within 10 seconds. The historical harness shape
 * (half the cohort answers, half abstains — for the vote-to-reveal
 * access-control probe) remains available as `alternate`/`first-half` so
 * existing abstainer-dependent evidence is unchanged.
 *
 * Unsupported split values are rejected, never silently mapped to a fallback.
 */
export type W3CohortSplit = 'alternate' | 'first-half' | 'all';

export interface CohortPlan {
  participants: number;
  split: W3CohortSplit;
  answeredCount: number;
  abstainerCount: number;
  /** Deterministic cohort predicate: does participant `index` submit? */
  isAnswered: (index: number) => boolean;
  /**
   * True only for the historical half-submit shapes, where an abstaining
   * participant is guaranteed to exist.
   */
  expectsAbstainer: boolean;
}

export function parseW3CohortSplit(raw: string | undefined): W3CohortSplit {
  if (raw === undefined || raw === '') return 'alternate';
  if (raw === 'alternate' || raw === 'first-half' || raw === 'all') return raw;
  throw new Error(
    `W3_COHORT_SPLIT "${raw}" is unsupported; use all, alternate, or first-half (refusing to fallback).`,
  );
}

export function planCohort(
  participants: number,
  splitInput: string | W3CohortSplit,
): CohortPlan {
  const split =
    typeof splitInput === 'string'
      ? parseW3CohortSplit(splitInput)
      : splitInput;
  if (!Number.isInteger(participants) || participants < 1)
    throw new Error('W3 participants must be a positive integer.');
  const answeredCount =
    split === 'all' ? participants : Math.ceil(participants / 2);
  return {
    participants,
    split,
    answeredCount,
    abstainerCount: participants - answeredCount,
    isAnswered:
      split === 'all'
        ? () => true
        : split === 'first-half'
          ? (index: number) => index < answeredCount
          : (index: number) => index % 2 === 0,
    expectsAbstainer: split !== 'all',
  };
}
