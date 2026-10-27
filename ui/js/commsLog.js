/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// COMMSLOG.JS — what the agents actually said to each other
// ============================================
//
// The map already draws a line for every agent-to-agent hop, so the shape of a
// conversation was visible while the words were not: a beam says "these two
// spoke", and then it fades. This keeps the sentence — the question an agent
// asked, the answer it got back, and the one-way orders it posted.
//
// In memory and bounded, exactly like trace.js: this is for watching a run, not
// a permanent transcript. Anything the operator is meant to keep is already in
// the session; this is the traffic that never lands there, and a second copy on
// disk would need its own retention decision.

import { store } from './store.js?v=351';

const MAX_EXCHANGES = 300;

let items = [];
let seq = 0;

function changed(entry) {
  try { store.emit('comms:changed', entry); } catch { /* no store */ }
}

/**
 * Record one exchange. Returns the entry so the answer can be attached to it
 * later, when the other agent actually replies.
 *
 * `kind` is 'ask' (answered, so a reply is expected), 'tell' (a one-way order)
 * or 'ping' (a nudge to go read the mailbox).
 */
export function record({ fromId, fromName, toId, toName, kind = 'ask', text = '' } = {}) {
  const e = {
    id: ++seq,
    t: Date.now(),
    fromId: fromId || null,
    fromName: fromName || fromId || 'agent',
    toId: toId || null,
    toName: toName || toId || 'agent',
    kind,
    text: String(text == null ? '' : text),
    reply: '',
    ok: null,
    ms: null,
  };
  items.push(e);
  if (items.length > MAX_EXCHANGES) items = items.slice(items.length - MAX_EXCHANGES);
  changed(e);
  return e;
}

/** Attach the answer — or the failure — to an entry an ask returned earlier. */
export function settle(entry, reply, ok = true) {
  if (!entry) return null;
  entry.reply = String(reply == null ? '' : reply);
  entry.ok = ok !== false;
  entry.ms = Date.now() - entry.t;
  changed(entry);
  return entry;
}

/** Newest first. */
export function recent(n = 200) {
  return items.slice(-Math.max(1, n)).reverse();
}

/** Entries one agent sent or received. Newest first. */
export function forAgent(agentId, n = 200) {
  if (!agentId) return [];
  return recent(MAX_EXCHANGES)
    .filter(e => e.fromId === agentId || e.toId === agentId)
    .slice(0, Math.max(1, n));
}

export function clear() {
  items = [];
  seq = 0;
  changed(null);
}

export function count() { return items.length; }

export const MAX = MAX_EXCHANGES;
