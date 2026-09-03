import { ExecutionContext } from '@nestjs/common';
import { AuthenticatedStudentSessionGuard } from './participant-token.guard';

describe('AuthenticatedStudentSessionGuard', () => {
  function makeContext(): ExecutionContext {
    return {} as ExecutionContext;
  }

  function makeGuard(participantOutcome: 'resolve' | 'reject' = 'resolve'): {
    guard: AuthenticatedStudentSessionGuard;
    sessions: { canActivateForParticipant: jest.Mock };
    students: { canActivate: jest.Mock };
  } {
    const sessions = {
      canActivateForParticipant:
        participantOutcome === 'reject'
          ? jest.fn().mockRejectedValue(new Error('unauthorized'))
          : jest.fn().mockResolvedValue(true),
    };
    const students = { canActivate: jest.fn().mockReturnValue(true) };
    const guard = new AuthenticatedStudentSessionGuard(
      sessions as never,
      students as never,
    );
    return { guard, sessions, students };
  }

  it('delegates to the participant-bound session classification first', async () => {
    const { guard, sessions, students } = makeGuard();

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);

    expect(sessions.canActivateForParticipant).toHaveBeenCalledTimes(1);
    expect(students.canActivate).toHaveBeenCalledTimes(1);
  });

  it('does not run the role guard when the session boundary rejects', async () => {
    const { guard, students } = makeGuard('reject');

    await expect(guard.canActivate(makeContext())).rejects.toThrow(
      'unauthorized',
    );

    expect(students.canActivate).not.toHaveBeenCalled();
  });

  it('composes only session and role guards, never participant resolution', async () => {
    const { guard, sessions, students } = makeGuard();

    await guard.canActivate(makeContext());

    // No ParticipantService dependency exists on the constructed instance.
    expect(
      Object.keys(guard as unknown as Record<string, unknown>).sort(),
    ).toEqual(['sessions', 'students']);
    expect(sessions.canActivateForParticipant).toHaveBeenCalled();
    expect(students.canActivate).toHaveBeenCalled();
  });
});
