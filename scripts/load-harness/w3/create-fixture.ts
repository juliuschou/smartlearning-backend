/**
 * W3 fixture provisioning driver: fresh teacher + course + question (poll or
 * quiz) + active LiveSession + open SessionQuestion. Same proven provisioning
 * contract as `scripts/load-harness/w2/create-fixture.ts`; W3 keeps its own copy
 * so W1/W2 harnesses cannot regress. Never touches rows outside the created chain.
 *
 * Poll -> 3 options (clean aggregate/reveal). Quiz -> 3 options with one correct
 * (exercises the correctness-reveal gate: isCorrect hidden while open, revealed
 * on close).
 */
import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { LoadHttpClient, requireLoadCorsOrigin } from '../http-client';
import { createOperation } from '../metrics';
import { requireW3RunId } from './run-contract';

type QuestionType = 'poll' | 'quiz';

let currentStep = 'validate-config';

function redactProvisioningError(raw: string): string {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return '';
  return firstLine
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '[redacted-id]')
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, '[redacted-secret]')
    .slice(0, 300);
}

type FixtureOut = {
  runId: string;
  questionType: QuestionType;
  username: string;
  courseId: string;
  questionId: string;
  liveSessionId: string;
  sessionQuestionId: string;
  sessionCode: string;
  options: Array<{ id: string; optionRef: string | null; isCorrect: boolean }>;
};

async function main(): Promise<void> {
  const baseUrl = process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3001';
  const corsOrigin = requireLoadCorsOrigin();
  const credentialOut = process.env.W3_CREDENTIAL_OUT;
  if (!credentialOut) throw new Error('W3_CREDENTIAL_OUT is required.');
  const runId =
    process.env.W3_TRACE_REQUIRED === '1'
      ? requireW3RunId(process.env.W3_RUN_ID)
      : (process.env.W3_RUN_ID ?? randomUUID());
  const questionType = (process.env.W3_QUESTION_TYPE ?? 'poll') as QuestionType;
  if (!['poll', 'quiz'].includes(questionType))
    throw new Error(`Unsupported W3_QUESTION_TYPE: ${questionType}`);
  // The provisioning bootstrap requires the `local-w1-` username prefix; the
  // `w3` segment keeps W3 fixtures distinguishable for cleanup/reporting.
  const username = `local-w1-w3-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const password = randomBytes(32).toString('base64');
  const createdBy = process.env.LOCAL_W1_PROVISION_CREATED_BY;
  if (!createdBy) throw new Error('LOCAL_W1_PROVISION_CREATED_BY is required.');

  const http = new LoadHttpClient(
    baseUrl,
    10_000,
    undefined,
    runId,
    corsOrigin,
  );
  const op = createOperation('w3-fixture', 'http');

  // Provision teacher via the existing bootstrap script contract.
  currentStep = 'provision-teacher';
  const { spawn } = await import('node:child_process');
  const provision = await new Promise<{
    status: number | null;
    stderr: string;
  }>((resolve) => {
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
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('close', (code) =>
      resolve({ status: code ?? 1, stderr: redactProvisioningError(stderr) }),
    );
    child.once('error', () =>
      resolve({
        status: 1,
        stderr: 'provisioning child process failed to start',
      }),
    );
  });
  if (provision.status !== 0) {
    const detail = provision.stderr ? `: ${provision.stderr}` : '';
    throw new Error(`W3 teacher provisioning failed${detail}`);
  }

  currentStep = 'login-teacher';
  const login = await http.loginTeacher(op, username, password);
  if (
    !login.data ||
    login.data.username !== username ||
    login.data.role !== 'teacher' ||
    login.data.canCreateCourse !== true ||
    login.data.mustChangePassword !== false
  )
    throw new Error(
      'W3 teacher login returned an invalid authorization projection.',
    );

  const marker = `w3-${runId}`;
  currentStep = 'create-course';
  const course = await http.createCourse(
    op,
    `Disposable ${marker}`,
    `Disposable W3 fixture ${marker}`,
  );
  const courseData = course.data;
  if (!courseData?.id)
    throw new Error('W3 course creation returned no course id.');

  const questionBody: Record<string, unknown> =
    questionType === 'poll'
      ? {
          type: 'poll',
          prompt: `Disposable W3 poll ${marker}`,
          selectionMode: 'single',
          options: [
            { optionRef: 'alpha', text: 'Alpha' },
            { optionRef: 'beta', text: 'Beta' },
            { optionRef: 'gamma', text: 'Gamma' },
          ],
        }
      : {
          type: 'quiz',
          prompt: `Disposable W3 quiz ${marker}`,
          options: [
            { optionRef: 'correct', text: 'Correct' },
            { optionRef: 'wrong1', text: 'Wrong 1' },
            { optionRef: 'wrong2', text: 'Wrong 2' },
          ],
          correctOptionRefs: ['correct'],
        };
  currentStep = 'create-question';
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
  if (!questionData?.id)
    throw new Error('W3 question creation returned no question id.');

  currentStep = 'create-live-session';
  const session = await http.createLiveSession(
    op,
    courseData.id,
    questionData.id,
  );
  const sessionData = session.data;
  if (!sessionData?.id || !sessionData.sessionCode)
    throw new Error('W3 live-session creation returned incomplete data.');
  currentStep = 'start-live-session';
  const started = await http.startLiveSession(op, sessionData.id);
  const sessionQuestionId = started.data?.sessionQuestions?.[0]?.id;
  if (!sessionQuestionId)
    throw new Error('W3 live-session start returned no session question.');
  currentStep = 'open-session-question';
  await http.openSessionQuestion(op, sessionData.id, sessionQuestionId);

  // Submission answers validate against the SessionQuestion SNAPSHOT options,
  // whose ids differ from the QuestionDefinition options. Re-read the session
  // via the teacher snapshot and take the snapshot option ids. Option isCorrect
  // is not exposed on the session DTO; the teacher results projection carries it.
  currentStep = 'read-snapshot';
  const snapshot = await http.teacherGetSnapshot(op, sessionData.id);
  const snapshotQuestion = (snapshot.data?.sessionQuestions ?? []).find(
    (q) => q.id === sessionQuestionId,
  );
  if (!snapshotQuestion)
    throw new Error('W3 snapshot missing session question.');
  const snapshotOptions = snapshotQuestion.options ?? [];
  if (
    snapshotOptions.length !== 3 ||
    snapshotOptions.some((option) => !option.id || !option.optionRef)
  )
    throw new Error('W3 snapshot returned incomplete options.');
  currentStep = 'read-results';
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
    options: snapshotOptions.map(
      (o: { id: string; optionRef?: string | null; isCorrect?: boolean }) => ({
        id: o.id,
        optionRef: o.optionRef ?? null,
        isCorrect: isCorrectByOptionId.get(o.id) ?? false,
      }),
    ),
  };
  // Credential handling (W3 authorization): the plaintext teacher password is
  // NEVER written into a durable artifact. It goes to a run-owned, 0600
  // ephemeral file that cleanup deletes. The fixture records only presence.
  currentStep = 'write-credential';
  await writeFile(credentialOut, password, { mode: 0o600 });
  (out as Record<string, unknown>).credentialPresent = true;
  (out as Record<string, unknown>).credentialFile = credentialOut;
  console.log(JSON.stringify({ fixture: out }, null, 2));
}

void main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      step: currentStep,
      error: error instanceof Error ? error.message : 'W3 fixture failed.',
    }) + '\n',
  );
  process.exit(2);
});
