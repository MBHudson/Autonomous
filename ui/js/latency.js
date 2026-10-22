// ============================================
// LATENCY.JS — measured per-agent model-call latency ("ping")
// ============================================
//
// Every real model call (streamed relay, one-shot relay, direct provider call)
// is timed in api.js and recorded here against the agent that made it. The
// clock starts AFTER the rate governor hands out a slot, so a fan-out waiting
// its turn is not reported as a slow model; the wait is kept separately as
// `queueMs`.
//
// Deliberately free of imports: the store is injected (bindStore) so this file
// loads in Node for the unit tests without any browser globals.

/** Samples kept per agent. Enough for a stable p95, small enough to persist. */
export const MAX_SAMPLES = 50;

/** Persist at most this often; a busy fan-out records many samples a second. */
const SAVE_DEBOUNCE_MS = 1500;

/**
 * Nearest-rank percentile of an ascending-sorted array.
 * @param {number[]} sorted ascending
 * @param {number} p 0..100
 */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * Summary of a sample list. Failed calls count towards the error rate but not
 * towards the timing figures — a 401 that answers in 80ms is not a fast model.
 * @param {Array<{ms:number, ttft?:number|null, queueMs?:number, ok:boolean, at:number, error?:string}>} samples
 */
export function computeStats(samples) {
  const list = Array.isArray(samples) ? samples : [];
  const okList = list.filter(s => s && s.ok && Number.isFinite(s.ms));
  const errors = list.filter(s => s && !s.ok);
  const ms = okList.map(s => s.ms).sort((a, b) => a - b);
  const ttfts = okList.map(s => s.ttft).filter(Number.isFinite);
  const queues = list.map(s => s && s.queueMs).filter(Number.isFinite);
  const avg = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const lastOk = okList.length ? okList[okList.length - 1] : null;
  const lastAny = list.length ? list[list.length - 1] : null;
  const lastErr = errors.length ? errors[errors.length - 1] : null;
  return {
    count: list.length,
    okCount: okList.length,
    errors: errors.length,
    errorRate: list.length ? errors.length / list.length : 0,
    last: lastOk ? lastOk.ms : null,
    lastTtft: lastOk && Number.isFinite(lastOk.ttft) ? lastOk.ttft : null,
    avg: avg(ms),
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    min: ms.length ? ms[0] : null,
    max: ms.length ? ms[ms.length - 1] : null,
    ttftAvg: avg(ttfts),
    queueAvg: avg(queues),
    lastAt: lastAny ? lastAny.at : null,
    lastOk: lastAny ? !!lastAny.ok : null,
    lastError: lastErr ? (lastErr.error || 'error') : null,
    lastErrorAt: lastErr ? lastErr.at : null,
    /** Oldest → newest successful durations, for sparklines. */
    series: okList.slice(-20).map(s => s.ms),
  };
}

/** Human figure for a duration: 840ms, 1.4s, 12s. */
export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/** Traffic-light bucket for a latency figure. */
export function latencyTier(ms) {
  if (!Number.isFinite(ms)) return 'none';
  if (ms < 1500) return 'good';
  if (ms < 4000) return 'warn';
  return 'bad';
}

function isAbort(err) {
  return !!err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')));
}

export class LatencyTracker {
  constructor({ storageKey = null, now = () => Date.now(), clock = null } = {}) {
    this.samples = new Map();
    this.storageKey = storageKey;
    this.now = now;
    // High-resolution clock for durations; wall clock only for timestamps.
    this.clock = clock || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._store = null;
    this._saveTimer = null;
    this._loaded = false;
  }

  bindStore(store) { this._store = store; }

  _load() {
    if (this._loaded) return;
    this._loaded = true;
    if (!this.storageKey || typeof localStorage === 'undefined') return;
    try {
      const raw = JSON.parse(localStorage.getItem(this.storageKey) || 'null');
      if (raw && typeof raw === 'object') {
        Object.entries(raw).forEach(([id, list]) => {
          if (Array.isArray(list)) this.samples.set(id, list.slice(-MAX_SAMPLES));
        });
      }
    } catch { /* corrupt cache: start empty */ }
  }

  _save() {
    if (!this.storageKey || typeof localStorage === 'undefined') return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(this.storageKey, JSON.stringify(Object.fromEntries(this.samples)));
      } catch { /* quota: latency is nice-to-have */ }
    }, SAVE_DEBOUNCE_MS);
  }

  /** Append one sample. Ignored without an agent id. */
  record(agentId, sample) {
    if (!agentId) return null;
    this._load();
    const s = {
      ms: Math.max(0, Math.round(Number(sample.ms) || 0)),
      ttft: Number.isFinite(sample.ttft) ? Math.max(0, Math.round(sample.ttft)) : null,
      queueMs: Number.isFinite(sample.queueMs) ? Math.max(0, Math.round(sample.queueMs)) : 0,
      ok: sample.ok !== false,
      at: sample.at || this.now(),
      kind: sample.kind || 'stream',
    };
    if (!s.ok && sample.error) s.error = String(sample.error).slice(0, 200);
    const list = this.samples.get(agentId) || [];
    list.push(s);
    while (list.length > MAX_SAMPLES) list.shift();
    this.samples.set(agentId, list);
    this._save();
    try { this._store?.emit('latency:changed', { agentId, sample: s }); } catch { /* best effort */ }
    return s;
  }

  get(agentId) {
    this._load();
    return this.samples.get(agentId) || [];
  }

  stats(agentId) { return computeStats(this.get(agentId)); }

  /** Pooled stats over several agents (provider totals). */
  statsFor(agentIds) {
    this._load();
    const all = [];
    (agentIds || []).forEach(id => all.push(...(this.samples.get(id) || [])));
    all.sort((a, b) => (a.at || 0) - (b.at || 0));
    return computeStats(all);
  }

  clear(agentId) {
    if (agentId) this.samples.delete(agentId); else this.samples.clear();
    this._save();
    try { this._store?.emit('latency:changed', { agentId: agentId || null }); } catch { /* ignore */ }
  }

  /**
   * Start timing a call. Returns a handle:
   *   started()   — the rate-governor slot was granted; the real clock starts
   *   first()     — first content/reasoning token arrived (idempotent)
   *   end(ok, e)  — finish; aborted calls are discarded, not counted as errors
   */
  begin(agentId, kind = 'stream') {
    const t0 = this.clock();
    let tStart = null;
    let tFirst = null;
    let done = false;
    const self = this;
    return {
      started() { if (tStart == null) tStart = self.clock(); },
      first() { if (tFirst == null) { if (tStart == null) tStart = t0; tFirst = self.clock(); } },
      end(ok = true, err = null) {
        if (done) return null;
        done = true;
        if (!agentId) return null;
        if (!ok && isAbort(err)) return null;
        const tEnd = self.clock();
        const start = tStart == null ? t0 : tStart;
        return self.record(agentId, {
          ms: tEnd - start,
          ttft: tFirst == null ? null : tFirst - start,
          queueMs: start - t0,
          ok,
          error: ok ? undefined : (err && (err.message || String(err))),
          kind,
        });
      },
    };
  }
}

/** Same slug rule as storage.js, without importing it (keeps this Node-safe). */
function storageKey() {
  try {
    const dir = new URL('../../', import.meta.url).pathname;
    const slug = dir.split('/').filter(Boolean).join('__') || 'app';
    return `${slug}::latency`;
  } catch { return null; }
}

export const latency = new LatencyTracker({ storageKey: storageKey() });
export default latency;
