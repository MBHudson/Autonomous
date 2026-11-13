/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// measure-live-usage -- the same show-me exchange, against a real model.
//
// Usage:
//   node tools/measure-live-usage.mjs
//   MODEL=<tag> RUNS=3 MAX_OUT=500 node tools/measure-live-usage.mjs
//
// The companion to tools/measure-display-tokens.mjs. That one estimates; this
// one sends the two requests and reads the runner's own token counts, so the
// prompt side is a measurement rather than arithmetic.
//
// Transport is Ollama's NATIVE /api/chat, not the OpenAI-compatible /v1 shape,
// for one reason: num_ctx. Ollama's default context is small, and a 7k-token
// prompt silently truncated to fit would report a prompt_eval_count for a
// prompt the model never saw. Native options let it be set explicitly, and
// prompt_eval_count / eval_count come back exact.
//
// Requests spent: 2 per pass (the exec turn and its follow-up) plus 1 (the
// show turn). Nothing here is billed: it is a local runner.

import { toolInstructions, defaultTools, isDisplayTool } from '../ui/js/tools.js';
import { estimateTokens, compactText } from '../ui/js/utils.js';

const ENDPOINT = process.env.OLLAMA_CHAT || 'http://127.0.0.1:11434/api/chat';
const MODEL = process.env.MODEL || 'DeepSeek-R1-Distill-Qwen-7B-int4-ov:v1';
const RUNS = Math.max(1, Number(process.env.RUNS || 3));
const MAX_OUT = Math.max(32, Number(process.env.MAX_OUT || 500));
const TEMP = 0.7;

const ROOT = '/var/www/Autonomous';
const ASK = 'Show me the last 2000 lines of logs/app.log — just the output.';

function buildLog(lines = 2000) {
  const out = [];
  for (let i = 1; i <= lines; i++) {
    const lvl = i % 97 === 0 ? 'ERROR' : (i % 23 === 0 ? 'WARN ' : 'INFO ');
    out.push(`2026-11-12T09:${String(i % 60).padStart(2, '0')}:11.428Z ${lvl} `
      + `worker-${i % 8} step ${i}/${lines} src/jobs/dispatch.php:${i % 412 + 1} `
      + `handled batch of ${i % 31 + 4} items in ${(i % 900) + 12}ms`);
  }
  return out.join('\n');
}

const log = buildLog();
const execOutput = `${log}\n[exit 0, 41ms]`;

const allNames = defaultTools();
const namesBefore = allNames.filter(n => !isDisplayTool(n));
const sysBefore = toolInstructions(namesBefore, ROOT, 'json');
const sysAfter = toolInstructions(allNames, ROOT, 'json');

const callBefore = '{"tool":"exec","arg":{"argv":["tail","-n","2000","logs/app.log"]}}';
const execCallMessages = [
  { role: 'system', content: sysBefore },
  { role: 'user', content: ASK },
];
const followUpMessages = [
  ...execCallMessages,
  { role: 'assistant', content: callBefore },
  {
    role: 'user',
    content: `TOOL_RESULT: ${compactText(execOutput, 16000)}\n`
      + 'Continue with the next tool call if the task needs it, or answer the user in plain prose when done.',
  },
];
const showMessages = [
  { role: 'system', content: sysAfter },
  { role: 'user', content: ASK },
];

const fmt = n => Number(n).toLocaleString('en-US');

async function ask(messages) {
  const body = {
    model: MODEL,
    messages,
    stream: false,
    options: { num_ctx: 32768, temperature: TEMP, num_predict: MAX_OUT },
  };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600000),
    });
  } catch (err) {
    throw new Error(`could not reach ${ENDPOINT}: ${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from the runner: ${text.slice(0, 400)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`unreadable reply: ${text.slice(0, 300)}`); }
  const content = String(data?.message?.content ?? '');
  return {
    promptTokens: Number(data.prompt_eval_count ?? 0),
    completionTokens: Number(data.eval_count ?? 0),
    ms: Date.now() - t0,
    content,
    // A reasoner puts its words in `thinking`, and eval_count bills both.
    thinking: String(data?.message?.thinking ?? ''),
    doneReason: data.done_reason || '',
  };
}

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = n => Math.round(n);

console.log('live display-token measurement');
console.log('='.repeat(72));
console.log(`runner: ${MODEL}`);
console.log(`endpoint: ${ENDPOINT}  temperature ${TEMP}  max output ${MAX_OUT}  passes ${RUNS}`);
console.log(`log: 2,000 lines, ${fmt(log.length)} chars`);
console.log(`estimated tool prompt: before ${fmt(estimateTokens(sysBefore))}, after ${fmt(estimateTokens(sysAfter))} tokens`);
console.log('');

const passes = [];
for (let i = 1; i <= RUNS; i++) {
  process.stdout.write(`pass ${i}/${RUNS}: exec turn… `);
  const step1 = await ask(execCallMessages);
  process.stdout.write(`${fmt(step1.promptTokens)}p/${fmt(step1.completionTokens)}c `);
  process.stdout.write('follow-up… ');
  const step2 = await ask(followUpMessages);
  process.stdout.write(`${fmt(step2.promptTokens)}p/${fmt(step2.completionTokens)}c `);
  process.stdout.write('show turn… ');
  const show = await ask(showMessages);
  console.log(`${fmt(show.promptTokens)}p/${fmt(show.completionTokens)}c`);
  const said = r => JSON.stringify(String(r.content || r.thinking || '').replace(/\s+/g, ' ').slice(0, 90));
  console.log(`    exec reply said: ${said(step1)}`);
  console.log(`    follow-up reply: ${said(step2)}`);
  passes.push({ step1, step2, show });
}

const beforePrompt = passes.map(p => p.step1.promptTokens + p.step2.promptTokens);
const beforeCompletion = passes.map(p => p.step1.completionTokens + p.step2.completionTokens);
const afterPrompt = passes.map(p => p.show.promptTokens);
const afterCompletion = passes.map(p => p.show.completionTokens);
const beforeTotal = passes.map((p, i) => beforePrompt[i] + beforeCompletion[i]);
const afterTotal = passes.map((p, i) => afterPrompt[i] + afterCompletion[i]);

console.log('');
console.log('billed tokens per "show me this" exchange');
console.log('-'.repeat(72));
const row = (label, arr) => console.log(`  ${label.padEnd(34)}mean ${fmt(round(mean(arr))).padStart(8)}   `
  + `runs ${arr.map(n => fmt(n)).join(', ')}`);
row('before — prompt (2 requests)', beforePrompt);
row('before — output', beforeCompletion);
row('before — TOTAL', beforeTotal);
console.log('');
row('after — prompt (1 request)', afterPrompt);
row('after — output', afterCompletion);
row('after — TOTAL', afterTotal);
console.log('');
const saved = mean(beforeTotal) - mean(afterTotal);
const pct = mean(beforeTotal) ? Math.round((saved / mean(beforeTotal)) * 100) : 0;
console.log(`  output tokens removed: ${fmt(round(mean(beforeCompletion)))} -> ${fmt(round(mean(afterCompletion)))}`);
console.log(`  total removed:         ${fmt(round(mean(beforeTotal)))} -> ${fmt(round(mean(afterTotal)))}  (${pct}% of a before-exchange)`);
console.log(`  requests:              2 -> 1`);
console.log('');
console.log(`estimate for comparison (same scenario, app estimator): 13,244 before / 2,816 after`);
console.log('Every count above is the runner\'s own prompt_eval_count / eval_count.');
