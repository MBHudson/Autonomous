/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// Foreign tool names: a model trained on another agent's tools calls `bash`,
// `Read`, `Grep`. Those calls are resolved onto our tools at parse time, so no
// prompt teaches them and no request is spent on the vocabulary difference.
//
// The properties worth protecting here, in order:
//   1. A foreign name never silently becomes a DISPLAY tool. `bash` means "run
//      it"; turning that into show_command hands the operator output the agent
//      believes it can read.
//   2. A shell string that needs a shell is not chopped into an argv. Refusing
//      is better than running a command the model did not ask for.
//   3. Our own names and arguments are untouched.

import {
  TOOL_ALIASES, resolveToolName, aliasToolArgs, splitCommandLine,
  parseToolCalls, stripToolCall, DISPLAY_TOOLS, TOOL_REGISTRY,
} from '../../ui/js/tools.js';

let pass = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else errors.push(`FAIL: ${name}`); };
const eq = (got, want, name) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else errors.push(`FAIL: ${name} (got ${g}, want ${w})`);
};

const call = text => parseToolCalls(text)[0] || null;

// --- names resolve onto ours --------------------------------------------------
eq(resolveToolName('bash'), 'exec', 'bash is exec');
eq(resolveToolName('Bash'), 'exec', 'capitalised Bash is exec');
eq(resolveToolName('Read'), 'read_file', 'Read is read_file');
eq(resolveToolName('Grep'), 'grep_code', 'Grep is grep_code');
eq(resolveToolName('LS'), 'list_dir', 'LS is list_dir');
eq(resolveToolName('Write'), 'write_file', 'Write is write_file');
eq(resolveToolName('Edit'), 'edit_file', 'Edit is edit_file, never write_file');
eq(resolveToolName('webfetch'), 'fetch_url', 'webfetch is fetch_url');
eq(resolveToolName('functions.grep'), 'grep_code', 'a prefixed foreign name still resolves');
eq(resolveToolName('read_file'), 'read_file', 'our own name is left alone');
eq(resolveToolName('frobnicate'), 'frobnicate', 'an unknown name is left alone');

// No alias may point at a display tool.
const displayTargets = Object.entries(TOOL_ALIASES)
  .filter(([, target]) => DISPLAY_TOOLS.includes(target) || TOOL_REGISTRY[target]?.display);
ok(displayTargets.length === 0, `no alias targets a display tool (${JSON.stringify(displayTargets)})`);

// --- arguments are reshaped, not guessed -------------------------------------
eq(splitCommandLine('tail -n 200 logs/app.log'), ['tail', '-n', '200', 'logs/app.log'], 'a plain command splits');
eq(splitCommandLine('grep -rn "time out" .'), ['grep', '-rn', 'time out', '.'], 'quoted spaces stay one token');
eq(splitCommandLine('cat x | head'), null, 'a pipe is refused, not chopped');
eq(splitCommandLine('echo hi && rm -rf /'), null, '&& is refused');
eq(splitCommandLine('echo "unterminated'), null, 'an unterminated quote is refused');

// --- end to end through the parser -------------------------------------------
eq(call('{"tool":"Bash","arg":{"command":"tail -n 200 logs/app.log"}}'),
  { tool: 'exec', arg: { argv: ['tail', '-n', '200', 'logs/app.log'] } },
  'a bash call becomes an exec argv');

eq(call('{"tool":"Read","arg":{"file_path":"docs/notes.md"}}'),
  { tool: 'read_file', arg: 'docs/notes.md' },
  'Read unwraps file_path onto read_file\'s scalar path');

eq(call('{"tool":"Grep","arg":{"pattern":"timeout"}}'),
  { tool: 'grep_code', arg: 'timeout' },
  'Grep keeps its pattern');

eq(call('{"tool":"LS","arg":{"path":"."}}'),
  { tool: 'list_dir', arg: '.' },
  'LS becomes list_dir with its path');

const write = call('{"tool":"Write","arg":{"file_path":"a.txt","content":"hi"}}');
eq(write.tool, 'write_file', 'Write becomes write_file');
eq(write.arg.path, 'a.txt', 'file_path is renamed to path');
eq(write.arg.content, 'hi', 'content survives');
eq(write.arg.file_path, undefined, 'the foreign key does not linger');

