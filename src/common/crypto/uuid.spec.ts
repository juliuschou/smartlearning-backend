import { isUuid, newId, normalizeUuid } from './uuid';

describe('UUID helpers', () => {
  it('generates and canonicalizes RFC UUIDs', () => {
    const id = newId();
    expect(isUuid(id)).toBe(true);
    expect(normalizeUuid(id.toUpperCase())).toBe(id);
  });

  it('rejects UUIDs with an invalid version or RFC variant', () => {
    expect(isUuid('0190c6b8-0000-0000-8000-000000000001')).toBe(false);
    expect(isUuid('0190c6b8-0000-7000-0000-000000000001')).toBe(false);
    expect(isUuid('0190c6b8-0000-7000-8000-000000000001')).toBe(true);
  });
});
