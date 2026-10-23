// ============================================
// TRACE.JS — a lightweight run log (observability)
// ============================================
//
// Every model turn and every tool call lands here as one event: who ran it,
// what it was, how long it took, whether it worked, and what it cost in
// tokens. It is the "what actually happened" view that per-agent totals
// cannot give you — they sum, this sequences.
//
// In-memory and bounded (this page-load only). A ring buffer, not storage:
// traces are for watching a run, not for keeping forever, and unbounded logs
// are how a tab grows to hundreds of megabytes.

import { store } from './store.js?v=299';

const MAX_EVENTS = 500;

let events = [];
let seq = 0;

/**
 * Record one event. `kind` is 'model' | 'tool' | 'error' | 'note'.
 * data: {agentId, agentName, model, tool, ms, ok, prompt, completion, approx, error}
 */
export function trace(kind, data = {}) {
  const e = { id: ++seq, t: Date.now(), kind, ...data };
  events.push(e);
  if (events.length > MAX_EVENTS) { events = events.slice(events.length - MAX_EVENTS); }
  try { store.emit('trace:changed', e); } catch { /* no store */ }
  return e;
}

/** Newest first. */
export function recent(n = 200) {
  return events.slice(-Math.max(1, n)).reverse();
}

export function clear() {
  events = [];
  try { store.emit('trace:changed', null); } catch { /* no store */ }
}

export function count() { return events.length; }

/** Roll the buffer into per-agent totals, for a header line. */
export function stats() {
  const byAgent = new Map();
  let calls = 0, toolCalls = 0, errors = 0, tokens = 0;
  for (const e of events) {
    if (e.kind === 'model') { calls++; tokens += (e.prompt || 0) + (e.completion || 0); }
    if (e.kind === 'tool') toolCalls++;
    if (e.ok === false) errors++;
    const key = e.agentId || 'system';
    const a = byAgent.get(key)
      || { agentId: key, name: e.agentName || key, calls: 0, tools: 0, errors: 0, tokens: 0 };
    if (e.agentName) a.name = e.agentName;
    if (e.kind === 'model') { a.calls++; a.tokens += (e.prompt || 0) + (e.completion || 0); }
    if (e.kind === 'tool') { a.tools++; if (e.ok === false) a.errors++; }
    byAgent.set(key, a);
  }
  return {
    calls, toolCalls, errors, tokens, count: events.length,
    byAgent: [...byAgent.values()].sort((x, y) => (y.calls + y.tools) - (x.calls + x.tools)),
  };
}
