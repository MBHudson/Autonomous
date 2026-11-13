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
  TRAINING_THROTTLE, TRAINING_DIR, TRAINING_FILE, TRAINING_FILE_TOKEN, TRAINING_TASKS, TRAINING_TASKS_EASY,
  TRAINING_TASKS_ADVANCED, TRAINING_TASKS_FRONTIER, TRAINING_TASKS_BROWSER, DRILL_CHECKS_ADVANCED,
  DRILL_CHECKS_FRONTIER, DRILL_CHECKS_BROWSER, TRAINING_BROWSER_TOKEN,
  trainingFileFor, isTrainingActive, trainingStepList, trainingBlockFor, trainingKickoffFor, trainingResumeFor,
  shouldResumeDrill, reachedCleanTarget, drillStripTitle, trainingDifficulty, trainingTasksFor, trainingChecksFor, showsEveryPass,
  trainingDifficultyLabel, trainingDifficultyHint, drillVerdict, normalizeCustomSteps, CUSTOM_STEP_MAX,
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
ok(TRAINING_TASKS.some(t => t.label.includes(TRAINING_FILE_TOKEN)), 'drill creates the agent\'s own training file');
ok(TRAINING_TASKS.filter(t => t.tool === 'edit_file').length >= 2,
  'drill edits twice with exact old_string/new_string replaces');
const appendStep = TRAINING_TASKS.find(t => t.tool === 'edit_file'
  && t.label.includes('drill 2 passed') && !t.label.includes('(exact match)'));
ok(!!appendStep && /old_string/.test(appendStep.label) && /new_string/.test(appendStep.label),
  'the add-a-line step teaches an anchored old_string/new_string replace, not a bare append');
ok(TRAINING_TASKS.some(t => t.tool === 'read_file' && /1-1/.test(t.label)),
  'drill teaches a ranged read so a big file is not pulled in whole');
ok(TRAINING_TASKS.filter(t => t.tool === 'read_file').every(t => /not show_file/.test(t.label)),
  'read steps say read_file, not show_file');
ok(TRAINING_TASKS.filter(t => t.tool === 'edit_file').every(t =>
  /not write_file/.test(t.label) && /str_replace_editor/.test(t.label)),
  'edit steps rule out write_file and str_replace_editor');
ok(/not read_file/.test(TRAINING_TASKS[TRAINING_TASKS.length - 1].label),
  'the final show_file step rules out read_file');
// A display step ends the turn, and training mode resumes the drill -- so the
// family can be practiced mid-drill, not only as the last step.
const showSteps = TRAINING_TASKS.filter(t => t.tool.startsWith('show_'));
ok(showSteps.length >= 3, `drill practices several display tools (got ${showSteps.length})`);
ok(showSteps.some(t => t.tool === 'show_file'), 'show_file is practiced');
ok(showSteps.some(t => t.tool === 'show_find'), 'show_find is practiced');
ok(showSteps.some(t => t.tool === 'show_command'), 'show_command is practiced');
ok(!('TRAINING_RESUME_LIMIT' in trainingModule),
  'no resume budget is exported: the loop is closed and unbounded');
ok(TRAINING_DIR === 'training' && TRAINING_FILE === 'training/training.txt', 'drill folder/default file constants');
eq(trainingFileFor({ id: 'agent_abc123' }), 'training/training-agent-abc123.txt', 'an agent gets a file named after its id');
ok(trainingFileFor({ id: 'agent_a' }) !== trainingFileFor({ id: 'agent_b' }),
  'two agents never share one drill file');
eq(trainingStepList().length, TRAINING_TASKS.length, 'step list covers every task');
ok(trainingStepList()[0].startsWith('1. think'), 'step list is numbered from 1');

// Easy mode is the original 12-step sequence, kept beside the current drill.
eq(TRAINING_TASKS_EASY.length, 12, 'easy mode has the original 12 steps');
eq(TRAINING_TASKS_EASY[TRAINING_TASKS_EASY.length - 1].tool, 'todo_write',
  'easy mode ends on the original completion step');
