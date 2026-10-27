/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// commsLog tests -- the record of what the agents said to each other.
//
// Usage: node tests/js/commsLog.test.mjs
//
// DOM-free: the log is a plain module holding an array, so it imports straight
// into Node. What matters here is that an exchange stays ONE entry with both
// halves (question then answer), that the ring buffer keeps the newest work and
// drops the oldest, and that filtering by agent finds traffic in both
// directions -- a filter that only matched `fromId` would hide every question
// an agent was ASKED, which is half of what the drawer is for.

// The `?v=` is not decoration: Node treats a specifier with a query string as
// its own module, and commsLog imports store that way. Importing the bare path
// here would give this test a SECOND store instance, and the change events it
// listens for would be emitted into the other one.
import { store } from '../../ui/js/store.js?v=350';
import * as comms from '../../ui/js/commsLog.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('commsLog tests');
console.log('-'.repeat(60));

// --- record + order ---------------------------------------------------------
comms.clear();
eq(comms.count(), 0, 'a cleared log is empty');
eq(comms.recent(), [], 'a cleared log has nothing to show');

const a = comms.record({ fromId: 'a1', fromName: 'North', toId: 'b2', toName: 'Muse', kind: 'ask', text: 'what is the schema?' });
const b = comms.record({ fromId: 'a1', fromName: 'North', toId: 'c3', toName: 'Worker', kind: 'tell', text: 'reindex the store' });
eq(comms.count(), 2, 'two exchanges recorded');
ok(a.id < b.id, 'ids increase in the order entries were recorded');
ok(a.text === 'what is the schema?', 'the question text is kept verbatim');
eq(comms.recent().map(e => e.toName), ['Worker', 'Muse'], 'recent() is newest first');
eq(comms.recent(1).map(e => e.toName), ['Worker'], 'recent(n) takes the newest n');

// --- defaults ---------------------------------------------------------------
const bare = comms.record({ fromId: 'x1', toId: 'y2' });
eq(bare.fromName, 'x1', 'a missing fromName falls back to the id');
eq(bare.toName, 'y2', 'a missing toName falls back to the id');
eq(bare.kind, 'ask', 'the kind defaults to ask');
eq(bare.text, '', 'a missing text is an empty string, not null');
eq(bare.reply, '', 'a new exchange has no reply yet');
eq(bare.ok, null, 'an unanswered exchange is neither ok nor failed');
eq(bare.ms, null, 'an unanswered exchange has no duration');

const nullText = comms.record({ fromId: 'x1', toId: 'y2', text: null });
eq(nullText.text, '', 'null text is coerced to empty rather than kept as null');

// --- settle -----------------------------------------------------------------
const first = comms.record({ fromId: 'a1', fromName: 'North', toId: 'b2', toName: 'Muse', text: 'ping?' });
const settled = comms.settle(first, 'pong', true);
ok(settled === first, 'settle returns the same entry, so callers can chain');
eq(first.reply, 'pong', 'the answer is attached to the exchange it answered');
eq(first.ok, true, 'a successful answer is marked ok');
ok(typeof first.ms === 'number' && first.ms >= 0, 'the duration is a number of milliseconds');

const failed = comms.record({ fromId: 'a1', toId: 'c3', text: 'you there?' });
comms.settle(failed, 'error: could not answer', false);
eq(failed.ok, false, 'a failure is marked, not silently dropped');
eq(failed.reply, 'error: could not answer', 'a failure still keeps the text that came back');

eq(comms.settle(null, 'x'), null, 'settling nothing is a no-op, not a crash');
eq(comms.settle(undefined, 'x'), null, 'settling undefined is a no-op');

// --- change events ----------------------------------------------------------
let events = 0;
const off = store.on('comms:changed', () => { events++; });
comms.record({ fromId: 'a1', toId: 'b2', text: 'one' });
ok(events === 1, 'record emits comms:changed');
const ev = comms.record({ fromId: 'a1', toId: 'b2', text: 'two' });
comms.settle(ev, 'ok');
ok(events === 3, 'settle emits a change too, so an open view can repaint');
off?.();
comms.record({ fromId: 'a1', toId: 'b2', text: 'three' });
ok(events === 3, 'a listener that unsubscribed stops hearing about changes');

// --- per-agent filtering ----------------------------------------------------
comms.clear();
const q = comms.record({ fromId: 'north', fromName: 'North', toId: 'muse', toName: 'Muse', text: 'q1' });
comms.settle(q, 'a1');
comms.record({ fromId: 'worker', fromName: 'Worker', toId: 'muse', toName: 'Muse', text: 'q2' });
comms.record({ fromId: 'muse', fromName: 'Muse', toId: 'worker', toName: 'Worker', text: 'q3' });

const forMuse = comms.forAgent('muse');
eq(forMuse.length, 3, 'every exchange Muse sent or received is found');
eq(forMuse.map(e => e.text), ['q3', 'q2', 'q1'], 'the agent view is newest first');
eq(comms.forAgent('north').map(e => e.text), ['q1'], 'an agent only sees its own traffic');
eq(comms.forAgent('north')[0].reply, 'a1', 'the answer travels with the exchange in the agent view');
eq(comms.forAgent('nobody'), [], 'an agent with no traffic shows nothing');
eq(comms.forAgent(''), [], 'no agent id shows nothing rather than everything');
eq(comms.forAgent(null), [], 'a null agent id shows nothing');

// --- the cap ----------------------------------------------------------------
// A long run must not grow the log without bound, and it must drop the OLDEST
// entries: the recent question is the one being debugged.
comms.clear();
for (let i = 1; i <= comms.MAX + 5; i++) {
  comms.record({ fromId: 'a', toId: 'b', text: `m${i}` });
}
eq(comms.count(), comms.MAX, `the log holds at most MAX (${comms.MAX}) entries`);
const kept = comms.recent(comms.MAX);
eq(kept[0].text, `m${comms.MAX + 5}`, 'the newest entry survives the cap');
eq(kept[kept.length - 1].text, 'm6', 'the five oldest entries were dropped');

// --- clear ------------------------------------------------------------------
comms.clear();
eq(comms.count(), 0, 'clear empties the log');
eq(comms.forAgent('muse'), [], 'clear also empties the per-agent view');

console.log('-'.repeat(60));
if (fail) {
  console.error(errors.join('\n'));
  console.error(`${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`${pass} passed`);
