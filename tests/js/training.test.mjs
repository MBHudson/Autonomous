/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
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
  isTrainingActive, trainingStepList, trainingBlockFor, trainingKickoffFor, trainingResumeFor,
  shouldResumeDrill, reachedCleanTarget,
} = await import(`../../ui/js/training.js?v=${version}`);
const trainingModule = await import(`../../ui/js/training.js?v=${version}`);
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
// The drill ends on a display tool ON PURPOSE: show_file paints the result into
// the transcript and ends the turn, so a show step anywhere earlier would strand
// every step after it. Completion is recorded in the step just before it.
eq(TRAINING_TASKS[TRAINING_TASKS.length - 1].tool, 'show_file',
  'drill ends by showing its result, not by describing it');
eq(TRAINING_TASKS[TRAINING_TASKS.length - 2].tool, 'todo_write',
  'completion is recorded immediately before the final show');
ok(TRAINING_TASKS.some(t => t.label.includes(TRAINING_FILE)), 'drill creates training.txt');
ok(TRAINING_TASKS.filter(t => t.tool === 'edit_file').length >= 2,
  'drill edits twice with exact old_string/new_string replaces');
const appendStep = TRAINING_TASKS.find(t => t.tool === 'edit_file'
  && t.label.includes('drill 2 passed') && !t.label.includes('(exact match)'));
ok(!!appendStep && /old_string/.test(appendStep.label) && /new_string/.test(appendStep.label),
  'the add-a-line step teaches an anchored old_string/new_string replace, not a bare append');
ok(TRAINING_TASKS.some(t => t.tool === 'read_file' && /1-1/.test(t.label)),
  'drill teaches a ranged read so a big file is not pulled in whole');
// A display step ends the turn, and training mode resumes the drill -- so the
// family can be practiced mid-drill, not only as the last step.
const showSteps = TRAINING_TASKS.filter(t => t.tool.startsWith('show_'));
ok(showSteps.length >= 3, `drill practices several display tools (got ${showSteps.length})`);
ok(showSteps.some(t => t.tool === 'show_file'), 'show_file is practiced');
ok(showSteps.some(t => t.tool === 'show_find'), 'show_find is practiced');
ok(showSteps.some(t => t.tool === 'show_command'), 'show_command is practiced');
ok(!('TRAINING_RESUME_LIMIT' in trainingModule),
  'no resume budget is exported: the loop is closed and unbounded');
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
// The display family is taught by name even though only one is practiced, and
// the error-reading rule names the recoveries the sandbox returns.
for (const name of ['show_file', 'show_find', 'show_command', 'show_url']) {
  ok(block.includes(name), `block teaches ${name}`);
}
ok(block.includes('END the turn'), 'block says a display call ends the turn');
ok(block.includes('never lets the drill stop'), 'block says the loop never stops on its own');
ok(block.includes('start a fresh pass at step 1'), 'block says a completed drill starts another pass');
ok(block.includes('Continue'), 'block names the Continue message the app sends');
ok(block.includes('Did you mean'), 'block tells the agent to fix the argument an error names');
ok(block.includes('relative to the sandbox'), 'block states the path rule');

// The continued turn is a bare "Continue": the drill is already in the prompt,
// and a paragraph repeated every few seconds is context paid for every turn.
eq(trainingResumeFor(), 'Continue', 'with nothing recorded, the continued turn is exactly Continue');
const resumed = trainingResumeFor({ a: { name: 'Scout', step: 15, totalSteps: 17, complete: false } });
ok(resumed.includes('step 16') && resumed.includes('todo_write'),
  'the resume names the recorded next step');
ok(/do not restart/i.test(resumed), 'the resume forbids restarting the pass');
const restarted = trainingResumeFor({ a: { name: 'Scout', step: 17, totalSteps: 17, complete: true } });
ok(restarted.includes('fresh pass'), 'a completed pass resumes into a fresh one');

// --- the clean-pass stopping rule -------------------------------------------
eq(reachedCleanTarget({ cleanPassTarget: 0 }, { a: { cleanPasses: 5 } }), null,
  '0 never stops on its own');
const targetHit = reachedCleanTarget({ cleanPassTarget: 2 },
  { a: { name: 'Scout', cleanPasses: 1 }, b: { name: 'Coder', cleanPasses: 2 } });
ok(!!targetHit && targetHit.name === 'Coder', 'the first agent at the target ends the run');
eq(reachedCleanTarget({ cleanPassTarget: 2 }, { a: { cleanPasses: 1 } }), null,
  'below the target keeps running');

// --- the resume decision (chat.js asks this after EVERY finished turn) -------
eq(shouldResumeDrill({ active: true }), true, 'an armed mode continues every turn');
eq(shouldResumeDrill({ active: false }), false, 'a disarmed mode never continues');
eq(shouldResumeDrill({}), false, 'no mode, no resume');
eq(shouldResumeDrill({ active: true, drillResumes: 999 }), true,
  'a resume count never ends the loop');
eq(shouldResumeDrill({ active: true, drillResumes: 9999, drillFails: 9 }), true,
  'failures never end the loop either - they only slow it down');

// The Start dispatch: self-contained, so a fresh turn AND a steered in-flight
// turn both get the drill even though only the fresh turn carries the block.
const kickoff = trainingKickoffFor();
ok(typeof kickoff === 'string' && kickoff.length > 200, 'kickoff is a full instruction');
ok(kickoff.includes('Training mode is ON'), 'kickoff announces the mode');
ok(kickoff.includes(TRAINING_DIR), 'kickoff names the drill folder');
ok(kickoff.includes('retried until it passes'), 'kickoff carries the retry rule');
ok(kickoff.includes('approval'), 'kickoff warns about approval pauses');
for (const t of TRAINING_TASKS) ok(kickoff.includes(t.tool), `kickoff lists ${t.tool}`);

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
