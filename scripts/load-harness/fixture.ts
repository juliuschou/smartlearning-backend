import { createOperation } from './metrics';
import type { LoadHttpClient } from './http-client';

export interface W1Fixture {
  runId: string;
  marker: string;
  courseId: string;
  questionId: string;
  liveSessionId: string;
  sessionQuestionId: string;
  sessionCode: string;
}

function data<T>(
  result: { data?: T; status: number; errorCode?: string },
  label: string,
): T {
  if (!result.data)
    throw new Error(
      `${label} did not return fixture data (${result.errorCode ?? result.status}).`,
    );
  return result.data;
}

export async function createW1Fixture(
  http: LoadHttpClient,
  runId: string,
  username: string,
  password: string,
): Promise<W1Fixture> {
  const operation = createOperation('fixture-create', 'http');
  await http.loginTeacher(operation, username, password);
  const marker = `load-harness-${runId}`;
  const course = data(
    await http.createCourse(
      operation,
      `Disposable ${marker}`,
      `Disposable W1 fixture ${marker}`,
    ),
    'Course creation',
  );
  const question = data(
    await http.createQuestion(
      operation,
      course.id,
      `Disposable W1 question ${marker}`,
    ),
    'Question creation',
  );
  const session = data(
    await http.createLiveSession(operation, course.id, question.id),
    'Live-session creation',
  );
  const started = data(
    await http.startLiveSession(operation, session.id),
    'Live-session start',
  );
  const sessionQuestionId = started.sessionQuestions?.[0]?.id;
  if (!sessionQuestionId)
    throw new Error('Live-session start returned no session question.');
  await http.openSessionQuestion(operation, session.id, sessionQuestionId);
  if (!session.sessionCode)
    throw new Error('Live-session creation returned no session code.');
  return {
    runId,
    marker,
    courseId: course.id,
    questionId: question.id,
    liveSessionId: session.id,
    sessionQuestionId,
    sessionCode: session.sessionCode,
  };
}
