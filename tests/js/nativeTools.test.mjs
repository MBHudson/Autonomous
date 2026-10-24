/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// Native tool schema + stream parsing tests.
//
// Usage: node tests/js/nativeTools.test.mjs

import {
  TOOL_SCHEMAS,
  nativeToolDefs,
  nativeToolChoice,
  nativeToolArgs,
  createNativeCallState,
  ingestNativeDelta,
  nativeCalls,
} from '../../ui/js/nativeTools.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('Native tool tests');
console.log('-'.repeat(60));

eq(TOOL_SCHEMAS.echo.properties.text.type, 'string', 'echo schema has text');
eq(TOOL_SCHEMAS.exec.properties.argv.type, 'array', 'exec schema has argv array');
eq(TOOL_SCHEMAS.todo_write.properties.todos.type, 'array', 'todo_write schema has todos');

const defs = [
  { name: 'echo', description: 'Repeat text' },
  { name: 'read_file', description: 'Read a file' },
];
const openai = nativeToolDefs(defs, 'openai');
eq(openai.length, 2, 'openai gets two tools');
eq(openai[0].type, 'function', 'openai uses function wrapper');
eq(openai[0].function.name, 'echo', 'openai keeps the name');
eq(openai[0].function.parameters.properties.text.type, 'string', 'openai passes schema');

const anthropic = nativeToolDefs(defs, 'anthropic');
eq(anthropic[0].input_schema.properties.text.type, 'string', 'anthropic uses input_schema');

const google = nativeToolDefs(defs, 'google');
ok(Array.isArray(google[0].functionDeclarations), 'google uses functionDeclarations');
eq(google[0].functionDeclarations[1].name, 'read_file', 'google keeps order');

eq(nativeToolChoice('openai'), 'auto', 'openai auto choice');
eq(nativeToolChoice('anthropic'), { type: 'auto' }, 'anthropic auto choice');
eq(nativeToolChoice('google'), null, 'google choice is configured separately');

eq(nativeToolArgs('echo', { text: 'hi' }), { arg: 'hi', note: undefined }, 'echo unwraps text');
eq(nativeToolArgs('read_file', { path: 'a.js' }), { arg: 'a.js', note: undefined }, 'read_file unwraps path');
eq(nativeToolArgs('write_file', { path: 'a.js', content: 'x' }).arg.path, 'a.js', 'write_file keeps object');
eq(nativeToolArgs('declare_goal_complete', { summary: 'done' }),
  { arg: undefined, note: 'done' }, 'goal summary becomes the note');
eq(nativeToolArgs('write_note', { text: 'x', name: 'n' }).note, 'n', 'write_note keeps its note name');

const oa = createNativeCallState();
ingestNativeDelta(oa, { choices: [{ delta: { tool_calls: [{
  index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"a' },
}] } }] }, 'openai');
ingestNativeDelta(oa, { choices: [{ delta: { tool_calls: [{
  index: 0, function: { arguments: 'b.js"}' },
}] } }] }, 'openai');
eq(nativeCalls(oa), [{ id: 'c1', name: 'read_file', arguments: { path: 'ab.js' } }],
  'openai fragments are joined and parsed');

const an = createNativeCallState();
ingestNativeDelta(an, {
  type: 'content_block_start', index: 1,
  content_block: { type: 'tool_use', id: 't1', name: 'todo_write', input: {} },
}, 'anthropic');
ingestNativeDelta(an, {
  type: 'content_block_delta', index: 1,
  delta: { type: 'input_json_delta', partial_json: '{"todos":[{"content":"x","status":"pending"}]}' },
}, 'anthropic');
eq(nativeCalls(an)[0].arguments.todos[0].content, 'x', 'anthropic partial JSON is parsed');

const go = createNativeCallState();
ingestNativeDelta(go, {
  candidates: [{ content: { parts: [
    { functionCall: { name: 'echo', args: { text: 'hi' } } },
    { functionCall: { id: 'g2', name: 'now', args: {} } },
  ] } }],
}, 'google');
eq(nativeCalls(go).length, 2, 'google keeps multiple calls');
eq(nativeCalls(go)[0].name, 'echo', 'google preserves order');

const empty = createNativeCallState();
eq(nativeCalls(empty), [], 'no tool calls is an empty array');

console.log('-'.repeat(60));
if (fail) {
  console.error(errors.join('\n'));
  console.error(`${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`${pass} passed`);
