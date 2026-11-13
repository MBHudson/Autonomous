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

import { store } from './store.js?v=432';

/** Fraction of the normal request rate agents get while training. */
export const TRAINING_THROTTLE = 0.5;

/** Folder the whole drill lives in. The sandbox jail still applies: this is
 *  resolved under the agent's writable root, never outside it. */
export const TRAINING_DIR = 'training';
export const TRAINING_FILE = 'training/training.txt';

/**
 * How many times one drill may be auto-resumed after a display step.
 *
 * A show_* call IS the reply and ends the turn, so without a resume the drill
 * would stop at the first display step. A budget (rather than "resume always")
 * keeps a model that keeps showing the same file from looping the turn forever.
 * Start resets it.
 */
export const TRAINING_RESUME_LIMIT = 6;

/**
 * The drill, simplest-first. One tool per step so a failure names exactly
 * what to retry. Approval-gated tools (write/exec/…) come after the free
 * ones, because each of those pauses on the operator's Approve button — that
 * pause is part of the lesson, not something to route around.
 */
export const TRAINING_TASKS = [
  { tool: 'think', label: 'Think one sentence about the drill before touching anything.' },
  { tool: 'todo_write', label: 'Write the drill steps below as your todo list, first one in_progress.' },
  { tool: 'echo', label: 'Echo the word "training" back.' },
  { tool: 'now', label: 'Report the current date and time.' },
  { tool: 'write_file', label: 'Create training/training.txt containing exactly the word "training". (Asks approval — wait for it, do not skip.)' },
  { tool: 'read_file', label: 'Read training/training.txt back and confirm it says "training".' },
  { tool: 'read_file', label: 'Read only line 1: call read_file with "training/training.txt 1-1". A range keeps a big file out of your context instead of pulling all of it in.' },
  { tool: 'edit_file', label: 'Append a second line "drill 2 passed" to training/training.txt. (Asks approval — wait for it.)' },
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
  { tool: 'show_file', label: 'Show training/training.txt to me with show_file — the file on screen IS the drill report. This ends the turn and the drill, so do not write the contents out again.' },
];

/** True while the operator has training mode armed. */
export function isTrainingActive() {
  try {
    return !!(store.get('settings.trainingMode') || {}).active;
  } catch {
    return false;
  }
}

/** Short numbered recap for the popup dialog. */
export function trainingStepList() {
  return TRAINING_TASKS.map((t, i) => `${i + 1}. ${t.tool} — ${t.label}`);
}

/**
 * The chat turn Start dispatches, so arming the mode IS starting the drill.
 * Self-contained on purpose: a fresh turn also carries the drill in its
 * system prompt, but a turn already in flight when Start is pressed was built
 * before arming — this text reaches those agents through the steer queue at
 * their next tool-loop boundary. Either way the drill runs through the normal
 * turn path, so messages, topology, metrics and trace all behave as usual.
 */
export function trainingKickoffFor() {
  const steps = TRAINING_TASKS.map((t, i) => `${i + 1}. ${t.tool}: ${t.label}`).join('\n');
  return `Training mode is ON — work this drill now, step by step, inside the "training" sandbox folder. Nothing else until it is done.\n`
    + `Steps:\n${steps}\n`
    + `Rules: one step at a time; a failed step is retried until it passes, never skipped — but READ the error and change the argument, because "Did you mean ..." or "not a file" means the path is wrong, not that the call should be sent again unchanged; paths stay relative to the sandbox (training/training.txt), never the project folder above it; write_file, edit_file and exec ask for my approval — waiting for it is part of the drill. After each passed step, update your todo list; the summary goes in the last todo item; the final show_file ends the drill.`;
}

/**
 * Whether a finished training turn should continue the drill.
 *
 * Two rules, both learned the hard way: `show_file` is the drill's LAST step, so
 * showing the finished file is the end rather than a step to continue from; and
 * the mode carries a resume budget so a model that keeps showing the same thing
 * cannot loop the turn forever.
 *
 * Pure (no store access) so the decision is testable without a chat instance.
 */
export function shouldResumeDrill(shownTool, mode) {
  if (!shownTool) return false;
  if (String(shownTool) === 'show_file') return false;
  return Number((mode || {}).drillResumes || 0) < TRAINING_RESUME_LIMIT;
}

/**
 * The text a resumed drill turn is dispatched with, after a display step ended
 * the previous turn. Deliberately short: the drill itself is already in the
 * system prompt, and the todo list says which step is next.
 */
export function trainingResumeFor() {
  return 'Training drill — continue with the NEXT step your todo list does not show completed. '
    + 'Do not repeat a completed step, do not restart the drill, and do not re-show output you already showed.';
}

/**
 * The system-prompt block injected in front of every agent's own prompt while
 * training is armed. Three jobs: INSTRUCT (the drill), PROBE (stay on it),
 * and REMEMBER (record each pass so the next turn reuses what worked).
 */
export function trainingBlockFor() {
  if (!isTrainingActive()) return '';
  const steps = TRAINING_TASKS.map((t, i) => `${i + 1}. ${t.tool}: ${t.label}`).join('\n');
  return `[TRAINING MODE — paced drill, ~50% request rate. Nothing else matters until the drill is done.]\n`
    + `Work ONLY these steps, in order, inside the "training" sandbox folder. Do not answer other questions, do not touch other files, do not start other work — if asked anything else, finish the current drill step first and say the drill comes first.\n`
    + `Steps:\n${steps}\n`
    + `Rules:\n`
    + `- One step at a time. Call the step's tool, read its result, then move on.\n`
    + `- If a tool call errors, is denied, or returns the wrong thing, read the error message and TRY AGAIN with fixed arguments. Keep retrying the SAME step — never skip a failed step, never move on until it returns ok.\n`
    + `- An error that says "Did you mean ..." or "not a file" is telling you the ARGUMENT is wrong: change it. Sending the identical call again fails identically.\n`
    + `- Paths are relative to the sandbox: training/training.txt. Never the project folder above it, and never an absolute C:\\... path.\n`
    + `- Some steps ask the operator for approval (write_file, edit_file, exec). That pause is normal: wait for it, do not work around it, do not narrate the call as text.\n`
    + `- Display tools paint their output straight into the transcript as your reply and END the turn: show_file (a file), show_find (search results), show_command (a command's output), show_url (a page). Never re-describe what one showed, and never use one when you need the output back to decide the next step — that is read_file, grep_code, exec.\n`
    + `- A display step ending the turn is NOT the drill ending: this mode resumes the drill with the next uncompleted step. Do not restart from step 1 and do not repeat a step your todo list marks completed.\n`
    + `- After each passed step, update your todo_write list so what worked is written down. Put the two-line summary (which tools passed, how many retries each took) in the final todo item: the last step shows the file and ends the turn.`;
}
