// Context budgeting tests.
//
// Usage: node tests/js/context.test.mjs
//
// Pure functions only; no browser globals.

import { estimateTokens, historyCharBudget, compactText } from '../../ui/js/utils.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('Context budgeting tests');
console.log('-'.repeat(60));

eq(estimateTokens(''), 0, 'empty text is zero tokens');
eq(estimateTokens('abcd'), 1, 'ascii uses ~4 chars/token');
ok(estimateTokens('日本語') >= 3, 'non-ascii is not underestimated');

eq(historyCharBudget(null), 24000, 'unknown model keeps the old budget');
eq(historyCharBudget(32768), 24000, '32k context stays conservative');
eq(historyCharBudget(65536), 81920, '64k context gets a larger budget');
eq(historyCharBudget(131072), 160000, 'large context is capped');
ok(historyCharBudget(131072) > historyCharBudget(65536), 'larger window -> larger history');

eq(compactText('short', 12000), 'short', 'short output passes through');
const long = 'HEAD' + 'x'.repeat(30000) + 'TAIL';
const capped = compactText(long, 12000);
ok(capped.startsWith('HEAD'), 'keeps the head');
ok(capped.endsWith('TAIL'), 'keeps the tail');
ok(capped.includes('chars omitted'), 'marks the omitted middle');
ok(capped.length < long.length, 'actually shrinks the value');
ok(capped.length <= 12080, 'stays close to the requested ceiling');

console.log('-'.repeat(60));
if (fail) {
  console.error(errors.join('\n'));
  console.error(`${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`${pass} passed`);
