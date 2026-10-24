/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// APPROVALS.JS — server-side command approvals, anywhere
// ============================================
//
// When an agent runs a command that is not on the allowlist, the server parks
// it and hands back a pending id. That request used to sit in the Config tab,
// which polled for it ONLY while the tab was open -- so a run on the routing
// chart stalled with no visible reason, and the thing it was waiting on lived
// somewhere the operator was not looking.
//
// This watcher polls regardless of tab and raises the in-app approval dialog
// the moment a new request appears. One dialog per pending id, ever: ids are
// remembered, and deciding removes the id from the server, so a second device
// or the Config tab's own buttons can never double-prompt.
//
// Errors back off instead of spamming: a copy with no token (or no server)
// would otherwise toast every few seconds forever.

import { api } from './api.js?v=326';
import { store } from './store.js?v=326';
import { askServerApproval } from './approveDialog.js?v=326';

const POLL_MS = 6000;
const MAX_BACKOFF_MS = 60000;

let started = false;
let timer = null;
let backoff = POLL_MS;
/** ids already shown (or being shown). Prevents double prompts. */
const seen = new Set();
/** ids currently with a dialog open. */
const open = new Set();

function cmdline(argv) {
  return (Array.isArray(argv) ? argv : []).map(a => String(a)).join(' ');
}

async function decide(id, decision, argv) {
  try {
    const res = await api.execDecide(id, decision);
    if (res && res.ok) {
      const cmd = cmdline(argv).slice(0, 80);
      if (decision === 'deny') {
        const name = (res && res.denied) || cmdline(argv).split(' ')[0];
        store.emit('toast', { message: `Denied and blocked "${name}" — remove it under Config → Allow/Deny list to undo.`, type: 'info' });
      } else if (decision === 'always' && res.allowlisted) {
        store.emit('toast', { message: `Allowed and added "${res.allowlisted}" to the allowlist (reversible in Config).`, type: 'info' });
      } else {
        store.emit('toast', { message: `Allowed once: ${cmd}`, type: 'info' });
      }
    } else {
      // Already handled elsewhere (Config tab, another device) or expired.
      store.emit('toast', { message: `That request is already handled (${(res && res.error) || 'gone'}).`, type: 'info' });
    }
  } catch (err) {
    store.emit('toast', { message: `Approval failed: ${err.message}`, type: 'error' });
  } finally {
    open.delete(id);
  }
}

async function promptOne(req) {
  const id = req.id;
  if (!id || seen.has(id) || open.has(id)) return;
  seen.add(id);
  open.add(id);
  try {
    const decision = await askServerApproval(req.argv, req.agent);
    await decide(id, decision, req.argv);
  } finally {
    open.delete(id);
  }
}

async function poll() {
  let list = null;
  try {
    const res = await api.execPending();
    list = res.pending || [];
    backoff = POLL_MS;
  } catch {
    // No server, no token, copy asleep: wait longer, stay silent. The next
    // success resets the interval.
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    schedule();
    return;
  }
  // Forget ids the server no longer lists (decided elsewhere, expired).
  const live = new Set(list.map(p => p.id).filter(Boolean));
  for (const id of [...seen]) if (!live.has(id)) seen.delete(id);
  for (const req of list) {
    // Fire and forget -- the poll loop must never wait on the operator.
    // Ordering is handled inside the dialog's own queue: one dialog at a
    // time, in arrival order, never stacked.
    promptOne(req).catch(() => {});
  }
  schedule();
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(poll, backoff);
}

export function initApprovals() {
  if (started) return;
  started = true;
  // Fast path: an exec call just parked something. Jump the queue instead of
  // waiting for the next poll -- the operator is likely watching that agent.
  try {
    store.on('exec:pending', () => {
      poll().catch(() => {});
    });
  } catch { /* no store */ }
  schedule();
}
