/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// The diff preview in the approval dialog.
//
// Usage: node tests/js/approvePreview.test.mjs
//
// approvalPreview() is the pure half of the dialog: it turns a pending call
// into add/del/context rows so the operator reads the change instead of a byte
// count. The checks below pin the shapes that matter -- a patch keeps its
// hunks, an editor call shows both sides, a write shows the whole content, a
// call with nothing to diff returns null, and a huge patch is bounded rather
// than freezing the prompt.

import { approvalPreview } from '../../ui/js/approveDialog.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('Approval diff preview tests');
console.log('-'.repeat(60));

// --- write_file: the bytes about to be written ------------------------------
const write = approvalPreview('write_file', { path: 'notes/a.txt', content: 'one\ntwo\n' });
eq(write.rows.map(r => r.kind), ['add', 'add'], 'write_file: every line is an addition');
eq(write.added, 2, 'write_file: counts additions');
eq(write.removed, 0, 'write_file: nothing removed');
eq(write.more, 0, 'write_file: nothing hidden');
ok(/notes\/a\.txt/.test(write.label), 'write_file: the label names the path');
eq(approvalPreview('write_file', { path: 'a.txt', content: 'x', mode: 'append' }).label.includes('Appending'), true,
  'write_file: append is labelled as such');

// --- apply_patch: it already is a diff --------------------------------------
const patch = [
  '*** Begin Patch',
  '*** Update File: src/app.js',
  '@@ const x = 1;',
  '-old line',
  '+new line',
  ' same',
  '*** End Patch',
].join('\n');
const rows = approvalPreview('apply_patch', { patch }).rows;
eq(rows.map(r => r.kind), ['meta', 'meta', 'meta', 'del', 'add', 'ctx', 'meta'],
  'apply_patch: headers and hunks are meta, changes keep their sign');
eq(rows[3].text, '-old line', 'apply_patch: the line text is shown as written');
ok(rows.some(r => r.text.includes('*** Update File: src/app.js')),
  'apply_patch: the touched file stays visible');

// --- editor tools: both sides of the edit -----------------------------------
const edit = approvalPreview('edit_file', { path: 'b.txt', old_string: 'before', new_string: 'after' });
eq(edit.rows, [{ kind: 'del', text: 'before' }, { kind: 'add', text: 'after' }],
  'edit_file: old then new');
eq([edit.added, edit.removed], [1, 1], 'edit_file: counts both sides');

const multi = approvalPreview('multi_edit', {
  edits: [
    { path: 'a.txt', old_string: 'a1', new_string: 'a2' },
    { path: 'b.txt', old_string: 'b1', new_string: 'b2' },
  ],
});
eq(multi.label, '2 edits', 'multi_edit: the label counts the edits');
ok(multi.rows.some(r => r.text === '--- a.txt') && multi.rows.some(r => r.text === '--- b.txt'),
  'multi_edit: each edit names its file');

const create = approvalPreview('str_replace_editor', { command: 'create', path: 'new.txt', file_text: 'hi' });
eq(create.rows, [{ kind: 'add', text: 'hi' }], 'str_replace_editor create: the new content');
eq(create.label.includes('New file'), true, 'str_replace_editor create: labelled as a new file');
eq(approvalPreview('str_replace_editor', { command: 'view', path: 'x' }), null,
  'str_replace_editor view: nothing to preview');

// --- nothing to diff --------------------------------------------------------
eq(approvalPreview('exec', { argv: ['ls', '-la'] }), null, 'exec: the command is the preview');
eq(approvalPreview('read_file', { path: 'x.txt' }), null, 'read_file: no preview');
eq(approvalPreview('write_file', { path: 'x.txt' }), null, 'write_file without content: no preview');
eq(approvalPreview('apply_patch', { patch: '   ' }), null, 'empty patch: no preview');
eq(approvalPreview('write_file', null), null, 'missing arguments: no preview');

// --- hostile and oversized content stays text -------------------------------
const hostile = approvalPreview('write_file', {
  path: 'x.html',
  content: '<script>alert(1)</script>\n<img src=x onerror=alert(2)>',
});
eq(hostile.rows[0].text, '<script>alert(1)</script>', 'markup is kept as literal text rows');
eq(hostile.rows[1].text, '<img src=x onerror=alert(2)>', 'every markup line stays literal');

const crlf = approvalPreview('write_file', { path: 'w.txt', content: 'a\r\nb\r\n' });
eq(crlf.rows.map(r => r.text), ['a', 'b'], 'CRLF content previews without stray carriage returns');

const huge = approvalPreview('write_file', { path: 'big.txt', content: Array(500).fill('line').join('\n') });
eq(huge.rows.length, 160, 'a huge write is capped at 160 rows');
eq(huge.more, 340, 'the count of hidden lines is reported');

const longLine = approvalPreview('write_file', { path: 'min.js', content: 'x'.repeat(2000) });
eq(longLine.rows[0].text.length, 401, 'one enormous line is clipped');

console.log('-'.repeat(60));
if (errors.length) errors.forEach(e => console.log(e));
console.log(`approvePreview: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
