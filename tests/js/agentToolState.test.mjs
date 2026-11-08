/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// agentToolState tests -- does the agent editor say what this agent can do?
//
// Usage: node tests/js/agentToolState.test.mjs
//
// The editor is where the file tools are chosen for one agent, and a per-agent
// root can name a folder the server refuses. A global line about the sandbox
// cannot see that, so the state has to be computed per agent -- and it has to
// avoid claiming a working directory it has not been told about.

import { agentToolState } from '../../ui/js/utils.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };

console.log('agent tool state tests');
console.log('-'.repeat(60));

const jailOn = { enabled: true, read_roots: ['/srv/site'], write_roots: ['/srv/site'] };
const jailOff = { enabled: false, read_roots: [], write_roots: [] };

// --- the happy path ----------------------------------------------------------
const follow = agentToolState({ unbound: [], status: jailOn, root: '' });
ok(follow.tone === 'ok', 'bound tools and a live jail read as ok');
ok(follow.text.startsWith('File tools: bound'), 'and say so plainly');
ok(follow.text.includes('/srv/site'), 'naming the directory the agent follows');
ok(!follow.text.includes('⚠'), 'with no warning sign');

const own = agentToolState({ unbound: [], status: jailOn, root: '/srv/site/ui' });
ok(own.tone === 'ok', 'a root inside the allowlist is fine');
ok(own.text.includes('/srv/site/ui'), 'and the agent is described as jailed to it');
ok(!own.text.includes('server\'s working directory'), 'not as following the global one');

// The server compares forward-slash paths; a Windows value reaches it that way.
const win = {
  enabled: true,
  read_roots: ['C:\\site'],
  write_roots: ['C:\\site'],
};
ok(agentToolState({ unbound: [], status: win, root: 'c:/site/ui/' }).tone === 'ok',
  'a Windows root matches however it is spelled');

// --- a per-agent root nobody allows -----------------------------------------
const outside = agentToolState({ unbound: [], status: jailOn, root: '/home/me/notes' });
ok(outside.tone === 'warn', 'a root outside the allowlist is a warning');
ok(outside.text.includes('/home/me/notes'), 'the offending root is named');
ok(outside.text.includes('not one of the server'), 'and the reason is stated');
ok(!outside.text.includes('BIND FILE TOOLS'),
  'a root problem does not offer a rebind it cannot perform');
ok(outside.text.includes('working directory in Config'), 'it points at the setting instead');

// --- the server has no directory at all -------------------------------------
const off = agentToolState({ unbound: [], status: jailOff, root: '' });
ok(off.tone === 'warn', 'an empty jail is a warning');
ok(off.text.includes('no working directory'), 'and says which half is missing');
ok(off.text.includes('working directory in Config'), 'pointing at the setting that fixes it');
ok(!off.text.includes('BIND FILE TOOLS'), 'no button for something a click cannot change');

// --- the page never bound its runners ---------------------------------------
const unbound = agentToolState({ unbound: ['write_file', 'read_file'], status: jailOn, root: '' });
ok(unbound.tone === 'warn', 'unbound tools are a warning');
ok(unbound.text.includes('never bound write_file'), 'the names are given');
ok(unbound.text.includes('read_file'), 'all of them');
ok(unbound.text.includes('BIND FILE TOOLS'), 'and the fix points at the button beside it');
ok(!unbound.text.includes('no working directory'), 'a live jail is not blamed');

const both = agentToolState({ unbound: ['write_file'], status: jailOff, root: '' });
ok(both.text.includes('never bound write_file') && both.text.includes('no working directory'),
  'both halves are named together');
ok((both.text.match(/⚠/g) || []).length === 1, 'one warning, not two stacked');

const many = agentToolState({ unbound: ['a', 'b', 'c', 'd', 'e', 'f'], status: jailOn, root: '' });
ok(many.text.includes('a, b, c, d and 2 more'), 'a long unbound list is summarised');

// --- unknown is not the same as fine ----------------------------------------
const unknown = agentToolState({ unbound: [], status: null, root: '' });
ok(unknown.tone === 'unknown', 'an unreachable status is its own state');
ok(unknown.text.includes('could not be checked'), 'which says exactly that');
ok(!unknown.text.includes('⚠'), 'and does not cry wolf');
ok(!unknown.text.includes('agents can read and write'), 'nor promise anything');

const pending = agentToolState({ unbound: ['write_file'], status: null, root: '' });
ok(pending.tone === 'warn', 'a known unbound tool still warns without the status');
ok(!pending.text.includes('no working directory'), 'without guessing at the jail');

// --- jitter -----------------------------------------------------------------
ok(agentToolState().tone === 'unknown', 'no arguments is not an error');
ok(agentToolState({ unbound: 'write_file', status: 'x', root: 12 }).tone === 'unknown',
  'garbage in every slot is ignored rather than trusted');
ok(agentToolState({ unbound: [1, '', null], status: jailOn }).tone === 'ok',
  'non-string unbound entries do not count as tools');

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
for (const e of errors) console.log('  ' + e);
process.exit(fail ? 1 : 0);
