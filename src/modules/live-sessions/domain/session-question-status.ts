export const SessionQuestionStatus = {
  NOT_OPEN: 'not_open',
  OPEN: 'open',
  CLOSED: 'closed',
} as const;

export type SessionQuestionStatus =
  (typeof SessionQuestionStatus)[keyof typeof SessionQuestionStatus];

export function canOpenSessionQuestion(status: SessionQuestionStatus): boolean {
  return status === SessionQuestionStatus.NOT_OPEN;
}

export function canCloseSessionQuestion(
  status: SessionQuestionStatus,
): boolean {
  return status === SessionQuestionStatus.OPEN;
}
