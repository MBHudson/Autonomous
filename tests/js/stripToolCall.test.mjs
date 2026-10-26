/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// stripToolCall tests -- what a FINISHED reply falls back to.
//
// Usage: node tests/js/stripToolCall.test.mjs
//
// DOM-free: tools.js touches no browser global at load, so it imports straight
// into Node. These cases are the contract the transcript depends on -- the
// streamed fallback keeps the run's words and never the markup the call was
// written in -- and each one was first observed in a live model reply.

import { parseToolCall, stripToolCall } from '../../ui/js/tools.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('stripToolCall tests');
console.log('-'.repeat(60));

// --- nothing to strip -------------------------------------------------------
eq(stripToolCall(''), '', 'empty stays empty');
eq(stripToolCall('   \n\t '), '', 'whitespace only is empty');
eq(stripToolCall(null), '', 'null is empty');
eq(stripToolCall(undefined), '', 'undefined is empty');

const plain = 'Just a normal answer, no tools involved.';
eq(stripToolCall(plain), plain, 'prose with no markup is untouched');

// Angle brackets and braces in prose are not markup.
const brackets = 'Compare <b>bold</b> and 3 < 4 > 2.';
eq(stripToolCall(brackets), brackets, 'angle brackets in prose survive');
const braces = 'The config is {"a":1} in shape, nothing else.';
eq(stripToolCall(braces), braces, 'a JSON object that is not a call survives');
eq(stripToolCall('{"tool":"not_a_real_tool","arg":1}'), '{"tool":"not_a_real_tool","arg":1}',
  'an object naming no known tool survives');

// A fenced block that is not a call is code the user was shown -- keep it.
const jsCode = 'Use this:\n```js\nconst x = {a: 1};\n```\nDone.';
eq(stripToolCall(jsCode), jsCode, 'an ordinary code block survives');

// --- our own JSON protocol ---------------------------------------------------
eq(stripToolCall('{"tool":"list_dir","arg":{"path":"ui/js"}}'), '',
  'a call-only reply leaves no prose');
eq(stripToolCall('Let me look at the folder.\n\n{"tool":"list_dir","arg":{"path":"ui/js"}}'),
  'Let me look at the folder.', 'the JSON after prose is cut, the prose stays');
eq(stripToolCall('Checking now.\n```json\n{"tool":"read_file","arg":{"path":"a.txt"}}\n```'),
  'Checking now.', 'a fenced call and its fence are cut');
eq(stripToolCall('{"tool":"write_file","arg":{"path":"n.txt","content":"{\\"a\\":1}"}}'), '',
  'a call whose argument holds JSON braces is cut whole');
eq(stripToolCall('Shape {"a":1} then {"tool":"list_dir","arg":{"path":"ui/js"}}'),
  'Shape {"a":1} then', 'a harmless object before the call does not hide it');
eq(stripToolCall('First line.\n\n{"tool":"list_dir","arg":{"path":"."}}\n\nSecond line.'),
  'First line.\n\nSecond line.', 'both paragraphs around a call survive');

// --- Claude / GLM XML wrappers ----------------------------------------------
eq(stripToolCall('Reading it.\n<function_calls><invoke name="read_file">'
  + '<parameter name="path">a.txt</parameter></invoke></function_calls>'),
  'Reading it.', 'an <invoke> inside <function_calls> takes the wrapper with it');
eq(stripToolCall('Reading it.\n<invoke name="read_file">'
  + '<parameter name="path">a.txt</parameter></invoke>'),
  'Reading it.', 'a bare <invoke> block is cut');

// --- Qwen / GLM native wrappers ---------------------------------------------
eq(stripToolCall('One moment.\n<|tool_call|>list_dir{"path":"ui/js"}<|/tool_call|>'),
  'One moment.', '<|tool_call|> … <|/tool_call|> is cut');
eq(stripToolCall('One moment.\n<|tool_call|>list_dir<|tool_call|>'),
  'One moment.', 'the bare repeated-tag form is cut');
eq(stripToolCall('One moment.\n<|tool_calls_begin|><|tool_call_begin|>list_dir'
  + '<|tool_call_end|><|tool_calls_end|>'),
  'One moment.', 'the begin/end spelling is cut with its container tags');

// --- shape of the result ----------------------------------------------------
eq(stripToolCall('Done.\n\n\n\n{"tool":"list_dir","arg":{"path":"."}}'), 'Done.',
  'no run of blank lines is left where the call was');
eq(stripToolCall('{"tool":"list_dir","arg":{"path":"."}}\n\nAfter the call.'),
  'After the call.', 'prose after a call leads the result');
ok(!stripToolCall('Checking now.\n```json\n{"tool":"read_file","arg":{"path":"a.txt"}}\n```')
  .includes('```'), 'the fence goes with the call');

// Two calls in one reply: both go.
eq(stripToolCall('A.\n{"tool":"list_dir","arg":{"path":"a"}}\n'
  + '{"tool":"list_dir","arg":{"path":"b"}}\nB.'),
  'A.\n\nB.', 'two calls are both cut');

// --- detection is unchanged -------------------------------------------------
// Stripping must not quietly change what the harness considers a call: every
// case above still parses as a call before it is stripped.
ok(parseToolCall('{"tool":"list_dir","arg":{"path":"ui/js"}}'), 'plain JSON still parses');
ok(parseToolCall('<function_calls><invoke name="read_file">'
  + '<parameter name="path">a.txt</parameter></invoke></function_calls>'), 'XML form still parses');
ok(parseToolCall('<|tool_call|>list_dir{"path":"ui/js"}<|/tool_call|>'), 'native form still parses');

console.log('-'.repeat(60));
if (fail) {
  console.error(errors.join('\n'));
  console.error(`${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`${pass} passed`);