ok(TRAINING_TASKS_EASY.some(t => t.tool === 'edit_file' && t.label.includes('Append a second line')),
  'easy mode keeps the old append wording that step 7 is meant to diagnose');
ok(!TRAINING_TASKS_EASY.some(t => t.tool.startsWith('show_')),
  'easy mode has no display-tool steps');
eq(trainingTasksFor('easy'), TRAINING_TASKS_EASY, 'easy selects the 12-step table');
eq(trainingTasksFor('hard'), TRAINING_TASKS, 'hard selects the current table');
eq(trainingDifficulty({}), 'hard', 'a missing difficulty defaults to hard');
eq(trainingDifficulty({ difficulty: 'easy' }), 'easy', 'easy reads back');
eq(trainingDifficulty({ difficulty: 'advanced' }), 'advanced', 'advanced reads back');
eq(trainingDifficulty({ difficulty: 'frontier' }), 'frontier', 'frontier reads back');
eq(trainingDifficulty({ difficulty: 'custom' }), 'custom', 'custom reads back');
eq(trainingDifficulty({ difficulty: 'nonsense' }), 'hard', 'an unknown difficulty falls back to hard');
eq(trainingChecksFor('easy').length, 12, 'easy checks align with its 12 steps');
eq(trainingChecksFor('hard').length, TRAINING_TASKS.length, 'hard checks align with its steps');
eq(trainingStepList(null, 'easy').length, 12, 'the dialog can list the easy steps');
eq(trainingStepList(null, 'hard').length, 17, 'the dialog can list the hard steps');

// Advanced is the fetch → save → show pipeline behind "show_url URL > log.txt".
eq(TRAINING_TASKS_ADVANCED.length, 8, 'advanced mode has 8 steps');
ok(TRAINING_TASKS_ADVANCED.some(t => t.tool === 'fetch_url' && t.label.includes('example.com')),
  'advanced fetches a page with fetch_url');
ok(TRAINING_TASKS_ADVANCED.some(t => t.tool === 'write_file' && t.label.includes('{file}')),
  'advanced saves the fetched page to the agent log file');
ok(TRAINING_TASKS_ADVANCED.some(t => t.label.includes('cannot redirect')),
  'advanced explains that show_url cannot redirect into a file');
ok(TRAINING_TASKS_ADVANCED.some(t => t.tool === 'show_file'), 'advanced shows the saved copy');
eq(trainingTasksFor('advanced'), TRAINING_TASKS_ADVANCED, 'advanced selects its own table');
eq(trainingChecksFor('advanced'), DRILL_CHECKS_ADVANCED, 'advanced selects its own checks');
eq(trainingFileFor({ id: 'agent_adv' }, 'advanced'), 'training/advanced-agent-adv.txt',
  'advanced gets its own per-agent log file');
eq(trainingFileFor({ id: 'agent_adv' }), 'training/training-agent-adv.txt',
  'the default file stays the hard drill file');
eq(trainingStepList(null, 'advanced').length, 8, 'the dialog can list the advanced steps');

// Frontier is the real-desktop Notepad demo.
eq(TRAINING_TASKS_FRONTIER.length, 6, 'frontier mode has 6 steps');
for (const name of ['window_list', 'window_open', 'window_type']) {
  ok(TRAINING_TASKS_FRONTIER.some(t => t.tool === name), `frontier uses ${name}`);
}
ok(TRAINING_TASKS_FRONTIER.some(t => t.tool === 'window_open' && /notepad/i.test(t.label)),
  'frontier opens Notepad');
ok(TRAINING_TASKS_FRONTIER.some(t => t.tool === 'window_type' && /Hello!/.test(t.label)),
  'frontier types Hello!');
eq(trainingTasksFor('frontier'), TRAINING_TASKS_FRONTIER, 'frontier selects its own table');
eq(trainingChecksFor('frontier'), DRILL_CHECKS_FRONTIER, 'frontier selects its own checks');
eq(trainingStepList(null, 'frontier').length, 6, 'the dialog can list the frontier steps');
eq(trainingDifficultyLabel('custom'), 'Custom', 'custom has a display name');
ok(trainingDifficultyHint('custom').includes('saved'), 'custom hint points at the saved steps');
eq(trainingDifficultyLabel('advanced'), 'Advanced', 'advanced has a display name');
eq(trainingDifficultyLabel('frontier'), 'Frontier', 'frontier has a display name');
ok(trainingDifficultyHint('advanced').includes('fetch_url'), 'advanced hint names fetch_url');
ok(trainingDifficultyHint('frontier').includes('Notepad'), 'frontier hint names Notepad');

