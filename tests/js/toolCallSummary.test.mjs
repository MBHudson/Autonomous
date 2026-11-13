/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// toolCallSummary tests -- does the tool-call box TELL the operator how many
// calls failed, and how many were retries?
//
// Usage: node tests/js/toolCallSummary.test.mjs
//
// During a training drill the question is not "what did the agent run" but "how
// many times did that step fail before it worked". The header said only
// "5 tool calls", so a turn that burned six attempts on one step looked clean
// unless every disclosure was opened. These assertions pin the count: a failure
// is a recorded error, and a retry is the same tool + same arguments sent again
// after one.

import { toolCallSummary } from '../../ui/js/utils.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('tool call summary tests');
console.log('-'.repeat(60));

const call = (tool, arg, status) => ({ tool, arg, status, result: '' });

// --- nothing to count -------------------------------------------------------
eq(toolCallSummary([]).total, 0, 'an empty turn counts zero');
eq(toolCallSummary(null).failed, 0, 'a missing list is not a crash');
eq(toolCallSummary([]).retries, 0, 'and has no retries');

// --- a clean turn -----------------------------------------------------------
{
  const s = toolCallSummary([call('think', 'a', 'ok'), call('echo', 'b', 'ok'), call('now', null, 'ok')]);
  eq(s.total, 3, 'three calls are counted');
  eq(s.failed, 0, 'a clean turn has no failures');
  eq(s.retries, 0, 'and no retries');
}

// --- one failure, then the same call fixed ---------------------------------
{
  const s = toolCallSummary([
    call('read_file', { path: 'nope.txt' }, 'error'),
    call('read_file', { path: 'nope.txt' }, 'ok'),
  ]);
  eq(s.failed, 1, 'the failed attempt is counted');
  eq(s.retries, 1, 'the identical call after it is a retry');
}

// --- two failures, then success --------------------------------------------
{
  const s = toolCallSummary([
    call('list_dir', { path: '.' }, 'error'),
    call('list_dir', { path: '.' }, 'error'),
    call('list_dir', { path: '.' }, 'ok'),
  ]);
  eq(s.failed, 2, 'both failures are counted');
  eq(s.retries, 2, 'each repeated attempt after a failure is a retry');
}

// --- a different argument is a different call ------------------------------
{
  const s = toolCallSummary([
    call('read_file', { path: 'a.txt' }, 'error'),
    call('read_file', { path: 'b.txt' }, 'ok'),
  ]);
  eq(s.failed, 1, 'the failure is counted');
  eq(s.retries, 0, 'a corrected argument is not a retry of the old one');
}

// --- skipped steps are not failures ----------------------------------------
{
  const s = toolCallSummary([
    call('show_file', { path: 'a.txt' }, 'ok'),
    call('grep_code', { pattern: 'x' }, 'skipped'),
  ]);
  eq(s.failed, 0, 'a step skipped by a display tool is not a failure');
  eq(s.retries, 0, 'and is not a retry');
  eq(s.total, 2, 'but it is still a call in the turn');
}

// --- a failure that is never retried ---------------------------------------
{
  const s = toolCallSummary([call('exec', ['nope'], 'error')]);
  eq(s.failed, 1, 'a lone failure is counted');
  eq(s.retries, 0, 'with no retry to report');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(errors.join('\n')); process.exit(1); }
