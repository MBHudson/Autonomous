// Latency tracker tests (pure maths + ring buffer + timing handle).
//
// Usage: node tests/js/latency.test.mjs
//
// No browser globals needed. Exits 0 on success, 1 on failure.

import { percentile, computeStats, fmtMs, latencyTier, LatencyTracker, MAX_SAMPLES } from '../../ui/js/latency.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('Latency tracker tests');
console.log('-'.repeat(60));

// percentile (nearest rank)
eq(percentile([], 95), null, 'percentile of empty is null');
eq(percentile([5], 95), 5, 'single value');
const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
eq(percentile(ten, 50), 5, 'p50 of 1..10');
eq(percentile(ten, 95), 10, 'p95 of 1..10');
eq(percentile(ten, 90), 9, 'p90 of 1..10');
eq(percentile(ten, 0), 1, 'p0 is min');
eq(percentile(ten, 100), 10, 'p100 is max');
const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
eq(percentile(hundred, 95), 95, 'p95 of 1..100');

// computeStats
const empty = computeStats([]);
eq(empty.count, 0, 'empty count');
eq(empty.avg, null, 'empty avg null');
eq(empty.errorRate, 0, 'empty error rate 0');
eq(empty.series.length, 0, 'empty series');
eq(computeStats(undefined).count, 0, 'undefined input tolerated');

const s = computeStats([
  { ms: 100, ttft: 40, queueMs: 0, ok: true, at: 1 },
  { ms: 300, ttft: 60, queueMs: 10, ok: true, at: 2 },
  { ms: 50, ok: false, at: 3, error: 'HTTP 401' },
  { ms: 200, ttft: null, queueMs: 20, ok: true, at: 4 },
]);
eq(s.count, 4, 'count includes failures');
eq(s.okCount, 3, 'okCount');
eq(s.errors, 1, 'errors');
eq(s.errorRate, 0.25, 'error rate');
eq(s.avg, 200, 'avg ignores failed call timing');
eq(s.min, 100, 'min');
eq(s.max, 300, 'max');
eq(s.last, 200, 'last successful');
eq(s.ttftAvg, 50, 'ttft avg skips nulls');
eq(s.queueAvg, 10, 'queue avg over samples that report it');
eq(s.lastError, 'HTTP 401', 'last error text');
eq(s.lastOk, true, 'most recent call ok');
eq(s.series.join(','), '100,300,200', 'series oldest→newest');

// formatting / tiers
eq(fmtMs(840), '840ms', 'fmt ms');
eq(fmtMs(1440), '1.4s', 'fmt seconds');
eq(fmtMs(12400), '12s', 'fmt long');
eq(fmtMs(null), '—', 'fmt null');
eq(latencyTier(800), 'good', 'tier good');
eq(latencyTier(2500), 'warn', 'tier warn');
eq(latencyTier(9000), 'bad', 'tier bad');
eq(latencyTier(null), 'none', 'tier none');

// ring buffer
const t = new LatencyTracker({ storageKey: null });
for (let i = 0; i < MAX_SAMPLES + 15; i++) t.record('a', { ms: i, ok: true, at: i });
eq(t.get('a').length, MAX_SAMPLES, 'ring buffer caps samples');
eq(t.get('a')[0].ms, 15, 'oldest samples dropped first');
eq(t.record(null, { ms: 1 }), null, 'no agent id → ignored');
eq(t.get('missing').length, 0, 'unknown agent → empty');

// pooled stats
t.record('b', { ms: 1000, ok: true, at: 1000 });
eq(t.statsFor(['b']).avg, 1000, 'statsFor single');
eq(t.statsFor(['a', 'b']).count, MAX_SAMPLES + 1, 'statsFor pools agents');

// timing handle with an injected clock
let now = 0;
const clockT = new LatencyTracker({ storageKey: null, clock: () => now, now: () => 42 });
const h = clockT.begin('x');
now = 500;   // queued 500ms waiting for the governor
h.started();
now = 800;
h.first();   // first token 300ms after the slot
h.first();   // idempotent
now = 2000;
const rec = h.end(true);
eq(rec.ms, 1500, 'duration measured from slot grant');
eq(rec.ttft, 300, 'ttft from slot grant');
eq(rec.queueMs, 500, 'queue wait kept separately');
eq(rec.at, 42, 'wall-clock timestamp');
eq(h.end(true), null, 'end is once-only');

const ab = clockT.begin('x');
const abErr = new Error('The user aborted a request.');
abErr.name = 'AbortError';
eq(ab.end(false, abErr), null, 'aborted calls are not recorded');
eq(clockT.get('x').length, 1, 'abort left no sample');

const bad = clockT.begin('x');
const r2 = bad.end(false, new Error('HTTP 500'));
eq(r2.ok, false, 'failure recorded');
eq(r2.error, 'HTTP 500', 'failure message kept');

// store event
const events = [];
clockT.bindStore({ emit: (e, d) => events.push([e, d.agentId]) });
clockT.record('y', { ms: 5 });
eq(events.length, 1, 'latency:changed emitted');
eq(events[0][0], 'latency:changed', 'event name');
eq(events[0][1], 'y', 'event agent id');

console.log(`${pass} passed, ${fail} failed`);
if (fail) { errors.forEach(e => console.log(e)); process.exit(1); }