// Browser is a separate, local-page drill rather than a longer Frontier.
eq(TRAINING_TASKS_BROWSER.length, 9, 'browser mode has 9 steps');
for (const name of ['browser_open', 'browser_read', 'browser_type', 'browser_click', 'browser_wait']) {
  ok(TRAINING_TASKS_BROWSER.some(t => t.tool === name), `browser drill uses ${name}`);
}
ok(TRAINING_TASKS_BROWSER.some(t => t.tool === 'browser_open' && t.label.includes(TRAINING_BROWSER_TOKEN)),
  'browser drill opens the local page placeholder');
ok(TRAINING_TASKS_BROWSER.some(t => t.tool === 'browser_type' && /#drill-name/.test(t.label) && /training/.test(t.label)),
  'browser drill types into the documented field');
ok(TRAINING_TASKS_BROWSER.some(t => t.tool === 'browser_click' && /#drill-submit/.test(t.label)),
  'browser drill clicks the documented button');
eq(trainingTasksFor('browser'), TRAINING_TASKS_BROWSER, 'browser selects its own table');
eq(trainingChecksFor('browser'), DRILL_CHECKS_BROWSER, 'browser selects its own checks');
eq(trainingDifficulty({ difficulty: 'browser' }), 'browser', 'browser difficulty reads back');
eq(trainingDifficultyLabel('browser'), 'Browser', 'browser has a display name');
ok(trainingDifficultyHint('browser').includes('local-page'), 'browser hint names its local page');
ok(trainingDifficultyHint('browser').includes('Labs → Browser'), 'browser hint states the Labs prerequisite');
eq(trainingStepList(null, 'browser').length, 9, 'the dialog can list the browser steps');
ok(trainingStepList(null, 'browser')[2].includes('browser.html'),
  'the browser step list resolves the local page URL');

// Disarmed by default: the prompt block injects nothing.
store.set('settings.trainingMode', { active: false, startedAt: 0 });
eq(isTrainingActive(), false, 'off by default');
eq(trainingBlockFor(), '', 'no prompt block while off');

// Armed: one retry-until-pass block heading the prompt.
store.set('settings.trainingMode', { active: true, startedAt: 1 });
eq(isTrainingActive(), true, 'armed flag reads back');
const drillFile = trainingFileFor({ id: 'agent_test' });
const block = trainingBlockFor({ id: 'agent_test' });
ok(block.includes('TRAINING MODE'), 'block names the mode');
ok(block.includes('TRY AGAIN'), 'block orders retries on failure');
ok(block.includes('never skip'), 'block forbids skipping failed steps');
ok(block.includes(drillFile), 'block names this agent\'s drill file');
ok(block.includes('OWN drill file'), 'block forbids touching another agent\'s file');
ok(trainingBlockFor({ id: 'agent_other' }).includes(trainingFileFor({ id: 'agent_other' })),
  'each agent\'s block names its own file');
ok(trainingStepList().some(s => s.includes('training/training-<agent>.txt')),
  'the operator-facing step list stays generic across agents');
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

// Easy gets the old drill's rules: no anchored-edit contract, and step 7 is
// still the old append instruction. The harness rules (paths, Continue) stay.
store.set('settings.trainingMode', { active: true, startedAt: 2, difficulty: 'easy' });
store.set('trainingVerdicts', {});

// --- complete synthetic passes for the new tables ---------------------------
const advFile = trainingFileFor({ id: 'agent_test' }, 'advanced');
const advancedCalls = [
  { tool: 'think', arg: 'plan', status: 'ok' },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
  { tool: 'fetch_url', arg: { url: 'https://example.com/' }, status: 'ok', result: 'URL: https://example.com/ (HTTP 200)\n\nExample Domain' },
  { tool: 'write_file', arg: { path: advFile, content: '<title>Example Domain</title>' }, status: 'ok' },
  { tool: 'read_file', arg: { path: advFile }, status: 'ok', result: '<title>Example Domain</title>' },
  { tool: 'show_url', arg: { url: 'https://example.com/' }, status: 'ok', result: 'Example Domain' },
  { tool: 'show_file', arg: { path: advFile }, status: 'ok', result: '<title>Example Domain</title>' },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
];
const advancedVerdict = drillVerdict(advancedCalls, advFile, 'advanced');
ok(advancedVerdict.complete && advancedVerdict.clean,
  'a complete advanced pass grades clean');
eq(advancedVerdict.totalSteps, 8, 'advanced verdict uses the 8-step table');

const frontierCalls = [
  { tool: 'think', arg: 'plan', status: 'ok' },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
  { tool: 'window_list', arg: {}, status: 'ok', result: 'Desktop programs: notepad - C:/Windows/System32/notepad.exe | running' },
  { tool: 'window_open', arg: { name: 'notepad' }, status: 'ok' },
  { tool: 'window_type', arg: { name: 'notepad', text: 'Hello!' }, status: 'ok' },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
];
const frontierVerdict = drillVerdict(frontierCalls, TRAINING_FILE, 'frontier');
ok(frontierVerdict.complete && frontierVerdict.clean,
  'a complete frontier pass grades clean');
eq(frontierVerdict.totalSteps, 6, 'frontier verdict uses the 6-step table');

const browserCalls = [
  { tool: 'think', arg: 'plan', status: 'ok' },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
  { tool: 'browser_open', arg: { url: 'http://127.0.0.1:8080/router/ui/drill/browser.html' }, status: 'ok', result: 'Opened http://127.0.0.1:8080/router/ui/drill/browser.html — Browser drill' },
  { tool: 'browser_read', arg: {}, status: 'ok', result: 'Browser drill\nYour name\nSay hello\nWaiting for a name.' },
  { tool: 'browser_type', arg: { selector: '#drill-name', text: 'training' }, status: 'ok', result: 'Typed 8 character(s)' },
  { tool: 'browser_click', arg: { selector: '#drill-submit' }, status: 'ok', result: 'Clicked #drill-submit' },
  { tool: 'browser_wait', arg: { ms: 300 }, status: 'ok', result: 'Waited 300ms' },
  { tool: 'browser_read', arg: {}, status: 'ok', result: 'Browser drill\nYour name\ntraining\nSay hello\nHello, training.' },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
];
const browserVerdict = drillVerdict(browserCalls, TRAINING_FILE, 'browser');
ok(browserVerdict.complete && browserVerdict.clean,
  'a complete browser pass grades clean');
eq(browserVerdict.totalSteps, 9, 'browser verdict uses the 9-step table');

// The completion summary needs the whole run, not just the live pass: a
// corrected step 5 in pass one, then a clean pass two.
const failedFrontierPass = [
  { tool: 'think', arg: 'plan', status: 'ok' },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
  { tool: 'window_list', arg: {}, status: 'ok', result: 'notepad | running' },
  { tool: 'window_open', arg: { name: 'notepad' }, status: 'ok' },
  { tool: 'window_type', arg: { name: 'notepad', text: 'Hello!' }, status: 'error', result: 'nothing to type into' },
  { tool: 'window_type', arg: { name: 'notepad', text: 'Hello!' }, status: 'ok' },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
];
const runVerdict = drillVerdict(failedFrontierPass.concat(frontierCalls), TRAINING_FILE, 'frontier');
eq(runVerdict.passes, 2, 'the run counts both completed passes');
eq(runVerdict.cleanPasses, 1, 'the run counts its clean pass');
eq(runVerdict.failuresTotal, 1, 'the run counts failures across passes');
eq(runVerdict.failureCounts['5'], 1, 'the run remembers which step failed');
const easyBlock = trainingBlockFor({ id: 'agent_test' });
ok(easyBlock.includes('Append a second line'), 'easy block keeps the old append step');
ok(easyBlock.includes('12-step pass'), 'easy block names the 12-step pass');
ok(!easyBlock.includes('never an append'), 'easy block has no anchored-edit contract');
ok(!easyBlock.includes('17. show_file:'), 'easy block never lists the 17-step ending');
ok(easyBlock.includes(drillFile), 'easy block still names this agent\'s own file');
ok(easyBlock.includes('never lets the drill stop'), 'easy block keeps the Continue loop');
const easyKickoff = trainingKickoffFor();
ok(easyKickoff.includes('12. todo_write:'), 'easy kickoff lists all 12 steps');
ok(!easyKickoff.includes('show_file'), 'easy kickoff does not name the hard ending');
ok(easyKickoff.includes('12-step pass'), 'easy kickoff names the pass length');

// Advanced gets the fetch/save/show lesson, including the redirect warning.
store.set('settings.trainingMode', { active: true, startedAt: 3, difficulty: 'advanced' });
store.set('trainingVerdicts', {});
const advancedBlock = trainingBlockFor({ id: 'agent_test' });
ok(advancedBlock.includes('fetch_url gets a page'), 'advanced block names fetch_url');
ok(advancedBlock.includes('show_url only DISPLAYS'), 'advanced block explains the display/tool split');
ok(advancedBlock.includes('Example Domain'), 'advanced block names the page it verifies');
ok(advancedBlock.includes(trainingFileFor({ id: 'agent_test' }, 'advanced')),
  'advanced block names the agent log file');
ok(advancedBlock.includes('final todo_write'), 'advanced block names its completion step');
const advancedKickoff = trainingKickoffFor();
ok(advancedKickoff.includes('8. todo_write:'), 'advanced kickoff lists all 8 steps');
ok(advancedKickoff.includes('Advanced pass'), 'advanced kickoff names the pass length');

// Frontier gets the real-desktop Notepad demo, not a file path.
store.set('settings.trainingMode', { active: true, startedAt: 4, difficulty: 'frontier' });
const frontierBlock = trainingBlockFor({ id: 'agent_test' });
ok(frontierBlock.includes('window_list first'), 'frontier block starts with window_list');
ok(frontierBlock.includes('window_open'), 'frontier block names window_open');
ok(frontierBlock.includes('window_type'), 'frontier block names window_type');
ok(frontierBlock.includes('Notepad'), 'frontier block names Notepad');
ok(frontierBlock.includes('Hello!'), 'frontier block carries the exact typed text');
ok(!frontierBlock.includes('relative to the sandbox'), 'frontier block stays off the sandbox path');
const frontierKickoff = trainingKickoffFor();
ok(frontierKickoff.includes('real desktop'), 'frontier kickoff names the real desktop');
ok(frontierKickoff.includes('6. todo_write:'), 'frontier kickoff lists all 6 steps');
ok(frontierKickoff.includes('Frontier pass'), 'frontier kickoff names the pass length');

// Browser gets the local page, its selectors and its visible finish line.
store.set('settings.trainingMode', { active: true, startedAt: 5, difficulty: 'browser' });
const browserBlock = trainingBlockFor({ id: 'agent_test' });
ok(browserBlock.includes('built-in browser'), 'browser block names the built-in browser');
ok(browserBlock.includes('browser.html'), 'browser block carries the local page URL');
ok(browserBlock.includes('#drill-name'), 'browser block names the input selector');
ok(browserBlock.includes('#drill-submit'), 'browser block names the button selector');
ok(browserBlock.includes('Hello, training'), 'browser block names the visible finish line');
ok(!browserBlock.includes('relative to the sandbox'), 'browser block stays off the sandbox path');
const browserKickoff = trainingKickoffFor();
ok(browserKickoff.includes('built-in browser'), 'browser kickoff names the built-in browser');
ok(browserKickoff.includes('browser.html'), 'browser kickoff carries the local page URL');
ok(browserKickoff.includes('9. todo_write:'), 'browser kickoff lists all 9 steps');
ok(browserKickoff.includes('Browser pass'), 'browser kickoff names the pass length');

// Custom drills: the operator's saved steps are the table, and the optional
// expected phrase is the only content check available to a free-form step.
const customSteps = normalizeCustomSteps([
  { tool: ' READ_FILE ', instruction: 'Read {file} and find hello', expect: ' HELLO ' },
  { tool: 'write_file', instruction: 'Save the result', expect: '' },
  { tool: '', instruction: 'not a step', expect: '' },
]);
eq(customSteps.length, 2, 'custom step normalisation drops incomplete rows');
eq(customSteps[0].tool, 'read_file', 'custom tool names are trimmed and lowercased');
eq(customSteps[0].expect, 'HELLO', 'expected phrases are trimmed but keep their case');
ok(CUSTOM_STEP_MAX >= 10, 'custom drills support a useful number of steps');
eq(normalizeCustomSteps(Array.from({ length: CUSTOM_STEP_MAX + 5 }, () => ({ tool: 'think', instruction: 'x' }))).length,
  CUSTOM_STEP_MAX, 'custom step normalisation enforces the cap');
eq(trainingTasksFor('custom', customSteps).length, 2, 'custom selects the saved table');
eq(trainingChecksFor('custom', customSteps).length, 2, 'custom checks align with its steps');
eq(trainingStepList(null, 'custom', customSteps)[0],
  '1. read_file — Read training/training-<agent>.txt and find hello (must include “HELLO”)',
  'custom step list fills {file} and names the expected phrase');
const customFile = trainingFileFor({ id: 'agent_test' }, 'custom');
const customCalls = [
  { tool: 'read_file', arg: { path: customFile }, status: 'ok', result: 'HELLO world' },
  { tool: 'write_file', arg: { path: customFile, content: 'HELLO' }, status: 'ok' },
];
const customVerdict = drillVerdict(customCalls, customFile, 'custom', customSteps);
ok(customVerdict.complete && customVerdict.clean, 'a complete custom pass with its expected phrase grades clean');
eq(customVerdict.totalSteps, 2, 'custom verdict uses the saved step count');
const customMiss = drillVerdict([
  { tool: 'read_file', arg: { path: customFile }, status: 'ok', result: 'nothing useful' },
  { tool: 'read_file', arg: { path: customFile }, status: 'ok', result: 'HELLO world' },
  { tool: 'write_file', arg: { path: customFile, content: 'HELLO' }, status: 'ok' },
], customFile, 'custom', customSteps);
ok(customMiss.complete && !customMiss.clean, 'a missing expected phrase is a failed attempt even after a corrected retry');
eq(customMiss.failureCounts['1'], 1, 'the custom failure is attributed to its step');
eq(trainingTasksFor('custom', []).length, 0, 'an empty custom drill has no tasks');
const emptyCustom = drillVerdict([], customFile, 'custom', []);
eq(emptyCustom.totalSteps, 0, 'an empty custom drill has no pass to grade');
eq(emptyCustom.complete, false, 'an empty custom drill never completes');
store.set('settings.trainingMode', { active: true, startedAt: 5, difficulty: 'custom', customSteps });
const customBlock = trainingBlockFor({ id: 'agent_test' });
ok(customBlock.includes('read_file'), 'custom block lists the saved tool');
ok(customBlock.includes('Read training/training-agent-test.txt and find hello'),
  'custom block fills {file} in the saved instruction');
ok(customBlock.includes('must include “HELLO”'), 'custom block states the expected phrase');
ok(customBlock.includes('expected phrase'), 'custom block explains the optional content check');
const customKickoff = trainingKickoffFor();
ok(customKickoff.includes('2. write_file:'), 'custom kickoff lists the saved steps');
ok(customKickoff.includes('2-step Custom pass'), 'custom kickoff names the saved pass length');
ok(customKickoff.includes('Brain Lab'), 'custom kickoff allows custom tools');
store.set('settings.trainingMode', { active: true, startedAt: 1, difficulty: 'hard' });

// The recorded position is per agent, in that agent's own block. One shared
// "Continue" used to list every agent's position, and a live run had a second
// model read another agent's "pass complete" and start at step 17.
store.set('trainingVerdicts', {
  agent_test: { step: 15, totalSteps: 17, complete: false, name: 'Scout' },
  agent_other: { step: 3, totalSteps: 17, complete: false, name: 'Coder' },
});
const positioned = trainingBlockFor({ id: 'agent_test' });
ok(positioned.includes('15/17') && positioned.includes('step 16') && positioned.includes('todo_write'),
  'the block names this agent\'s recorded next step');
ok(positioned.includes('never restart the pass early'), 'the block forbids restarting early');
ok(!positioned.includes('3/17'), 'the block never carries another agent\'s position');
store.set('trainingVerdicts', { agent_test: { step: 17, totalSteps: 17, complete: true } });
ok(trainingBlockFor({ id: 'agent_test' }).includes('fresh pass'),
  'a completed pass resumes into a fresh one');
store.set('trainingVerdicts', {});

// The continued turn is generic: every agent reads its own position above.
eq(trainingResumeFor(),
  'Continue. Your TRAINING MODE block records your own position from the calls the app saw — resume there, never restart the pass early.',
  'the shared Continue points at the per-agent block instead of listing positions');

// --- the clean-pass stopping rule -------------------------------------------
eq(reachedCleanTarget({ cleanPassTarget: 0 }, { a: { cleanPasses: 5 } }), null,
  '0 never stops on its own');
const targetHit = reachedCleanTarget({ cleanPassTarget: 2 },
  { a: { name: 'Scout', cleanPasses: 1 }, b: { name: 'Coder', cleanPasses: 2 } });
ok(!!targetHit && targetHit.name === 'Coder', 'the first agent at the target ends the run');
eq(reachedCleanTarget({ cleanPassTarget: 2 }, { a: { cleanPasses: 1 } }), null,
  'below the target keeps running');

// The strip says the rule only when there is one.
eq(drillStripTitle({}), 'drill', 'no target keeps the one-word header');
eq(drillStripTitle({ difficulty: 'easy' }), 'easy drill', 'easy mode is named in the strip');
eq(drillStripTitle({ difficulty: 'advanced' }), 'advanced drill', 'advanced mode is named in the strip');
eq(drillStripTitle({ difficulty: 'frontier' }), 'frontier drill', 'frontier mode is named in the strip');
eq(drillStripTitle({ cleanPassTarget: 0 }), 'drill', 'target 0 keeps the one-word header');
eq(drillStripTitle({ cleanPassTarget: 1 }), 'drill \u00b7 stop at 1 clean pass', 'one pass is singular');
eq(drillStripTitle({ cleanPassTarget: 3 }), 'drill \u00b7 stop at 3 clean passes', 'the header names the target');

// --- the resume decision (chat.js asks this after EVERY finished turn) -------
eq(shouldResumeDrill({ active: true }), true, 'an armed mode continues every turn');
eq(shouldResumeDrill({ active: false }), false, 'a disarmed mode never continues');
eq(shouldResumeDrill({}), false, 'no mode, no resume');
eq(shouldResumeDrill({ active: true, drillResumes: 999 }), true,
  'a resume count never ends the loop');
eq(shouldResumeDrill({ active: true, drillResumes: 9999, drillFails: 9 }), true,
  'failures never end the loop either - they only slow it down');
eq(showsEveryPass({ active: true }), false, 'pass reports are off by default');
eq(showsEveryPass({ active: true, showEveryPass: false }), false, 'the unchecked setting stays off');
eq(showsEveryPass({ active: true, showEveryPass: true }), true, 'Show every pass enables per-pass reports');
eq(showsEveryPass({ active: false, showEveryPass: true }), false, 'a stopped run never opens a pass report');

// The Start dispatch: self-contained, so a fresh turn AND a steered in-flight
// turn both get the drill even though only the fresh turn carries the block.
const kickoff = trainingKickoffFor();
ok(typeof kickoff === 'string' && kickoff.length > 200, 'kickoff is a full instruction');
ok(kickoff.includes('Training mode is ON'), 'kickoff announces the mode');
ok(kickoff.includes(TRAINING_DIR), 'kickoff names the drill folder');
ok(!kickoff.includes('<agent>'), 'kickoff never asks a model to resolve the agent placeholder');
ok(kickoff.includes('your drill file'), 'kickoff points at the agent\'s own file, named exactly in the prompt block');
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
