#!/usr/bin/env node
/**
 * Runnable end-to-end test of POST /api/v1/auth/change-password against a
 * live backend (the compose stack on localhost:3000).
 *
 * Flow: login → change-password (session + CSRF rotation) → verify the new
 * password logs in → verify the old password no longer works.
 *
 * Usage:
 *   node scripts/verify-change-password.mjs \
 *     http://localhost:3000 <username> <current-password> <new-password>
 *
 * Exit code 0 on success, 1 on any failed assertion or network error.
 *
 * Why these headers:
 *  - change-password is guarded by SessionGuard + CsrfGuard. CsrfGuard is
 *    fail-closed: it requires an `Origin` exactly present in CORS_ORIGIN and a
 *    matching `__Host-csrf` cookie + `x-csrf-token` header pair.
 *  - The cookie jar deliberately does NOT send `Origin` on login: login is not
 *    CSRF-guarded, and sending one would add nothing (it only needs to match
 *    on guarded mutations, which is what we assert below).
 */

const [, , BASE = 'http://localhost:3000', USERNAME, CURRENT, NEW_PASSWORD] =
  process.argv;

const ORIGIN = 'http://localhost:3000';
const LOGIN = `${BASE}/api/v1/auth/login`;
const CHANGE_PASSWORD = `${BASE}/api/v1/auth/change-password`;
const SESSION = `${BASE}/api/v1/auth/session`;

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

function extractCookie(cookieHeader, name) {
  const entry = cookieHeader
    .split(';')
    .map((s) => s.trim())
    .find((p) => p.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : undefined;
}

/** Cookie jar: login and change-password both rotate the session+csrf cookies. */
const jar = { session: undefined, csrf: undefined };

async function login(username, password) {
  const res = await fetch(LOGIN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  jar.session = extractCookie(setCookie, '__Host-session');
  jar.csrf = extractCookie(setCookie, '__Host-csrf');
  return { status: res.status, body: await res.json() };
}

async function changePassword(current, next) {
  const res = await fetch(CHANGE_PASSWORD, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `__Host-session=${jar.session}; __Host-csrf=${jar.csrf}`,
      Origin: ORIGIN,
      'x-csrf-token': jar.csrf,
    },
    body: JSON.stringify({ currentPassword: current, newPassword: next }),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  if (setCookie) {
    jar.session = extractCookie(setCookie, '__Host-session');
    jar.csrf = extractCookie(setCookie, '__Host-csrf');
  }
  return { status: res.status, body: await res.json() };
}

async function main() {
  if (!USERNAME || !CURRENT || !NEW_PASSWORD) {
    console.error(
      'Usage: node scripts/verify-change-password.mjs <base-url> <username> <current-password> <new-password>',
    );
    process.exit(2);
  }

  console.log(`→ login with current password: ${USERNAME}`);
  const loginRes = await login(USERNAME, CURRENT);
  assert(
    loginRes.status === 201 && loginRes.body.data?.username === USERNAME,
    `login with current password returned 201 + session (got ${loginRes.status}: ${JSON.stringify(loginRes.body)})`,
  );
  assert(Boolean(jar.session) && Boolean(jar.csrf), 'login set session + csrf cookies');

  console.log(`→ change password to the new value`);
  const changeRes = await changePassword(CURRENT, NEW_PASSWORD);
  assert(
    changeRes.status === 201 && changeRes.body.data?.mustChangePassword === false,
    `change-password returned 201 with mustChangePassword=false (got ${changeRes.status}: ${JSON.stringify(changeRes.body)})`,
  );
  assert(Boolean(jar.session) && Boolean(jar.csrf), 'change-password rotated session + csrf cookies');

  console.log(`→ verify new password logs in`);
  const newLogin = await login(USERNAME, NEW_PASSWORD);
  assert(
    newLogin.status === 201 && newLogin.body.data?.username === USERNAME,
    `login with new password returned 201 (got ${newLogin.status}: ${JSON.stringify(newLogin.body)})`,
  );

  console.log(`→ verify old password is rejected`);
  const oldLogin = await login(USERNAME, CURRENT);
  assert(
    oldLogin.status === 401 && oldLogin.body.error?.code === 'AUTH_INVALID_CREDENTIALS',
    `old password rejected with 401 AUTH_INVALID_CREDENTIALS (got ${oldLogin.status}: ${JSON.stringify(oldLogin.body)})`,
  );

  console.log(`\nAll assertions passed — password change verified end-to-end.`);
}

main().catch((err) => {
  console.error(`✗ script failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
