import { normalizeParticipantDisplayName } from './display-name';

describe('participant display name', () => {
  it('trims safe Unicode names and allows duplicates by policy', () => {
    expect(normalizeParticipantDisplayName('  小明  ')).toBe('小明');
    expect(normalizeParticipantDisplayName('小明')).toBe('小明');
  });

  it.each(['', '   ', 'x'.repeat(41), 'line\nname', '‮hidden'])(
    'rejects unsafe or invalid name %j',
    (value) => {
      expect(() => normalizeParticipantDisplayName(value)).toThrow();
    },
  );
});
