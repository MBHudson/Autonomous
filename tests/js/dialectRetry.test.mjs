/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// dialectRetry tests -- what happens to a reply that should have been a call.
//
// Usage: node tests/js/dialectRetry.test.mjs
//
// Two separate rescues exist in the tool loop, and they are gated differently:
//
//   * the DIALECT RE-TEACH (nextDialect -> plain/json/native/anthropic) fires
//     only when the reply carries a call shape -- it exists for "right idea,
//     wrong syntax".
//   * the NARRATION NUDGE fires when the reply *describes* using a tool.
//
// The measured failure this pins: a small model given native tool schemas
// (Ollama, capabilities:["tools"]) answered in prose with a fenced, non-tool
// JSON blob. That is call-shaped enough to be wrong and not call-shaped enough
// to be re-taught, so no dialect fallback happens. The turn gets ONE nudge in
// the same dialect, and if the model repeats itself that prose is the answer.
// Verify with tools/measure-tool-choice.mjs MODE=native.

// nextDialect() lives in toolManifest.js, which imports api.js and touches
// `window` at load, so it cannot be imported in Node. These tests cover the
// two predicates that decide whether it is ever called, which is the part that
// goes wrong.
import { looksLikeToolReply, narratesToolUse, shouldFallBackFromNative } from '../../ui/js/utils.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('dialectRetry tests');
console.log('-'.repeat(60));

// --- the two replies that were actually measured -----------------------------
// Verbatim from the native-mode run against DeepSeek-R1-Distill-Qwen-7B.
const narrated = ' To print the contents of `docs/notes.md`, I will use the `exec` tool '
  + 'with the `fetch_url` method. This will fetch the file and display it.';
const fenced = '\n\nTo view the contents of `docs/notes.md`, use the following command:\n\n'
  + '```json\n{\n  "argv": ["cat", "/var/www/Autonomous/docs/notes.md"]\n}\n```';
const offered = ['exec', 'read_file', 'show_file', 'show_command', 'show_find', 'show_url'];

// Neither reply carries a call shape, so the DIALECT re-teach never fires —
// re-teaching cannot fix a model that ignored the tool interface.
eq(looksLikeToolReply(narrated), false, 'the narrated reply is not call-shaped');
eq(looksLikeToolReply(fenced), false, 'the fenced argv blob is not call-shaped');

// The narrated one still reaches the NARRATION rescue, which re-asks once in
// the same dialect and does not switch to JSON.
eq(narratesToolUse(narrated, offered), true, 'the narrated reply is caught by the rescue');
// The fenced one mentions no tool and no intent: nothing rescues it at all.
eq(narratesToolUse(fenced, offered), false, 'the fenced blob is caught by nothing');
ok(!looksLikeToolReply(narrated) && narratesToolUse(narrated, offered),
  'narrated: one nudge, no dialect switch');

// --- call-shaped replies DO get re-taught ------------------------------------
eq(looksLikeToolReply('{"tool":"read_file","arg":{"path":"x"}}'), true,
  'a json call is call-shaped');
eq(looksLikeToolReply('{"tool": "read_file"}'), true, 'whitespace after the colon is fine');
eq(looksLikeToolReply('<|tool_call|>{"tool":"read_file"}<|/tool_call|>'), true,
  'a native tag is call-shaped');
eq(looksLikeToolReply('<function_calls><invoke name="read_file"></invoke></function_calls>'), true,
  'a claude xml call is call-shaped');
eq(looksLikeToolReply('Here is the answer: 42.'), false, 'a plain answer is not a call');
eq(looksLikeToolReply(''), false, 'an empty reply is not a call');
eq(looksLikeToolReply('I wrote a tool for that.'), false, 'mentioning a tool is not a call shape');

// --- narration needs BOTH a tool word and an intent phrase -------------------
eq(narratesToolUse("I'll use the exec tool now."), true, 'a stated intent plus a tool word');
eq(narratesToolUse('I will call read_file.', ['read_file']), true,
  'a named tool counts when it was offered');
eq(narratesToolUse('I will call read_file.'), false,
  'without the offered list, only the word "tool" counts (the old gap)');
eq(narratesToolUse('I will call overwrite_everything.', ['read_file']), false,
  'a tool that was NOT offered is not a tool word');
eq(narratesToolUse('Let me check that with show_file.', ['show_file']), true,
  'let me counts as intent');
eq(narratesToolUse('The grep_code tool is available.'), false,
  'naming a tool without intent is not narration to rescue');
eq(narratesToolUse('I will answer in prose.'), false, 'intent without a tool word is not narration');
eq(narratesToolUse(''), false, 'empty is not narration');

// --- the native fallback is bounded to once per turn --------------------------
// Native schemas accepted, nudge failed, no fallback yet: this is the case.
eq(shouldFallBackFromNative({ nativeMode: true, nudgedInNative: true, fallbackUsed: false }), true,
  'a failed nudge in native mode falls back');
eq(shouldFallBackFromNative({ nativeMode: true, nudgedInNative: true, fallbackUsed: true }), false,
  'the fallback happens once per turn, never twice');
eq(shouldFallBackFromNative({ nativeMode: true, nudgedInNative: false, fallbackUsed: false }), false,
  'no fallback before the nudge has been tried');
eq(shouldFallBackFromNative({ nativeMode: false, nudgedInNative: true, fallbackUsed: false }), false,
  'no fallback when the dialect was never native');
eq(shouldFallBackFromNative({ nativeMode: true, nudgedInNative: true, fallbackUsed: false, hasCall: true }),
  false, 'a call means there is nothing to fall back from');
eq(shouldFallBackFromNative({}), false, 'empty state falls back from nothing');

for (const line of errors) console.log(line);
console.log(`dialectRetry: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
