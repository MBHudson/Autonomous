/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// APPROVE-DIALOG.JS — one approval prompt, everywhere
// ============================================
//
// This replaces `window.confirm` for tool approvals. A native confirm is a
// browser chrome dialog: it cannot be styled, it blocks the whole tab with no
// context, and on some mobile browsers it is easy to miss entirely. This is a
// DOM dialog mounted above everything (chart drawer included), showing the
// full command, with explicit buttons.
//
// Session scope: approvals live in module memory only. Reload the page and
// they are gone, so "approve" never becomes a permanent grant by accident.
// Permanent grants are a deliberate act through Always allow (server pending)
// or the Config allowlist editor -- both reversible, both visible.
//
// Escape and backdrop-click both mean DENY. A prompt that can be dismissed
// into an approval is a prompt that approves things while you fumble for the
// close button.

import { store } from './store.js?v=431';

/** tool|arg pairs approved this page-load. Gone on reload, by design. */
const sessionApprovals = new Set();

export function approvalKey(tool, arg) {
  let a;
  try { a = JSON.stringify(arg); } catch { a = String(arg); }
  return `${tool}|${a}`;
}

export function sessionApproved(tool, arg) {
  return sessionApprovals.has(approvalKey(tool, arg));
}

export function rememberApproval(tool, arg) {
  sessionApprovals.add(approvalKey(tool, arg));
}

const queue = [];
let showing = false;

function countLines(text) {
  return String(text).split('\n').length;
}

function detailText(tool, arg) {
  if (!arg || typeof arg !== 'object') {
    if (tool === 'exec') return String(arg ?? '');
    try { return JSON.stringify(arg).slice(0, 200); } catch { return ''; }
  }
  if (tool === 'write_file') {
    const content = String(arg.content ?? '');
    const n = countLines(content);
    return `path ${arg.path || '?'} (${content.length} bytes, ${n} line${n === 1 ? '' : 's'}${arg.mode === 'append' ? ', appending' : ', overwriting'})`;
  }
  // The editor tools used to fall through to a JSON dump truncated at 200
  // characters, which showed the start of a patch and none of its change.
  if (tool === 'apply_patch') {
    const patch = String(arg.patch ?? '');
    const files = patch.split('\n')
      .map((l) => (l.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) || [])[1])
      .filter(Boolean);
    const n = countLines(patch);
    return `patch, ${n} line${n === 1 ? '' : 's'}${files.length ? `, ${files.length} file${files.length === 1 ? '' : 's'}: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}` : ''}`;
  }
  if (tool === 'str_replace_editor') {
    const cmd = String(arg.command || '?');
    return `${cmd} ${arg.path || '?'}${cmd === 'insert' && arg.insert_line != null ? ` (after line ${arg.insert_line})` : ''}`;
  }
  if (tool === 'edit_file') {
    return `path ${arg.path || '?'}${arg.replace_all ? ' (every occurrence)' : ''}`;
  }
  if (tool === 'multi_edit') {
    const edits = Array.isArray(arg.edits) ? arg.edits : [];
    const paths = [...new Set(edits.map((e) => e && e.path).filter(Boolean))];
    return `${edits.length} edit${edits.length === 1 ? '' : 's'}${paths.length ? `: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', …' : ''}` : ''}`;
  }
  if (tool === 'exec') {
    // argv arrives as {argv:[...]}, a bare array, or a string. Show the
    // actual command line -- String() on the object form printed
    // "[object Object]", which approves blind.
    let argv = arg;
    if (argv && typeof argv === 'object' && !Array.isArray(argv)) argv = argv.argv;
    if (Array.isArray(argv)) return argv.map(a => String(a)).join(' ');
    try { return JSON.stringify(arg).slice(0, 200); } catch { return String(arg).slice(0, 200); }
  }
  try { return JSON.stringify(arg).slice(0, 200); } catch { return ''; }
}

// --- the change itself ------------------------------------------------------
//
// "path notes.txt (740 bytes, overwriting)" is not something anyone can
// approve: the bytes are the whole decision. apply_patch already IS a diff,
// and the editor tools carry old/new strings that reduce to the same two
// columns. Everything here is plain text and is rendered with textContent --
// a model can write `</pre>` or `<img onerror=...>` into a file, and it must
// stay inert on the page.