// echo's scalar can arrive object-wrapped in a JSON dialect. Both paths must
// reach the tool as the bare string it takes, or the result is
// "[object Object]" and a training step can never pass.
eq(call('{"tool":"echo","arg":{"text":"training"}}'),
  { tool: 'echo', arg: 'training' },
  'an object-wrapped echo collapses to the bare text');
eq(TOOL_REGISTRY.echo.run({ text: 'training' }), 'training',
  'echo unwraps text even when the alias step did not run');
eq(TOOL_REGISTRY.echo.run({ strange: 'x' }), '{"strange":"x"}',
  'an unknown object is stringified, never [object Object]');

// Already-ours calls must pass through byte for byte.
eq(call('{"tool":"read_file","arg":"docs/notes.md"}'),
  { tool: 'read_file', arg: 'docs/notes.md' },
  'our own call is unchanged');
eq(call('{"tool":"exec","arg":{"argv":["ls","-la"],"timeout":30}}'),
  { tool: 'exec', arg: { argv: ['ls', '-la'], timeout: 30 } },
  'an argv and timeout survive untouched');

// A shell string we cannot split faithfully stays a string: exec will reject it
// with a real argument error rather than run something approximate.
const piped = call('{"tool":"bash","arg":{"command":"cat x | head"}}');
eq(piped.tool, 'exec', 'the pipe call still resolves to exec');
eq(piped.arg.argv, undefined, 'no argv is invented from an unsplittable command');
eq(piped.arg.command, 'cat x | head', 'the original command is left intact');

// A lossless object is canonicalised; one carrying extra keys is not, so nothing
// the model asked for is silently dropped.
eq(call('{"tool":"read_file","arg":{"file_path":"a.txt"}}').arg, 'a.txt',
  'a single path key collapses to the scalar read_file takes');
eq(call('{"tool":"read_file","arg":{"path":"a.txt","offset":10}}').arg,
  { path: 'a.txt', offset: 10 }, 'extra keys keep the object intact');
eq(call('{"tool":"read_file","arg":{"file_path":"a.txt","range":"1-1"}}'),
  { tool: 'read_file', arg: { path: 'a.txt', range: '1-1' } },
  'file_path plus range keeps both fields');
const edit = call('{"tool":"Edit","arg":{"file_path":"a.txt","old_string":"a","new_string":"b"}}');
eq(edit, { tool: 'edit_file', arg: { path: 'a.txt', old_string: 'a', new_string: 'b' } },
  'Edit folds file_path onto edit_file path');
eq(call('{"tool":"edit_file","arg":{"file_path":"a.txt","old_str":"a","new_str":"b"}}').arg,
  { path: 'a.txt', old_string: 'a', new_string: 'b' },
  'edit_file accepts the old_str/new_str spelling');
eq(aliasToolArgs('read_file', '{"path":"a.txt","range":"1-1"}'),
  { path: 'a.txt', range: '1-1' },
  'a stringified read argument is parsed before normalization');
eq(aliasToolArgs('edit_file', '{"file_path":"a.txt","old_string":"a","new_string":"b"}'),
  { path: 'a.txt', old_string: 'a', new_string: 'b' },
  'a stringified edit argument is parsed before normalization');

// --- the transcript still gets cleaned ---------------------------------------
// Aliasing must not break span matching: the same call is parsed for run AND for
// removal, so a mismatch would leak raw JSON into the saved conversation.
eq(stripToolCall('{"tool":"Bash","arg":{"command":"ls -la"}}').trim(), '',
  'an aliased call is still stripped from the transcript');
eq(stripToolCall('Sure, running it now.\n{"tool":"Read","arg":"a.txt"}').trim(),
  'Sure, running it now.', 'prose around an aliased call is kept');

// --- the danger case ---------------------------------------------------------
// `bash` must never be re-routed to show_command, even though display tools
// would save tokens: the agent would read a result it never received.
const shown = call('{"tool":"bash","arg":{"command":"tail -n 5 app.log"}}');
ok(!TOOL_REGISTRY[shown.tool].display, 'bash resolves to a tool that RUNS, never one that only shows');

for (const line of errors) console.log(line);
console.log(`toolAliases: ${pass} passed, ${errors.length} failed`);
process.exit(errors.length ? 1 : 0);
