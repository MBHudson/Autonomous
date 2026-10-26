/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ifaceMode tests -- which desktop shell the app wears, and which one it wears
// when nobody has said.
//
// Usage: node tests/js/ifaceMode.test.mjs
//
// DOM-free: ifaceMode.js imports nothing and reads no browser global, so the
// default that decides what every existing profile sees on its next reload is
// pinned here rather than in a screenshot. The two things worth guarding are
// (1) that silence means Classic -- an absent value must never quietly hand
// somebody the glass shell they never chose -- and (2) that a narrow window is
// Classic no matter what, because that width is the mobile hybrid, not a shell.

import {
  normalizeIface, resolveIface, ifaceLabel,
  IFACE_CLASSIC, IFACE_DESKTOP,
} from '../../ui/js/ifaceMode.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };

console.log('ifaceMode tests');
console.log('-'.repeat(60));

// --- the default ------------------------------------------------------------
ok(normalizeIface(undefined) === IFACE_CLASSIC, 'no saved choice normalises to classic');
ok(normalizeIface(null) === IFACE_CLASSIC, 'null normalises to classic');
ok(normalizeIface('') === IFACE_CLASSIC, 'an empty string normalises to classic');
ok(resolveIface({}) === IFACE_CLASSIC, 'no arguments at all is classic');
ok(resolveIface() === IFACE_CLASSIC, 'being called with nothing is classic');
ok(resolveIface({ wide: true }) === IFACE_CLASSIC, 'a wide window with no choice is still classic');

// --- the explicit choices ---------------------------------------------------
ok(normalizeIface('classic') === IFACE_CLASSIC, '"classic" stays classic');
ok(normalizeIface('desktop') === IFACE_DESKTOP, '"desktop" is the glass shell');
ok(normalizeIface(' DESKTOP ') === IFACE_DESKTOP, 'case and padding do not matter');
ok(resolveIface({ mode: 'classic', wide: true }) === IFACE_CLASSIC, 'classic on a wide window stays classic');
ok(resolveIface({ mode: 'desktop', wide: true }) === IFACE_DESKTOP, 'desktop on a wide window wears the glass');

// --- junk falls back, never up ---------------------------------------------
// A value the app does not recognise must never become the heavier shell.
for (const junk of ['Desktop 2026', 'new', 'true', '1', 'glass', 'old', 'desktopish']) {
  ok(resolveIface({ mode: junk, wide: true }) === IFACE_CLASSIC,
    `unrecognised value "${junk}" falls back to classic`);
}

// --- width always wins ------------------------------------------------------
// Below 1025px the app is the slide-over drawer layout, which both shells share
// and this module must never override.
ok(resolveIface({ mode: 'desktop', wide: false }) === IFACE_CLASSIC,
  'desktop on a narrow window is the mobile hybrid, not the glass');
ok(resolveIface({ mode: 'desktop' }) === IFACE_CLASSIC, 'desktop with no width given is not the glass');
ok(resolveIface({ mode: 'desktop', wide: 1 }) === IFACE_DESKTOP, 'a truthy width is treated as wide');

// --- labels -----------------------------------------------------------------
ok(ifaceLabel('desktop') === 'Desktop 2026', 'the shell has a name for toasts');
ok(ifaceLabel('classic') === 'Classic', 'classic has a name for toasts');
ok(ifaceLabel(undefined) === 'Classic', 'the default has a name too');

// --- a sweep: every mode, both widths, always exactly one answer ------------
const answers = new Set();
for (const mode of [undefined, null, '', 'classic', 'desktop', 'junk']) {
  for (const wide of [true, false]) {
    const got = resolveIface({ mode, wide });
    answers.add(got);
    const want = normalizeIface(mode) === IFACE_DESKTOP && wide ? IFACE_DESKTOP : IFACE_CLASSIC;
    ok(got === want, `resolve(${String(mode)}, wide=${wide}) is ${want}`);
  }
}
ok(answers.size === 2, 'both shells are reachable across the sweep');

console.log('-'.repeat(60));
if (fail) {
  console.error(errors.join('\n'));
  console.error(`${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`${pass} passed`);