const PREVIEW_MAX_ROWS = 160;
const PREVIEW_MAX_LINE = 400;

function previewLines(text) {
  const out = String(text).replace(/\r\n?/g, '\n').split('\n');
  // A file's final newline is not an extra line.
  if (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out;
}

function previewClip(text) {
  return text.length > PREVIEW_MAX_LINE ? text.slice(0, PREVIEW_MAX_LINE) + '…' : text;
}

function previewRows(rows, kind, text) {
  for (const line of previewLines(text)) rows.push({ kind, text: previewClip(line) });
}

/**
 * The change a tool call would make, as rows ready to render.
 * Returns null for a tool with nothing to diff (exec, reads, unknown tools).
 *
 * @returns {{label:string, added:number, removed:number, more:number,
 *            rows:{kind:'add'|'del'|'ctx'|'meta', text:string}[]}|null}
 */
export function approvalPreview(tool, arg) {
  if (!arg || typeof arg !== 'object') return null;
  const rows = [];
  let label = '';

  if (tool === 'write_file') {
    if (typeof arg.content !== 'string') return null;
    label = `${arg.mode === 'append' ? 'Appending to' : 'Contents of'} ${arg.path || '?'}`;
    previewRows(rows, 'add', arg.content);
  } else if (tool === 'apply_patch') {
    const patch = typeof arg.patch === 'string' ? arg.patch : '';
    if (!patch.trim()) return null;
    label = 'Patch';
    for (const raw of previewLines(patch)) {
      if (/^\*\*\*/.test(raw) || /^@@/.test(raw)) rows.push({ kind: 'meta', text: previewClip(raw) });
      else if (/^\+\+\+|^---/.test(raw)) rows.push({ kind: 'meta', text: previewClip(raw) });
      else if (raw.startsWith('+')) rows.push({ kind: 'add', text: previewClip(raw) });
      else if (raw.startsWith('-')) rows.push({ kind: 'del', text: previewClip(raw) });
      else rows.push({ kind: 'ctx', text: previewClip(raw) });
    }
  } else if (tool === 'str_replace_editor') {
    const cmd = String(arg.command || '');
    if (cmd === 'view') return null;
    label = `${cmd === 'create' ? 'New file' : 'Edit of'} ${arg.path || '?'}`;
    if (cmd === 'create' && typeof arg.file_text === 'string') {
      previewRows(rows, 'add', arg.file_text);
    } else if (cmd === 'str_replace' || cmd === 'insert') {
      if (typeof arg.old_str === 'string' && arg.old_str !== '') previewRows(rows, 'del', arg.old_str);
      if (typeof arg.new_str === 'string' && arg.new_str !== '') previewRows(rows, 'add', arg.new_str);
    }
  } else if (tool === 'edit_file') {
    if (typeof arg.old_string !== 'string' || typeof arg.new_string !== 'string') return null;
    label = `Edit of ${arg.path || '?'}${arg.replace_all ? ' (every occurrence)' : ''}`;
    previewRows(rows, 'del', arg.old_string);
    previewRows(rows, 'add', arg.new_string);
  } else if (tool === 'multi_edit') {
    const edits = Array.isArray(arg.edits) ? arg.edits : [];
    if (!edits.length) return null;
    label = `${edits.length} edit${edits.length === 1 ? '' : 's'}`;
    edits.forEach((e, i) => {
      if (!e || typeof e !== 'object') return;
      if (i) rows.push({ kind: 'meta', text: '…' });
      rows.push({ kind: 'meta', text: `--- ${e.path || '?'}` });
      if (typeof e.old_string === 'string' && e.old_string !== '') previewRows(rows, 'del', e.old_string);
      if (typeof e.new_string === 'string' && e.new_string !== '') previewRows(rows, 'add', e.new_string);
    });
  } else {
    return null;
  }

  if (!rows.length) return null;
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === 'add') added++;
    else if (r.kind === 'del') removed++;
  }
  const more = Math.max(0, rows.length - PREVIEW_MAX_ROWS);
  return { label, added, removed, more, rows: rows.slice(0, PREVIEW_MAX_ROWS) };
}

/**
 * Ask the operator. Resolves true on approve, false on deny/dismiss.
 * Requests queue: one dialog at a time, in arrival order.
 */
