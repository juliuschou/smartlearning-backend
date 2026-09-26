import { Prisma } from '../../../generated/prisma/client';
import { projectDiagnosticError } from './diagnostic-error';

describe('projectDiagnosticError', () => {
  it('keeps bounded Prisma and database codes only', () => {
    const error = new Prisma.PrismaClientKnownRequestError('raw message', {
      code: 'P2010',
      clientVersion: '7.9.1',
      meta: {
        code: '40P01',
        message: 'raw SQL detail',
        query: 'SELECT secret',
        target: ['private_field'],
      },
    });

    expect(projectDiagnosticError(error)).toEqual({
      errorType: 'PrismaClientKnownRequestError',
      prismaCode: 'P2010',
      databaseCode: '40P01',
    });
  });

  it('keeps generic errors compatible with the existing projection', () => {
    expect(projectDiagnosticError(new Error('secret'))).toEqual({
      errorType: 'Error',
    });
    expect(projectDiagnosticError('secret')).toEqual({
      errorType: 'string',
    });
  });

  it('omits malformed or overlong codes without throwing', () => {
    const error = new Prisma.PrismaClientKnownRequestError('message', {
      code: 'P2010',
      clientVersion: '7.9.1',
      meta: { code: { nested: true } },
    });
    expect(projectDiagnosticError(error)).toEqual({
      errorType: 'PrismaClientKnownRequestError',
      prismaCode: 'P2010',
    });

    const longCode = new Prisma.PrismaClientKnownRequestError('message', {
      code: 'x'.repeat(33),
      clientVersion: '7.9.1',
      meta: { code: '40P01' },
    });
    expect(projectDiagnosticError(longCode)).toEqual({
      errorType: 'PrismaClientKnownRequestError',
      databaseCode: '40P01',
    });
  });

  it('fails open when Prisma metadata access throws', () => {
    const error = new Prisma.PrismaClientKnownRequestError('message', {
      code: 'P2010',
      clientVersion: '7.9.1',
    });
    Object.defineProperty(error, 'meta', {
      configurable: true,
      get: () => {
        throw new Error('diagnostic getter failure');
      },
    });

    expect(projectDiagnosticError(error)).toEqual({
      errorType: 'PrismaClientKnownRequestError',
      prismaCode: 'P2010',
    });
  });
});
