// The two stream conversions, tested without a browser.
//
//   - Anthropic splits usage across frames, and the total was computed from
//     the last frame alone, so it reported max(input, output).
//   - Google's finishReason was never read, so a MAX_TOKENS or SAFETY stop
//     arrived as an ordinary short reply.

import { mergeUsage, googleFinishReason } from '../../ui/js/streamShape.js?v=428';

let pass = 0;
let fail = 0;

function ok(cond, name) {
  if (cond) { pass++; return; }
  fail++;
  console.log('FAIL: ' + name);
}

function same(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${name} (got ${a}, want ${e})`);
}

console.log('stream shape tests');
console.log('-'.repeat(60));

// --- mergeUsage -------------------------------------------------------------

same(mergeUsage(null, 10, 0, 0), { prompt: 10, completion: 0, total: 10 },
  'a lone input count becomes the total');

// The shipped bug: message_start gave {prompt:1200,total:1200}, then
// message_delta carried output_tokens 300 with no prompt tokens.
same(mergeUsage({ prompt: 1200, completion: 0, total: 1200 }, 0, 300, 0),
  { prompt: 1200, completion: 300, total: 1500 },
  'input then output totals add instead of taking the larger');

// The reverse order must behave the same way.
same(mergeUsage({ prompt: 0, completion: 300, total: 300 }, 1200, 0, 0),
  { prompt: 1200, completion: 300, total: 1500 },
  'output then input totals add too');

// A provider that states its own total keeps it when it is the largest figure.
same(mergeUsage({ prompt: 1, completion: 1, total: 2 }, 0, 0, 99),
  { prompt: 1, completion: 1, total: 99 },
  'an explicit total is respected');

// A frame that repeats a running total must not double it.
same(mergeUsage({ prompt: 100, completion: 50, total: 150 }, 100, 50, 150),
  { prompt: 100, completion: 50, total: 150 },
  'a repeated running total is not summed twice');

// Counts never shrink when a later frame is partial.
same(mergeUsage({ prompt: 100, completion: 50, total: 150 }, 80, 0, 0),
  { prompt: 100, completion: 50, total: 150 },
  'a smaller later figure does not lower the count');

same(mergeUsage(undefined, undefined, undefined, undefined),
  { prompt: 0, completion: 0, total: 0 },
  'a frame with no counts leaves a zeroed usage object');

// --- googleFinishReason -----------------------------------------------------

ok(googleFinishReason('MAX_TOKENS') === 'length', 'MAX_TOKENS reads as length');
ok(googleFinishReason('STOP') === 'stop', 'STOP reads as stop');
ok(googleFinishReason('SAFETY') === 'content_filter', 'SAFETY reads as content_filter');
ok(googleFinishReason('RECITATION') === 'content_filter', 'RECITATION reads as content_filter');
ok(googleFinishReason('PROHIBITED_CONTENT') === 'content_filter', 'a blocked answer reads as content_filter');
ok(googleFinishReason('BLOCKLIST') === 'content_filter', 'BLOCKLIST reads as content_filter');
ok(googleFinishReason('OTHER') === 'other', 'an unknown reason passes through lowercased');
ok(googleFinishReason(null) === null, 'a missing reason stays null');
ok(googleFinishReason('') === null, 'an empty reason stays null');

console.log('-'.repeat(60));
console.log(`streamShape: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
