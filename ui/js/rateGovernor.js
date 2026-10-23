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
// await, so 16 parallel callers cannot all see "room for one more". Waits are
// abort-aware (Stop still stops) and capped (fail open: after maxWait the
// call goes out anyway and the 429 retry path becomes the safety net).
//
// In-memory only. Reload resets every bucket, which is the safe direction:
// a stale bucket throttles calls that would succeed, a fresh one merely risks
// a 429 the retry path already handles.

import { store } from './store.js?v=306';
import { settingFor, hasRateLock, overridesOf } from './agentConfig.js?v=306';
import { defaultRpmFor } from './harness.js?v=306';

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
    b = { times: [], notBefore: 0, waiting: 0 };
    buckets.set(key, b);
  }
  return b;
}

function prune(b, now) {
  while (b.times.length && b.times[0] <= now - WINDOW_MS) b.times.shift();
}

/**
 * Claim the next slot, synchronously. Returns when the call may start and
 * how long it must wait first. No awaits inside: parallel callers serialize
 * here instead of racing past the check.
 */
function reserve(key, rpm, now) {
  const b = bucketFor(key);
  prune(b, now);
  let startAt = now;
  if (b.notBefore > startAt) startAt = b.notBefore;
  // Re-prune against the pushed-back start: slots freeing while we wait count.
  while (b.times.length && b.times[0] <= startAt - WINDOW_MS) b.times.shift();
  if (b.times.length >= rpm) startAt = Math.max(startAt, b.times[0] + WINDOW_MS + SLOT_BUFFER_MS);
  if (b.notBefore > startAt) startAt = b.notBefore;
  b.times.push(startAt);
  return { key, waitMs: Math.max(0, startAt - now) };
}

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
  const rpm = conf.rpm;
  const now = Date.now();
  const { waitMs } = reserve(key, rpm, now);
  if (waitMs <= 0) return { key, waitedMs: 0, overBudget: false };
  const maxWait = conf.maxWait;
  const capped = Math.min(waitMs, maxWait);
  const b = bucketFor(key);
  b.waiting += 1;
  try {
    store.emit('governor:changed', { key, waiting: b.waiting });
  } catch { /* no store */ }
  try {
    await sleep(capped, opts.signal);
  } finally {
    b.waiting = Math.max(0, b.waiting - 1);
    try {
      store.emit('governor:changed', { key, waiting: b.waiting });
    } catch { /* no store */ }
  }
  if (!conf.stealth && capped >= 1500) {
    try {
      store.emit('toast', {
        message: `Rate limit: waited ${Math.round(capped / 1000)}s for a slot${capped < waitMs ? ' (cap reached, going anyway)' : ''}`,
        type: 'info',
      });
    } catch { /* no store */ }
  }
  return { key, waitedMs: capped, overBudget: capped < waitMs };
}

/**
 * A real 429 teaches the bucket: hold it closed for the server's Retry-After
 * (capped), or 10s when none was given. The next acquire waits instead of
 * spending another refusal.
 */
export function note429(key, retryAfterMs) {
  if (!key) return;
  const ra = Number(retryAfterMs);
  const hold = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60000) : 10000;
  const b = bucketFor(key);
  b.notBefore = Math.max(b.notBefore, Date.now() + hold);
  try {
    store.emit('governor:changed', { key, waiting: b.waiting, learned: true });
  } catch { /* no store */ }
}

/** Requests in the current window for one host+key. For injection + status. */
export function usageFor(endpoint, apiKey, agentId = null) {
  const spec = { endpoint, api_key: apiKey, agent_id: agentId };
  const conf = rateConf(spec);
  const key = bucketForSpec(spec);
  const b = buckets.get(key);
  if (!b) return { key, used: 0, rpm: conf.rpm, waiting: 0 };
  prune(b, Date.now());
  return { key, used: b.times.length, rpm: conf.rpm, waiting: b.waiting };
}

/** Every live bucket, busiest first. For the Config status line. */
export function snapshot() {
  const now = Date.now();
  const out = [];
  for (const [key, b] of buckets) {
    prune(b, now);
    if (!b.times.length && !b.waiting) continue;
    out.push({ key: shortBucket(key), used: b.times.length, rpm: governorRpm(), waiting: b.waiting });
  }
  return out.sort((a, b2) => (b2.used - a.used));
}
