/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// RATE-GOVERNOR.JS — per-key request pacing
// ============================================
//
// A 20-requests/minute key dies when 16 chart nodes fire at once or a retry
// storm spends the whole minute in 3 seconds. This paces outbound MODEL
// calls so a full bucket never looks like an outage.
//
// Keyed on host + effective key, never on agent or provider id: four agents
// with four keys are four separate buckets (no false sharing), while two
// agents on one Groq key correctly contend for the same one. Same key on two
// hosts is two buckets, because the limit lives at the provider, not in the
// key string.
//
// Reserve-then-wait, done synchronously: the slot is claimed before the first
// await, so 16 parallel callers cannot all see "room for one more". A claim is
// a real claim -- it holds its place in the window even while it is still in
// the future, and it is handed back when the call never goes out (Stop), so a
// cancelled fan-out cannot bench the key for the next minute.
//
// Waits are abort-aware (Stop still stops) and capped: past maxWait the call
// goes out anyway and the 429 retry path becomes the safety net. When it does,
// the claim moves to the moment actually used instead of staying parked in the
// future, so the window keeps telling the truth.
//
// In-memory only. Reload resets every bucket, which is the safe direction:
// a stale bucket throttles calls that would succeed, a fresh one merely risks
// a 429 the retry path already handles.

import { store } from './store.js?v=382';
import { settingFor, hasRateLock, overridesOf } from './agentConfig.js?v=382';
import { defaultRpmFor } from './harness.js?v=382';

/** Sliding window length. Per-minute limits are the common shape. */
const WINDOW_MS = 60000;
/** Small spacing so a freed slot is actually free when we use it. */
const SLOT_BUFFER_MS = 250;

const buckets = new Map();

function settings() {
  return store.get('settings') || {};
}

export function governorEnabled() {
  return settings().rateLimitEnabled !== false;
}

export function governorRpm() {
  const n = parseInt(settings().rateLimitRpm, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 600) : 20;
}

export function governorMaxWaitMs() {
  // Stored in MILLISECONDS (the Config field edits seconds and converts on
  // SAVE). Clamp to 1s..10min; the default covers a full saturated minute.
  const n = parseInt(settings().rateLimitMaxWaitMs, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 1000), 600000) : 65000;
}

export function governorStealth() {
  return settings().rateLimitStealth !== false;
}

function hostOf(endpoint) {
  try {
    const h = new URL(String(endpoint || '')).hostname.toLowerCase();
    return h || String(endpoint || '');
  } catch {
    return String(endpoint || '');
  }
}

/** Sync djb2 hash: a bucket id, not a credential. Never logged raw. */
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** Stable bucket id for one provider host + one effective key. */
export function bucketKey(endpoint, apiKey) {
  return `${hostOf(endpoint)}:${hash(`${hostOf(endpoint)}|${apiKey || ''}`)}`;
}

function agentFor(spec) {
  const id = spec?.agent_id;
  if (!id) return null;
  return (store.get('agents') || []).find(a => a.id === id) || null;
}

function providerFor(agent) {
  if (!agent) return null;
  return (store.get('providers') || []).find(p => p.id === agent.provider) || null;
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const asRpm = v => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 600) : null;
};

/**
 * Resolve pacing for this call.
 *
 * Precedence for the per-minute ceiling:
 *   agent rateRpm lock  >  provider rateRpm  >  global rateLimitRpm (if the
 *   operator set one)  >  the host's free-tier default (harness table).
 *
 * That last rung is the fix for "the limiter does nothing": with nothing
 * configured, a NVIDIA NIM key now paces at its real 40/min instead of a
 * generic 20, and a local Ollama host (0) is left unpaced. An agent with ANY
 * rate lock owns its own bucket; otherwise it shares the host+key bucket.
 */
function rateConf(spec) {
  const s = settings();
  const globalEnabled = s.rateLimitEnabled !== false;
  const hostRpm = defaultRpmFor(spec?.endpoint);
  const globalRpm = asRpm(s.rateLimitRpm) ?? hostRpm;

  const agent = agentFor(spec);
  if (!agent) {
    return {
      enabled: globalEnabled && hostRpm !== 0,
      rpm: globalRpm,
      maxWait: governorMaxWaitMs(),
      stealth: governorStealth(),
      own: false,
    };
  }
  const o = overridesOf(agent);
  const provider = providerFor(agent);
  const providerRpm = provider ? asRpm(provider.rateRpm) : null;
  const rpm = has(o, 'rateRpm') ? asRpm(o.rateRpm) ?? globalRpm : (providerRpm ?? globalRpm);
  return {
    enabled: settingFor(agent, 'rateEnabled') !== false && rpm !== 0,
    rpm,
    maxWait: settingFor(agent, 'rateMaxWaitMs'),
    stealth: settingFor(agent, 'rateStealth') !== false,
    own: hasRateLock(agent),
  };
}