export function askApproval(tool, arg) {
  return new Promise((resolve) => {
    queue.push({ tool, arg, detail: detailText(tool, arg), mode: 'tool', resolve });
    pump();
  });
}

/**
 * Ask about a server-side pending command (not on the allowlist).
 * Resolves 'once' | 'always' | 'deny'.
 */
export function askServerApproval(argv, agent) {
  return new Promise((resolve) => {
    queue.push({
      tool: 'exec',
      arg: { argv },
      detail: (Array.isArray(argv) ? argv.map(a => String(a)).join(' ') : String(argv)),
      mode: 'server',
      agent,
      resolve,
    });
    pump();
  });
}

function pump() {
  if (showing || !queue.length) return;
  showing = true;
  const req = queue.shift();
  show(req).then((result) => {
    showing = false;
    req.resolve(result);
    // Next queued prompt, if any, on the next frame so the DOM settles.
    if (queue.length) requestAnimationFrame(pump);
  });
}

function show(req) {
  return new Promise((resolve) => {
    let veil = null;
    const denyValue = req.mode === 'server' ? 'deny' : false;
    function done(value) {
      document.removeEventListener('keydown', onKey, true);
      if (veil) veil.remove();
      resolve(value);
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); done(denyValue); }
    }

    veil = document.createElement('div');
    veil.className = 'approve-veil';
    const box = document.createElement('div');
    box.className = 'approve-box';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-label', 'Approve tool run');

    const title = document.createElement('div');
    title.className = 'approve-title';
    // textContent throughout: tool names and argv are model-influenced and
    // must never become HTML.
    title.textContent = req.mode === 'server'
      ? `Allow this command?${req.agent ? ` (${req.agent} is waiting)` : ''}`
      : `Run tool "${req.tool}"?`;

    const cmd = document.createElement('pre');
    cmd.className = 'approve-cmd';
    cmd.textContent = req.detail || '(no arguments)';

    const preview = req.mode === 'server' ? null : approvalPreview(req.tool, req.arg);
    let diffHead = null;
    let diff = null;
    if (preview) {
      box.classList.add('has-diff');
      diffHead = document.createElement('div');
      diffHead.className = 'approve-diff-head';
      diffHead.textContent = `${preview.label}  +${preview.added} −${preview.removed}`
        + (preview.more ? `  (${preview.more} more line${preview.more === 1 ? '' : 's'} not shown)` : '');
      diff = document.createElement('pre');
      diff.className = 'approve-diff';
      for (const row of preview.rows) {
        const span = document.createElement('span');
        span.className = `approve-diff-row ${row.kind}`;
        // textContent: file content is model-written and must stay text.
        span.textContent = row.text === '' ? ' ' : row.text;
        diff.appendChild(span);
      }
    }

    const note = document.createElement('div');
    note.className = 'approve-note';
    note.textContent = req.mode === 'server'
      ? 'Not on the allowlist. "Always allow" permits the program; "Deny" blocks it. Both are reversible under Config → Allow/Deny list.'
      : 'Approved for this session only. Reload and you will be asked again.';

    const btns = document.createElement('div');
    btns.className = 'approve-btns';
    const mk = (label, cls, value) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn ${cls}`;
      b.textContent = label;
      b.addEventListener('click', () => done(value));
      return b;
    };
    if (req.mode === 'server') {
      btns.append(mk('Allow once', 'btn-primary', 'once'));
      btns.append(mk('Always allow', 'btn-primary', 'always'));
      btns.append(mk('Deny + block', 'btn-ghost', 'deny'));
    } else {
      btns.append(mk('Approve', 'btn-primary', true));
      btns.append(mk('Deny', 'btn-ghost', false));
    }

    box.append(title, cmd);
    if (preview) box.append(diffHead, diff);
    box.append(note, btns);
    veil.appendChild(box);
    document.body.appendChild(veil);
    document.addEventListener('keydown', onKey, true);
    // Backdrop click denies: the safe default when the pointer misses.
    veil.addEventListener('pointerdown', (ev) => {
      if (ev.target === veil) done(denyValue);
    });
    // Focus the primary button so Enter answers quickly. Escape still denies,
    // and the dialog shows the full command before anything can be clicked.
    const first = btns.querySelector('button');
    if (first) first.focus();
  });
}
