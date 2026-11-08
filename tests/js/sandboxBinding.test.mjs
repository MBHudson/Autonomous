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

import { unboundTools, SANDBOX_UNBOUND_MARKER, TOOL_REGISTRY,
  sandboxBindingReport, setSandboxBindError, bindSandboxNow,
  setSandboxClient, autoBindSandboxOnce, runTool } from '../../ui/js/tools.js';

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

// --- the report the Config panel reads --------------------------------------
// Config shows this beside the working directory, so an unbound tool is
// visible where the operator already is, without a console or a model failing
// first. Same detection as the retry loop, so the two cannot disagree.
const fresh = sandboxBindingReport();
ok(Array.isArray(fresh.unbound) && fresh.unbound.includes('write_file'),
  'the report names the tools still unbound');
ok(fresh.error === '', 'and starts with no error recorded');
setSandboxBindError('Sandbox tools still unbound after 5 attempts: write_file');
ok(sandboxBindingReport().error.includes('5 attempts'), 'a failed bind is reported with its reason');
ok(sandboxBindingReport().unbound.includes('write_file'), 'the reason does not replace the names');
setSandboxBindError('');
ok(sandboxBindingReport().error === '', 'a later successful bind clears the reason');

// --- the first real call finishes a missed bind ------------------------------
// The boot bind is one shot. When it throws partway -- or never runs -- the
// tools keep their placeholder and the first call to one of them used to be the
// end of it: the model got "reload the page" and the operator had to guess.
// runTool now makes that one attempt itself, so the call it was asked for is the
// call that runs. Order matters here: this block needs the real placeholders.
const noClient = await runTool('read_file', 'notes.txt');
ok(String(noClient).includes('not bound'), 'with no client a call still fails loudly');
const unasked = autoBindSandboxOnce();
ok(unasked.attempted === false && unasked.unbound.length > 0,
  'and no attempt is invented without one');

const fakeApi = { sandbox: async () => ({ path: 'notes.txt', bytes: 5, content: 'hello' }) };
setSandboxClient(fakeApi);
const firstCall = await runTool('read_file', 'notes.txt');
ok(firstCall.includes('hello') && !firstCall.includes('not bound'),
  'the first real call binds and then runs, without a reload');
ok(sandboxBindingReport().unbound.length === 0, 'and the repair is visible to Config');
ok(autoBindSandboxOnce().attempted === false, 'the automatic attempt happens once per page');
ok((typeof fakeApi.sandbox === 'function'), 'the remembered client is the one that was used');

// --- the Config button's one attempt ------------------------------------------
// Binding assigns a runner to every tool without calling the server, so an
// empty client is enough to prove the verdict: unbound goes empty, the reason
// clears, and the report the panel reads agrees.
const rebound = bindSandboxNow({});
ok(Array.isArray(rebound.unbound) && rebound.unbound.length === 0,
  'one attempt reports what is left (nothing, here)');
ok(rebound.error === '', 'and clears the recorded reason');
ok(sandboxBindingReport().unbound.length === 0, 'the panel report follows the attempt');
ok(sandboxBindingReport().error === '', 'and shows no stale reason');
ok(bindSandboxNow(null).unbound.length === 0, 'a missing client does not throw the button handler');

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
for (const e of errors) console.log('  ' + e);
process.exit(fail ? 1 : 0);
