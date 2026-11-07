/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// toolCalls tests -- multi-call parsing, argv leniency, near-miss fields.
//
// Usage: node tests/js/toolCalls.test.mjs
//
// DOM-free like the other parser tests: tools.js touches no browser global
// at load, so the parser and the argv normaliser can be checked in Node.
// Each case was first observed in a live model reply: two calls in one
// reply used to run the first and silently drop the second; numbers in argv
// (["sleep", 5]) were refused outright; "parameters"/"input" argument names
// parsed to an undefined arg.

import { parseToolCalls, normaliseExecArgv } from '../../ui/js/tools.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('toolCalls tests');
console.log('-'.repeat(60));

// --- several calls in one reply ------------------------------------------------
{
  const calls = parseToolCalls(
    '{"tool":"list_dir","arg":{}}\n{"tool":"read_file","arg":{"path":"x"}}'
  );
  eq(calls.length, 2, 'two JSON calls parse');
  eq(calls[0].tool, 'list_dir', 'first call keeps its tool');
  eq(calls[1].arg, { path: 'x' }, 'second call keeps its arg');
}
{
  const calls = parseToolCalls('{"tool":"think","arg":{"thought":"hi"}}');
  eq(calls.length, 1, 'single call still parses');
}
{
  const calls = parseToolCalls('just some prose, no call here');
  eq(calls.length, 0, 'prose parses to nothing');
}
{
  // A call-shaped object hiding in prose is found, not skipped.
  const calls = parseToolCalls('Let me check:\n{"tool":"list_agents"} and go.');
  eq(calls.length, 1, 'prose-wrapped call parses');
  eq(calls[0].tool, 'list_agents', 'prose-wrapped call names the tool');
}
{
  // The reasoning-channel fallback still works when the text holds nothing.
  const calls = parseToolCalls(
    'I will call the tool now.',
    '{"tool":"recall"}'
  );
  eq(calls.length, 1, 'fallback reasoning parses');
}

// --- argv leniency ---------------------------------------------------------------
eq(normaliseExecArgv(['sleep', 5]), ['sleep', '5'], 'numbers coerce to strings');
eq(normaliseExecArgv(['head', '-n', 20]), ['head', '-n', '20'], 'flags and numbers mix');
eq(normaliseExecArgv(['ok', true]), ['ok', 'true'], 'booleans coerce to strings');
eq(normaliseExecArgv({ argv: ['ls', '-la'], timeout: 300 }), ['ls', '-la'],
  'timeout beside argv does not break the parse');
eq(normaliseExecArgv('pwd'), ['pwd'], 'bare string stays one element (server splits it)');
eq(normaliseExecArgv(['ls -la']), ['ls -la'], 'single string stays one element');
eq(normaliseExecArgv(['a', {}]), null, 'objects are never argv entries');
eq(normaliseExecArgv([]), null, 'empty array is nothing');

// --- near-miss argument field names ----------------------------------------------
{
  const calls = parseToolCalls('{"tool":"read_file","parameters":{"path":"x"}}');
  eq(calls.length, 1, 'parameters form parses');
  eq(calls[0].arg, { path: 'x' }, 'parameters become the arg');
}
{
  const calls = parseToolCalls('{"tool":"think","input":{"thought":"hi"}}');
  eq(calls.length, 1, 'input form parses');
  eq(calls[0].arg, { thought: 'hi' }, 'input becomes the arg');
}

for (const line of errors) {
  console.log(line);
}
console.log(`toolCalls: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
