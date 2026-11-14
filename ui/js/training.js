/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// TRAINING.JS — Training mode: a paced tool drill
// ============================================
//
// While armed (Agents-tab header, dumbbell button), every active agent is:
//   * throttled to ~50% of its normal request rate (see rateGovernor.js), and
//   * locked by system prompt to one simple drill, worked in order, with a
//     retry-until-it-works rule so a miss becomes practice instead of a skip.
//
// Nothing here teaches weights — models do not keep those between calls. What
// "remember what worked" means is: the agent tracks each passed step with
// todo_write, and the drill that last worked stays in the run transcript and
// the todo list. The operator ends the drill with Stop on the same button.

import { store } from './store.js?v=458';

/** Fraction of the normal request rate agents get while training. */
export const TRAINING_THROTTLE = 0.5;

/** Folder the whole drill lives in. The sandbox jail still applies: this is
 *  resolved under the agent's writable root, never outside it. */
export const TRAINING_DIR = 'training';
export const TRAINING_FILE = 'training/training.txt';
/** Placeholder in the step labels, filled with the caller's own drill file. */
export const TRAINING_FILE_TOKEN = '{file}';
/** Local page the Browser drill drives; resolved against this module so it
 *  works at the root and under the Apache /router mount alike. */
export const TRAINING_BROWSER_PATH = 'ui/drill/browser.html';
export const TRAINING_BROWSER_TOKEN = '{browser}';
/** A saved custom drill is capped so a bad paste cannot make an endless pass. */
export const CUSTOM_STEP_MAX = 50;

/**
 * The saved custom steps, in the shape the drill uses.
 *
 * A custom step is a tool name plus the operator's instruction. `expect` is
 * optional: when it is set, a successful call also has to mention that text in
 * its arguments or result. Without it, the app can only know the tool returned
 * ok -- it cannot grade free-form prose.
 */
export function normalizeCustomSteps(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, CUSTOM_STEP_MAX).map((step) => {
    const tool = String(step && step.tool || '').trim().toLowerCase().slice(0, 80);
    const instruction = String(step && step.instruction || '').trim().slice(0, 1200);
    const expect = String(step && step.expect || '').trim().slice(0, 200);
    return { tool, instruction, ...(expect ? { expect } : {}) };
  }).filter(step => step.tool && step.instruction);
}

/**
 * The drill file for one agent.
 *
 * Every active agent trains in the SAME sandbox, so one shared training.txt
 * let two passes collide: agent B's completed output was what agent A's step 7
 * read, A's step 8 then added a second "drill 2 passed" line, and A's step 9
 * could not match uniquely ("old string appears 2 times"). A file per agent
 * makes the drill's own state private to the pass that produced it.
 */
export function trainingFileFor(agent, difficulty = 'hard') {
  const raw = String((agent && (agent.id || agent.code || agent.name)) || 'agent');
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-48) || 'agent';
  const stem = difficulty === 'advanced' ? 'advanced' : 'training';
  return `${TRAINING_DIR}/${stem}-${slug}.txt`;
}

/** Generic wording for surfaces that describe the drill to the operator. */
const fileForSteps = (agent, difficulty = 'hard') => agent
  ? trainingFileFor(agent, difficulty)
  : `${TRAINING_DIR}/${difficulty === 'advanced' ? 'advanced' : 'training'}-<agent>.txt`;
const fillFile = (text, agent, difficulty = 'hard') =>
  String(text).split(TRAINING_FILE_TOKEN).join(fileForSteps(agent, difficulty));
const browserDrillUrl = () => new URL('../drill/browser.html', import.meta.url).href;
const fillBrowser = (text) => String(text).split(TRAINING_BROWSER_TOKEN).join(browserDrillUrl());

/**
 * Training mode is a closed loop: while it is armed, EVERY finished turn is
 * followed by "Continue", with no budget and no exception for the last step.
 *
 * The old six-resume budget existed to stop a model looping on one display
 * step, but it made the mode useless for unattended practice: a model that
 * stopped after two free steps stalled the drill and the operator had to cycle
 * Start (or leave Always-On running to fake the loop). A finished drill now
 * simply starts another pass.
 *
 * Every exit is a human action, on purpose: switch training off, press STOP
 * (that turn only), type a draft into the composer, or deactivate every agent.
 */

/**
 * The drill, simplest-first. One tool per step so a failure names exactly
 * what to retry. Approval-gated tools (write/exec/…) come after the free
 * ones, because each of those pauses on the operator's Approve button — that
 * pause is part of the lesson, not something to route around.
 */
export const TRAINING_TASKS = [
  { tool: 'think', label: 'Think one sentence about the drill before touching anything.' },
  { tool: 'todo_write', label: 'Write the drill steps below as your todo list, first one in_progress.' },
  { tool: 'echo', label: 'Echo the word "training" back — echo takes a bare string: {"tool":"echo","arg":"training"}, not an object like {"arg":{"text":"training"}}.' },
  { tool: 'now', label: 'Report the current date and time.' },
  { tool: 'write_file', label: 'Create {file} containing exactly the word "training". (Asks approval — wait for it, do not skip.)' },
  { tool: 'read_file', label: 'Read {file} back with read_file — not show_file — and confirm it says "training".' },
  { tool: 'read_file', label: 'Read only line 1 of {file}: call read_file with the path and a trailing " 1-1" — not show_file. A range keeps a big file out of your context instead of pulling all of it in.' },
  { tool: 'edit_file', label: 'In {file}, use edit_file — not write_file and not str_replace_editor — to replace the exact text "training" with "training\\ndrill 2 passed". old_string is the text you match, new_string is what replaces it; edit_file is search-and-replace, never an append. (Asks approval — wait for it.)' },
  { tool: 'edit_file', label: 'Use edit_file again — not write_file and not str_replace_editor — to replace the exact line "drill 2 passed" with "drill 2 passed (exact match)". (Asks approval — old_string/new_string edits only touch the text you name.)' },
  { tool: 'list_dir', label: 'List the training folder.' },
  { tool: 'glob_files', label: 'Find files matching "training/*".' },
  { tool: 'grep_code', label: 'Search the training folder for the word "training".' },
  // The display family: each show_* call paints its output into the transcript
  // and ENDS the turn. Training mode resumes the drill after it, which is what
  // lets these sit mid-drill instead of only at the end.
  { tool: 'show_find', label: 'Show me the search: use show_find for "training" — the matches on screen are your reply. This ends the turn; the drill resumes after it.' },
  { tool: 'exec', label: 'Run ["echo","training"] and confirm the output. (Asks approval — wait for it.)' },
  { tool: 'show_command', label: 'Show me a command: use show_command for ["echo","training"] and let its output be your reply. (Asks approval — this is the display twin of exec: it ends the turn, and the drill resumes.)' },
  { tool: 'todo_write', label: 'Mark every drill step completed, and put your two-line summary (which tools passed, retries) in the last item.' },
  { tool: 'show_file', label: 'Show {file} to me with show_file — not read_file — the file on screen IS the drill report. This ends the turn; the mode then sends Continue for a fresh pass, so do not write the contents out again.' },
];

