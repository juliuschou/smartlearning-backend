'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
async function exercise(mode) {
  const commands = [];
  const output = [];
  const password = "pa'ss;word";
  const proc = { env: { RESTORE_ID: 'a'.repeat(64), PATH: '/usr/bin' } };
  class Client {
    constructor(options) { assert.equal(options.password, password + '-deliberately-invalid'); }
    async connect() { if (mode !== 'accepted-wrong-password') throw { code: '28P01' }; }
    async end() {}
  }
  const req = name => {
    if (name === 'node:fs') return { lstatSync: () => ({ isSymbolicLink: () => false }),
      statSync: () => ({ mode: 0o100600 }), readFileSync: () => '' };
    if (name === 'node:module') return { createRequire: () => key => key === 'pg' ? { Client } : {
      parse: () => ({ DATABASE_URL: `postgresql://restricted:${encodeURIComponent(password)}@localhost:5432/smartlearning_test?schema=public`,
        COOKIE_SECRET: 'offline', CORS_ORIGIN: 'http://localhost', PORT: '3001' }),
    } };
    if (name === 'node:child_process') return { spawnSync: (program, args, options) => {
      assert.equal(args.some(value => value.includes(password)), false);
      if (program === 'docker') commands.push({ args, input: options.input });
      return { status: mode === 'identity' && program === 'python3' ? 1 : 0 };
    } };
    return require(name);
  };
  const context = vm.createContext({ require: req, __dirname, process: proc, URL,
    setTimeout: callback => callback(), console: { log: value => output.push(value), error: value => output.push(value) } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'cold-rebuild-credentials.cjs'), 'utf8')
    .replace('main().catch(() => {', 'globalThis.finished = main().catch(() => {'), context);
  await context.finished;
  assert.equal(output.join('').includes(password), false);
  return { commands, output: output.join('\n'), exitCode: proc.exitCode };
}
test('private stdin escapes password and enforces SCRAM + negative auth', async () => {
  const result = await exercise();
  assert.match(result.commands[0].input, /PASSWORD 'pa''ss;word'/);
  assert.ok(result.commands.some(command => command.args.includes('/^host /s/ trust$/ scram-sha-256/')));
  assert.equal(result.exitCode, undefined);
  assert.match(result.output, /SCRAM_RECOVERY_PASS/);
});
test('wrong password accepted is a hard failure', async () => {
  const result = await exercise('accepted-wrong-password');
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.output, /SCRAM_RECOVERY_PASS/);
});
test('unverified identity prevents credential write', async () => {
  const result = await exercise('identity');
  assert.equal(result.commands.length, 0);
  assert.equal(result.exitCode, 1);
});
