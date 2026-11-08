/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// toolInstructions tests -- what the model is TOLD about calling tools.
//
// Usage: node tests/js/toolInstructions.test.mjs
//
// The narration nudge in chat.js (a second request saying "that reply contained
// no tool call") exists because a model sometimes describes a call instead of
// sending one. These assertions pin the instruction that is meant to stop that
// happening in the first place, and that the wrong/right example is written in
// the dialect the model is actually being taught.

import { toolInstructions } from '../../ui/js/tools.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };

console.log('toolInstructions tests');
console.log('-'.repeat(60));

const json = toolInstructions(['list_agents', 'think'], '', 'json');
const plain = toolInstructions(['list_agents'], '', 'plain');
const anthropic = toolInstructions(['list_agents'], '', 'anthropic');
const native = toolInstructions(['list_agents'], '', 'native');
const nativeApi = toolInstructions(['list_agents'], '', 'native-api');

// --- narrating a call is named as a failure, not discouraged in passing -------
ok(/SAYING you will use a tool is not using it/.test(json),
  'json: narrating a call is named outright');
ok(/turn ends with that sentence as your answer/.test(json),
  'json: the consequence is stated');
ok(/There is no later step where the\s+harness acts on an intention/.test(json),
  'json: says the harness never acts on an intention');
ok(/never announce/.test(json), 'json: the announce rule is still present');

// --- a wrong/right pair, and in the dialect being taught ---------------------
ok(/Wrong:/.test(json) && /Right:/.test(json), 'json: a wrong/right pair is shown');
ok(json.includes('{"tool":"list_agents"}'), 'json: the right example is the json dialect');
ok(native.includes('<|tool_call|>{"tool":"list_agents"}<|/tool_call|>'),
  'native: the right example is the native dialect');
ok(anthropic.includes('<invoke name="list_agents">'),
  'anthropic: the right example is the xml dialect');
ok(plain.includes('{"tool":"list_agents"}'), 'plain: the right example stays bare json');

// --- an example can execute, so say so ---------------------------------------
ok(/is scanned for\s+calls/.test(json), 'json: warns that a described call can execute');

// --- native-schema mode gets the same rule, without a competing syntax -------
ok(/never announce|Never announce/.test(nativeApi), 'native-api: the announce rule is present');
ok(!/Wrong:/.test(nativeApi), 'native-api: no prompt-dialect example is mixed in');
ok((nativeApi.match(/<\|tool_call\|>/g) || []).length === 1 && /do not print/.test(nativeApi),
  'native-api: names the tag once, only to forbid it');

// --- think is called, not discussed ------------------------------------------
ok(/do not write about using it/.test(json), 'think: says to call it rather than describe it');

// --- nothing to teach, nothing said ------------------------------------------
ok(toolInstructions([], '', 'json') === '', 'no tools means no instructions');

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
for (const e of errors) console.log('  ' + e);
process.exit(fail ? 1 : 0);
