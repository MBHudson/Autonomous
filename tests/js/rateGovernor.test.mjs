/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// Rate-governor scheduler tests.
//
// Usage: node tests/js/rateGovernor.test.mjs
//
// The planner is driven with a fake clock, so nothing here waits; the one real
// acquire() is aborted immediately. No network, no derived settings. Exits 0
// on success, 1 on failure.

import {
  planSlot, releaseSlot, acquire, note429, usageFor, bucketKey,
} from '../../ui/js/rateGovernor.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('Rate governor tests');
console.log('-'.repeat(60));

const WINDOW = 60000;
const ENDPOINT = 'https://unknown.example/v1/chat/completions';
const keyOf = suffix => bucketKey(ENDPOINT, `test-key-${suffix}`);
const T0 = 1_000_000;

// --- the window fills at its ceiling, then waits one window ---------------
const fresh = keyOf('fresh');
const waits = [];
for (let i = 0; i < 20; i++) waits.push(planSlot(fresh, 20, T0).waitMs);
ok(waits.every(w => w === 0), '20 slots at 20/min all start at once');

const over = planSlot(fresh, 20, T0);
ok(over.waitMs >= WINDOW && over.waitMs <= WINDOW + 1000,
  `the 21st waits one window (got ${over.waitMs}ms)`);

// A caller arriving later must not see the bucket as empty: a claim made ahead
// of time still occupies its place in the window.
const later = planSlot(fresh, 20, T0 + 1000);
ok(later.waitMs >= 50000, `a later caller still waits (got ${later.waitMs}ms)`);

// --- a claimed slot can be handed back ------------------------------------
const busy = keyOf('release');
for (let i = 0; i < 20; i++) planSlot(busy, 20, T0);
const held = planSlot(busy, 20, T0);
ok(held.waitMs > 0, 'a full bucket queues the next call');
ok(releaseSlot(busy, held.at) === true, 'releaseSlot takes exactly one claim back');
ok(releaseSlot(busy, 12345678) === false, 'releasing an unknown claim reports false');
// The claim was for the far side of the window, so that is where the room is.
eq(planSlot(busy, 1, held.at).waitMs, 0, 'the released slot is free when it comes due');

// --- a real 429 becomes a hold the planner obeys ---------------------------
const held429 = keyOf('hold');
note429(held429, 5000, T0);
const after429 = planSlot(held429, 20, T0);
ok(after429.waitMs >= 4000, `a learned 429 hold is respected (got ${after429.waitMs}ms)`);

const noHeader = keyOf('hold-default');
note429(noHeader, undefined, T0);
const afterDefault = planSlot(noHeader, 20, T0);
ok(afterDefault.waitMs >= 9000, `no Retry-After means a 10s hold (got ${afterDefault.waitMs}ms)`);
eq(planSlot(keyOf('untouched'), 20, T0).waitMs, 0, 'an unrelated bucket is unaffected');

// --- usage counts starts that happened, not claims still in the queue ------
const uEndpoint = ENDPOINT;
const uKey = 'usage-key';
const uBucket = bucketKey(uEndpoint, uKey);
const uNow = Date.now();
for (let i = 0; i < 20; i++) planSlot(uBucket, 20, uNow);
const queued = planSlot(uBucket, 20, uNow);
ok(queued.waitMs > 0, 'the usage bucket is full');
const u = usageFor(uEndpoint, uKey);
eq(u.used, 20, 'usage counts the 20 starts due now, not the queued claim');
eq(u.rpm, 20, "usage reports this bucket's own ceiling");
eq(u.waiting, 0, 'nothing is waiting yet');

// --- a stopped wait gives its slot back -----------------------------------
const aKey = 'abort-key';
const aBucket = bucketKey(ENDPOINT, aKey);
const aBase = Date.now();
for (let i = 0; i < 20; i++) planSlot(aBucket, 20, aBase);
const ctrl = new AbortController();
const pending = acquire({ endpoint: ENDPOINT, api_key: aKey }, { signal: ctrl.signal });
eq(usageFor(ENDPOINT, aKey).waiting, 1, 'a queued call is reported as waiting');

let aborted = false;
try { ctrl.abort(); await pending; } catch (e) { aborted = e.name === 'AbortError'; }
ok(aborted, 'Stop rejects the queued call with AbortError');
eq(usageFor(ENDPOINT, aKey).waiting, 0, 'a stopped wait stops counting as queued');

// At the moment the claimed slot came due there must be room: a reservation
// left behind would push this caller on by another window.
const atBoundary = planSlot(aBucket, 1, aBase + WINDOW + 250);
eq(atBoundary.waitMs, 0, 'the slot a stopped turn held is free when the window turns');

// --- a queue longer than the cap fails open, at the time actually used -----
const oKey = 'over-key';
const oBucket = bucketKey(ENDPOINT, oKey);
const oNow = Date.now();
for (let i = 0; i < 40; i++) planSlot(oBucket, 20, oNow);
const res = await acquire({ endpoint: ENDPOINT, api_key: oKey }, {});
eq(res.overBudget, true, 'a queue longer than the cap goes anyway');
eq(res.waitedMs, 0, 'and it does not wait for it');
eq(usageFor(ENDPOINT, oKey).used, 21, 'the early call is counted at the time it really went out');

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
for (const e of errors) console.log('  ' + e);
process.exit(fail ? 1 : 0);