/**
 * Easy mode: the original 12-step sequence, kept for comparison.
 *
 * The wording is taken from commit 53b05a9, with two deliberate changes:
 *   * the hard-coded training/training.txt path became {file}, so two agents
 *     still drill in their own files instead of colliding in one;
 *   * the final "and stop: the drill is done" became "this completes the
 *     12-step pass", because the current harness sends Continue and owns the
 *     ending.
 *
 * Everything else is the old wording — including "Append a second line" on
 * step 7. That instruction is the point of Easy mode: it is the step that did
 * not match what edit_file can do, and keeping it lets you see which models
 * still fail there and at which step number. Do not "fix" it here; Hard mode
 * is where the anchored edit is taught.
 */
export const TRAINING_TASKS_EASY = [
  { tool: 'think', label: 'Think one sentence about the drill before touching anything.' },
  { tool: 'todo_write', label: 'Write the drill steps below as your todo list, first one in_progress.' },
  { tool: 'echo', label: 'Echo the word "training" back.' },
  { tool: 'now', label: 'Report the current date and time.' },
  { tool: 'write_file', label: 'Create {file} containing exactly the word "training". (Asks approval — wait for it, do not skip.)' },
  { tool: 'read_file', label: 'Read {file} back and confirm it says "training".' },
  { tool: 'edit_file', label: 'Append a second line "drill 2 passed" to {file}. (Asks approval — wait for it.)' },
  { tool: 'list_dir', label: 'List the training folder.' },
  { tool: 'glob_files', label: 'Find files matching "training/*".' },
  { tool: 'grep_code', label: 'Search the training folder for the word "training".' },
  { tool: 'exec', label: 'Run ["echo","training"] and confirm the output. (Asks approval — wait for it.)' },
  { tool: 'todo_write', label: 'Mark every drill step completed — this completes the 12-step pass.' },
];

/**
 * Advanced mode: the read → save → show pipeline behind
 * “show_url URL > log.txt”. `show_url` is a display tool: it paints a page and
 * ends the turn, so it cannot redirect into a file. The drill teaches the two
 * real halves instead — fetch_url to read the bytes, write_file to keep them —
 * then proves both the live page and the saved copy on screen.
 */
export const TRAINING_TASKS_ADVANCED = [
  { tool: 'think', label: 'Think one sentence about the fetch → save → show pipeline before touching anything.' },
  { tool: 'todo_write', label: 'Write the Advanced steps as your todo list, first one in_progress.' },
  { tool: 'fetch_url', label: 'Fetch https://example.com/ with fetch_url and read the page text. This is the read half of “show_url URL > log.txt”: show_url only displays a page and cannot redirect into a file.' },
  { tool: 'write_file', label: 'Save that fetched page text to {file} with write_file — the redirect half, done as a real file. (Asks approval — wait for it.)' },
  { tool: 'read_file', label: 'Read {file} back with read_file and confirm the saved page still says “Example Domain”.' },
  { tool: 'show_url', label: 'Show the live page with show_url at https://example.com/ — the page text on screen is your reply. This ends the turn; the drill resumes after it.' },
  { tool: 'show_file', label: 'Show the saved copy with show_file at {file} — the file on screen proves the redirect, not just the fetch. This ends the turn; the drill resumes after it.' },
  { tool: 'todo_write', label: 'Mark every step completed and put your one-line summary (what was fetched, where it was saved) in the last item — this completes the 8-step Advanced pass.' },
];

/**
 * Frontier mode: the real desktop.
 *
 * This is deliberately the small Notepad demo, not a file drill. The operator
 * configures programs in Config → Shell access; agents only name one, and both
 * window_open and window_type still pause for approval. The typed text is the
 * result, so the final step records it and leaves the window open.
 */
export const TRAINING_TASKS_FRONTIER = [
  { tool: 'think', label: 'Think one sentence about the desktop demo before touching anything.' },
  { tool: 'todo_write', label: 'Write the Frontier steps as your todo list, first one in_progress.' },
  { tool: 'window_list', label: 'Call window_list and find the configured program named “notepad”. Do not open anything yet.' },
  { tool: 'window_open', label: 'Open Notepad on the real desktop with window_open: {"name":"notepad"}. (Asks approval — the window is the demo, so leave it open.)' },
  { tool: 'window_type', label: 'Type exactly “Hello!” into Notepad with window_type: {"name":"notepad","text":"Hello!"}. (Asks approval — the result must say the window was read back and contains the typed text; if it says unverified, retry.)' },
  { tool: 'todo_write', label: 'Mark every step completed and put one line in the last item: Notepad is open and “Hello!” was typed on screen. This completes the 6-step Frontier pass.' },
];

/**
 * Browser mode: the built-in browser driving a deterministic local page.
 *
 * This is deliberately separate from Frontier. Browser Labs is an opt-in
 * server setting and Chrome/Edge may not be installed; folding these steps
 * into the Notepad drill would make a browser failure block the desktop demo
 * too. The local page has one field and one button, so the pass can be
 * recorded or repeated without a public site changing under it.
 */
