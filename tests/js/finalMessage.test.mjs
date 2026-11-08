/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// The reply a turn gets when it ran tools and never wrote an answer.
//
// Usage: node tests/js/finalMessage.test.mjs
//
// The failure these pin: a model answered with the harness's own `[called exec]`
// placeholder, so the transcript showed a caption where the tool's result
// belonged. DOM-free -- the rules take strings and tool records.

import {
  isPlaceholderReply, finishedWithoutAnswer, TOOL_RESULT_NOTICE_CHARS,
  claimsCompletedToolWork,
} from '../../ui/js/utils.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };

console.log('final message tests');
console.log('-'.repeat(60));

// --- the placeholder is not an answer ----------------------------------------
ok(isPlaceholderReply('[called exec]') === true, 'the harness placeholder is recognised');
ok(isPlaceholderReply('  [called exec_start]\n') === true, 'whitespace around it does not hide it');
ok(isPlaceholderReply('[called mcp_call]') === true, 'any tool name counts');
ok(isPlaceholderReply('I called exec and it failed') === false, 'a sentence about a call is a reply');
ok(isPlaceholderReply('[called ]') === false, 'a malformed placeholder is left alone');
ok(isPlaceholderReply('') === false, 'empty text is not a placeholder');

// --- the notice carries the result -------------------------------------------
const one = finishedWithoutAnswer([{ tool: 'exec', result: 'created testingNOW.txt' }]);
ok(/^Finished after running 1 tool call without writing an answer\./.test(one),
  'one call is singular and says what happened');
ok(one.includes('exec \u2192 created testingNOW.txt'), 'the tool and its result ride along');

const multi = finishedWithoutAnswer([
  { tool: 'exec', result: 'ok' },
  { tool: 'exec_start', result: 'handle 7\nstarted' },
]);
ok(/2 tool calls/.test(multi), 'several calls are counted');
ok(multi.includes('exec_start \u2192 handle 7 started'), 'the LAST result is the one shown');
ok(!multi.includes('exec \u2192 ok'), 'earlier results are not piled up');

// --- edge cases ---------------------------------------------------------------
ok(finishedWithoutAnswer([]) === 'The agent finished without writing a reply.',
  'no calls at all keeps the plain notice');
ok(finishedWithoutAnswer(null) === 'The agent finished without writing a reply.',
  'a missing call list keeps the plain notice');
ok(!finishedWithoutAnswer([{ tool: 'exec', result: '' }]).includes('\u2192'),
  'a result-less call adds no arrow');
ok(finishedWithoutAnswer([{ tool: 'exec', result: '   \n  ' }]).includes('without writing an answer'),
  'whitespace-only output adds no arrow');

const long = finishedWithoutAnswer([{ tool: 'exec', result: 'x'.repeat(5000) }]);
ok(long.length < 800, 'a huge result is cut');
ok(long.includes('x'.repeat(TOOL_RESULT_NOTICE_CHARS)), 'the cut keeps the configured characters');
ok(!long.includes('x'.repeat(TOOL_RESULT_NOTICE_CHARS + 1)), 'and stops exactly there');

const messy = finishedWithoutAnswer([{ tool: 'exec', result: 'line one\r\n\n  line two\t' }]);
ok(messy.includes('exec \u2192 line one line two'), 'whitespace is collapsed into one line');

// --- a claim of work that never happened -------------------------------------
// The reply that started this: no tool call, and a past-tense report that the
// write had happened.
ok(claimsCompletedToolWork('No tool call needed — write_file completed the task straightforwardly.') === true,
  'write_file reported as completed is a claim');
ok(claimsCompletedToolWork('The tool\'s arguments were set correctly, and no further actions are required.') === false,
  'talking about the tool without claiming completion is not a claim');
ok(claimsCompletedToolWork('I will use write_file to create the file.') === false,
  'a future intention is not a past-tense claim');
ok(claimsCompletedToolWork('The file was created in the sandbox.') === false,
  'no named tool means no claim (too broad otherwise)');
ok(claimsCompletedToolWork('exec saved the output to disk') === true, 'exec counts as a named tool');
ok(claimsCompletedToolWork('git_commit finished') === true, 'git_commit counts as a named tool');
ok(claimsCompletedToolWork('') === false, 'empty text claims nothing');
ok(claimsCompletedToolWork(null) === false, 'missing text claims nothing');

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
for (const e of errors) console.log('  ' + e);
process.exit(fail ? 1 : 0);
