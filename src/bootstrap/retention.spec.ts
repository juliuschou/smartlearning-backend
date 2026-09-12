import {
  disableRetentionSchedulersForOperatorCommand,
  parseRetentionCommand,
} from './retention';

describe('retention command parser', () => {
  it.each([
    'inspect',
    'dry-run',
    'run-once',
    'manifest-export-once',
    'reconcile-inspect',
    'reconcile-apply',
  ])('accepts %s', (command) => {
    expect(parseRetentionCommand(['node', 'retention', command])).toBe(command);
  });
  it('forces both schedulers off before an operator command boots AppModule', () => {
    const env = {
      RETENTION_PURGE_SCHEDULER_ENABLED: 'true',
      RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED: 'true',
    } as NodeJS.ProcessEnv;

    disableRetentionSchedulersForOperatorCommand(env);

    expect(env.RETENTION_PURGE_SCHEDULER_ENABLED).toBe('false');
    expect(env.RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED).toBe('false');
  });

  it('defaults to inspect and rejects unknown commands', () => {
    expect(parseRetentionCommand(['node', 'retention'])).toBe('inspect');
    expect(() => parseRetentionCommand(['node', 'retention', 'purge'])).toThrow(
      'Unknown retention command',
    );
  });
});
