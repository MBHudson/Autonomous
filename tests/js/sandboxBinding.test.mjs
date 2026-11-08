/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// unboundTools tests -- can the app tell that the sandbox binding failed?
//
// Usage: node tests/js/sandboxBinding.test.mjs
//
// The app used to bind the server-backed tools once, inside a try/catch that
// swallowed the error, with no way to ask afterwards whether it worked. An
// unbound write_file then answered with a placeholder a model read as success.
// These assertions cover the check the retry loop in app.js is built on.

import { unboundTools, SANDBOX_UNBOUND_MARKER, TOOL_REGISTRY } from '../../ui/js/tools.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };

console.log('sandbox binding tests');
console.log('-'.repeat(60));

// --- the marker is the thing being looked for --------------------------------
ok(typeof SANDBOX_UNBOUND_MARKER === 'string' && SANDBOX_UNBOUND_MARKER.length > 10,
  'the unbound marker is a stable string');

// --- the real registry, before any binding ------------------------------------
const real = unboundTools();
ok(real.includes('write_file'), 'an unbound registry reports write_file');
ok(real.includes('read_file'), 'and read_file');
ok(!real.includes('list_agents'), 'a tool with a real runner is not reported');
ok(real.length > 5, `several server-backed tools start unbound (${real.length})`);

// --- a fake registry, so the check is not tied to the real one ---------------
// The message is written out, not referenced through the constant: a foreign
// registry can only be judged by what its runners say, and this is that path.
const placeholder = { run: () => { throw new Error('the sandbox file API is not bound — reload the page'); } };
const bound = { run: async () => 'ok' };
ok(JSON.stringify(unboundTools({ a: placeholder, b: bound })) === '["a"]',
  'exactly the placeholder is reported');
ok(unboundTools({ a: bound, b: bound }).length === 0, 'a fully bound registry reports nothing');
ok(unboundTools({ c: {} }).length === 0, 'an entry with no runner is not counted as unbound');
ok(unboundTools(null).length === 0, 'a missing registry is not an error');
ok(unboundTools({ a: { run: 'not a function' } }).length === 0, 'a non-function runner is ignored');

// --- partial binding is the dangerous case ----------------------------------
// One entry missing used to abort the binder partway: everything assigned
// before it worked, everything after stayed a placeholder, and nothing said so.
const partial = {
  read_file: bound,
  write_file: placeholder,
  exec: placeholder,
};
const left = unboundTools(partial);
ok(left.length === 2 && left.includes('write_file') && left.includes('exec'),
  'a partial bind names precisely what is left');

// --- the real entries throw the marker, not a friendly sentence -------------
let message = '';
try { TOOL_REGISTRY.write_file.run({ path: 'x', content: 'y' }, null, {}); } catch (err) { message = err.message; }
ok(message.includes('not bound'), 'an unbound call fails loudly instead of returning a status');

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
for (const e of errors) console.log('  ' + e);
process.exit(fail ? 1 : 0);
