/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
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

import { store } from './store.js?v=426';

/** Fraction of the normal request rate agents get while training. */
export const TRAINING_THROTTLE = 0.5;

/** Folder the whole drill lives in. The sandbox jail still applies: this is
 *  resolved under the agent's writable root, never outside it. */
export const TRAINING_DIR = 'training';
export const TRAINING_FILE = 'training/training.txt';

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
  { tool: 'edit_file', label: 'Append a second line "drill 2 passed" to training/training.txt. (Asks approval — wait for it.)' },
  { tool: 'list_dir', label: 'List the training folder.' },
  { tool: 'glob_files', label: 'Find files matching "training/*".' },
  { tool: 'grep_code', label: 'Search the training folder for the word "training".' },
  { tool: 'exec', label: 'Run ["echo","training"] and confirm the output. (Asks approval — wait for it.)' },
  { tool: 'todo_write', label: 'Mark every drill step completed and stop: the drill is done.' },
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
    + `Rules: one step at a time; a failed step is retried until it passes, never skipped; write_file, edit_file and exec ask for my approval — waiting for it is part of the drill. After each passed step, update your todo list; when every step is completed, give a two-line summary (which tools passed, how many retries each took) and stop.`;
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
    + `- Some steps ask the operator for approval (write_file, edit_file, exec). That pause is normal: wait for it, do not work around it, do not narrate the call as text.\n`
    + `- After each passed step, update your todo_write list so what worked is written down. When every step is completed, give a two-line summary (which tools passed, how many retries each took) and stop.`;
}
