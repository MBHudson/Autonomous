/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// fileToolWarning tests -- is the chat warned before a model can claim a write?
//
// Usage: node tests/js/fileToolWarning.test.mjs
//
// The reply comes after the tools ran (or did not), so a warning placed in the
// reply is already too late to stop the transcript claiming a file that is not
// on disk. These assertions cover the sentence the chat adds at the top of a
// turn, for each way the tools can be unusable.

import { fileToolWarning } from '../../ui/js/utils.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };

console.log('file tool warning tests');
console.log('-'.repeat(60));

const jailOn = { enabled: true, read_roots: ['/srv/site'], write_roots: ['/srv/site'] };
const jailOff = { enabled: false, read_roots: [], write_roots: [] };

// --- the happy path says nothing --------------------------------------------
ok(fileToolWarning([], jailOn) === '', 'bound tools and a live jail produce no warning');
ok(fileToolWarning([], null) === '', 'no status to judge and nothing unbound is not a warning');
ok(fileToolWarning(undefined, undefined) === '', 'missing arguments are not an error');

// --- browser side: the binding never happened -------------------------------
const unbound = fileToolWarning(['write_file', 'read_file'], jailOn);
ok(unbound.includes('never bound write_file'), 'an unbound tool is named');
ok(unbound.includes('read_file'), 'and so is the rest of the list');
ok(unbound.includes('not on disk'), 'the consequence is stated, not implied');
ok(unbound.includes('BIND FILE TOOLS'), 'the fix points at the button in the same bubble');
ok(!unbound.includes('Reload the page'), 'and no longer sends the operator to a reload');
ok(!unbound.includes('no allowed directory'), 'a live jail is not blamed');

// A long list is summarised rather than printed whole.
const many = fileToolWarning(['a', 'b', 'c', 'd', 'e', 'f'], jailOn);
ok(many.includes('a, b, c, d and 2 more'), 'a long unbound list is summarised');

// --- server side: the jail has no directory ---------------------------------
const noJail = fileToolWarning([], jailOff);
ok(noJail.includes('no allowed directory'), 'an empty jail is reported');
ok(noJail.includes('Working Project Directory'), 'and points at the setting that fixes it');
ok(noJail.includes('not on disk'), 'the consequence is stated here too');

// --- both halves at once ----------------------------------------------------
const both = fileToolWarning(['write_file'], jailOff);
ok(both.includes('never bound write_file') && both.includes('no allowed directory'),
  'both failures are named together');
ok((both.match(/⚠/g) || []).length === 1, 'one warning, not two stacked');

// --- jitter ----------------------------------------------------------------
ok(fileToolWarning('write_file', jailOff).includes('no allowed directory'),
  'a non-array unbound value is ignored rather than trusted');
ok(fileToolWarning([], { enabled: 'no' }) === '',
  'only an explicit false counts as a disabled jail');

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
for (const e of errors) console.log('  ' + e);
process.exit(fail ? 1 : 0);
