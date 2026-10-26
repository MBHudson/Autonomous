/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// planDrawer tests -- which Config drawer the desktop skin puts out.
//
// Usage: node tests/js/drawerState.test.mjs
//
// DOM-free: drawerState.js imports nothing and touches no browser global, so the
// rule that broke in the running app can be checked here. The case that matters
// most is a CLOSE IN FLIGHT: the section's <details> is still open for the
// 440ms of the retract, and the Config tab repaints its live status lines
// throughout, so a section that is closing looked open and the drawer opened
// itself again on the last fifth of the close.
//
// Sections are opaque to planDrawer(), so these are plain objects standing in
// for the elements.

import { planDrawer } from '../../ui/js/drawerState.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const A = { id: 'A' }, B = { id: 'B' }, C = { id: 'C' };

console.log('planDrawer tests');
console.log('-'.repeat(60));

// --- opening ----------------------------------------------------------------
eq(planDrawer({ open: [A] }), { target: A, closePrev: false, close: [] },
  'an open section with nothing out is the target');
eq(planDrawer({}), null, 'nothing open, nothing to do');
eq(planDrawer(), null, 'called with no arguments');
eq(planDrawer({ open: [A], current: A }), null, 'the section already out is left alone');

// --- the regression: a close is still in flight -----------------------------
eq(planDrawer({ open: [A], current: null, closing: A }), null,
  'a retracting section is not re-opened by a repaint');
eq(planDrawer({ open: [A, B], current: null, closing: A }), { target: B, closePrev: false, close: [] },
  'a repaint mid-close opens the next open section, not the retracting one');
eq(planDrawer({ open: [A, B], current: null, closing: A, clicked: B }), { target: B, closePrev: false, close: [] },
  'a click mid-close opens the clicked section');
eq(planDrawer({ open: [A], current: null, closing: A, clicked: A }), null,
  'clicking the retracting section does not restart it');
eq(planDrawer({ open: [], current: null, closing: A }), null,
  'once the close has finished the section is just closed');
eq(planDrawer({ open: [A], current: A, closing: A }), null,
  'a section cannot be both out and retracting');

// --- clicking ---------------------------------------------------------------
eq(planDrawer({ open: [A, B], current: A, clicked: B }), { target: B, closePrev: true, close: [] },
  'clicking another section swaps the drawer');
eq(planDrawer({ open: [A, B, C], current: A, clicked: C }), { target: C, closePrev: true, close: [B] },
  'a swap folds up any other open section');
eq(planDrawer({ open: [A], current: null, clicked: B }), { target: A, closePrev: false, close: [] },
  'a click that closed a section falls back to what is still open');
eq(planDrawer({ open: [], current: null, clicked: A }), null,
  'a click that closed the only section leaves nothing out');
eq(planDrawer({ open: [A], current: null, clicked: A }), { target: A, closePrev: false, close: [] },
  'clicking a freshly opened section brings its drawer out');

// --- repaints and scrolling, with no click ----------------------------------
eq(planDrawer({ open: [A, B], current: A }), { target: B, closePrev: true, close: [] },
  'a repaint with two open sections shows the one that is not out');
eq(planDrawer({ open: [A, B], current: B, closing: A }), null,
  'a retracting section is skipped even while another is out');

// --- every combination ------------------------------------------------------
// 8 open-sets x 4 current x 4 closing x 4 clicked = 512. Three properties have
// to hold for all of them; they are counted as one assertion each so a failure
// prints the combination that broke it.
const sections = [A, B, C];
const picks = [null, A, B, C];
const openSets = [];
for (let mask = 0; mask < 8; mask++) openSets.push(sections.filter((_, i) => mask & (1 << i)));

const bad = { target: [], close: [], flag: [], click: [] };
for (const open of openSets) {
  for (const current of picks) {
    for (const closing of picks) {
      for (const clicked of picks) {
        const plan = planDrawer({ open, current, closing, clicked });
        const where = `open=[${open.map(s => s.id)}] current=${current && current.id} `
          + `closing=${closing && closing.id} clicked=${clicked && clicked.id}`;
        if (!plan) continue;

        // 1. The retracting section can never be the one opened.
        if (plan.target === closing || !open.includes(plan.target) || plan.target === current) {
          bad.target.push(`${where} -> target ${plan.target && plan.target.id}`);
        }
        // 2. Folding up never touches the drawer that is out or the new one.
        if (plan.close.includes(plan.target) || plan.close.includes(current)
          || plan.close.some(s => !open.includes(s))
          || new Set(plan.close).size !== plan.close.length) {
          bad.close.push(`${where} -> close [${plan.close.map(s => s.id)}]`);
        }
        // 3. A plan that opens something first retracts what is out.
        if (plan.closePrev !== (current !== null)) bad.flag.push(where);

        // 4. An explicit click on an open, non-retracting section is obeyed:
        //    it is the target, unless it is already the one out (no-op).
        if (clicked && open.includes(clicked) && clicked !== closing) {
          const obeyed = clicked === current ? plan === null : plan.target === clicked;
          if (!obeyed) bad.click.push(`${where} -> target ${plan.target && plan.target.id}`);
        }
      }
    }
  }
}

ok(bad.target.length === 0, 'no combination opens the retracting section'
  + (bad.target.length ? `: ${bad.target.slice(0, 3).join(' | ')}` : ''));
ok(bad.close.length === 0, 'folding up never touches the new or the outgoing drawer'
  + (bad.close.length ? `: ${bad.close.slice(0, 3).join(' | ')}` : ''));
ok(bad.flag.length === 0, 'a plan always retracts the outgoing drawer first'
  + (bad.flag.length ? `: ${bad.flag.slice(0, 3).join(' | ')}` : ''));
ok(bad.click.length === 0, 'an explicit click on an open section is obeyed'
  + (bad.click.length ? `: ${bad.click.slice(0, 3).join(' | ')}` : ''));

console.log('-'.repeat(60));
if (fail) {
  console.error(errors.join('\n'));
  console.error(`${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`${pass} passed`);
