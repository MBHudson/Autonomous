/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// measure-display-tokens -- what a "show me this" turn costs, before and after
// the display tools.
//
// Usage: node tools/measure-display-tokens.mjs
//
// WHAT THIS IS, AND WHAT IT IS NOT
//
// This is a measurement of the app's own accounting over a fixed, repeatable
// scenario. It imports the real modules -- the tool prompt the model is sent,
// the same 16,000-character transcript cap, the same caption -- and counts with
// estimateTokens(), the estimator the app already uses to budget a context
// window. It makes NO provider call, so it cannot report a billed amount.
//
// Every number below is therefore an estimate, not an invoice. What it can say
// exactly is structural: how many requests the turn makes, and how many
// characters of output are ever written as text at all.
//
// The scenario is the request the display tools exist for: "show me the last
// 2,000 lines of this log", against a 2,000-line file.
//
// ESTIMATOR DRIFT, measured against a live runner (measure-live-usage.mjs): on
// prose this estimator lands within 1% (2,776 real vs 2,797 estimated for the
// after-turn prompt). On a number-dense log it runs about 49% LOW (13,803 real
// vs 9,239 estimated), because digits, colons and decimals tokenise far worse
// than four characters each. Treat these figures as a floor for log content.

import { toolInstructions, defaultTools, isDisplayTool, displayCaption, clipDisplay, MAX_DISPLAY_CHARS } from '../ui/js/tools.js';
import { estimateTokens, compactText } from '../ui/js/utils.js';

const ROOT = '/var/www/Autonomous';
const ASK = 'Show me the last 2000 lines of logs/app.log — just the output.';

// --- the log ----------------------------------------------------------------
// A dense build/test log: timestamps, levels, file:line, timings. ~120k chars.
function buildLog(lines = 2000) {
  const out = [];
  for (let i = 1; i <= lines; i++) {
    const lvl = i % 97 === 0 ? 'ERROR' : (i % 23 === 0 ? 'WARN ' : 'INFO ');
    out.push(`2026-11-12T09:${String(i % 60).padStart(2, '0')}:11.428Z ${lvl} `
      + `worker-${i % 8} step ${i}/2000 src/jobs/dispatch.php:${i % 412 + 1} `
      + `handled batch of ${i % 31 + 4} items in ${(i % 900) + 12}ms`);
  }
  return out.join('\n');
}

const log = buildLog();
const execOutput = `${log}\n[exit 0, 41ms]`;

// --- what the two paths send ------------------------------------------------
const allNames = defaultTools();
const namesBefore = allNames.filter(n => !isDisplayTool(n));

const sysBefore = toolInstructions(namesBefore, ROOT, 'json');
const sysAfter = toolInstructions(allNames, ROOT, 'json');

// The model's own output for the step, in the dialect it is taught.
const callBefore = '{"tool":"exec","arg":{"argv":["tail","-n","2000","logs/app.log"]}}';
const callAfter = '{"tool":"show_command","arg":{"argv":["tail","-n","2000","logs/app.log"]}}';

// What exec hands back to the model, through the same cap the app applies.
const fedBack = `TOOL_RESULT: ${compactText(execOutput, 16000)}\n`
  + 'Continue with the next tool call if the task needs it, or answer the user in plain prose when done.';

// The two ways a model answers step 2: paste what it can see, or summarise it.
const visible = compactText(execOutput, 16000);
const replyPaste = visible;
const replySummary = 'The last 2000 lines are all INFO/WARN/ERROR lines from the dispatch worker, '
  + 'with ERROR entries roughly one per 97 lines. The command exited 0 in 41ms.';

// --- the two turns ----------------------------------------------------------
const before = {
  requests: 2,
  prompt: estimateTokens(sysBefore + ASK) + estimateTokens(sysBefore + ASK + callBefore + fedBack),
  completion: estimateTokens(callBefore),
  replyPaste: estimateTokens(replyPaste),
  replySummary: estimateTokens(replySummary),
  storedReply: estimateTokens(replyPaste),
};

const caption = displayCaption({ tool: 'show_command', arg: { argv: ['tail', '-n', '2000', 'logs/app.log'] } });
const after = {
  requests: 1,
  prompt: estimateTokens(sysAfter + ASK),
  completion: estimateTokens(callAfter),
  replyPaste: 0,
  replySummary: 0,
  storedReply: estimateTokens(caption),
};

