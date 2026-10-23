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

import { store } from './store.js?v=298';

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

function detailText(tool, arg) {
  if (tool === 'write_file' && arg && typeof arg === 'object') {
    const content = String(arg.content ?? '');
    const lines = content.split('\n').length;
    return `path ${arg.path || '?'} (${content.length} bytes, ${lines} line${lines === 1 ? '' : 's'}${arg.mode === 'append' ? ', appending' : ', overwriting'})`;
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

    box.append(title, cmd, note, btns);
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
