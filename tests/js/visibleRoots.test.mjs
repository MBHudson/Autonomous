/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// visibleRoots tests -- which sandbox paths a model is TOLD about.
//
// Usage: node tests/js/visibleRoots.test.mjs
//
// A Windows install can carry a Linux root (the MCP server's /var/www sandbox)
// in its config. The manifest listed every configured root as readable, so
// agents probed a path that cannot exist on this machine and collected
// "not a file" errors -- four of them in one session. These assertions pin the
// filter, including the case where nothing exists: a broken config is still
// better described than hidden.

import { visibleRoots } from '../../ui/js/utils.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('visible roots tests');
console.log('-'.repeat(60));

const win = 'C:/Users/anonb/sandbox';
const linux = 'C:/var/www/illegalwebsite.com/sandbox';   // as seen from Windows

// --- the dead root is not offered -------------------------------------------
eq(visibleRoots([win, linux], [linux]), [win], 'a root missing here is left out');

// --- nothing missing: nothing dropped --------------------------------------
eq(visibleRoots([win, linux], []), [win, linux], 'a healthy config is shown whole');

// --- no report from the server: show what we have --------------------------
eq(visibleRoots([win], undefined), [win], 'an older server that reports nothing still lists its roots');

// --- everything missing: say so rather than say nothing --------------------
eq(visibleRoots([linux], [linux]), [linux], 'when no root exists the config is still described');

// --- junk input -------------------------------------------------------------
eq(visibleRoots(null, []), [], 'a missing list is empty, not a crash');
eq(visibleRoots([win, '', null], []), [win], 'empty entries are dropped');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(errors.join('\n')); process.exit(1); }
