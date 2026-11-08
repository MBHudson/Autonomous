/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// COMMSLOG.JS — what was actually said, by whom, to whom
// ============================================
//
// The map already draws a line for every hop, so the shape of a conversation
// was visible while the words were not: a beam says "these two spoke", and then
// it fades. This keeps the sentence — your prompt, the task a coordinator hands
// down, the question an agent asked, the answer it got back, and the reply a
// model produced.
//
// It began as agent-to-agent traffic only, which is exactly why a map card
// could name two agents and then show nothing beneath them: the hops that make
// up most turns (you -> agent, coordinator -> agent, agent -> you) were drawn
// but never recorded here. Every hop the UI draws now leaves its words, so
// "Messages" is the conversation rather than the part that happened to go
// through ask_agent.
//
// In memory and bounded, exactly like trace.js: this is for watching a run, not
// a permanent transcript. Anything the operator is meant to keep is already in
// the session; this is the traffic that never lands there, and a second copy on
// disk would need its own retention decision.

import { store } from './store.js?v=382';

const MAX_EXCHANGES = 600;

/**
 * One entry's text is capped. A prompt can be a pasted file, and the log holds
 * hundreds of entries: unbounded text here is how a long run eats the tab.
 */
const MAX_TEXT = 8000;

let items = [];
let seq = 0;

function changed(entry) {
  try { store.emit('comms:changed', entry); } catch { /* no store */ }
}

/**
 * Cut text to what one entry keeps. Exported because the map puts the same
 * sentence on the beam that draws the hop, and two copies of one message that
 * were cut differently would disagree about what was said.
 */
export function clipText(value) {
  const s = String(value == null ? '' : value);
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT - 1) + '…' : s;
}

/**
 * Record one hop. Returns the entry so an answer can be attached to it later,
 * when the other agent actually replies.
 *
 * `kind` is
 *   'prompt'   you -> an agent: the turn being dispatched
 *   'delegate' a coordinator -> an agent: the same task handed down
 *   'ask'      an agent -> another agent, answered, so a reply is expected
 *   'tell'     a one-way order into a mailbox
 *   'ping'     a nudge to go read the mailbox
 *   'reply'    an agent -> you: the answer that came back
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
    text: clipText(text),
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
  entry.reply = clipText(reply);
  entry.ok = ok !== false;
  entry.ms = Date.now() - entry.t;
  changed(entry);
  return entry;
}

/** Newest first. */
export function recent(n = 200) {
  return items.slice(-Math.max(1, n)).reverse();
}

/** Entries one agent sent or received — its whole side of the conversation. */
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
export const TEXT_MAX = MAX_TEXT;
