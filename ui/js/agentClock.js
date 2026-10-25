/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// AGENT-CLOCK.JS — per-agent usage line (tokens / requests / uptime)
// ============================================
//
// One line per agent: tokens spent against a budget (e.g. 1.2m/8.0m), the
// request count, and how long this page has been up. Rendered on the agent
// card (Agents tab) and on routing-chart nodes, refreshed on every recorded
// call.
//
// Three different "max" figures are kept apart on purpose:
//   - the fraction (1.2m/8.0m) is the BUDGET you set in Config (a provider's
//     free-tier token allowance). Set it to 0 and the line shows raw totals.
//   - the model's CONTEXT WINDOW (the thing that kills a call when the
//     conversation outgrows it) shows in the tooltip when known. From the
//     generated harness table; unknown models show nothing, never a fake number.
//   - the agent's maxTokens/output cap also lives in the tooltip.
//
// Metrics start at zero on an install that has never recorded a call, so a new
// clock reads "no usage yet" until the agent actually calls.

import { store } from './store.js?v=330';
import { usageFor, limitsFor } from './rateGovernor.js?v=330';
import { settingFor } from './agentConfig.js?v=330';
import { contextLimitFor } from './harness.js?v=330';

export { contextLimitFor };

export function fmtTokens(n) {
  n = Math.round(n || 0);
  if (n >= 1000000) return `${(n / 1000000).toFixed(2).replace(/\.?0+$/, '')}m`;
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(2).replace(/\.?0+$/, '')}k`;
  return String(n);
}

function fmtUptime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

function fmtAgo(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const BOOT_AT = Date.now();
/** agentId -> ms timestamp of the last recorded call, this page-load only. */
const lastActive = new Map();

/**
 * All-time totals for one agent, summed across every session.
 *
 * `calls` counts turns the provider reported usage for; `requests` counts
 * every turn the agent ran, including ones with no usage block (many free
 * tiers stream without one). Keeping both means the request count is honest
 * even when token accounting is not.
 */
export function agentTotals(agentId) {
  const metrics = store.get('metrics') || { sessions: {} };
  let prompt = 0, completion = 0, calls = 0, requests = 0, approx = false;
  for (const sess of Object.values(metrics.sessions || {})) {
    const e = sess?.agents?.[agentId];
    if (!e) continue;
    prompt += e.prompt || 0;
    completion += e.completion || 0;
    calls += e.calls || 0;
    requests += e.requests || e.calls || 0;
    approx = approx || !!e.approx;
  }
  return { prompt, completion, calls, requests, approx, total: prompt + completion };
}

function agentAndProvider(agentId) {
  const agent = (store.get('agents') || []).find(a => a.id === agentId);
  if (!agent) return {};
  const provider = (store.get('providers') || []).find(p => p.id === agent.provider);
  return { agent, provider };
}

/** True while one of this agent's calls is queued on its rate bucket. */
function agentWaiting(agentId) {
  const { agent, provider } = agentAndProvider(agentId);
  if (!agent) return false;
  try {
    return usageFor(agent.endpoint || provider?.endpoint, agent.keyOverride || provider?.apiKey, agent.id).waiting > 0;
  } catch {
    return false;
  }
}

/**
 * One agent's clock line. {text, title, waiting, over}.
 * over is true when spent tokens passed the budget.
 */
export function clockFor(agentId) {
  const { agent, provider } = agentAndProvider(agentId);
  if (!agent) return { text: '', title: '', waiting: false, over: false };
  const t = agentTotals(agentId);
  const limit = contextLimitFor(agent.model);
  const cap = settingFor(agent, 'maxTokens') ?? 16384;
  const budget = Number(settingFor(agent, 'tokenBudget')) || 0;
  const waiting = agentWaiting(agentId);
  const up = fmtUptime(Date.now() - BOOT_AT);
  const seen = lastActive.get(agentId);
  const activeBit = seen ? ` · active ${fmtAgo(Date.now() - seen)}` : '';
  const waitBit = waiting ? ' · ⏳ waiting for a slot' : '';

  let rpmBit = '';
  try {
    const lim = limitsFor(agent.endpoint || provider?.endpoint, agent.keyOverride || provider?.apiKey, agent.id);
    if (lim.enabled && lim.rpm) rpmBit = ` · ${lim.rpm}/min`;
  } catch { /* decorative */ }

  const title = `${t.prompt.toLocaleString('en-US')} in · ${t.completion.toLocaleString('en-US')} out · `
    + `${t.requests} request${t.requests === 1 ? '' : 's'} · ${t.calls} billed call${t.calls === 1 ? '' : 's'} · output cap ${Number(cap).toLocaleString('en-US')}`
    + (budget ? ` · budget ${budget.toLocaleString('en-US')}` : ' · no budget set')
    + (limit ? ` · context ${limit.toLocaleString('en-US')}` : ' · context unknown')
    + (seen ? ` · last call ${new Date(seen).toLocaleString()}` : ' · no calls yet');

  if (!t.requests) {
    return { text: `⚡ no usage yet · up ${up}${rpmBit}${waitBit}`, title, waiting, over: false };
  }

  const over = !!(budget && t.total >= budget);
  // Budget is the headline the operator asked for (used/limit); fall back to a
  // context-window fraction, then to a raw token total.
  const frac = budget
    ? `${fmtTokens(t.total)}/${fmtTokens(budget)}`
    : (limit ? `${fmtTokens(t.total)}/${fmtTokens(limit)}` : `${fmtTokens(t.total)} tok`);
  const pct = budget ? ` (${Math.round((t.total / budget) * 100)}%)` : '';
  const mark = t.approx ? '~' : '';   // some turns were estimated, not reported
  return {
    text: `⚡ ${mark}${frac}${pct} · ${t.requests} req · up ${up}${activeBit}${rpmBit}${waitBit}`,
    title,
    waiting,
    over,
  };
}

/** Refresh every agent-card clock in the Agents tab. Cheap: text updates. */
export function refreshAgentClocks() {
  try {
    document.querySelectorAll('[data-clock-agent]').forEach(el => {
      const c = clockFor(el.dataset.clockAgent);
      if (el.textContent !== c.text) el.textContent = c.text;
      if (c.title) el.title = c.title;
      el.classList.toggle('clock-waiting', !!c.waiting);
      el.classList.toggle('clock-over', !!c.over);
    });
  } catch { /* non-DOM context */ }
}

/** Refresh one routing-chart node's clock line. Best-effort: never break a render. */
export function updateNodeClock(el, node) {
  try {
    if (!el || !node || node.type !== 'agent' || !node.agentId) return;
    let line = el.querySelector('.rc-node-clock');
    if (!line) {
      line = document.createElement('div');
      line.className = 'rc-node-clock';
      const meta = el.querySelector('.rc-node-meta');
      if (meta) meta.after(line);
      else el.appendChild(line);
    }
    const c = clockFor(node.agentId);
    if (line.textContent !== c.text) line.textContent = c.text;
    if (c.title) line.title = c.title;
    line.classList.toggle('clock-waiting', !!c.waiting);
    line.classList.toggle('clock-over', !!c.over);
  } catch { /* a clock must never break the canvas */ }
}

let clockInit = false;
/** Wire refresh triggers. Idempotent: safe to call from several panels. */
export function initClocks() {
  if (clockInit) return;
  clockInit = true;
  try {
    store.on('metrics:changed', (payload) => {
      if (payload && payload.agentId) lastActive.set(payload.agentId, Date.now());
      refreshAgentClocks();
    });
    // Governor waits carry no agent id; just repaint pips.
    store.on('governor:changed', () => refreshAgentClocks());
    // Uptime and "active Xm ago" go stale otherwise. One timer, not one per
    // agent: 17 intervals ticking forever is how tabs die in the background.
    setInterval(refreshAgentClocks, 60000);
  } catch { /* no store */ }
}
