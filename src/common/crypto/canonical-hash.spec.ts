import { canonicalJsonStringify, hashPayload } from './canonical-hash';

describe('canonical-hash', () => {
  it('produces identical output regardless of object key order', () => {
    const a = canonicalJsonStringify({ b: 1, a: 2, c: 3 });
    const b = canonicalJsonStringify({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('preserves array order', () => {
    const a = canonicalJsonStringify([3, 1, 2]);
    const b = canonicalJsonStringify([1, 2, 3]);
    expect(a).not.toBe(b);
    expect(a).toBe('[3,1,2]');
  });

  it('omits undefined values', () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJsonStringify([1, undefined, 2])).toBe('[1,2]');
  });

  it('handles nested objects and arrays', () => {
    const value = {
      questions: [
        { type: 'poll', options: [{ text: 'B' }, { text: 'A' }] },
        { type: 'open_text', prompt: 'p' },
      ],
    };
    const canonical = canonicalJsonStringify(value);
    expect(canonical).toBe(
      '{"questions":[{"options":[{"text":"B"},{"text":"A"}],"type":"poll"},{"prompt":"p","type":"open_text"}]}',
    );
  });

  it('hashPayload is stable across key order and prefixed sha256:', () => {
    const a = hashPayload({ b: 1, a: 2 });
    const b = hashPayload({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a.startsWith('sha256:')).toBe(true);
    expect(a.length).toBe('sha256:'.length + 64);
  });

  it('hashPayload differs when array order differs', () => {
    expect(hashPayload([1, 2, 3])).not.toBe(hashPayload([3, 2, 1]));
  });

  it('hashPayload handles strings, booleans, null', () => {
    expect(hashPayload('x')).not.toBe(hashPayload('y'));
    expect(hashPayload(true)).not.toBe(hashPayload(false));
    expect(hashPayload(null)).not.toBe(hashPayload(''));
  });
});
