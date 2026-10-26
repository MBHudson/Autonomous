/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// Run the whole JS suite.
//
// Usage: node tests/js/run.mjs
//
// Every `*.test.mjs` in this directory is run as its own Node process, exactly
// as it would be run by hand, so one test's globals or failed import cannot
// affect another. A file fails if it exits non-zero; its full output is printed
// when it does. The runner's own exit code is 1 if any file failed.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const files = readdirSync(here)
  .filter(name => name.endsWith('.test.mjs'))
  .sort();

console.log('JS test suite');
console.log('='.repeat(60));

if (!files.length) {
  console.error(`No *.test.mjs files in ${here}`);
  process.exit(1);
}

/** Last non-empty line of a stream, trimmed. */
const lastLine = text => {
  const lines = String(text || '').trimEnd().split('\n').filter(l => l.trim());
  return (lines[lines.length - 1] || '').trim();
};

const failures = [];
let assertions = 0;
let counted = 0;

for (const file of files) {
  const res = spawnSync(process.execPath, [join(here, file)], { encoding: 'utf8' });
  const failed = res.error || res.status !== 0;
  // The last line of STDOUT is that test's own count. stderr is deliberately not
  // consulted for the summary: harness.test.mjs logs an expected error there and
  // still passes, so its stack trace would otherwise be reported as the result.
  const summary = lastLine(res.stdout) || lastLine(res.stderr);

  if (failed) {
    failures.push(file);
    console.log(`\nFAIL  ${file}`);
    for (const line of `${res.stdout || ''}${res.stderr || ''}`.trimEnd().split('\n')) {
      console.log(`      ${line}`);
    }
    if (res.error) console.log(`      ${res.error.message}`);
    else if (res.signal) console.log(`      killed by ${res.signal}`);
  } else {
    // Only a passing file's count is trusted: a failing one stops wherever it
    // failed, so whatever it last printed is not the number that ran.
    const count = /(\d+) passed/.exec(summary);
    if (count) {
      assertions += Number(count[1]);
      counted++;
    }
    console.log(`ok    ${file}  --  ${summary}`);
  }
}

console.log('='.repeat(60));
const passed = files.length - failures.length;
const total = counted === files.length ? `, ${assertions} assertions` : '';
console.log(`${files.length} files, ${passed} passed, ${failures.length} failed${total}`);

if (failures.length) {
  console.error(`\nFailed: ${failures.join(', ')}`);
  process.exit(1);
}