/** What the governor will actually use for a call — for the Config status line. */
export function limitsFor(endpoint, apiKey, agentId = null) {
  const conf = rateConf({ endpoint, api_key: apiKey, agent_id: agentId });
  return {
    enabled: conf.enabled,
    rpm: conf.rpm,
    hostDefault: defaultRpmFor(endpoint),
    own: conf.own,
  };
}

function bucketForSpec(spec) {
  const base = bucketKey(spec?.endpoint, spec?.api_key);
  if (!rateConf(spec).own) return base;
  return `${base}:agent-${hash(String(spec.agent_id))}`;
}

/** Short human label for status lines. Not reversible to the key. */
export function shortBucket(key) {
  return String(key || '').slice(0, 24);
}

function bucketFor(key) {
  let b = buckets.get(key);
  if (!b) {
    b = { times: [], notBefore: 0, waiting: 0, rpm: 0 };
    buckets.set(key, b);
  }
  return b;
}

function prune(b, now) {
  while (b.times.length && b.times[0] <= now - WINDOW_MS) b.times.shift();
}

/** First index in an ascending list whose value is strictly AFTER `t`. */
function upper(times, t) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function insert(times, at) {
  times.splice(upper(times, at), 0, at);
}

/**
 * Claim the next slot, synchronously. Returns when the call may start and how
 * long it must wait first. No awaits inside, so parallel callers serialize
 * here instead of racing past the check.
 *
 * The window is counted AT THE START TIME BEING CLAIMED, and re-counted after
 * every push forward. That is what makes the promise above true:
 *
 *   * a claim made ahead of time keeps occupying its place, so a queue cannot
 *     all land on one instant and go out as a burst; and
 *   * only load that is genuinely in the past is forgotten, so a claim cannot
 *     quietly delete requests that are still inside the minute.
 *
 * Exported for the unit tests: this is the whole scheduler, and it has no I/O.
 *
 * @returns {{key:string, at:number, waitMs:number}}
 */
export function planSlot(key, rpm, now = Date.now()) {
  const b = bucketFor(key);
  b.rpm = rpm;
  prune(b, now);
  let startAt = Math.max(now, b.notBefore);
  for (let guard = 0; guard < 1000; guard++) {
    const from = upper(b.times, startAt - WINDOW_MS);
    const to = upper(b.times, startAt);
    if (to - from < rpm) break;
    // The oldest start inside that window decides when a place frees up.
    const next = b.times[from] + WINDOW_MS + SLOT_BUFFER_MS;
    if (next <= startAt) break;
    startAt = next;
  }
  const at = Math.max(startAt, b.notBefore);
  insert(b.times, at);
  return { key, at, waitMs: Math.max(0, at - now) };
}

/**
 * Hand a claimed slot back. Used when the call never went out -- a wait cut
 * short by Stop, or a queue longer than the operator allows -- because a
 * reservation left behind keeps the key shut for a request nobody sent.
 */
export function releaseSlot(key, at) {
  const b = buckets.get(key);
  if (!b) return false;
  const i = b.times.indexOf(at);
  if (i === -1) return false;
  b.times.splice(i, 1);
  return true;
}

/** Move a claim to `now`: the call is going out early, so say so honestly. */
function rebook(key, at, now) {
  releaseSlot(key, at);
  insert(bucketFor(key).times, now);
}