export const TRAINING_TASKS_BROWSER = [
  { tool: 'think', label: 'Think one sentence about the browser drill before touching anything.' },
  { tool: 'todo_write', label: 'Write the Browser steps as your todo list, first one in_progress.' },
  { tool: 'browser_open', label: 'Open the local Browser drill page in a visible window with browser_open: {"url":"{browser}","headless":false}. Wait for it to load.' },
  { tool: 'browser_read', label: 'Read the page with browser_read and confirm it says “Browser drill”.' },
  { tool: 'browser_type', label: 'Type exactly “training” into the name field with browser_type: {"selector":"#drill-name","text":"training"}. (Asks approval — wait for it.)' },
  { tool: 'browser_click', label: 'Click the “Say hello” button with browser_click: {"selector":"#drill-submit"}.' },
  { tool: 'browser_wait', label: 'Wait for the page to settle with browser_wait: {"ms":300}.' },
  { tool: 'browser_read', label: 'Read the page again with browser_read and confirm it says “Hello, training”.' },
  { tool: 'todo_write', label: 'Mark every step completed and put one line in the last item: the browser opened the local drill page, “training” was typed, and “Hello, training” was read back. This completes the 9-step Browser pass.' },
];

/** Terms used by the checks below, tolerant of how a model spells an argument. */
const argText = (call) => {
  try { return JSON.stringify((call && call.arg) ?? '').toLowerCase(); }
  catch { return String((call && call.arg) || '').toLowerCase(); }
};
const resultText = (call) => String((call && call.result) || '').toLowerCase();
const namesTrainingFile = (call, file) => argText(call).includes(String(file || TRAINING_FILE).toLowerCase());
/** The edit_file arguments as sent, before the case-folding argText() applies. */
const editArg = (call) => (call && call.arg && typeof call.arg === 'object' && !Array.isArray(call.arg)) ? call.arg : {};
const showsTraining = (call) => /training/.test(resultText(call));
const showsExample = (call) => /example domain/i.test(resultText(call));

/**
 * What each step can be CHECKED on, beyond "the call returned ok".
 *
 * Index-aligned with TRAINING_TASKS. `null` means the step has no checkable
 * artefact (think, todo_write, now): a successful call is all the evidence
 * there can be. Every other entry looks at the arguments and/or the result, so
 * a model cannot "pass" the ranged read with a full read, or the write with an
 * empty file, and still be called clean.
 */
export const DRILL_CHECKS = [
  null,                                                                     // 1 think
  null,                                                                     // 2 todo_write
  (c) => showsTraining(c),                                                  // 3 echo
  null,                                                                     // 4 now
  (c, file) => namesTrainingFile(c, file) && /"content"\s*:\s*"training/.test(argText(c)), // 5 write_file
  (c, file) => namesTrainingFile(c, file) && showsTraining(c),                // 6 read back
  (c, file) => namesTrainingFile(c, file) && /1-1|"range"/.test(argText(c)),  // 7 ranged read
  (c, file) => namesTrainingFile(c, file)
    && String(editArg(c).old_string ?? '') === 'training'
    && /training\r?\ndrill 2 passed/.test(String(editArg(c).new_string ?? '')), // 8 anchored append
  (c, file) => namesTrainingFile(c, file)
    && String(editArg(c).old_string ?? '') === 'drill 2 passed'
    && /drill 2 passed \(exact match\)/.test(String(editArg(c).new_string ?? '')), // 9 exact replace
  (c) => showsTraining(c),                                                  // 10 list_dir
  (c) => showsTraining(c),                                                  // 11 glob_files
  (c) => showsTraining(c),                                                  // 12 grep_code
  (c) => showsTraining(c),                                                  // 13 show_find
  (c) => showsTraining(c),                                                  // 14 exec
  (c) => showsTraining(c),                                                  // 15 show_command
  null,                                                                     // 16 todo_write
  (c, file) => namesTrainingFile(c, file) && showsTraining(c),                // 17 show_file
];

/**
 * Easy-mode checks, aligned with TRAINING_TASKS_EASY.
 *
 * Step 7 is deliberately lenient: the old label says "append", a capability
 * edit_file does not have. A model that anchors the edit correctly passes; a
 * model that sends an empty old_string fails at step 7, which is the failure
 * this mode exists to expose. The check does not require the hard mode's
 * exact old_string/new_string pair, because the old wording never taught it.
 */
export const DRILL_CHECKS_EASY = [
  null,                                                                     // 1 think
  null,                                                                     // 2 todo_write
  (c) => showsTraining(c),                                                  // 3 echo
  null,                                                                     // 4 now
  (c, file) => namesTrainingFile(c, file) && /"content"\s*:\s*"training/.test(argText(c)), // 5 write_file
  (c, file) => namesTrainingFile(c, file) && showsTraining(c),                // 6 read back
  (c, file) => namesTrainingFile(c, file) && /drill 2 passed/.test(argText(c)), // 7 append attempt
  (c) => showsTraining(c),                                                  // 8 list_dir
  (c) => showsTraining(c),                                                  // 9 glob_files
  (c) => showsTraining(c),                                                  // 10 grep_code
  (c) => showsTraining(c),                                                  // 11 exec
  null,                                                                     // 12 todo_write
];

/** Advanced checks, aligned with TRAINING_TASKS_ADVANCED. */
export const DRILL_CHECKS_ADVANCED = [
  null,                                                                     // 1 think
  null,                                                                     // 2 todo_write
  (c) => /example\.com/i.test(argText(c)) && showsExample(c),                // 3 fetch_url
  (c, file) => namesTrainingFile(c, file) && /example domain/i.test(argText(c)), // 4 write_file
  (c, file) => namesTrainingFile(c, file) && showsExample(c),                // 5 read_file
  (c) => /example\.com/i.test(argText(c)) && showsExample(c),                // 6 show_url
  (c, file) => namesTrainingFile(c, file) && showsExample(c),                // 7 show_file
  null,                                                                     // 8 todo_write
];

/** Frontier checks, aligned with TRAINING_TASKS_FRONTIER. */
export const DRILL_CHECKS_FRONTIER = [
  null,                                                                     // 1 think
  null,                                                                     // 2 todo_write
  (c) => /notepad/i.test(resultText(c)),                                    // 3 window_list
  (c) => /notepad/i.test(argText(c)),                                       // 4 window_open
  (c) => /notepad/i.test(argText(c))
    && /"text"\s*:\s*"hello!"/.test(argText(c))
    && /read back from the window.*the typed text is there/i.test(resultText(c)), // 5 window_type
  null,                                                                     // 6 todo_write
];

