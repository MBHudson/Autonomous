/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// Run the full suite: PHP first, then JS.
//
// Usage: node tests/run.mjs
//
// Each language keeps its own runner (tests/php/run.php, tests/js/run.mjs) so a
// suite can still be run alone; this only runs both and reports the verdict.
// PHP is looked up as $PHP_BINARY, then "php" on PATH. A suite that cannot run
// at all is reported as a failure, never as a pass.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const suites = [
  {
    id: 'php',
    label: 'PHP',
    cmd: process.env.PHP_BINARY || 'php',
    args: [join(here, 'php', 'run.php')],
    missing: `php not found (${process.env.PHP_BINARY || 'php'} on PATH) — set PHP_BINARY to the binary`,
  },
  {
    id: 'js',
    label: 'JS',
    cmd: process.execPath,
    args: [join(here, 'js', 'run.mjs')],
    missing: 'node not found',
  },
];

console.log('All suites');
console.log('='.repeat(60));

const failed = [];
const skipped = [];

for (const suite of suites) {
  console.log(`\n--- ${suite.label} ---`);
  const res = spawnSync(suite.cmd, suite.args, { stdio: 'inherit' });
  if (res.error) {
    // ENOENT: the interpreter itself is missing, so nothing ran.
    console.error(`${suite.label} suite did not run: ${suite.missing}`);
    console.error(`  (${res.error.message})`);
    skipped.push(suite.id);
    continue;
  }
  if (res.status !== 0) failed.push(suite.id);
}

console.log(`\n${'='.repeat(60)}`);
const passed = suites.length - failed.length - skipped.length;
console.log(`${suites.length} suites: ${passed} passed, ${failed.length} failed, ${skipped.length} did not run`);

const problems = [...failed.map(id => `${id} failed`), ...skipped.map(id => `${id} did not run`)];
if (problems.length) {
  console.error(`\n${problems.join('; ')}`);
  process.exit(1);
}
console.log('\nAll suites passed.');
