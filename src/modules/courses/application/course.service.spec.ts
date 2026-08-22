import { CourseService } from './course.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';

describe('CourseService.createCourse', () => {
  const ownerAccountId = '01900000-0000-7000-8000-000000000001';
  const tx = {
    account: { findUnique: jest.fn() },
    course: { create: jest.fn() },
  };
  const lockAccountForUpdate = jest.fn();
  const run = jest.fn(async (work: (client: unknown) => Promise<unknown>) =>
    work(tx),
  );

  let service: CourseService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CourseService(
      {} as PrismaService,
      { run, lockAccountForUpdate } as unknown as TransactionService,
    );
  });

  it('rechecks the permission after locking the owner row', async () => {
    tx.account.findUnique.mockResolvedValue({
      id: ownerAccountId,
      role: 'teacher',
      canCreateCourse: false,
    });

    await expect(
      service.createCourse({ ownerAccountId, name: 'Blocked course' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(run).toHaveBeenCalledTimes(1);
    expect(lockAccountForUpdate).toHaveBeenCalledWith(tx, ownerAccountId);
    expect(tx.course.create).not.toHaveBeenCalled();
  });

  it('creates the course only after the locked account allows it', async () => {
    tx.account.findUnique.mockResolvedValue({
      id: ownerAccountId,
      role: 'teacher',
      canCreateCourse: true,
    });
    tx.course.create.mockResolvedValue({
      id: '01900000-0000-7000-8000-000000000002',
    });

    await service.createCourse({
      ownerAccountId,
      name: 'Allowed course',
      description: 'Created under the account lock',
    });

    expect(tx.course.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerAccountId,
        name: 'Allowed course',
        description: 'Created under the account lock',
        status: 'draft',
      }),
    });
  });
});
