/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// showTools tests -- the tools whose result is the answer.
//
// Usage: node tests/js/showTools.test.mjs
//
// A show_* call ends the turn: the app performs the request and paints the
// output into the transcript, so the content never becomes a token. Three
// things have to hold for that to be a saving rather than a leak:
//   1. only the caption is stored as message content (the output rides in the
//      tool-call record, which is never sent to a provider),
//   2. each tool inherits the gate of the tool it mirrors, so denying exec
//      denies show_command too,
//   3. the model is told plainly that these end its turn.
// DOM-free like the other parser tests.

import {
  isDisplayTool, displayCaption, clipDisplay, policyNameFor,
  MAX_DISPLAY_CHARS, TOOL_REGISTRY, toolInstructions,
} from '../../ui/js/tools.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('showTools tests');
console.log('-'.repeat(60));

// --- which tools display ------------------------------------------------------
eq(isDisplayTool('show_file'), true, 'show_file displays');
eq(isDisplayTool('show_command'), true, 'show_command displays');
eq(isDisplayTool('show_find'), true, 'show_find displays');
eq(isDisplayTool('show_url'), true, 'show_url displays');
eq(isDisplayTool('read_file'), false, 'read_file does not display');
eq(isDisplayTool('exec'), false, 'exec does not display');
eq(isDisplayTool(''), false, 'an empty name displays nothing');

// --- every display tool is registered and marked ------------------------------
for (const name of ['show_file', 'show_command', 'show_find', 'show_url']) {
  ok(!!TOOL_REGISTRY[name], `${name} is in the registry`);
  ok(TOOL_REGISTRY[name] && TOOL_REGISTRY[name].display === true, `${name} carries the display marker`);
}

// --- gates are inherited, not re-invented -------------------------------------
eq(policyNameFor('show_command'), 'exec', 'show_command is judged as exec');
eq(policyNameFor('show_file'), 'read_file', 'show_file is judged as read_file');
eq(policyNameFor('show_find'), 'grep_code', 'show_find is judged as grep_code');
eq(policyNameFor('show_url'), 'fetch_url', 'show_url is judged as fetch_url');
eq(policyNameFor('exec'), 'exec', 'a normal tool is judged as itself');
// A command is the only one that can change the machine.
eq(TOOL_REGISTRY.show_command.needsApproval, true, 'show_command asks before it runs');
eq(!!TOOL_REGISTRY.show_file.needsApproval, false, 'showing a file asks nothing');

// --- the caption is what a later turn pays for --------------------------------
eq(displayCaption({ tool: 'show_command', arg: { argv: ['tail', '-n', '20', 'app.log'] } }),
  'Ran `tail -n 20 app.log` — output below.', 'command caption names the argv');
eq(displayCaption({ tool: 'show_command', arg: ['pwd'] }),
  'Ran `pwd` — output below.', 'a bare array is still named');
eq(displayCaption({ tool: 'show_file', arg: { path: 'logs/app.log' } }),
  'Contents of `logs/app.log` below.', 'file caption names the path');
eq(displayCaption({ tool: 'show_file', arg: 'notes.md' }),
  'Contents of `notes.md` below.', 'a scalar path is still named');
eq(displayCaption({ tool: 'show_url', arg: { url: 'https://example.com/x' } }),
  'Text of https://example.com/x below.', 'url caption names the page');
eq(displayCaption({ tool: 'show_find', arg: { query: 'timeout' } }),
  'Search results for “timeout” below.', 'find caption names the query');
eq(displayCaption({ tool: 'show_file', arg: {} }), 'File contents below.',
  'an empty arg still produces a caption');
// The caption is re-sent on every later turn, so it must stay small.
const longest = displayCaption({ tool: 'show_command', arg: { argv: ['x'.repeat(400)] } });
ok(longest.length < 500, 'a caption never becomes a payload');

// --- display clipping is honest ----------------------------------------------
eq(clipDisplay('short'), 'short', 'a small value passes through');
{
  const big = 'a'.repeat(MAX_DISPLAY_CHARS + 250);
  const clipped = clipDisplay(big);
  ok(clipped.startsWith('a'.repeat(100)), 'the head of a big value survives');
  ok(/\[250 more characters not shown\]/.test(clipped), 'the omitted count is stated');
  ok(clipped.length < big.length, 'clipping actually shortens');
}
{
  // A display value may be far larger than the 16k transcript cap: none of it
  // is ever sent to a provider, so the only limit is the session file.
  const sixteenK = 'b'.repeat(40000);
  eq(clipDisplay(sixteenK), sixteenK, '40k passes: the transcript cap does not apply');
}

// --- the model is taught what these do ---------------------------------------
const taught = toolInstructions(['show_file', 'show_command', 'show_find', 'show_url'], '', 'json');
ok(/END YOUR TURN/.test(taught), 'the prompt says these end the turn');
ok(/do not repeat it, summarise it/.test(taught), 'the prompt forbids restating the output');
ok(/never comes back to you/.test(taught), 'the prompt says a show_* result is not returned');
ok(/\{"tool":"show_command","arg":\{"argv":\[/.test(taught), 'show_command gets an argv example');
ok(/\{"tool":"show_file","arg":\{"path":/.test(taught), 'show_file gets a path example');
ok(/\{"tool":"show_find","arg":\{"query":/.test(taught), 'show_find gets a query example');
ok(/\{"tool":"show_url","arg":\{"url":/.test(taught), 'show_url gets a url example');
ok(!/END YOUR TURN/.test(toolInstructions(['read_file'], '', 'json')),
  'an agent without a display tool is told nothing about them');

// --- the steering rule, and where it sits -------------------------------------
ok(/WHICH TOOL - show or read\?/.test(taught), 'the show-or-read rule is taught');
ok(taught.indexOf('WHICH TOOL') < taught.indexOf('Available tools:'),
  'the rule comes before the tool list, where a small model still reads');
ok(/-> show_command/.test(taught), 'the rule maps a command to show_command');
ok(/-> show_file/.test(taught), 'the rule maps a file to show_file');
ok(/list_dir lists names only/.test(taught), 'list_dir is distinguished from showing contents');
ok(/only when YOU need the/.test(taught), 'the read tools are scoped to the agent\'s own use');
// A description that names the competing tool taught the model to pick it, so
// the display descriptions must not mention read_file.
ok(!/read_file/.test(TOOL_REGISTRY.show_file.describe), 'show_file does not name read_file');
// The reverse handoff is wanted: read_file may point AT show_file, because that
// pointer fires at the moment the model is choosing read_file.
ok(/show_file/.test(TOOL_REGISTRY.read_file.describe), 'read_file hands off to show_file');
ok(!/WHICH TOOL/.test(toolInstructions(['read_file', 'exec'], '', 'json')),
  'an agent with no display tool is not given the rule');
// Display tools lead the examples: a small model reads the first ones as default.
// Compared on a MIXED list — a list of display tools alone proves nothing.
{
  const mixed = toolInstructions(['read_file', 'exec', 'show_file'], '', 'json');
  ok(mixed.indexOf('{"tool":"show_file"') < mixed.indexOf('{"tool":"read_file"'),
    'display examples come before read_file on a mixed list');
  ok(mixed.indexOf('{"tool":"show_file"') < mixed.indexOf('{"tool":"exec"'),
    'display examples come before exec on a mixed list');
}

const xml = toolInstructions(['show_command'], '', 'anthropic');
ok(/<invoke name="show_command">/.test(xml), 'the xml dialect gets its own example');
ok(/<parameter name="argv">/.test(xml), 'the xml example carries the argv');

for (const line of errors) console.log(line);
console.log(`showTools: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