/** Browser checks, aligned with TRAINING_TASKS_BROWSER. */
export const DRILL_CHECKS_BROWSER = [
  null,                                                                     // 1 think
  null,                                                                     // 2 todo_write
  (c) => /drill\/browser\.html/i.test(argText(c))
    && /visible window/i.test(resultText(c)),                              // 3 browser_open (visible)
  (c) => /browser drill/i.test(resultText(c)),                              // 4 browser_read heading
  (c) => /#drill-name/i.test(argText(c)) && /"text"\s*:\s*"training"/.test(argText(c)), // 5 browser_type
  (c) => /#drill-submit/i.test(argText(c)),                                 // 6 browser_click
  (c) => /"ms"\s*:\s*\d+/.test(argText(c)) || /waited \d+ms/i.test(resultText(c)), // 7 browser_wait
  (c) => /hello,\s*training/i.test(resultText(c)),                          // 8 browser_read result
  null,                                                                     // 9 todo_write
];

/** The saved custom table, or the current one when no explicit list is given. */
function customStepsFrom(steps) {
  return normalizeCustomSteps(steps === undefined ? store.get('settings.trainingMode.customSteps') : steps);
}

/** Turn saved custom steps into the same task shape the built-in drills use. */
function customTasksFrom(steps) {
  return customStepsFrom(steps).map(step => ({ tool: step.tool, label: step.instruction, expect: step.expect || '' }));
}

/** Optional literal check for a custom step; no `expect` means success is enough. */
function customChecksFrom(steps) {
  return customStepsFrom(steps).map(step => {
    if (!step.expect) return null;
    const needle = step.expect.toLowerCase();
    return (call) => `${argText(call)}\n${resultText(call)}`.includes(needle);
  });
}

/** Which drill a mode setting selects. Unknown/legacy settings are Hard. */
export function trainingDifficulty(mode) {
  const d = String((mode && mode.difficulty) || '').toLowerCase();
  return ['easy', 'hard', 'advanced', 'frontier', 'browser', 'custom'].includes(d) ? d : 'hard';
}

/** The ordered task table for a difficulty. */
export function trainingTasksFor(difficulty, customSteps = undefined) {
  if (difficulty === 'easy') return TRAINING_TASKS_EASY;
  if (difficulty === 'advanced') return TRAINING_TASKS_ADVANCED;
  if (difficulty === 'frontier') return TRAINING_TASKS_FRONTIER;
  if (difficulty === 'browser') return TRAINING_TASKS_BROWSER;
  if (difficulty === 'custom') return customTasksFrom(customSteps);
  return TRAINING_TASKS;
}

/** The index-aligned checks for a difficulty. */
export function trainingChecksFor(difficulty, customSteps = undefined) {
  if (difficulty === 'easy') return DRILL_CHECKS_EASY;
  if (difficulty === 'advanced') return DRILL_CHECKS_ADVANCED;
  if (difficulty === 'frontier') return DRILL_CHECKS_FRONTIER;
  if (difficulty === 'browser') return DRILL_CHECKS_BROWSER;
  if (difficulty === 'custom') return customChecksFrom(customSteps);
  return DRILL_CHECKS;
}

const DIFFICULTY_INFO = {
  easy: {
    label: 'Easy',
    hint: 'Easy runs the original 12-step sequence, including its old append step. Per-agent files and the Continue loop still apply.',
  },
  hard: {
    label: 'Hard',
    hint: 'Hard runs the current 17-step drill with the ranged read, anchored edits and display tools.',
  },
  advanced: {
    label: 'Advanced',
    hint: 'Advanced runs an 8-step fetch → save → show pipeline: fetch_url reads https://example.com/, write_file keeps it as the log, then show_url and show_file prove the live page and the saved copy.',
  },
  frontier: {
    label: 'Frontier',
    hint: 'Frontier runs a 6-step real-desktop demo: window_list finds Notepad, window_open opens it, and window_type types “Hello!” and reads the window back to prove it landed. Leave the window open to watch it.',
  },
  browser: {
    label: 'Browser',
    hint: 'Browser runs a 9-step local-page demo in a visible window: open the page, read it, type “training”, click “Say hello”, wait, then read “Hello, training” back. Needs Config → Labs → Browser and Chrome or Edge.',
  },
  custom: {
    label: 'Custom',
    hint: 'Custom runs the steps you saved in the drill builder. Each step names the tool the agent must call and the instruction it must follow; an optional expected phrase adds a content check.',
  },
};

/** Human name for a difficulty, used by the dialog and the Start toast. */
export function trainingDifficultyLabel(difficulty) {
  return DIFFICULTY_INFO[trainingDifficulty({ difficulty })]?.label || 'Hard';
}

/** One-line explanation of what a difficulty practices. */
export function trainingDifficultyHint(difficulty) {
  return DIFFICULTY_INFO[trainingDifficulty({ difficulty })]?.hint || DIFFICULTY_INFO.hard.hint;
}

/** What the final step is and what happens after it, per drill. */
function trainingEnding(difficulty, total = 0) {
  if (difficulty === 'easy') {
    return 'After each passed step, update your todo list; the final todo_write completes the 12-step pass — the mode then sends Continue again, so begin a fresh pass instead of waiting.';
  }
  if (difficulty === 'advanced') {
    return 'After each passed step, update your todo list; the final todo_write completes the 8-step Advanced pass — the mode then sends Continue again, so begin a fresh pass instead of waiting. show_url and show_file end their turns, and the drill resumes after each one.';
  }
  if (difficulty === 'frontier') {
    return 'After each passed step, update your todo list; the final todo_write completes the 6-step Frontier pass — the mode then sends Continue again, so begin a fresh pass instead of waiting. The Notepad window stays open after the typing step; do not close it.';
  }
  if (difficulty === 'browser') {
    return 'After each passed step, update your todo list; the final todo_write completes the 9-step Browser pass — the mode then sends Continue again, so begin a fresh pass instead of waiting. The local drill page stays open; do not navigate to other sites.';
  }
  if (difficulty === 'custom') {
    return `After each passed step, update your todo list; the final step completes the ${total}-step Custom pass — the mode then sends Continue again, so begin a fresh pass instead of waiting.`;
  }
  return 'After each passed step, update your todo list; the summary goes in the last todo item; the final show_file ends the PASS — the mode then sends Continue again, so begin a fresh pass instead of waiting.';
}

