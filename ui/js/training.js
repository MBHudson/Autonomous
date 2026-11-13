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

import { store } from './store.js?v=446';

/** Fraction of the normal request rate agents get while training. */
export const TRAINING_THROTTLE = 0.5;

/** Folder the whole drill lives in. The sandbox jail still applies: this is
 *  resolved under the agent's writable root, never outside it. */
export const TRAINING_DIR = 'training';
export const TRAINING_FILE = 'training/training.txt';
/** Placeholder in the step labels, filled with the caller's own drill file. */
export const TRAINING_FILE_TOKEN = '{file}';

/**
 * The drill file for one agent.
 *
 * Every active agent trains in the SAME sandbox, so one shared training.txt
 * let two passes collide: agent B's completed output was what agent A's step 7
 * read, A's step 8 then added a second "drill 2 passed" line, and A's step 9
 * could not match uniquely ("old string appears 2 times"). A file per agent
 * makes the drill's own state private to the pass that produced it.
 */
export function trainingFileFor(agent) {
  const raw = String((agent && (agent.id || agent.code || agent.name)) || 'agent');
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-48) || 'agent';
  return `${TRAINING_DIR}/training-${slug}.txt`;
}

/** Generic wording for surfaces that describe the drill to the operator. */
const fileForSteps = (agent) => agent ? trainingFileFor(agent) : 'training/training-<agent>.txt';
const fillFile = (text, agent) => String(text).split(TRAINING_FILE_TOKEN).join(fileForSteps(agent));

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
  { tool: 'read_file', label: 'Read {file} back and confirm it says "training".' },
  { tool: 'read_file', label: 'Read only line 1 of {file}: call read_file with that path plus " 1-1" in the range. A range keeps a big file out of your context instead of pulling all of it in.' },
  { tool: 'edit_file', label: 'In {file}, replace the exact text "training" with "training\\ndrill 2 passed" — old_string is the text you match, new_string is what replaces it; edit_file is search-and-replace, never an append. (Asks approval — wait for it.)' },
  { tool: 'edit_file', label: 'Replace the exact line "drill 2 passed" with "drill 2 passed (exact match)". (Asks approval — old_string/new_string edits only touch the text you name.)' },
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
  { tool: 'show_file', label: 'Show {file} to me with show_file — the file on screen IS the drill report. This ends the turn; the mode then sends Continue for a fresh pass, so do not write the contents out again.' },
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

/** Which drill a mode setting selects. Unknown/legacy settings are Hard. */
export function trainingDifficulty(mode) {
  return mode && mode.difficulty === 'easy' ? 'easy' : 'hard';
}

/** The ordered task table for a difficulty. */
export function trainingTasksFor(difficulty) {
  return difficulty === 'easy' ? TRAINING_TASKS_EASY : TRAINING_TASKS;
}

