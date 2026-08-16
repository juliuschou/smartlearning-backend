import { hashPassword, verifyPassword } from './password-hasher';

describe('password-hasher (argon2id)', () => {
  it('hashes and verifies a password round-trip', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(typeof hash).toBe('string');
    expect(hash).not.toBe('correct horse battery staple');
    await expect(
      verifyPassword(hash, 'correct horse battery staple'),
    ).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
  });

  it('produces argon2id-encoded hashes (self-describing parameters)', async () => {
    const hash = await hashPassword('whatever-123456');
    // Encoded hash begins with the argon2id algorithm identifier and carries
    // the configured m=65536, t=3, p=1 parameters (M2 §5). argon2's encoder
    // orders the params, so we assert each is present rather than the order.
    expect(hash).toMatch(/^\$argon2id\$v=\d+\$/);
    expect(hash).toMatch(/m=65536/);
    expect(hash).toMatch(/t=3/);
    expect(hash).toMatch(/p=1/);
  });
});
