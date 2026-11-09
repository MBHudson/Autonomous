/* KEEP THE COPYRIGHT BELOW INTACT */
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// pathText tests -- nested path objects must never become "[object Object]".
//
// Usage: node tests/js/toolPath.test.mjs
//
// DOM-free: tools.js touches no browser global at load.
//
// Each case was first observed live: a model sent {"path":{"path":"..."}} and
// String() turned it into the literal "[object Object]", which the server
// then jailed and reported as a missing file -- an error the model could not
// correct, so training mode's retry rule looped on it.

import { pathText } from '../../ui/js/tools.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('pathText tests');
console.log('-'.repeat(60));

eq(pathText('training/training.txt'), 'training/training.txt', 'plain string passes through');
eq(pathText(''), '', 'empty string stays empty (callers decide what empty means)');
eq(pathText(20), '20', 'number stringifies');
eq(pathText({ path: 'training/training.txt' }), 'training/training.txt', 'object with path unwraps');
eq(pathText({ path: { path: 'training/training.txt' } }), 'training/training.txt', 'nested path unwraps one level');
eq(pathText({ arg: 'training/training.txt' }), 'training/training.txt', 'object with arg unwraps');
eq(pathText({}), null, 'empty object is null, never "[object Object]"');
eq(pathText({ path: { deep: 1 } }), null, 'unresolvable nesting is null');
eq(pathText({ path: ['a'] }), null, 'array path is null');
eq(pathText(['training/training.txt']), null, 'top-level array is null');
eq(pathText(null), null, 'null is null');
eq(pathText(undefined), null, 'undefined is null');
ok(pathText({ path: 'x' }) !== '[object Object]', 'never the literal "[object Object]"');
ok(pathText({ path: { path: 'x' } }) !== '[object Object]', 'never the literal, nested either');

console.log('-'.repeat(60));
if (fail) {
  for (const e of errors) console.log(e);
  console.log(`${pass} passed, ${fail} FAILED`);
  process.exit(1);
}
console.log(`${pass} passed, 0 failed`);