/** The index-aligned checks for a difficulty. */
export function trainingChecksFor(difficulty) {
  return difficulty === 'easy' ? DRILL_CHECKS_EASY : DRILL_CHECKS;
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
export function drillVerdict(calls, file = TRAINING_FILE, difficulty = 'hard') {
  const tasks = trainingTasksFor(difficulty);
  const checks = trainingChecksFor(difficulty);
  const total = tasks.length;
  const list = Array.isArray(calls) ? calls.filter(c => c && c.tool) : [];
  const blank = () => ({ step: 0, failures: 0, retries: 0, pending: false, failedAt: null, offStep: 0, offTool: '' });
  let cur = blank();
  let passes = 0;
  let cleanPasses = 0;
  let last = null;
  let lastKey = '';
  let lastStatus = '';

  for (const call of list) {
    const tool = String(call.tool);
    const status = String(call.status || '');

    // A finished pass: only the drill's first step opens the next one.
    if (cur.step >= total) {
      if (tool !== tasks[0].tool) continue;
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
      cur.failures++;
      if (cur.failedAt === null) cur.failedAt = cur.step + 1;
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
      cur.failures++;
      if (cur.failedAt === null) cur.failedAt = cur.step + 1;
      if (retry) cur.retries++;
      continue;
    }
    // running / skipped / unknown: the step may yet happen, but it has not.
    if (status !== 'ok') continue;
    cur.step++;
  }

  const complete = cur.step >= total;
  if (complete) {
    passes++;
    if (cur.failures === 0 && !cur.pending) cleanPasses++;
    last = cur;
  }
  // While a new pass is in progress the judgement is still the finished one.
  const judged = complete ? cur : last;
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
    retries: cur.retries,
    pending: cur.pending,
    failedAt: cur.failedAt,
    // Calls since the last step progress that were for another tool. Not a
    // failure (the step was never attempted), but the visible sign of a model
    // that lost its place.
    offStep: cur.offStep,
    offTool: cur.offTool,
    nextTool: complete ? '' : (tasks[cur.step]?.tool || ''),
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
  const base = trainingDifficulty(mode) === 'easy' ? 'easy drill' : 'drill';
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

/** Short numbered recap for the popup dialog. */
export function trainingStepList(agent = null, difficulty = 'hard') {
  return trainingTasksFor(difficulty).map((t, i) => `${i + 1}. ${t.tool} — ${fillFile(t.label, agent)}`);
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
  const diff = difficulty || trainingDifficulty(store.get('settings.trainingMode'));
  const tasks = trainingTasksFor(diff);
  const stepLabel = (label) => String(label).split(TRAINING_FILE_TOKEN).join('your drill file');
  const steps = tasks.map((t, i) => `${i + 1}. ${t.tool}: ${stepLabel(t.label)}`).join('\n');
  // Easy ends on todo_write, Hard ends on show_file: naming the wrong final
  // tool here would send an Easy run looking for a step it does not have.
  const ending = diff === 'easy'
    ? 'After each passed step, update your todo list; the final todo_write completes the 12-step pass — the mode then sends Continue again, so begin a fresh pass instead of waiting.'
    : 'After each passed step, update your todo list; the summary goes in the last todo item; the final show_file ends the PASS — the mode then sends Continue again, so begin a fresh pass instead of waiting.';
  return `Training mode is ON — work this drill now, step by step, inside the "training" sandbox folder. Nothing else while it is on.\n`
    + `Steps:\n${steps}\n`
    + `Rules: one step at a time; a failed step is retried until it passes, never skipped — but READ the error and change the argument, because "Did you mean ..." or "not a file" means the path is wrong, not that the call should be sent again unchanged; every agent has its OWN file in the training folder — use the exact path in your TRAINING MODE block, which the app also repeats when this kickoff reaches a turn already in flight — never another agent's file, and never the project folder above the sandbox; write_file, edit_file and exec ask for my approval — waiting for it is part of the drill. ${ending}`;
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
  const tasks = trainingTasksFor(difficulty);
  const file = fileForSteps(agent);
  const steps = tasks.map((t, i) => `${i + 1}. ${t.tool}: ${fillFile(t.label, agent)}`).join('\n');
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
    + `Work ONLY these steps, in order, inside the "training" sandbox folder. Do not answer other questions, do not touch other files, do not start other work — if asked anything else, finish the current drill step first and say the drill comes first.\n`
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

  return opening
    + `- One step at a time. Call the step's tool, read its result, then move on.\n`
    + `- If a tool call errors, is denied, or returns the wrong thing, read the error message and TRY AGAIN with fixed arguments. Keep retrying the SAME step — never skip a failed step, never move on until it returns ok.\n`
    + `- An error that says "Did you mean ..." or "not a file" is telling you the ARGUMENT is wrong: change it. Sending the identical call again fails identically.\n`
    + `- edit_file is exact search-and-replace, never an append: old_string is the text you match, new_string replaces it. To add a line, anchor on the neighbouring text (old_string "training" → new_string "training\\ndrill 2 passed"). An empty or ambiguous old_string is refused, so a bare append can never pass.\n`
    + `- Paths are relative to the sandbox: ${file}. Never the project folder above it, and never an absolute C:\\... path. Every agent has its OWN drill file — do not read or edit another agent's.\n`
    + `- THIS RUN uses the file above. Any earlier training transcript that mentions training/training.txt is an OLD run: ignore its paths and copy nothing from it.\n`
    + positionRule
    + `- Some steps ask the operator for approval (write_file, edit_file, exec). That pause is normal: wait for it, do not work around it, do not narrate the call as text.\n`
    + `- Display tools paint their output straight into the transcript as your reply and END the turn: show_file (a file), show_find (search results), show_command (a command's output), show_url (a page). Never re-describe what one showed, and never use one when you need the output back to decide the next step — that is read_file, grep_code, exec.\n`
    + `- The Continue message names the step the app recorded for you. Resume at that step; do not start another pass while steps remain — the app saw every call you made, so an early restart shows up as off-step calls.\n`
    + `- This mode never lets the drill stop. When a turn ends — a display step, a short reply, even the final show_file — you are sent "Continue" automatically. Treat Continue as the next instruction: pick up the first step your todo list does not show completed, and when every step is complete, start a fresh pass at step 1. Never say the drill is finished, never ask whether to continue, never wait for the operator.\n`
    + `- After each passed step, update your todo_write list so what worked is written down. Put the two-line summary (which tools passed, how many retries each took) in the final todo item: the last step shows the file and ends the turn.`;
}
