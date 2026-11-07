/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// scrollFollow tests -- the pure predicates behind the scroll-to-latest
// button and the scroll-up pause.
//
// Usage: node tests/js/scrollFollow.test.mjs
//
// DOM-free like the other unit tests: isNearBottom and scrollFollowWanted
// take plain numbers, so the follow/pause decision in chat.js can be checked
// in Node without a browser.

import { isNearBottom, scrollFollowWanted } from '../../ui/js/utils.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };

console.log('scrollFollow tests');
console.log('-'.repeat(60));

// --- isNearBottom -------------------------------------------------------------
ok(isNearBottom(0, 100, 100) === true, 'exact bottom counts');
ok(isNearBottom(76, 200, 100) === true, 'within tolerance counts (24px default)');
ok(isNearBottom(75, 200, 100) === false, 'past tolerance does not count');
ok(isNearBottom(0, 50, 100) === true, 'unscrollable content is at the bottom');
ok(isNearBottom(0, 100, 100, 0) === true, 'zero tolerance still counts exact bottom');
ok(isNearBottom(99, 200, 100, 0) === false, 'zero tolerance rejects 1px up');
ok(isNearBottom('bad', 'bad', 'bad') === true, 'garbage numbers read as bottom, not stuck');

// --- scrollFollowWanted -------------------------------------------------------
ok(scrollFollowWanted(true, null) === true, 'toggle on, no gesture follows');
ok(scrollFollowWanted(false, null) === false, 'toggle off, no gesture stays put');
ok(scrollFollowWanted(undefined, null) === true, 'missing toggle keeps old behaviour');
ok(scrollFollowWanted(false, true) === true, 'button grants temporary follow with toggle off');
ok(scrollFollowWanted(true, true) === true, 'button follow with toggle on');
ok(scrollFollowWanted(true, false) === false, 'scroll-up pause beats toggle on');
ok(scrollFollowWanted(false, false) === false, 'pause with toggle off stays put');

console.log('-'.repeat(60));
if (errors.length) {
  for (const e of errors) console.log(e);
  console.log(`${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`${pass} passed`);
