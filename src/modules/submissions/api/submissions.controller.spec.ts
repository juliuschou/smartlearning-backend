import type { Request } from 'express';
import type { ParticipantContext } from '../../participants/application/participant.service';
import type { CreateSubmissionDto } from './dto';
import { SubmissionsController } from './submissions.controller';

const liveSessionId = '01999999-9999-7999-8999-999999999991';
const sessionQuestionId = '01999999-9999-7999-8999-999999999992';
const participantId = '01999999-9999-7999-8999-999999999993';
const idempotencyKey = '01999999-9999-7999-8999-999999999994';
const requestId = 'w3-controller-correlation-1';

describe('SubmissionsController request correlation', () => {
  it('passes the normalized HTTP request ID as trace-only context', async () => {
    const submittedAt = new Date('2026-10-07T00:00:00.000Z');
    const submission = {
      id: '01999999-9999-7999-8999-999999999995',
      liveSessionId,
      sessionQuestionId,
      participantId,
      selectedOptionRefs: ['01999999-9999-7999-8999-999999999996'],
      textAnswer: null,
      submittedAt,
    };
    const submissions = {
      submit: jest.fn().mockResolvedValue(submission),
    };
    const controller = new SubmissionsController(submissions as never);
    const participant: ParticipantContext = {
      liveSessionId,
      participantId,
    };
    const dto: CreateSubmissionDto = {
      sessionQuestionId,
      selectedOptionRefs: ['alpha'],
    };
    const request = {
      requestId,
      id: requestId,
      get: jest.fn(),
    } as unknown as Request;

    await expect(
      controller.create(
        liveSessionId,
        idempotencyKey,
        participant,
        dto,
        request,
      ),
    ).resolves.toEqual({
      id: submission.id,
      liveSessionId,
      sessionQuestionId,
      participantId,
      selectedOptionRefs: submission.selectedOptionRefs,
      textAnswer: null,
      submittedAt: submittedAt.toISOString(),
    });
    expect(submissions.submit).toHaveBeenCalledWith(
      liveSessionId,
      participant,
      idempotencyKey,
      dto,
      { correlationId: requestId },
    );
  });
});
