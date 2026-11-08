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

import { parseToolCalls, normaliseExecArgv, repairToolName } from '../../ui/js/tools.js';

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
  // The reasoning-channel fallback is for a reply that said NOTHING of its own.
  // Prose means the channel is being mined for musings, and a model's musings
  // contain example JSON -- running those calls the same tool repeatedly.
  eq(parseToolCalls('I will call the tool now.', '{"tool":"recall"}').length, 0,
    'prose in the reply stops the reasoning fallback');
  eq(parseToolCalls('Final Answer: \\boxed{think}', '{"tool":"list_agents","arg":{}}').length, 0,
    'a stray answer stops the reasoning fallback');
  eq(parseToolCalls('I will explain the syntax first.',
    '{"tool":"list_agents"}\n{"tool":"echo","arg":"hi"}').length, 0,
    'examples in the reasoning do not run beside a prose reply');
  eq(parseToolCalls('   \n', '{"tool":"recall"}').length, 1,
    'an empty reply still gets the reasoning fallback');
  eq(parseToolCalls('', '{"tool":"recall"}').length, 1,
    'no text at all still gets the reasoning fallback');
  eq(parseToolCalls('{"tool":"read_file","arg":{"path":"x"}}', '{"tool":"recall"}').length, 1,
    'a real call is used and the reasoning fallback is not consulted');
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

// --- guessed tool names --------------------------------------------------------
// Every case below came from a real local-model reply: the name was right in
// meaning and wrong in spelling, the exact registry check refused it, and the
// turn ended as prose with no tool having run.
eq(repairToolName('list_agent'), 'list_agents', 'a missing plural names the same tool');
eq(repairToolName('Read-File'), 'read_file', 'case and hyphens fold to the registry spelling');
eq(repairToolName('read_fil'), 'read_file', 'a one-character slip is repaired');
eq(repairToolName('list_dir()'), 'list_dir', 'a stray () from prose is ignored');
eq(repairToolName('functions.read_file'), 'read_file', 'a namespace prefix is dropped');
eq(repairToolName('read_file'), 'read_file', 'an exact name is returned as given');
eq(repairToolName('search_web'), '', 'an invented name is not guessed at');
eq(repairToolName('now'), 'now', 'a short exact name still resolves');
eq(repairToolName('know'), '', 'a short near-miss is left alone');
eq(repairToolName(''), '', 'an empty name repairs to nothing');
{
  const calls = parseToolCalls('{"tool":"list_agent","arg":{}}');
  eq(calls.length, 1, 'a JSON call with a near-miss name parses');
  eq(calls[0].tool, 'list_agents', 'and runs the tool it meant');
}
{
  // Two equally close candidates mean the intent is ambiguous: refuse rather
  // than run the wrong tool.
  const names = ['read_file', 'read_note'];
  const probes = ['read_fil'];
  const repaired = probes.map(repairToolName);
  ok(repaired.some(name => names.includes(name)) || repaired[0] === '',
    'an ambiguous repair either resolves to one real tool or refuses');
}

// --- guessed wrappers ----------------------------------------------------------
// LM Studio / Llama templates wrap a call in <|begin|> … <|end|>; the body is
// ordinary JSON, so only the wrapper needs accepting.
{
  const calls = parseToolCalls('<|begin|>\n{"tool": "list_agents", "arg": {}}\n<|end|>');
  eq(calls.length, 1, 'a begin/end fence around JSON parses');
  eq(calls[0].tool, 'list_agents', 'the fenced call keeps its tool');
}
{
  const calls = parseToolCalls('<answer>\n{"tool": "list_agents", "arg": {}}\n</answer>');
  eq(calls.length, 1, 'an answer wrapper around JSON parses');
}
{
  const calls = parseToolCalls('<|begin|>list_agents<|end|>');
  eq(calls.length, 1, 'a begin/end fence around a bare name parses');
  eq(calls[0].tool, 'list_agents', 'the bare fenced name is the tool');
}
{
  const calls = parseToolCalls('<|begin|>read_file{"path":"x"}<|end|>');
  eq(calls.length, 1, 'a begin/end fence around name+JSON parses');
  eq(calls[0].arg, { path: 'x' }, 'the fenced name+JSON keeps its arg');
}
{
  const calls = parseToolCalls('<|begin|>I will look at the files now.<|end|>');
  eq(calls.length, 0, 'prose inside a fence is not a call');
}
{
  const calls = parseToolCalls('<|tool|>{"tool":"list_agent"}<|/tool|>');
  eq(calls.length, 1, 'a <|tool|> fence parses');
  eq(calls[0].tool, 'list_agents', 'and its near-miss name is repaired');
}

for (const line of errors) {
  console.log(line);
}
console.log(`toolCalls: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
