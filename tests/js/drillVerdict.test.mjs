/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// Training-drill verdict tests.
//
// Usage: node tests/js/drillVerdict.test.mjs
//
// The verdict answers "did this agent pass every drill step, and did it do so
// without a failed attempt?" from the tool records alone. Nothing here trusts
// the agent's todo list, so these tests construct the records by hand.
//
// The ?v= is read from store.js, like the other suites: a hardcoded copy splits
// the test from the modules the first time the cache-buster moves.

import { readFileSync } from 'node:fs';
const version = /APP_VERSION\s*=\s*(\d+)/.exec(
  readFileSync(new URL('../../ui/js/store.js', import.meta.url), 'utf8'),
)?.[1];
if (!version) {
  console.error('Drill verdict tests\n' + '-'.repeat(60));
  console.error('Cannot read APP_VERSION from ui/js/store.js.');
  process.exit(1);
}
const { TRAINING_TASKS, DRILL_CHECKS, drillVerdict, drillVerdictText } =
  await import(`../../ui/js/training.js?v=${version}`);

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('Drill verdict tests');
console.log('-'.repeat(60));

/** One tool record, shaped like the ones chat.js logs. */
const call = (tool, arg, status, result) => ({ tool, arg, status, result, ms: 1 });

/** One clean pass in drill order. */
const cleanPass = () => [
  call('think', { note: 'start' }, 'ok', 'thinking'),
  call('todo_write', { todos: [] }, 'ok', 'updated'),
  call('echo', { text: 'training' }, 'ok', 'training'),
  call('now', {}, 'ok', '2026-11-12 12:00'),
  call('write_file', { path: 'training/training.txt', content: 'training' }, 'ok', 'wrote 8 bytes'),
  call('read_file', { path: 'training/training.txt' }, 'ok', '1  training'),
  call('read_file', { path: 'training/training.txt', range: '1-1' }, 'ok', '1  training'),
  call('edit_file', { path: 'training/training.txt', old_string: 'training', new_string: 'training\ndrill 2 passed' }, 'ok', 'replaced 1'),
  call('edit_file', { path: 'training/training.txt', old_string: 'drill 2 passed', new_string: 'drill 2 passed (exact match)' }, 'ok', 'replaced 1'),
  call('list_dir', { path: 'training' }, 'ok', 'training.txt  21 bytes'),
  call('glob_files', { pattern: 'training/*' }, 'ok', 'training/training.txt'),
  call('grep_code', { pattern: 'training' }, 'ok', 'training/training.txt:1:training'),
  call('show_find', { pattern: 'training' }, 'ok', 'training/training.txt:1:training'),
  call('exec', { argv: ['echo', 'training'] }, 'ok', 'training'),
  call('show_command', { argv: ['echo', 'training'] }, 'ok', '$ echo training\n\ntraining'),
  call('todo_write', { todos: [] }, 'ok', 'complete'),
  call('show_file', { path: 'training/training.txt' }, 'ok', '1  training\n2  drill 2 passed'),
];

// The table and its checks stay aligned; a new step without a check is a gap
// the verdict would silently grade as "ok is enough".
eq(DRILL_CHECKS.length, TRAINING_TASKS.length, 'every drill step has a check slot');

// A pass that went through cleanly.
{
  const v = drillVerdict(cleanPass());
  eq(v.complete, true, 'a full pass reads complete');
  eq(v.clean, true, 'a pass with no failures reads clean');
  eq(v.step, TRAINING_TASKS.length, 'every step is counted');
  eq(v.passes, 1, 'one completed pass');
  eq(v.failures, 0, 'no failed attempts');
  eq(v.retries, 0, 'no retries');
  eq(v.pending, false, 'nothing waiting on an approval');
  eq(v.cleanPasses, 1, 'a clean pass counts toward the stopping rule');
}

// Clean passes are counted separately from completed ones.
{
  const dirty = cleanPass();
  dirty.splice(2, 0, call('echo', { text: 'training' }, 'error', 'error: relay refused'));
  const v = drillVerdict(dirty.concat(cleanPass()));
  eq(v.passes, 2, 'both passes completed');
  eq(v.cleanPasses, 1, 'only the pass without failures is clean');
  eq(drillVerdict(cleanPass().concat(cleanPass())).cleanPasses, 2, 'two clean passes count as two');
}

// An identical call repeated after an error is both a failure and a retry.
{
  const calls = cleanPass();
  calls.splice(5, 1,
    call('read_file', { path: 'training/training.txt' }, 'error', 'error: no such file'),
    call('read_file', { path: 'training/training.txt' }, 'error', 'error: no such file'),
    call('read_file', { path: 'training/training.txt' }, 'ok', '1  training'),
  );
  const v = drillVerdict(calls);
  eq(v.complete, true, 'a retried step still finishes the pass');
  eq(v.clean, false, 'a retried step makes the pass not clean');
  eq(v.failures, 2, 'both failed attempts are counted');
  eq(v.retries, 1, 'the identical repeat is a retry');
  eq(v.failedAt, 6, 'the failing step is named');
}

// A corrected attempt is a failure but NOT a literal retry: different args.
{
  const calls = cleanPass();
  calls.splice(5, 1,
    call('read_file', { path: 'training/typo.txt' }, 'error', 'error: no such file'),
    call('read_file', { path: 'training/training.txt' }, 'ok', '1  training'),
  );
  const v = drillVerdict(calls);
  eq(v.complete, true, 'the corrected step still passes');
  eq(v.failures, 1, 'the wrong-argument attempt is a failure');
  eq(v.retries, 0, 'different arguments are not a literal retry');
  eq(v.clean, false, 'a corrected step is not a clean step');
}

