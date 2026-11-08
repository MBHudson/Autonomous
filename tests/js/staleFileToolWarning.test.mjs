/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// stale file-tool warning tests -- does a fixed install stop saying it is broken?
//
// Usage: node tests/js/staleFileToolWarning.test.mjs  (or all: node tests/run.mjs)
//
// The warning is added to a conversation before a turn so a model cannot claim
// a write that did not happen. Once the tools are repaired the sentence is no
// longer true, and a transcript that keeps it is misleading in the opposite
// direction -- it says files are not on disk after they are.

import { isFileToolWarning, withoutFileToolWarnings, FILE_TOOL_WARNING_PREFIX } from '../../ui/js/utils.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };

console.log('stale file tool warning tests');
console.log('-'.repeat(60));

const note = text => ({ role: 'agent', agentId: null, content: text, timestamp: 1 });

// --- what counts as a warning ------------------------------------------------
const old = note(`${FILE_TOOL_WARNING_PREFIX} — this page never bound write_file. Anything an agent reports writing is not on disk.`);
ok(isFileToolWarning(old), 'an existing warning with no flag is recognised by its opening');
ok(isFileToolWarning({ ...old, content: `  ${old.content}` }), 'leading whitespace does not hide it');
ok(isFileToolWarning({ role: 'agent', agentId: null, fileToolWarning: true, content: '✓ File tools are bound.' }),
  'the flag alone is enough, whatever the text now says');

ok(!isFileToolWarning({ role: 'agent', agentId: 'agent_1', content: `${FILE_TOOL_WARNING_PREFIX} — quoted by a model.` }),
  "a model quoting the sentence is not deleted");
ok(!isFileToolWarning({ role: 'agent', agentId: 'agent_1', content: 'I wrote the file.' }),
  'an ordinary reply is not a warning');
ok(!isFileToolWarning({ role: 'user', agentId: null, content: `${FILE_TOOL_WARNING_PREFIX} — pasted by the operator.` }),
  'a user message is never mistaken for the note');
ok(!isFileToolWarning(null) && !isFileToolWarning('x') && !isFileToolWarning(undefined),
  'non-messages are ignored rather than trusted');

// --- removing them -----------------------------------------------------------
const messages = [
  { role: 'user', content: 'do the thing' },
  note(`${FILE_TOOL_WARNING_PREFIX} — this page never bound write_file.`),
  { role: 'agent', agentId: 'agent_1', content: 'Done, I wrote notes.md.' },
  { role: 'agent', agentId: null, fileToolWarning: false, content: '✓ File tools are bound — agents can read and write now.' },
  note(`${FILE_TOOL_WARNING_PREFIX} — the server has no allowed directory.`),
];
const cleaned = withoutFileToolWarnings(messages);
ok(cleaned.removed === 2, 'both stale warnings are counted');
ok(cleaned.messages.length === 3, 'and removed from the list');
ok(cleaned.messages.some(m => m.content === 'do the thing'), 'the question stays');
ok(cleaned.messages.some(m => m.content === 'Done, I wrote notes.md.'), 'so does the reply');
ok(!cleaned.messages.some(m => String(m.content).startsWith(FILE_TOOL_WARNING_PREFIX)),
  'no warning survives');

// A bubble that was corrected after a successful rebind is not a warning any
// more: its content is the confirmation, so clearing must leave it alone.
const rebindNote = { role: 'agent', agentId: null, content: '✓ File tools are bound in this page — the server\'s working directory could not be checked.' };
ok(!isFileToolWarning(rebindNote), 'a corrected bubble is not a warning');

// --- nothing to do -----------------------------------------------------------
const clean = withoutFileToolWarnings([{ role: 'user', content: 'hello' }]);
ok(clean.removed === 0, 'a clean conversation reports nothing removed');
ok(clean.messages.length === 1, 'and is returned intact');
ok(withoutFileToolWarnings(undefined).removed === 0, 'a missing list is not an error');
ok(withoutFileToolWarnings('nonsense').messages.length === 0, 'a non-array is treated as empty');

// --- the original list is untouched -----------------------------------------
ok(messages.length === 5, 'the caller keeps its own array');

// --- the reload path ---------------------------------------------------------
// loadConversation() hands the button the message it read back from storage, so
// the note has to still be recognisable after that round trip.
const stored = JSON.parse(JSON.stringify(note(`${FILE_TOOL_WARNING_PREFIX} — this page never bound write_file.`)));
ok(isFileToolWarning(stored), 'a warning still reads as one after a storage round-trip');
ok(withoutFileToolWarnings([stored, { role: 'user', content: 'hi' }]).removed === 1,
  'and is still removable after the reload');

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
for (const e of errors) console.log('  ' + e);
process.exit(fail ? 1 : 0);
