/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// reasoningOpenByDefault tests -- the decision behind whether a Reasoning panel
// starts open.
//
// Usage: node tests/js/reasoningPanel.test.mjs
//
// DOM-free like the other unit tests: the rule takes a string and the saved
// preference, so the remembering behaviour can be checked in Node without a
// browser.

import {
  reasoningOpenByDefault, REASONING_OPEN_CHARS, isReasoningEcho, REASONING_ECHO_SLACK,
} from '../../ui/js/utils.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };

console.log('reasoningOpenByDefault tests');
console.log('-'.repeat(60));

// --- until the operator chooses, length decides -------------------------------
ok(reasoningOpenByDefault('short thought', undefined) === false, 'a short thought stays collapsed');
ok(reasoningOpenByDefault('x'.repeat(REASONING_OPEN_CHARS), undefined) === true,
  'exactly at the threshold opens');
ok(reasoningOpenByDefault('x'.repeat(REASONING_OPEN_CHARS - 1), undefined) === false,
  'one character short stays collapsed');
ok(reasoningOpenByDefault('   ', undefined) === false, 'whitespace is not thinking');
ok(reasoningOpenByDefault(null, undefined) === false, 'no reasoning at all stays collapsed');
ok(reasoningOpenByDefault(undefined, undefined) === false, 'undefined reasoning stays collapsed');
ok(reasoningOpenByDefault('x'.repeat(REASONING_OPEN_CHARS * 5), undefined) === true,
  'a very long trace opens');

// --- Auto is a choice, not an absence ---------------------------------------
ok(reasoningOpenByDefault('x'.repeat(REASONING_OPEN_CHARS), 'auto') === true,
  'auto still opens a long trace');
ok(reasoningOpenByDefault('short thought', 'auto') === false, 'auto still collapses a short one');
ok(reasoningOpenByDefault('x'.repeat(REASONING_OPEN_CHARS - 1), 'auto') === false,
  'auto keeps the threshold exactly');

// --- a saved choice wins, whatever the length --------------------------------
ok(reasoningOpenByDefault('short', true) === true, 'a remembered open wins over a short trace');
ok(reasoningOpenByDefault('x'.repeat(REASONING_OPEN_CHARS * 5), false) === false,
  'a remembered close wins over a long trace');
ok(reasoningOpenByDefault('', true) === true, 'a remembered open holds even with nothing to show');

// --- the threshold itself ----------------------------------------------------
ok(REASONING_OPEN_CHARS === 400, 'the threshold is 400 characters');

// --- reasoning that is really the reply --------------------------------------
// Hiding the panel is right when the provider echoed the answer into the
// reasoning field. It is wrong whenever the answer is merely PART of the trace:
// that is what made a long trace vanish at the moment of commit.
const longThought = 'Step one: list the agents, then read the roster. '
  + 'x'.repeat(900)
  + ' Final Answer: \\boxed{think}'
  + ' y'.repeat(400);
ok(isReasoningEcho('the same words', 'the same words') === true,
  'identical text is an echo');
ok(isReasoningEcho('  Same   WORDS\n', 'same words') === true,
  'case and whitespace do not defeat the echo rule');
ok(isReasoningEcho('Here is my answer: forty two', 'forty two') === true,
  'a reply wrapped in a short preamble is still an echo');
ok(isReasoningEcho('\\boxed{think}', '\\boxed{think}') === true,
  'the junk a local model emits as both answer and thought is an echo');
ok(isReasoningEcho(longThought, '\\boxed{think}') === false,
  'a short reply inside a long trace is NOT an echo -- the panel keeps its thinking');
ok(isReasoningEcho(longThought, 'think') === false,
  'a one-word reply inside a long trace is not an echo');
ok(isReasoningEcho(longThought, 'Step one: list the agents') === false,
  'restating one sentence of a long trace does not make it an echo');
ok(isReasoningEcho('', 'an answer') === false, 'no reasoning is not an echo');
ok(isReasoningEcho('a long thought about the task', '') === false,
  'a thoughts-only reply keeps its panel');
ok(isReasoningEcho(null, null) === false, 'nothing at all is not an echo');
ok(REASONING_ECHO_SLACK === 120, 'the wrapper allowance is 120 characters');
ok(isReasoningEcho('forty two ' + 'and then some more words '.repeat(9), 'forty two') === false,
  'a trace far longer than its reply is thinking, not an echo');

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
for (const e of errors) console.log('  ' + e);
process.exit(fail ? 1 : 0);