/**
 * Grade a drill pass from the tool records alone.
 *
 * The point is not to ask the model whether it succeeded -- its todo list is a
 * claim, not evidence. The app saw every call it made: which tool, with what
 * arguments, and whether the result was ok, an error, skipped or waiting on an
 * approval. This walks those records against TRAINING_TASKS in order and
 * answers two questions:
 *
 *   complete -- did a full pass of every step run?
 *   clean    -- did it do so with no failed attempt at any step?
 *
 * Retries are counted the way the transcript header counts them (the same
 * tool + the same arguments sent again after an error), but `failures` also
 * counts a CORRECTED attempt, which is why `clean` is failures === 0 rather
 * than retries === 0: a step fixed with different arguments is not a clean
 * step, even though it is not a literal repeat.
 *
 * A pass boundary is a `think` after the pass has every step. Records that are
 * still running, skipped because a display tool ended the turn, or waiting on
 * an approval never prove a step passed -- and a skipped call is not a
 * failure either.
 */
export function drillVerdict(calls, file = TRAINING_FILE, difficulty = 'hard', customSteps = undefined) {
  const tasks = trainingTasksFor(difficulty, customSteps);
  const checks = trainingChecksFor(difficulty, customSteps);
  const total = tasks.length;
  const list = Array.isArray(calls) ? calls.filter(c => c && c.tool) : [];
  // A custom drill with no saved steps has no pass to grade. Return the empty
  // shape rather than dividing by / indexing into a zero-length table.
  if (!total) {
    return {
      totalSteps: 0, step: 0, complete: false, clean: false, passes: 0, cleanPasses: 0,
      failures: 0, failuresTotal: 0, failureCounts: {}, retries: 0, pending: false,
      failedAt: null, offStep: 0, offTool: '', nextTool: '', retryHint: '', empty: true,
    };
  }
  const blank = () => ({
    step: 0, failures: 0, failureCounts: {}, retries: 0, pending: false,
    failedAt: null, offStep: 0, offTool: '', lastFailure: null,
  });
  let cur = blank();
  let passes = 0;
  let cleanPasses = 0;
  let last = null;
  let lastKey = '';
  let lastStatus = '';
  // Failures belong to the step they happened on, not just the pass. The live
  // strip still reads `failures` for the current pass; the completion summary
  // reads this run-wide tally ("2x step 5, 1x step 7").
  const completedFailureCounts = {};
  let completedFailures = 0;
  const mergePass = (pass) => {
    for (const [step, n] of Object.entries(pass.failureCounts || {})) {
      completedFailureCounts[step] = (completedFailureCounts[step] || 0) + n;
    }
    completedFailures += pass.failures;
  };
  const countFailure = (failedResult = '') => {
    const stepNo = cur.step + 1;
    cur.failures++;
    cur.failureCounts[stepNo] = (cur.failureCounts[stepNo] || 0) + 1;
    if (cur.failedAt === null) cur.failedAt = stepNo;
    cur.lastFailure = { step: stepNo, result: String(failedResult || '') };
  };

  for (const call of list) {
    const tool = String(call.tool);
    const status = String(call.status || '');

    // A finished pass: only the drill's first step opens the next one.
    if (cur.step >= total) {
      if (tool !== tasks[0].tool) continue;
      mergePass(cur);
      passes++;
      if (cur.failures === 0 && !cur.pending) cleanPasses++;
      last = cur;
      cur = blank();
    }

    const want = tasks[cur.step];
    const check = checks[cur.step];
    const key = `${tool}|${argText(call)}`;
    const retry = lastKey === key && lastStatus === 'error';
    lastKey = key;
    lastStatus = status;

    // A check only judges a call that SUCCEEDED: a pending approval, an error
    // and a still-running call have produced no artefact to inspect.
    const checkOk = !check || status !== 'ok' || check(call, file);

    // Another tool never advances the drill, and it is not an attempt at this
    // step either. It is still recorded: a run of calls for other steps is what
    // a model that lost its place looks like, and the strip used to sit on the
    // same number with no explanation while one restarted the drill.
    if (tool !== want.tool) {
      if (status !== 'skipped' && status !== 'running') {
        cur.offStep++;
        cur.offTool = tool;
      }
      continue;
    }

    // The right tool with arguments this step cannot accept IS an attempt at
    // it -- a full read is not the ranged read. This used to be ignored, so a
    // model could repeat a wrong call and still be graded clean.
    if (!checkOk) {
      countFailure(resultText(call));
      if (status === 'error' && retry) cur.retries++;
      cur.offStep = 0;
      cur.offTool = '';
      continue;
    }

    // A real attempt at the step clears the "lost" signal.
    cur.offStep = 0;
    cur.offTool = '';

    if (status === 'pending') { cur.pending = true; continue; }
    if (status === 'error') {
      countFailure(resultText(call));
      if (retry) cur.retries++;
      continue;
    }
    // running / skipped / unknown: the step may yet happen, but it has not.
    if (status !== 'ok') continue;
    cur.step++;
  }

  const complete = cur.step >= total;
  if (complete) {
    mergePass(cur);
    passes++;
    if (cur.failures === 0 && !cur.pending) cleanPasses++;
    last = cur;
  }
  const failureCounts = { ...completedFailureCounts };
  if (!complete) {
    for (const [step, n] of Object.entries(cur.failureCounts)) {
      failureCounts[step] = (failureCounts[step] || 0) + n;
    }
  }
  // While a new pass is in progress the judgement is still the finished one.
  const judged = complete ? cur : last;
  // The Frontier typing step is the one place where a successful-looking call
  // can still be a failure: the app now reads the window back, and if that
  // read-back says unverified, the operator needs the next action in the strip,
  // not just a red "1 failed at step 5".
  const nextTask = complete ? null : tasks[cur.step];
  const retryHint = (!complete && difficulty === 'frontier'
    && nextTask && nextTask.tool === 'window_type'
    && cur.lastFailure && cur.lastFailure.step === cur.step + 1
    && /unverified|could not be read back/i.test(cur.lastFailure.result))
    ? 'Retry window_type: the window text was not read back, so the typed text is unconfirmed.'
    : (!complete && difficulty === 'browser'
      && nextTask && nextTask.tool === 'browser_open'
      && cur.lastFailure && cur.lastFailure.step === cur.step + 1
      && /headless/.test(cur.lastFailure.result))
      ? 'Retry browser_open with "headless":false: this drill needs a visible window.'
      : '';
  return {
    totalSteps: total,
    step: Math.min(cur.step, total),
    complete,
    // "Clean" is a claim about a FINISHED pass only. A pass in progress, or a
    // log with no calls, is never clean however few failures it has so far.
    clean: !!judged && judged.failures === 0 && !judged.pending,
    passes,
    // Clean passes in this run: the number the "stop after N clean passes"
    // option counts, and the same judgement `clean` makes — a finished pass
    // with zero failed attempts.
    cleanPasses,
    // Failure counts describe the pass being watched: while another pass runs,
    // that is the one whose failures the operator needs to see live.
    failures: cur.failures,
    // The whole run, for the completion summary: every finished pass plus the
    // one in progress, with a per-step breakdown.
    failuresTotal: completedFailures + (complete ? 0 : cur.failures),
    failureCounts,
    retries: cur.retries,
    pending: cur.pending,
    failedAt: cur.failedAt,
    // Calls since the last step progress that were for another tool. Not a
    // failure (the step was never attempted), but the visible sign of a model
    // that lost its place.
    offStep: cur.offStep,
    offTool: cur.offTool,
    nextTool: complete ? '' : (tasks[cur.step]?.tool || ''),
    retryHint,
  };
}

