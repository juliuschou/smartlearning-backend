import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../generated/prisma/client';
import { newId } from '../../../src/common/crypto/uuid';
import { projectDiagnosticError } from '../../../src/common/observability/diagnostic-error';
import { LiveSessionService } from '../../../src/modules/live-sessions/application/live-session.service';
import { TransactionService } from '../../../src/prisma/transaction.service';
import type { PrismaService } from '../../../src/prisma/prisma.service';

const runId =
  process.env.D4_RUN_ID ??
  `d4-prisma-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;
const mode = process.argv[2] ?? 'baseline';
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error('DATABASE_URL is required');

function urlFor(applicationName: string): string {
  const url = new URL(baseUrl!);
  url.searchParams.set('application_name', applicationName);
  url.searchParams.set('connection_limit', '5');
  return url.toString();
}

function serviceFor(prisma: PrismaClient): LiveSessionService {
  const wrapper = { prisma } as unknown as PrismaService;
  const transactions = new TransactionService(wrapper);
  return new LiveSessionService(
    wrapper,
    transactions,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

async function createFixture(prisma: PrismaClient) {
  const accountId = newId();
  const courseId = newId();
  const questionId = newId();
  const optionIds = [newId(), newId()];
  const liveSessionId = newId();
  const sessionQuestionId = newId();
  const snapshotOptionIds = [newId(), newId()];
  const participantId = newId();
  const eventId = newId();
  const now = new Date();
  const username = `${runId}-owner`;
  const sessionCode = `D4${runId
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-6)
    .toUpperCase()}`;

  await prisma.account.create({
    data: {
      id: accountId,
      username,
      displayName: `${runId} owner`,
      role: 'teacher',
      status: 'active',
      canCreateCourse: true,
    },
  });
  await prisma.course.create({
    data: {
      id: courseId,
      ownerAccountId: accountId,
      name: `${runId} course`,
      status: 'draft',
    },
  });
  await prisma.questionDefinition.create({
    data: {
      id: questionId,
      courseId,
      type: 'poll',
      prompt: `${runId} question`,
      selectionMode: 'single',
      position: 0,
      options: {
        create: optionIds.map((id, index) => ({
          id,
          optionRef: `option-${index}`,
          text: `Option ${index}`,
          position: index,
          isCorrect: false,
        })),
      },
    },
  });
  await prisma.liveSession.create({
    data: {
      id: liveSessionId,
      courseId,
      status: 'active',
      sessionCode,
      startedAt: now,
      realtimeEventSeq: 1,
      realtimeEventSequence: { create: { lastEventSeq: 1n } },
    },
  });
  await prisma.sessionQuestion.create({
    data: {
      id: sessionQuestionId,
      liveSessionId,
      questionDefinitionId: questionId,
      position: 0,
      status: 'closed',
      aggregateVersion: 1,
      snapshotType: 'poll',
      snapshotPrompt: `${runId} question`,
      snapshotSelectionMode: 'single',
      closedAt: now,
      options: {
        create: snapshotOptionIds.map((id, index) => ({
          id,
          optionRef: `option-${index}`,
          text: `Option ${index}`,
          position: index,
          isCorrect: false,
        })),
      },
    },
  });
  await prisma.participant.create({
    data: {
      id: participantId,
      liveSessionId,
      displayName: `${runId} participant`,
      tokenHash: `${runId}-token-hash`,
    },
  });
  await prisma.liveSessionEvent.create({
    data: {
      id: eventId,
      liveSessionId,
      sessionQuestionId,
      eventName: 'result.updated',
      eventSeq: 1n,
      aggregateVersion: 1,
      visibility: 'participant',
      projectionInput: { sessionQuestionId, status: 'closed' },
      deliveryState: 'pending',
      attemptCount: 0,
      nextAttemptAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    },
  });

  return {
    runId,
    username,
    accountId,
    courseId,
    questionId,
    optionIds,
    liveSessionId,
    sessionQuestionId,
    snapshotOptionIds,
    participantId,
    eventId,
  };
}

async function cleanup(
  prisma: PrismaClient,
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  await prisma.$transaction(async (tx) => {
    await tx.liveSessionEvent.deleteMany({
      where: { id: fixture.eventId, liveSessionId: fixture.liveSessionId },
    });
    await tx.sessionQuestionOption.deleteMany({
      where: { sessionQuestionId: fixture.sessionQuestionId },
    });
    await tx.participant.deleteMany({
      where: {
        id: fixture.participantId,
        liveSessionId: fixture.liveSessionId,
      },
    });
    await tx.sessionQuestion.deleteMany({
      where: {
        id: fixture.sessionQuestionId,
        liveSessionId: fixture.liveSessionId,
      },
    });
    await tx.liveSessionEventSequence.deleteMany({
      where: { liveSessionId: fixture.liveSessionId },
    });
    await tx.liveSession.deleteMany({
      where: { id: fixture.liveSessionId, courseId: fixture.courseId },
    });
    await tx.questionOption.deleteMany({
      where: { questionDefinitionId: fixture.questionId },
    });
    await tx.questionDefinition.deleteMany({
      where: { id: fixture.questionId, courseId: fixture.courseId },
    });
    await tx.course.deleteMany({
      where: { id: fixture.courseId, ownerAccountId: fixture.accountId },
    });
    await tx.account.deleteMany({
      where: { id: fixture.accountId, username: fixture.username },
    });
  });
}

async function baseline(
  prisma: PrismaClient,
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  const service = serviceFor(prisma);
  const result = await service.getResults(
    fixture.liveSessionId,
    fixture.sessionQuestionId,
    {
      kind: 'participant',
      participantId: fixture.participantId,
    },
  );
  if (result.snapshotType !== 'poll') {
    throw new Error(
      `D4 expected poll results, received ${result.snapshotType}`,
    );
  }
  return {
    optionCount: result.options.length,
    totalSubmissions: result.totalResponses,
  };
}

async function terminateBlockedOperation(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  const target = new PrismaClient({
    adapter: new PrismaPg({ connectionString: urlFor(`d4-target-${runId}`) }),
  });
  const holder = new PrismaClient({
    adapter: new PrismaPg({ connectionString: urlFor(`d4-holder-${runId}`) }),
  });
  const observer = new PrismaClient({
    adapter: new PrismaPg({ connectionString: urlFor(`d4-observer-${runId}`) }),
  });
  await Promise.all([
    target.$connect(),
    holder.$connect(),
    observer.$connect(),
  ]);
  let releaseHolder!: () => void;
  const holderRelease = new Promise<void>(
    (resolve) => (releaseHolder = resolve),
  );
  const held = holder.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM live_session WHERE id = ${fixture.liveSessionId}::uuid FOR UPDATE`;
    await holderRelease;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const service = serviceFor(target);
  const operation = service.getResults(
    fixture.liveSessionId,
    fixture.sessionQuestionId,
    {
      kind: 'participant',
      participantId: fixture.participantId,
    },
  );
  let pid: number | undefined;
  for (let i = 0; i < 100; i += 1) {
    const rows = await observer.$queryRaw<Array<{ pid: number }>>`
      SELECT pid
      FROM pg_stat_activity
      WHERE application_name = ${`d4-target-${runId}`}
        AND wait_event_type = 'Lock'
        AND state = 'active'
      LIMIT 1`;
    if (rows[0]) {
      pid = rows[0].pid;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!pid) {
    releaseHolder();
    await held;
    await Promise.all([
      target.$disconnect(),
      holder.$disconnect(),
      observer.$disconnect(),
    ]);
    throw new Error(
      'D4 could not observe the production operation waiting on the held live_session row lock',
    );
  }
  const terminated = await observer.$queryRaw<
    Array<{ terminated: boolean }>
  >`SELECT pg_terminate_backend(${pid}) AS terminated`;
  releaseHolder();
  await held;
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  const projection = error ? projectDiagnosticError(error) : undefined;
  await Promise.all([
    target.$disconnect(),
    holder.$disconnect(),
    observer.$disconnect(),
  ]);
  if (!error)
    throw new Error(
      'D4 target operation unexpectedly succeeded after its backend session was terminated',
    );
  return { pid, terminated: terminated[0]?.terminated ?? false, projection };
}

(async () => {
  if (mode !== 'baseline' && mode !== 'repro')
    throw new Error('Usage: d4-prisma-repro.ts baseline|repro');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: urlFor(`d4-main-${runId}`) }),
  });
  await prisma.$connect();
  const fixture = await createFixture(prisma);
  try {
    const baselineResult = await baseline(prisma, fixture);
    const reproduction =
      mode === 'repro' ? await terminateBlockedOperation(fixture) : undefined;
    process.stdout.write(
      JSON.stringify(
        { fixture, baseline: baselineResult, reproduction },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await cleanup(prisma, fixture);
    await prisma.$disconnect();
  }
})().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      errorType: error?.constructor?.name ?? 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
    }) + '\n',
  );
  process.exitCode = 1;
});
