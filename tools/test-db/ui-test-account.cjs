#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const readline = require('node:readline');
const { StringDecoder } = require('node:string_decoder');
const { Client } = require('pg');
const argon2 = require('argon2');
const { isEmail } = require('class-validator');
const {
  assertIntegrationReady,
  assertTestTarget,
  loadTarget,
} = require('./assert-integration-ready.cjs');

function fail(message) {
  throw new Error(message);
}

function normalizeEmail(value) {
  const email = String(value || '').trim();
  if (email.length > 254 || !isEmail(email)) {
    fail('Email 格式無效（最多 254 個字元）。');
  }
  return email;
}

function validateName(value) {
  const name = String(value || '').trim();
  const length = [...name].length;
  if (length < 1 || length > 100) fail('姓名需為 1–100 個字元。');
  return name;
}

function validatePassword(value) {
  if (typeof value !== 'string' || [...value].length < 8 || Buffer.byteLength(value, 'utf8') > 1024) {
    fail('密碼需至少 8 個 Unicode 字元，且 UTF-8 長度不可超過 1024 bytes。');
  }
  return value;
}

function accountNameFor(runId, email) {
  const suffix = crypto.createHash('sha256').update(`${runId}:${email.toLowerCase()}`).digest('hex').slice(0, 20);
  return `uitest-${suffix}`;
}

