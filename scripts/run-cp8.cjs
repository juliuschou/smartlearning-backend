#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const phases = [
  {
    name: 'static',
    command: 'npm',
    args: ['run', 'test:cp8:static', '--', '--runInBand'],
  },
  {
    name: 'e2e',
    command: 'npm',
    args: [
      'run',
      'test:e2e',
      '--',
      '--runInBand',
      'test/live-session-realtime.e2e-spec.ts',
      'test/live-session-route-matrix.e2e-spec.ts',
      'test/quiz-live-flow.e2e-spec.ts',
      'test/live-session-close-cancel.e2e-spec.ts',
      'test/cp3-terminal-state.e2e-spec.ts',
    ],
  },
  {
    name: 'integration',
    command: 'npm',
    args: [
      'run',
      'test:integration',
      '--',
      '--runInBand',
      'test/poll-submission.integration-spec.ts',
      'test/live-session-auto-close.integration-spec.ts',
      'test/terminal-matrix.integration-spec.ts',
      'test/question-cascade.integration-spec.ts',
    ],
  },
];

function timestamp() {
  return new Date().toISOString();
}

for (const phase of phases) {
  const command = `${phase.command} ${phase.args.join(' ')}`;
  console.log(`[CP8 ${timestamp()}] START ${phase.name}: ${command}`);
  const result = spawnSync(phase.command, phase.args, {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
  });

  if (result.error) {
    console.error(
      `[CP8 ${timestamp()}] FAIL ${phase.name}: ${result.error.message}`,
    );
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(
      `[CP8 ${timestamp()}] FAIL ${phase.name}: exit=${result.status}`,
    );
    process.exit(result.status ?? 1);
  }

  console.log(`[CP8 ${timestamp()}] PASS ${phase.name}`);
}

console.log(`[CP8 ${timestamp()}] PASS all phases`);