/**
 * The verdict that reached this run's clean-pass target, or null.
 *
 * `cleanPassTarget` 0 (the default) means never stop on its own. With several
 * agents, the FIRST to reach the target ends the run for all of them: waiting
 * for every agent would let one bad model keep a fleet billing forever, which
 * is the opposite of what a stopping rule is for.
 */
export function reachedCleanTarget(mode, verdicts) {
  const target = Math.max(0, Math.floor(Number(mode && mode.cleanPassTarget) || 0));
  if (!target) return null;
  for (const v of Object.values(verdicts || {})) {
    if (v && Number(v.cleanPasses || 0) >= target) return v;
  }
  return null;
}

/**
 * The strip's leading label. States the stopping rule only when one is set, so
 * the normal header stays one word and a run that will end itself says so.
 */
export function drillStripTitle(mode) {
  const n = Math.max(0, Math.floor(Number(mode && mode.cleanPassTarget) || 0));
  const difficulty = trainingDifficulty(mode);
  const base = difficulty === 'easy' ? 'easy drill'
    : difficulty === 'advanced' ? 'advanced drill'
      : difficulty === 'frontier' ? 'frontier drill'
        : difficulty === 'custom' ? 'custom drill' : 'drill';
  if (!n) return base;
  return `${base} \u00b7 stop at ${n} clean pass${n === 1 ? '' : 'es'}`;
}

/**
 * One line for a verdict, shared by the live strip and the Training dialog so
 * the two can never describe the same run differently.
 *
 * Complete passes are described by their outcome; an unfinished one shows how
 * far it got and what is blocking it. "clean" only ever appears on a finished
 * pass (see drillVerdict).
 */
export function drillVerdictText(verdict) {
  if (!verdict) return '';
  const bits = [`${verdict.step}/${verdict.totalSteps}`];
  if (verdict.complete) {
    bits.push(verdict.clean ? 'clean' : `${verdict.failures} failed`);
  } else if (verdict.failures) {
    bits.push(`${verdict.failures} failed${verdict.failedAt ? ` at step ${verdict.failedAt}` : ''}`);
  } else if (verdict.offStep) {
    bits.push(`waiting for ${verdict.nextTool || 'the next step'} (last call: ${verdict.offTool})`);
  }
  if (verdict.pending) bits.push('approval');
  if (verdict.retryHint) bits.push(verdict.retryHint);
  if (verdict.passes) bits.push(`${verdict.passes} pass${verdict.passes === 1 ? '' : 'es'}`);
  return bits.join(' \u00b7 ');
}

/** True while the operator has training mode armed. */
export function isTrainingActive() {
  try {
    return !!(store.get('settings.trainingMode') || {}).active;
  } catch {
    return false;
  }
}

/** Whether a completed pass should get its own report while the run goes on. */
export function showsEveryPass(mode) {
  return !!(mode && mode.active && mode.showEveryPass);
}

/** Short numbered recap for the popup dialog. */
export function trainingStepList(agent = null, difficulty = 'hard', customSteps = undefined) {
  return trainingTasksFor(difficulty, customSteps)
    .map((t, i) => `${i + 1}. ${t.tool} — ${fillBrowser(fillFile(t.label, agent, difficulty))}${t.expect ? ` (must include “${t.expect}”)` : ''}`);
}

/**
 * The chat turn Start dispatches, so arming the mode IS starting the drill.
 * Self-contained on purpose: a fresh turn also carries the drill in its
 * system prompt, but a turn already in flight when Start is pressed was built
 * before arming — this text reaches those agents through the steer queue at
 * their next tool-loop boundary. Either way the drill runs through the normal
 * turn path, so messages, topology, metrics and trace all behave as usual.
 */
export function trainingKickoffFor(difficulty = null) {
  // This one text reaches every agent, so it must never contain the literal
  // `<agent>` placeholder: a live run had the model stop to work out what its
  // "agent id" was instead of reading the exact path its own prompt block
  // already carried. The block is authoritative; this message stays generic.
  const mode = store.get('settings.trainingMode') || {};
  const diff = difficulty || trainingDifficulty(mode);
  const tasks = trainingTasksFor(diff, mode.customSteps);
  const stepLabel = (label) => fillBrowser(String(label).split(TRAINING_FILE_TOKEN)
    .join(diff === 'advanced' ? 'your log file' : 'your drill file'));
  const steps = tasks.map((t, i) => `${i + 1}. ${t.tool}: ${stepLabel(t.label)}${t.expect ? ` (must include “${t.expect}”)` : ''}`).join('\n');
  const ending = trainingEnding(diff, tasks.length);
  const custom = diff === 'custom';
  const scope = diff === 'frontier'
    ? 'on the real desktop'
    : diff === 'browser'
      ? 'in the built-in browser, on the local drill page'
      : custom
        ? 'wherever each step directs (the training folder, a URL, or the real desktop)'
        : 'inside the "training" sandbox folder';
  const fileRule = diff === 'frontier'
    ? 'window_list first, and use only the program names it shows; window_open the program before window_type; leave Notepad open after typing; never touch another window'
    : diff === 'browser'
      ? 'open only the local browser drill page named above in a visible window (headless:false); use #drill-name for the field and #drill-submit for the button; do not navigate to any other site'
      : custom
        ? 'use the exact tool each step names, including any custom tool saved in Brain Lab, and follow the instruction as written'
        : 'every agent has its OWN file in the training folder — use the exact path in your TRAINING MODE block, which the app also repeats when this kickoff reaches a turn already in flight — never another agent\'s file, and never the project folder above the sandbox';
  const approvalRule = diff === 'frontier'
    ? 'window_open and window_type ask for my approval — waiting for it is part of the drill'
    : diff === 'browser'
      ? 'browser_type asks for my approval — waiting for it is part of the drill'
      : custom
        ? 'any step whose tool asks for my approval — waiting for it is part of the drill'
        : 'write_file, edit_file and exec ask for my approval — waiting for it is part of the drill';
  return `Training mode is ON — work this drill now, step by step, ${scope}. Nothing else while it is on.\n`
    + `Steps:\n${steps}\n`
    + `Rules: one step at a time; a failed step is retried until it passes, never skipped — but READ the error and change the argument, because "Did you mean ..." or "not a file" means the path is wrong, not that the call should be sent again unchanged; ${fileRule}; ${approvalRule}. ${ending}`;
}

