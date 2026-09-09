import { parseRetentionCommand } from './retention';

describe('retention command parser', () => {
  it.each([
    'inspect',
    'run-once',
    'manifest-export-once',
    'reconcile-inspect',
    'reconcile-apply',
  ])('accepts %s', (command) => {
    expect(parseRetentionCommand(['node', 'retention', command])).toBe(command);
  });
  it('defaults to inspect and rejects unknown commands', () => {
    expect(parseRetentionCommand(['node', 'retention'])).toBe('inspect');
    expect(() => parseRetentionCommand(['node', 'retention', 'purge'])).toThrow(
      'Unknown retention command',
    );
  });
});
