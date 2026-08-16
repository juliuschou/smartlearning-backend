import { hash, verify, argon2id, type HashOptions } from 'argon2';

/**
 * Argon2id password hashing. Parameters fixed per M2 關鍵技術決策 §5
 * (OWASP baseline): m=64 MiB, t=3, p=1. Tuning/benchmark is a Phase 2/9
 * verification task; do not change parameters without re-benchmarking.
 *
 * The encoded hash string embeds the algorithm + parameters, so stored hashes
 * are self-describing and a future parameter upgrade can rehash on verify.
 */
const ARGON2_OPTIONS: HashOptions = {
  type: argon2id,
  memoryCost: 64 * 1024, // 64 MiB in KiB
  timeCost: 3,
  parallelism: 1,
};

/** Hash a plaintext password with Argon2id. Never store plaintext. */
export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a plaintext password against an Argon2id encoded hash.
 * Returns false on mismatch (never throws for wrong password) so callers can
 * apply a uniform, generic login-failure path that does not leak account state.
 */
export function verifyPassword(
  encodedHash: string,
  plaintext: string,
): Promise<boolean> {
  return verify(encodedHash, plaintext);
}
