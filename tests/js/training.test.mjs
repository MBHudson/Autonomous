/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// Training-mode drill tests.
//
// Usage: node tests/js/training.test.mjs
//
// Covers the drill table and the armed/disarmed prompt block. The governor
// halving is exercised through limitsFor with a settings flip. No network.
// Exits 0 on success, 1 on failure.
//
// The `?v=` is read from store.js rather than written here, because the
// cache-buster moves on every UI release: a hardcoded copy silently splits
// this test from the modules under test the first time it moves (the armed
// assertions fail while nothing at all is wrong with the code). Same lesson
// commsLog.test.mjs learned first.
import { readFileSync } from 'node:fs';
const version = /APP_VERSION\s*=\s*(\d+)/.exec(
  readFileSync(new URL('../../ui/js/store.js', import.meta.url), 'utf8'),
)?.[1];
if (!version) {
  console.error('Training mode tests\n' + '-'.repeat(60));
  console.error('Cannot read APP_VERSION from ui/js/store.js.');
  process.exit(1);
}
const {
  TRAINING_THROTTLE, TRAINING_DIR, TRAINING_FILE, TRAINING_TASKS,
  isTrainingActive, trainingStepList, trainingBlockFor,
} = await import(`../../ui/js/training.js?v=${version}`);
const { store } = await import(`../../ui/js/store.js?v=${version}`);
const { limitsFor } = await import(`../../ui/js/rateGovernor.js?v=${version}`);

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('Training mode tests');
console.log('-'.repeat(60));

// The throttle is the documented half rate.
eq(TRAINING_THROTTLE, 0.5, 'throttle is 50%');

// The drill lives in one sandbox folder and names it.
ok(TRAINING_TASKS.length >= 10, `drill has a full tool list (got ${TRAINING_TASKS.length})`);
ok(TRAINING_TASKS.every(t => t.tool && t.label), 'every step names a tool and a task');
eq(TRAINING_TASKS[0].tool, 'think', 'drill starts free (no approval gate)');
eq(TRAINING_TASKS[TRAINING_TASKS.length - 1].tool, 'todo_write', 'drill ends by recording completion');
ok(TRAINING_TASKS.some(t => t.label.includes(TRAINING_FILE)), 'drill creates training.txt');
ok(TRAINING_DIR === 'training' && TRAINING_FILE === 'training/training.txt', 'drill folder/file constants');
eq(trainingStepList().length, TRAINING_TASKS.length, 'step list covers every task');
ok(trainingStepList()[0].startsWith('1. think'), 'step list is numbered from 1');

// Disarmed by default: the prompt block injects nothing.
store.set('settings.trainingMode', { active: false, startedAt: 0 });
eq(isTrainingActive(), false, 'off by default');
eq(trainingBlockFor(), '', 'no prompt block while off');

// Armed: one retry-until-pass block heading the prompt.
store.set('settings.trainingMode', { active: true, startedAt: 1 });
eq(isTrainingActive(), true, 'armed flag reads back');
const block = trainingBlockFor();
ok(block.includes('TRAINING MODE'), 'block names the mode');
ok(block.includes('TRY AGAIN'), 'block orders retries on failure');
ok(block.includes('never skip'), 'block forbids skipping failed steps');
ok(block.includes(TRAINING_FILE), 'block names the drill file');
for (const t of TRAINING_TASKS) ok(block.includes(t.tool), `block lists ${t.tool}`);

// Armed: the governor halves the ceiling on the no-agent path.
const ENDPOINT = 'https://unknown.example/v1/chat/completions';
store.set('settings.trainingMode', { active: false, startedAt: 0 });
const plain = limitsFor(ENDPOINT, 'k-off');
const off = limitsFor(ENDPOINT, 'k-half-check');
store.set('settings.trainingMode', { active: true, startedAt: 1 });
const on = limitsFor(ENDPOINT, 'k-half-check');
eq(on.rpm, Math.max(1, Math.floor(off.rpm * TRAINING_THROTTLE)), 'armed ceiling is ~50% of disarmed');
ok(off.rpm > 0 && plain.rpm === off.rpm, 'disarmed ceiling is untouched');
store.set('settings.trainingMode', { active: false, startedAt: 0 });

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
for (const e of errors) console.log('  ' + e);
process.exit(fail ? 1 : 0);
