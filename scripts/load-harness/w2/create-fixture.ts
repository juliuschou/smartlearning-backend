/**
 * W2 fixture provisioning driver: fresh teacher + course + question (per type)
 * + active LiveSession + open SessionQuestion. Reuses the load-harness HTTP
 * client. Never touches rows outside the created chain.
 */
import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { LoadHttpClient } from '../http-client';
import { createOperation } from '../metrics';

type FixtureOut = {
  runId: string;
  questionType: 'poll' | 'open_text' | 'quiz';
  username: string;
  courseId: string;
  questionId: string;
  liveSessionId: string;
  sessionQuestionId: string;
  sessionCode: string;
  options?: Array<{ id: string; optionRef: string | null; isCorrect: boolean }>;
};

async function main(): Promise<void> {
  const baseUrl = process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3001';
  const runId = process.env.W2_RUN_ID ?? randomUUID();
  const questionType = (process.env.W2_QUESTION_TYPE ?? 'poll') as
    'poll' | 'open_text' | 'quiz';
  if (!['poll', 'open_text', 'quiz'].includes(questionType))
    throw new Error(`Unsupported W2_QUESTION_TYPE: ${questionType}`);
  const username = `local-w1-w2-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const password = randomBytes(32).toString('base64');
  const createdBy = process.env.LOCAL_W1_PROVISION_CREATED_BY;
  if (!createdBy) throw new Error('LOCAL_W1_PROVISION_CREATED_BY is required.');

  const http = new LoadHttpClient(baseUrl, 10_000, undefined, runId);
  const op = createOperation('w2-fixture', 'http');

  // Provision teacher via the existing bootstrap script contract.
  const { spawn } = await import('node:child_process');
  const provision = await new Promise<{ status: number | null }>((resolve) => {
    const child = spawn(
      'node',
      ['dist/src/bootstrap/provision-local-w1-teacher.js', 'provision'],
      {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          LOCAL_W1_TEACHER_USERNAME: username,
          LOCAL_W1_PROVISIONING_ENABLED: '1',
          LOCAL_PROVISION_TARGET: 'disposable',
          LOAD_DISPOSABLE_TARGET: '1',
          LOCAL_W1_TEACHER_PASSWORD: password,
          LOCAL_W1_PROVISION_CREATED_BY: createdBy,
        },
        stdio: 'ignore',
      },
    );
    child.once('close', (code) => resolve({ status: code ?? 1 }));
    child.once('error', () => resolve({ status: 1 }));
  });
  if (provision.status !== 0)
    throw new Error('W2 teacher provisioning failed.');

  const login = await http.loginTeacher(op, username, password);
  if (!login.data) throw new Error('W2 teacher login failed.');

  const marker = `w2-${runId}`;
  const course = await http.createCourse(
    op,
    `Disposable ${marker}`,
    `Disposable W2 fixture ${marker}`,
  );
  const courseData = course.data;
  if (!courseData) throw new Error('W2 course creation failed.');

  const questionBody: Record<string, unknown> =
    questionType === 'poll'
      ? {
          type: 'poll',
          prompt: `Disposable W2 poll ${marker}`,
          selectionMode: 'single',
          options: [
            { optionRef: 'alpha', text: 'Alpha' },
            { optionRef: 'beta', text: 'Beta' },
            { optionRef: 'gamma', text: 'Gamma' },
          ],
        }
      : questionType === 'open_text'
        ? { type: 'open_text', prompt: `Disposable W2 open_text ${marker}` }
        : {
            type: 'quiz',
            prompt: `Disposable W2 quiz ${marker}`,
            options: [
              { optionRef: 'correct', text: 'Correct' },
              { optionRef: 'wrong1', text: 'Wrong 1' },
              { optionRef: 'wrong2', text: 'Wrong 2' },
            ],
            correctOptionRefs: ['correct'],
          };
  const question = await http.createQuestionRaw(
    op,
    courseData.id,
    questionBody,
  );
  const questionData = question.data as
    | {
        id: string;
        options?: Array<{
          id: string;
          optionRef: string | null;
          isCorrect?: boolean;
        }>;
      }
    | undefined;
  if (!questionData) throw new Error('W2 question creation failed.');

  const session = await http.createLiveSession(
    op,
    courseData.id,
    questionData.id,
  );
  const sessionData = session.data;
  if (!sessionData?.sessionCode)
    throw new Error('W2 live-session creation failed.');
  const started = await http.startLiveSession(op, sessionData.id);
  const sessionQuestionId = started.data?.sessionQuestions?.[0]?.id;
  if (!sessionQuestionId)
    throw new Error('W2 live-session start returned no session question.');
  await http.openSessionQuestion(op, sessionData.id, sessionQuestionId);

  // Submission answers validate against the SessionQuestion SNAPSHOT options,
  // whose ids differ from the QuestionDefinition options. Re-read the session
  // via the teacher snapshot and take the snapshot option ids.
  const snapshot = await http.teacherGetSnapshot(op, sessionData.id);
  const snapshotQuestion = (snapshot.data?.sessionQuestions ?? []).find(
    (q) => q.id === sessionQuestionId,
  );
  if (!snapshotQuestion)
    throw new Error('W2 snapshot missing session question.');
  // Option isCorrect is not exposed on the session DTO; the teacher results
  // projection carries it. Merge it onto the snapshot options.
  const results = await http.teacherGetResults(
    op,
    sessionData.id,
    sessionQuestionId,
  );
  const isCorrectByOptionId = new Map(
    (results.data?.options ?? [])
      .filter((o): o is { optionId: string; isCorrect?: boolean } =>
        Boolean(o.optionId),
      )
      .map((o) => [o.optionId, o.isCorrect ?? false]),
  );

  const out: FixtureOut = {
    runId,
    questionType,
    username,
    courseId: courseData.id,
    questionId: questionData.id,
    liveSessionId: sessionData.id,
    sessionQuestionId,
    sessionCode: sessionData.sessionCode,
    options: (snapshotQuestion.options ?? []).map(
      (o: { id: string; optionRef?: string | null; isCorrect?: boolean }) => ({
        id: o.id,
        optionRef: o.optionRef ?? null,
        isCorrect: isCorrectByOptionId.get(o.id) ?? false,
      }),
    ),
  };
  if (process.env.W2_TEACHER_PASSWORD_OUT)
    (out as Record<string, unknown>).teacherPassword = password;
  console.log(JSON.stringify(out, null, 2));
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'W2 fixture failed.'}\n`,
  );
  process.exitCode = 2;
});