const shown = clipDisplay(execOutput);
const fmt = n => n.toLocaleString('en-US');
const pct = (a, b) => (b === 0 ? '—' : `${Math.round((1 - a / b) * 100)}%`);

console.log('display-token measurement (app estimator, no provider call)');
console.log('='.repeat(72));
console.log(`estimateTokens(): ceil(ascii/4 + nonAscii)  — the app's own context estimator`);
console.log(`log: 2,000 lines, ${fmt(log.length)} chars, ~${fmt(estimateTokens(log))} tokens`);
console.log(`exec transcript cap: 16,000 chars (${fmt(estimateTokens(visible))} tokens fed back)`);
console.log('');

const rows = [
  ['requests sent', before.requests, after.requests],
  ['prompt tokens', before.prompt, after.prompt],
  ['the tool call', before.completion, after.completion],
  ['reply tokens — model pastes the output', before.replyPaste, after.replyPaste],
  ['reply tokens — model summarises it', before.replySummary, after.replySummary],
];
console.log('per exchange');
console.log('-'.repeat(72));
console.log('  ' + ' '.repeat(44) + 'before'.padStart(9) + 'after'.padStart(10) + 'cut'.padStart(8));
for (const [label, b, a] of rows) {
  console.log(`  ${label.padEnd(44)}${fmt(b).padStart(9)}${fmt(a).padStart(10)}${pct(a, b).padStart(8)}`);
}

const totalBeforePaste = before.prompt + before.completion + before.replyPaste;
const totalAfter = after.prompt + after.completion;
const totalBeforeSummary = before.prompt + before.completion + before.replySummary;
console.log('-'.repeat(72));
console.log(`  ${'TOTAL, model pastes the output'.padEnd(44)}${fmt(totalBeforePaste).padStart(9)}${fmt(totalAfter).padStart(10)}${pct(totalAfter, totalBeforePaste).padStart(8)}`);
console.log(`  ${'TOTAL, model summarises it'.padEnd(44)}${fmt(totalBeforeSummary).padStart(9)}${fmt(totalAfter).padStart(10)}${pct(totalAfter, totalBeforeSummary).padStart(8)}`);

console.log('');
console.log('the one exact number');
console.log('-'.repeat(72));
console.log(`  requests per "show me this" exchange:  2 -> 1`);
console.log(`  log characters ever written as text:  ${fmt(visible.length)} -> 0`);

console.log('');
console.log('the cost of the feature');
console.log('-'.repeat(72));
const sysDelta = estimateTokens(sysAfter) - estimateTokens(sysBefore);
const perExchangeSaving = totalBeforeSummary - totalAfter;
console.log(`  tool prompt: ${fmt(estimateTokens(sysBefore))} -> ${fmt(estimateTokens(sysAfter))} tokens `
  + `(+${fmt(sysDelta)} on every request, because four tools and one rule were added)`);
if (sysDelta > 0) {
  console.log(`  the first shown log saves ${fmt(perExchangeSaving)}, which covers ${fmt(Math.floor(perExchangeSaving / sysDelta))} requests' worth of that increase`);
}

console.log('');
console.log('what stays in the conversation');
console.log('-'.repeat(72));
console.log(`  stored reply: ${fmt(before.storedReply)} tokens (a pasted log) -> ${fmt(after.storedReply)} (the caption)`);
console.log(`  "${caption}"`);
console.log(`  older turns are compacted by compactMessages(), so this is paid in full at least once,`);
console.log(`  then shrinks with the rest of the history.`);

console.log('');
console.log('per 100 exchanges');
console.log('-'.repeat(72));
console.log(`  model pastes:   ${fmt(totalBeforePaste * 100)} -> ${fmt(totalAfter * 100)} tokens `
  + `(${fmt((totalBeforePaste - totalAfter) * 100)} fewer), 100 fewer requests`);
console.log(`  model summarises: ${fmt(totalBeforeSummary * 100)} -> ${fmt(totalAfter * 100)} tokens `
  + `(${fmt((totalBeforeSummary - totalAfter) * 100)} fewer)`);

console.log('');
console.log(`displayed body: ${fmt(shown.length)} of ${fmt(execOutput.length)} chars shown (display cap ${fmt(MAX_DISPLAY_CHARS)})`);
console.log('NOT MEASURED: any provider bill. No key is configured in this copy, and no request was made.');