/** Abort-aware pause: Stop still stops while a call is queued. */
function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (!signal) return new Promise(r => setTimeout(r, ms));
  if (signal.aborted) {
    const e = new Error('The user aborted a request.');
    e.name = 'AbortError';
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    let t = null;
    const onAbort = () => {
      if (t !== null) clearTimeout(t);
      const e = new Error('The user aborted a request.');
      e.name = 'AbortError';
      reject(e);
    };
    t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wait for a slot on this call's bucket. Resolves {waitedMs, overBudget}.
 * overBudget means the wait exceeded maxWait and the call proceeds anyway.
 */
export async function acquire(spec, opts = {}) {
  const conf = rateConf(spec);
  const key = bucketForSpec(spec);
  if (!conf.enabled) return { key, waitedMs: 0, overBudget: false };

  const now = Date.now();
  const plan = planSlot(key, conf.rpm, now);
  const maxWait = conf.maxWait;

  // Longer than the operator allows. The call goes out now -- the retry path
  // is the safety net -- but the claim moves to the moment actually used, so a
  // queue nobody is in stops being reported for minutes afterwards.
  if (plan.waitMs > maxWait) {
    rebook(key, plan.at, now);
    if (!conf.stealth) {
      try {
        store.emit('toast', {
          message: `Rate limit: ${Math.round(plan.waitMs / 1000)}s is past the `
            + `${Math.round(maxWait / 1000)}s cap — going anyway`,
          type: 'info',
        });
      } catch { /* no store */ }
    }
    return { key, waitedMs: 0, overBudget: true };
  }

  if (plan.waitMs <= 0) return { key, waitedMs: 0, overBudget: false };

  const b = bucketFor(key);
  b.waiting += 1;
  try {
    store.emit('governor:changed', { key, waiting: b.waiting });
  } catch { /* no store */ }

  let waited = Math.min(plan.waitMs, maxWait);
  try {
    await sleep(waited, opts.signal);
    // A 429 learned while we were queued moved the hold. Honour it while there
    // is budget left; past maxWait the call goes and the retry path takes over.
    // Without this the lesson only reached the NEXT caller, while everyone
    // already asleep woke up and spent the same refusal.
    const hold = bucketFor(key).notBefore - Date.now();
    if (hold > 0) {
      const extra = Math.min(hold, Math.max(0, maxWait - waited));
      if (extra > 0) {
        await sleep(extra, opts.signal);
        waited += extra;
      }
    }
  } catch (err) {
    // Stop, or the tab closing mid-queue: the call never went out, so give the
    // slot back instead of leaving the key paced for a phantom request.
    releaseSlot(key, plan.at);
    throw err;
  } finally {
    b.waiting = Math.max(0, b.waiting - 1);
    try {
      store.emit('governor:changed', { key, waiting: b.waiting });
    } catch { /* no store */ }
  }

  if (!conf.stealth && waited >= 1500) {
    try {
      store.emit('toast', {
        message: `Rate limit: waited ${Math.round(waited / 1000)}s for a slot`,
        type: 'info',
      });
    } catch { /* no store */ }
  }
  return { key, waitedMs: waited, overBudget: waited < plan.waitMs };
}

/**
 * A real 429 teaches the bucket: hold it closed for the server's Retry-After
 * (capped), or 10s when none was given. The next acquire waits instead of
 * spending another refusal, and a caller already queued re-reads this hold
 * after it wakes (see acquire), so the lesson reaches the whole queue.
 *
 * `now` is injectable for the unit tests; production never passes it.
 */
export function note429(key, retryAfterMs, now = Date.now()) {
  if (!key) return;
  const ra = Number(retryAfterMs);
  const hold = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60000) : 10000;
  const b = bucketFor(key);
  b.notBefore = Math.max(b.notBefore, now + hold);
  try {
    store.emit('governor:changed', { key, waiting: b.waiting, learned: true });
  } catch { /* no store */ }
}

/**
 * Requests that actually started inside the window for one host+key. A claim
 * still waiting its turn is deliberately NOT counted: "20/20 used" while
 * nothing has gone out reads as an overrun when it is only a queue.
 */
export function usageFor(endpoint, apiKey, agentId = null) {
  const spec = { endpoint, api_key: apiKey, agent_id: agentId };
  const conf = rateConf(spec);
  const key = bucketForSpec(spec);
  const b = buckets.get(key);
  if (!b) return { key, used: 0, rpm: conf.rpm, waiting: 0 };
  const now = Date.now();
  prune(b, now);
  return { key, used: upper(b.times, now), rpm: conf.rpm, waiting: b.waiting };
}

/**
 * Every live bucket, busiest first. For the Config status line. Each row
 * carries the ceiling THAT bucket was paced to, not the global fallback: an
 * auto bucket on NVIDIA runs at 40 while a locked agent runs at its own lock.
 */
export function snapshot() {
  const now = Date.now();
  const out = [];
  for (const [key, b] of buckets) {
    prune(b, now);
    if (!b.times.length && !b.waiting) continue;
    out.push({
      key: shortBucket(key),
      used: upper(b.times, now),
      rpm: b.rpm || governorRpm(),
      waiting: b.waiting,
    });
  }
  return out.sort((a, b2) => (b2.used - a.used));
}