/**
 * Whether a finished training turn should be continued.
 *
 * "Every turn" is the point: a display step, a plain text reply, a budget
 * exhaustion and a completed drill all get the same treatment. The drill block
 * in the system prompt says what to do with the Continue that follows.
 *
 * Pure (no store access) so the decision is testable without a chat instance.
 */
export function shouldResumeDrill(mode) {
  return !!(mode && mode.active);
}

/**
 * The text a continued drill turn is dispatched with.
 *
 * Plain "Continue" when there is nothing recorded yet. Once calls exist, the
 * message carries the position the APP saw for each agent. A resumed turn was
 * rebuilt from a short message window and its own todo list, and a model that
 * lost track restarted the whole pass: the calls for steps 1-15 then arrived
 * while the verdict waited at 16, which read as a silent stall. Naming the
 * next step costs one line and makes the restart impossible to do innocently.
 *
 * Still sent silently and rendered nowhere, so the operator sees only the
 * drill -- the model sees the position its own past calls produced.
 */
export function trainingResumeFor() {
  // One message reaches EVERY active agent, so it must not list their
  // positions: a live run had the second model read the first model's
  // "pass complete (17/17)" and start at step 17. Each agent's own position
  // is in its own TRAINING MODE block, where the app wrote it; this stays
  // generic and points there.
  return 'Continue. Your TRAINING MODE block records your own position from the calls the app saw — resume there, never restart the pass early.';
}

/**
 * The system-prompt block injected in front of every agent's own prompt while
 * training is armed. Three jobs: INSTRUCT (the drill), PROBE (stay on it),
 * and REMEMBER (record each pass so the next turn reuses what worked).
 */
