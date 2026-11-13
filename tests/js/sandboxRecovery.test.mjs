/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// sandbox recovery tests -- what happens when a model asks for the wrong thing.
//
// Usage: node tests/js/sandboxRecovery.test.mjs
//
// A small local model says "show ." instead of "list .", calls list_dir with no
// path at all, and names the project folder instead of the sandbox. Every one of
// those used to be an error string, and the model answered by making the same
// call again: the transcript filled with identical failures. These assertions pin
// the answers that end the loop -- a listing instead of "not a file", the allowed
// directories instead of "needs path", and the warning that a refused path was
// replaced by the sandbox listing.

import { TOOL_REGISTRY, bindSandboxTools } from '../../ui/js/tools.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const threw = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

console.log('sandbox recovery tests');
console.log('-'.repeat(60));

const calls = [];
const api = {
  sandbox: async (action, params) => {
    calls.push([action, params]);
    if (action === 'read') {
      if (params.path === 'folder') throw new Error('read_file: not a file: C:/sandbox/folder');
      if (params.path === 'missing.txt') throw new Error('read_file: not a file: C:/sandbox/missing.txt');
      return { path: 'C:/sandbox/a.txt', bytes: 2, truncated: false, content: 'hi' };
    }
    if (action === 'list') {
      if (params.path === 'folder') {
        return {
          path: 'C:/sandbox/folder', writable: true, skipped: 0,
          entries: [
            { type: 'dir', name: 'sub', size: 0 },
            { type: 'file', name: 'a.txt', size: 2 },
          ],
        };
      }
      if (!params.path) return { dirs: ['C:/sandbox'] };
      if (params.path === 'outside') {
        return {
          path: 'C:/sandbox', writable: true, skipped: 0,
          warning: 'list_dir: path is outside the allowed directories. Allowed: C:/sandbox',
          entries: [{ type: 'file', name: 'notes.txt', size: 12 }],
        };
      }
      throw new Error(`list_dir: not a directory: C:/sandbox/${params.path}`);
    }
    return {};
  },
};
bindSandboxTools(api);

// --- a directory given to a file tool answers with what is inside it --------
const listing = await TOOL_REGISTRY.read_file.run({ path: 'folder' }, null, {});
ok(listing.includes('sub/'), 'read_file on a directory lists the subdirectory');
ok(listing.includes('a.txt'), 'read_file on a directory lists the file');
ok(!/^error/.test(listing), 'read_file on a directory is not an error');
ok(calls.some(c => c[0] === 'list' && c[1].path === 'folder'),
  'and it is the list_dir call that answered');

// --- a genuinely missing file keeps the read error ---------------------------
const missing = await threw(() => TOOL_REGISTRY.read_file.run({ path: 'missing.txt' }, null, {}));
ok(missing && /not a file/.test(missing.message),
  'a missing file still reports not a file, not "not a directory"');

// --- list_dir with no path is an orientation call ----------------------------
const orient = await TOOL_REGISTRY.list_dir.run(null, null, {});
ok(orient.includes('C:/sandbox'), 'list_dir with no argument returns the allowed directories');
ok(!/needs "path"/.test(orient), 'list_dir with no argument no longer asks for a shape to retry');

// --- a refused list arrives with the sandbox in view and a warning ----------
const refused = await TOOL_REGISTRY.list_dir.run({ path: 'outside' }, null, {});
ok(refused.startsWith('warning:'), 'a refused path leads with the warning');
ok(refused.includes('notes.txt'), 'and still shows what the agent CAN see');

// --- a normal read is untouched ---------------------------------------------
const plain = await TOOL_REGISTRY.read_file.run('a.txt', null, {});
ok(plain.startsWith('C:/sandbox/a.txt') && plain.includes('hi'), 'a normal read is unchanged');

// --- a range can be spelled in the path OR as a JSON field ------------------
await TOOL_REGISTRY.read_file.run('a.txt 2-4', null, {});
ok(calls.at(-1)[1].range === '2-4', 'the "path 2-4" spelling sends the range');
await TOOL_REGISTRY.read_file.run({ path: 'a.txt', range: '2-4' }, null, {});
ok(calls.at(-1)[1].range === '2-4', 'the {"path","range"} spelling sends it too');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(errors.join('\n')); process.exit(1); }