async function promptLine(label, { hidden = false } = {}) {
  if (!process.stdin.isTTY || (hidden && typeof process.stdin.setRawMode !== 'function')) {
    fail('此指令需要互動式終端；拒絕在可能回顯密碼的非 TTY 環境執行。');
  }
  if (!hidden) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await new Promise((resolve) => rl.question(`${label}: `, resolve))).trim();
    } finally {
      rl.close();
    }
  }

  process.stdout.write(`${label}: `);
  return new Promise((resolve, reject) => {
    let value = '';
    const decoder = new StringDecoder('utf8');
    const input = process.stdin;
    const onData = (chunk) => {
      for (const character of decoder.write(chunk)) {
        if (character === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('已取消。'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u0008' || character === '\u007f') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        if (character >= ' ') value += character;
      }
    };
    function cleanup() {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
    }
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

async function collectInput() {
  const email = normalizeEmail(await promptLine('Email（登入識別）'));
  const name = validateName(await promptLine('姓名'));
  const password = validatePassword(await promptLine('設定密碼（輸入不會顯示）', { hidden: true }));
  const confirmation = await promptLine('再次輸入密碼（輸入不會顯示）', { hidden: true });
  if (password !== confirmation) fail('兩次輸入的密碼不一致。');
  return { email, name, password };
}

function makeClient(connectionString) {
  return new Client({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
}

async function provisionAccount({ runId, email, name, password, client, hashPassword = argon2.hash }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedName = validateName(name);
  const validatedPassword = validatePassword(password);
  const passwordHash = await hashPassword(validatedPassword);
  if (passwordHash === validatedPassword) fail('密碼雜湊失敗。');
  const accountName = accountNameFor(runId, normalizedEmail);

  await client.query('BEGIN');
  try {
    const role = await client.query(
      `INSERT INTO app.role (role_code, name, description, is_system_reserved, status)
       VALUES ('TEACHER', '老師', 'Local UI integration test role', TRUE, 'ENABLED'::app.role_status_e)
       ON CONFLICT (role_code) DO NOTHING
       RETURNING id, name, is_system_reserved, status`,
    );
    const roleResult = role.rowCount
      ? role
      : await client.query(
        `SELECT id, name, is_system_reserved, status FROM app.role WHERE role_code = 'TEACHER' FOR SHARE`,
      );
    const teacherRole = roleResult.rows[0];
    if (!teacherRole || teacherRole.name !== '老師' || teacherRole.is_system_reserved !== true || teacherRole.status !== 'ENABLED') {
      fail('資料庫中的 TEACHER 角色不存在或內容不符合固定角色目錄；停止建立帳號。');
    }

    const created = await client.query(
      `INSERT INTO app.user_account (email, email_verified, password_hash, name, account_name, status)
       VALUES ($1, TRUE, $2, $3, $4, 'ACTIVE'::app.user_status_e)
       RETURNING id, email, account_name`,
      [normalizedEmail, passwordHash, normalizedName, accountName],
    );
    const account = created.rows[0];
    await client.query(
      'INSERT INTO app.user_role (user_account_id, role_id) VALUES ($1::uuid, $2::uuid)',
      [account.id, teacherRole.id],
    );
    await client.query('COMMIT');
    return { ...account, roleCode: 'TEACHER' };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') fail('Email 或測試帳號名稱已存在；未修改任何既有帳號。');
    throw error;
  }
}

async function revokeAccount({ runId, email, client }) {
  const normalizedEmail = normalizeEmail(email);
  const accountName = accountNameFor(runId, normalizedEmail);
  await client.query('BEGIN');
  try {
    const result = await client.query(
      `SELECT account.id
       FROM app.user_account AS account
       JOIN app.user_role AS assignment ON assignment.user_account_id = account.id
       JOIN app.role AS role ON role.id = assignment.role_id
       WHERE lower(account.email) = lower($1)
         AND account.account_name = $2
         AND role.role_code = 'TEACHER'
       FOR UPDATE`,
      [normalizedEmail, accountName],
    );
    if (result.rowCount !== 1) fail('找不到此 run 建立的精確 UI 測試帳號；未修改任何資料。');
    const accountId = result.rows[0].id;
    await client.query(
      `UPDATE app.login_session
       SET status = 'REVOKED'::app.login_session_status_e,
           revoked_at = COALESCE(revoked_at, now())
       WHERE user_account_id = $1::uuid
         AND status = 'ACTIVE'::app.login_session_status_e`,
      [accountId],
    );
    await client.query(
      `UPDATE app.user_account
       SET status = 'DISABLED'::app.user_status_e, updated_at = now()
       WHERE id = $1::uuid AND account_name = $2`,
      [accountId, accountName],
    );
    await client.query('COMMIT');
    return { email: normalizedEmail, disabled: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function withTarget(runId, requireEmpty, operation) {
  if (requireEmpty) await assertIntegrationReady(runId);
  else await assertTestTarget(runId);
  const { databaseUrl } = loadTarget(runId);
  const client = makeClient(databaseUrl);
  await client.connect();
  try {
    const identity = await client.query('SELECT current_database() AS db');
    if (identity.rows[0].db !== 'smartlearning_test') fail('目前連線資料庫身分不符；拒絕操作。');
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function main() {
  const [action, runId] = process.argv.slice(2);
  if (action === '--help' || action === 'help') {
    process.stdout.write('用法：node tools/test-db/ui-test-account.cjs <create|revoke> <run-id>\n');
    return;
  }
  if (!['create', 'revoke'].includes(action) || !runId) {
    fail('需要指定 create 或 revoke，以及明確的測試 DB run ID。');
  }
  if (action === 'create') {
    const input = await collectInput();
    const account = await withTarget(runId, true, (client) => provisionAccount({ ...input, runId, client }));
    process.stdout.write(`已建立本機測試帳號：${account.email}（角色 TEACHER，狀態 ACTIVE）。請使用剛才輸入的密碼登入 UI。\n`);
    process.stdout.write('帳密不會再次顯示；請勿將密碼貼入紀錄、工單或版本控制。\n');
    return;
  }
  const email = normalizeEmail(await promptLine('要停用的測試帳號 Email'));
  const confirmation = await promptLine('確認停用請輸入 DISABLE');
  if (confirmation !== 'DISABLE') fail('確認文字不符；未修改任何資料。');
  const result = await withTarget(runId, false, (client) => revokeAccount({ runId, email, client }));
  process.stdout.write(`已停用 ${result.email} 的本機測試帳號，並撤銷其有效登入 session。\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || '操作失敗。'}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  accountNameFor,
  normalizeEmail,
  validateName,
  validatePassword,
  provisionAccount,
  revokeAccount,
  withTarget,
};