export function trainingBlockFor(agent = null) {
  if (!isTrainingActive()) return '';
  const mode = store.get('settings.trainingMode') || {};
  const difficulty = trainingDifficulty(mode);
  const tasks = trainingTasksFor(difficulty, mode.customSteps);
  const frontier = difficulty === 'frontier';
  const browser = difficulty === 'browser';
  const custom = difficulty === 'custom';
  const file = fileForSteps(agent, difficulty);
  const steps = tasks.map((t, i) => `${i + 1}. ${t.tool}: ${fillBrowser(fillFile(t.label, agent, difficulty))}${t.expect ? ` (must include “${t.expect}”)` : ''}`).join('\n');
  const mine = agent ? (store.get('trainingVerdicts') || {})[agent.id] : null;
  const total = tasks.length;
  const recorded = mine && Number.isFinite(Number(mine.step)) ? Math.max(0, Number(mine.step)) : null;
  const step = recorded === null ? null : Math.min(recorded, total);
  const complete = !!(mine && (mine.complete || step >= total));
  const next = step !== null && step < total ? tasks[step] : null;
  const positionRule = step === null ? ''
    : complete
      ? `- YOUR recorded position: pass complete (${total}/${total}) — start a fresh pass at step 1.\n`
      : `- YOUR recorded position: ${step}/${total} — next is step ${step + 1}${next ? ` (${next.tool})` : ''}. Resume there; never restart the pass early.\n`;
  const opening = `[TRAINING MODE — paced drill, ~50% request rate. Nothing else matters until training mode is switched off.]\n`
    + (frontier
      ? `Work ONLY these steps, in order, on the real desktop. Do not answer other questions, do not open unrelated programs, do not start other work — if asked anything else, finish the current drill step first and say the drill comes first.\n`
      : browser
        ? `Work ONLY these steps, in order, in the built-in browser. Do not answer other questions, do not open unrelated pages, do not start other work — if asked anything else, finish the current drill step first and say the drill comes first.\n`
        : custom
          ? `Work ONLY these steps, in order, wherever each one directs. Do not answer other questions, do not start unrelated work — if asked anything else, finish the current drill step first and say the drill comes first.\n`
          : `Work ONLY these steps, in order, inside the "training" sandbox folder. Do not answer other questions, do not touch other files, do not start other work — if asked anything else, finish the current drill step first and say the drill comes first.\n`)
    + `Steps:\n${steps}\n`
    + `Rules:\n`;

  // Easy keeps the old drill's rules (there is no edit_file contract and no
  // display-tool lesson) so step 7 stays the diagnostic it was. The path,
  // old-transcript and position rules are harness safety, not difficulty.
  if (difficulty === 'easy') {
    return opening
      + `- One step at a time. Call the step's tool, read its result, then move on.\n`
      + `- If a tool call errors, is denied, or returns the wrong thing, read the error message and TRY AGAIN with fixed arguments. Keep retrying the SAME step — never skip a failed step, never move on until it returns ok.\n`
      + `- Paths are relative to the sandbox: ${file}. Never the project folder above it, and never an absolute C:\\... path. Every agent has its OWN drill file — do not read or edit another agent's.\n`
      + `- THIS RUN uses the file above. Any earlier training transcript that mentions training/training.txt is an OLD run: ignore its paths and copy nothing from it.\n`
      + positionRule
      + `- Some steps ask the operator for approval (write_file, edit_file, exec). That pause is normal: wait for it, do not work around it, do not narrate the call as text.\n`
      + `- The Continue message names the step the app recorded for you. Resume there; do not start another pass while steps remain — the app saw every call you made, so an early restart shows up as off-step calls.\n`
      + `- This mode never lets the drill stop. When a turn ends — a short reply or a completed pass — you are sent "Continue" automatically. Treat Continue as the next instruction: pick up the first step your todo list does not show completed, and when every step is complete, start a fresh pass at step 1. Never say the drill is finished, never ask whether to continue, never wait for the operator.\n`
      + `- After each passed step, update your todo_write list so what worked is written down.`;
  }

  const oneStep = `- One step at a time. Call the step's tool, read its result, then move on.\n`;
  const retry = `- If a tool call errors, is denied, or returns the wrong thing, read the error message and TRY AGAIN with fixed arguments. Keep retrying the SAME step — never skip a failed step, never move on until it returns ok.\n`;
  const continueRule = `- The Continue message names the step the app recorded for you. Resume at that step; do not start another pass while steps remain — the app saw every call you made, so an early restart shows up as off-step calls.\n`;
  const stopRule = `- This mode never lets the drill stop. When a turn ends — a display step, a short reply, even the final step — you are sent "Continue" automatically. Treat Continue as the next instruction: pick up the first step your todo list does not show completed, and when every step is complete, start a fresh pass at step 1. Never say the drill is finished, never ask whether to continue, never wait for the operator.\n`;

  if (custom) {
    return opening
      + oneStep
      + retry
      + `- These are the operator's saved custom steps. Call the exact tool named by each step and carry out its instruction; never substitute an easier tool.\n`
      + `- A step may use a built-in tool or one saved in Brain Lab. If a step includes {file}, it resolves to your drill file, ${file}; otherwise follow the instruction exactly.\n`
      + `- Some custom steps carry an expected phrase. The app checks the call's arguments and result for it, so make sure the phrase appears before moving on.\n`
      + positionRule
      + `- Any step whose tool asks for approval may pause. That pause is normal: wait for it, do not work around it, and do not narrate the call as text.\n`
      + continueRule
      + stopRule
      + `- After each passed step, update your todo_write list so what worked is written down.`;
  }

  if (difficulty === 'frontier') {
    return opening
      + oneStep
      + retry
      + `- This is the REAL desktop, not the sandbox: window_list first, and use only the program names it shows. Never invent a path, executable or window name.\n`
      + `- window_open starts one configured program by name; the window outlives your reply. Call window_list again if you are unsure whether it is already running.\n`
      + `- window_type types into the newest window of that program, live on screen, then reads the window back. Type exactly "Hello!" into Notepad, keep the burst short, and leave the window open afterwards — the result must say the typed text is there; if it says unverified, retry the step.\n`
      + positionRule
      + `- window_open and window_type ask the operator for approval. That pause is normal: wait for it, do not work around it, and do not narrate the call as text.\n`
      + continueRule
      + stopRule
      + `- After each passed step, update your todo_write list so what worked is written down. The final todo_write is the summary; the Notepad window stays open.`;
  }

  if (difficulty === 'browser') {
    return opening
      + oneStep
      + retry
      + `- This drill runs in the built-in browser, not the sandbox or the desktop. Open only the local page named above; do not navigate to other sites.\n`
      + `- browser_type needs the #drill-name selector and the exact text "training". browser_click uses #drill-submit. browser_read after each action tells you what actually changed.\n`
      + `- browser_wait is a real pause for the page to settle; keep it short (300 ms). The final browser_read must show “Hello, training”.\n`
      + positionRule
      + `- browser_type asks the operator for approval. That pause is normal: wait for it, do not work around it, and do not narrate the call as text.\n`
      + continueRule
      + stopRule
      + `- After each passed step, update your todo_write list so what worked is written down. The final todo_write is the summary; the local drill page stays open.`;
  }

  if (difficulty === 'advanced') {
    return opening
      + oneStep
      + retry
      + `- An error that says "Did you mean ..." or "not a file" is telling you the ARGUMENT is wrong: change it. Sending the identical call again fails identically.\n`
      + `- fetch_url gets a page's text into your context. show_url only DISPLAYS a page and ENDS the turn; it cannot redirect into a file. The redirect in "show_url URL > log.txt" is two calls here: fetch_url to read the bytes, then write_file to keep them.\n`
      + `- Paths are relative to the sandbox: ${file}. Never the project folder above it, and never an absolute C:\\... path. Every agent has its OWN log file — do not read or edit another agent's.\n`
      + `- THIS RUN uses the file above. Any earlier training transcript that mentions another path is an OLD run: ignore its paths and copy nothing from it.\n`
      + positionRule
      + `- write_file asks the operator for approval. That pause is normal: wait for it, do not work around it, and do not narrate the call as text.\n`
      + `- Display tools paint their output straight into the transcript as your reply and END the turn: show_url (the live page) and show_file (the saved copy). Never re-describe what one showed. Use fetch_url when you need the page text back to save it; use show_url only when the page itself is the answer.\n`
      + continueRule
      + stopRule
      + `- After each passed step, update your todo_write list so what worked is written down. The final todo_write is the summary — it completes the pass, and the mode then sends Continue for a fresh one.`;
  }

  return opening
    + oneStep
    + retry
    + `- An error that says "Did you mean ..." or "not a file" is telling you the ARGUMENT is wrong: change it. Sending the identical call again fails identically.\n`
    + `- edit_file is exact search-and-replace, never an append: old_string is the text you match, new_string replaces it. To add a line, anchor on the neighbouring text (old_string "training" → new_string "training\\ndrill 2 passed"). An empty or ambiguous old_string is refused, so a bare append can never pass.\n`
    + `- Paths are relative to the sandbox: ${file}. Never the project folder above it, and never an absolute C:\\... path. Every agent has its OWN drill file — do not read or edit another agent's.\n`
    + `- THIS RUN uses the file above. Any earlier training transcript that mentions training/training.txt is an OLD run: ignore its paths and copy nothing from it.\n`
    + positionRule
    + `- Some steps ask the operator for approval (write_file, edit_file, exec). That pause is normal: wait for it, do not work around it, do not narrate the call as text.\n`
    + `- Display tools paint their output straight into the transcript as your reply and END the turn: show_file (a file), show_find (search results), show_command (a command's output), show_url (a page). Never re-describe what one showed, and never use one when you need the output back to decide the next step — that is read_file, grep_code, exec. The read steps are read_file, never show_file; the edit steps are edit_file, never write_file or str_replace_editor.\n`
    + continueRule
    + stopRule.replace('even the final step', 'even the final show_file')
    + `- After each passed step, update your todo_write list so what worked is written down. Put the two-line summary (which tools passed, how many retries each took) in the final todo item: the last step shows the file and ends the turn.`;
}