// A skipped call proves nothing and is not a failure.
{
  const calls = cleanPass();
  calls.splice(5, 0, call('read_file', { path: 'training/training.txt' }, 'skipped', 'Skipped: this step ended by showing output.'));
  const v = drillVerdict(calls);
  eq(v.complete, true, 'a skipped sibling does not block the pass');
  eq(v.clean, true, 'skipped is not a failure');
  eq(v.failures, 0, 'skipped is not counted as failed');
}

// A waiting approval stalls the step: the drill has not passed it.
{
  const calls = cleanPass().slice(0, 5);
  calls.push(call('read_file', { path: 'training/training.txt' }, 'pending', 'Waiting for your approval.'));
  const v = drillVerdict(calls);
  eq(v.complete, false, 'a pending approval is not a passed step');
  eq(v.step, 5, 'the pass stops at the waiting step');
  eq(v.pending, true, 'the verdict reports the wait');
  eq(v.clean, false, 'an unfinished pass is never clean');
}

// A call that is not this step cannot pass it: a full read is not the ranged
// read, and writing the wrong content is not the write step.
{
  const calls = cleanPass().slice(0, 6);
  calls.push(call('read_file', { path: 'training/training.txt' }, 'ok', '1  training'));
  const v = drillVerdict(calls);
  eq(v.step, 6, 'a full read does not satisfy the ranged-read step');

  const wrongWrite = cleanPass().slice(0, 4);
  wrongWrite.push(call('write_file', { path: 'training/training.txt', content: 'something else' }, 'ok', 'wrote 14 bytes'));
  eq(drillVerdict(wrongWrite).step, 4, 'writing the wrong content does not pass the write step');
}

// A model that lost its place shows as off-step, not as a silent stall.
{
  const calls = cleanPass().slice(0, 15);
  calls.push(call('think', { note: 'restart' }, 'ok', 'thinking'));
  const v = drillVerdict(calls);
  eq(v.step, 15, 'an off-step call does not advance the pass');
  eq(v.offStep, 1, 'the off-step call is counted');
  eq(v.offTool, 'think', 'the off-step tool is named');
  eq(v.nextTool, 'todo_write', 'the expected tool is reported');
  ok(drillVerdictText(v).includes('waiting for todo_write'), 'the stall is named in the strip text');
  const back = drillVerdict(calls.concat([call('todo_write', { todos: [] }, 'ok', 'updated')]));
  eq(back.step, 16, 'the step still passes once it is attempted');
  eq(back.offStep, 0, 'progress clears the off-step signal');
}

// The right tool with the wrong arguments is a failed attempt, not silence.
{
  const calls = cleanPass().slice(0, 6);
  calls.push(call('read_file', { path: 'training/training.txt' }, 'ok', '1  training'));
  const v = drillVerdict(calls);
  eq(v.failures, 1, 'a wrong-argument attempt is a failure');
  eq(v.failedAt, 7, 'it names the step it happened on');
  eq(v.step, 6, 'it does not advance');
}

// A pass in progress is not a second completed pass, and the judgement still
// describes the finished one.
{
  const calls = cleanPass().concat(cleanPass().slice(0, 3));
  const v = drillVerdict(calls);
  eq(v.passes, 1, 'only completed passes are counted');
  eq(v.complete, false, 'the pass in progress is not complete');
  eq(v.step, 3, 'progress is reported for the pass in progress');
  eq(v.clean, true, 'the judgement still describes the finished pass');
}

// A run with a dirty first pass and a clean second one is clean: the verdict
// follows the LATEST completed pass, not the worst one.
{
  // First pass: the echo step failed once, then passed. Dirty, but complete.
  const first = cleanPass();
  first.splice(2, 0, call('echo', { text: 'training' }, 'error', 'error: relay refused'));
  const second = cleanPass();
  const v = drillVerdict(first.concat(second));
  eq(v.passes, 2, 'two passes seen');
  eq(v.clean, true, 'the latest completed pass decides clean');
}

// An empty or unknown log grades as nothing, not as a pass.
{
  const v = drillVerdict([]);
  eq(v.complete, false, 'no calls, no pass');
  eq(v.step, 0, 'no calls, no progress');
  eq(v.clean, false, 'no calls is not clean');
  eq(drillVerdict(null).step, 0, 'a missing log is handled');
}

// --- the one-line form the strip and the dialog both render ------------------
eq(drillVerdictText(drillVerdict(cleanPass())), '17/17 \u00b7 clean \u00b7 1 pass',
  'a clean pass reads step count, clean and passes');
{
  const v = drillVerdict(cleanPass().slice(0, 5));
  eq(drillVerdictText(v), '5/17', 'a partial pass reads only its progress');
}
{
  const calls = cleanPass().slice(0, 5);
  calls.push(call('read_file', { path: 'training/typo.txt' }, 'error', 'error: no such file'));
  eq(drillVerdictText(drillVerdict(calls)), '5/17 \u00b7 1 failed at step 6',
    'a failure names the step it happened on');
}
eq(drillVerdictText(null), '', 'no verdict renders nothing');

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
for (const e of errors) console.log('  ' + e);
process.exit(fail ? 1 : 0);
