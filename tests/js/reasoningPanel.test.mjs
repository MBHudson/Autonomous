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

import { reasoningOpenByDefault, REASONING_OPEN_CHARS } from '../../ui/js/utils.js';

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

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
for (const e of errors) console.log('  ' + e);
process.exit(fail ? 1 : 0);
