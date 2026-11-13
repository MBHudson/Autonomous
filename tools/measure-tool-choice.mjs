/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// measure-tool-choice -- which tool a small local model actually picks.
//
// Usage:
//   node tools/measure-tool-choice.mjs                      # json dialect
//   MODE=native node tools/measure-tool-choice.mjs          # one native request
//   MODE=native-loop node tools/measure-tool-choice.mjs     # native -> nudge -> json
//   MODE=turns node tools/measure-tool-choice.mjs           # three turns, memo honoured
//   MEMO=0 MODE=turns node tools/measure-tool-choice.mjs    # same, memo ignored
//   MODE=vocab node tools/measure-tool-choice.mjs           # our names vs Bash/Read/Grep
//   MODEL=<tag> RUNS=10 CHOICE_TEMP=0.7 node tools/measure-tool-choice.mjs
//
// The display tools only save tokens if the model reaches for them. This sends
// the app's real prompt (toolInstructions, with the display tools offered) to a
// local runner, parses the reply with the app's own parser, and reports the
// distribution of the tool it chose. Nothing is billed.
//
// MODE=native-loop replays the loop's escape route on one request at a time:
//   1. native tool schemas, one request
//   2. no tool_calls -> the narration nudge, still native
//   3. still no call -> re-teach the prompt dialect and ask once more
// It reports which stage produced a call, which is the only way to see whether
// the fallback recovers a model that silently ignores the schemas.
//
// FIRST RESULT, worth knowing before trusting a native-mode number: with
// DeepSeek-R1-Distill-Qwen-7B-int4-ov:v1, MODE=native scored 0/24 while
// MODE=json scored 22/24 on the same four requests. The runner reports
// capabilities:["tools"] and accepted every schema, but answered with prose and
// a fenced JSON snippet instead of a tool_calls frame — under three different
// system prompts, including none at all. A model advertising tool support is
// not evidence it emits tool calls; that is the case the app's dialect
// auto-fit and the native fallback exist for.
//
// NATIVE-LOOP RESULT (same model, 16 runs): 0 recovered at native, 0 after the
// nudge, 15 after the JSON fallback (94%) -- 14/16 of those picked a display
// tool, against 22/24 for a plain JSON turn. The fallback works; native mode on
// this model costs two wasted requests first. Keeping the failed narration in
// context instead of rewinding dropped the display rate to 7/16, so the rewind
// is what makes the recovered call the RIGHT call.
//
// VOCABULARY RESULT (MODE=vocab, 4 runs/case): swapping the acting tools'
// names for Bash/Read/Grep/LS/Glob/WebFetch, in an otherwise identical prompt,
// did NOT help -- it measured worse. Display asks 94% vs 75%, acting asks 58%
// vs 33% right tool (and 4/12 wrongly shown instead of 1/12). The model emitted
// `exec` even when the tool was named Bash, so the alias table was never even
// exercised. Keep the aliases as a zero-cost compatibility net for models that
// do use that vocabulary; do not expect them to improve selection.
//
// TURNS RESULT (4 conversations of three turns each): 5.0 requests per
// conversation with the remembered dialect honoured (3 + 1 + 1), 9.0 without it
// (3 + 3 + 3). MEMO=0 measures the unfixed path; the tool choice at n=4 is too
// small to read, only the request count is.

import { toolInstructions, defaultTools, isDisplayTool, parseToolCalls, TOOL_REGISTRY } from '../ui/js/tools.js';
import { nativeToolDefs, createNativeCallState, ingestNativeDelta, nativeCalls } from '../ui/js/nativeTools.js';

const ENDPOINT = process.env.OLLAMA_CHAT || 'http://127.0.0.1:11434/api/chat';
const MODEL = process.env.MODEL || 'DeepSeek-R1-Distill-Qwen-7B-int4-ov:v1';
const RUNS = Math.max(1, Number(process.env.RUNS || 10));
// NOT `TEMP`: Windows already sets TEMP to a directory, and Number() of that is
// NaN — the first baseline ran with an undefined temperature and said so.
const tempArg = Number(process.env.CHOICE_TEMP);
const TEMP = Number.isFinite(tempArg) ? tempArg : 0.7;
// A reasoning model spends output tokens thinking before it emits a call; too
// small a budget truncates every reply before any JSON appears.
const MAX_OUT = Math.max(64, Number(process.env.MAX_OUT || 900));
const MODE = ['native', 'native-loop', 'turns', 'vocab'].includes(process.env.MODE) ? process.env.MODE : 'json';
const ROOT = '/var/www/Autonomous';

// The request a display tool exists for. Each case names the tool it SHOULD get.
const CASES = [
  {
    ask: 'Show me the last 2000 lines of logs/app.log — just the output.',
    want: 'show_command',
  },
  {
    ask: 'Print the contents of docs/notes.md so I can read them here.',
    want: 'show_file',
  },
  {
    ask: 'What is in config/settings.json? Paste it here.',
    want: 'show_file',
  },
  {
    ask: 'Find every place the word "timeout" appears in this project and show me the hits.',
    want: 'show_find',
  },
];

// The acting side of the vocabulary question: these asks should NOT be shown to
// the operator, they need the result back. exec/read_file live here, so this is
// where a foreign name could plausibly change what the model reaches for.
const ACT_CASES = [
  { ask: 'Run the test suite and tell me whether it passed.', want: 'exec' },
  { ask: 'What files are in the src directory? Just the names.', want: 'list_dir' },
  { ask: 'Check whether the word timeout appears in ui/js and report the count.', want: 'grep_code' },
];

const names = defaultTools().filter(t => isDisplayTool(t) || ['read_file', 'exec', 'list_dir', 'grep_code', 'fetch_url', 'glob_files'].includes(t));
const sysJson = toolInstructions(names, ROOT, 'json');
const sysNative = toolInstructions(names, ROOT, 'native-api');
const toolDefs = nativeToolDefs(names.map(n => ({ name: n, description: TOOL_REGISTRY[n].describe })), 'openai');

// The vocabulary experiment changes ONE thing: the names. Same sentences, same
// descriptions, same examples, with `exec` swapped for `Bash` and so on -- the
// vocabulary a model trained on another agent's tools saw thousands of times.
// The display tools keep their names because no model was ever trained on a
// foreign spelling of "show this to the operator"; they are the one part of the
// choice that has to be learned from our own prompt.
const FOREIGN_NAMES = {
  exec: 'Bash',
  read_file: 'Read',
  grep_code: 'Grep',
  list_dir: 'LS',
  glob_files: 'Glob',
  fetch_url: 'WebFetch',
  write_file: 'Write',
};
function foreignPrompt(text) {
  let s = text;
  for (const [ours, theirs] of Object.entries(FOREIGN_NAMES)) {
    s = s.replace(new RegExp(`\\b${ours}\\b`, 'g'), theirs);
  }
  return s;
}

const NUDGE = 'That reply contained no tool call. If you meant to use a tool, call it now through '
  + 'the provided tool interface. If no tool is needed, just answer the user.';

async function ask(messages, native) {
  const body = {
    model: MODEL,
    messages,
    stream: false,
    options: { num_ctx: 8192, temperature: TEMP, num_predict: MAX_OUT },
  };
  if (native) body.tools = toolDefs;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = String(data?.message?.content ?? '');
  const thinking = String(data?.message?.thinking ?? '');
  // Native calls are read with the app's own accumulator, not a regex here, so
  // this measures what the loop would actually execute.
  let calls = [];
  if (native) {
    const state = createNativeCallState();
    ingestNativeDelta(state, data, 'openai');
    calls = nativeCalls(state).map(c => ({ tool: c.name, arg: c.arguments }));
  } else {
    calls = parseToolCalls(text, thinking);
  }
  return {
    text, thinking, calls,
    completionTokens: Number(data.eval_count ?? 0),
    doneReason: String(data?.done_reason ?? ''),
  };
}

const said = r => String(r.text || r.thinking || '(no reply)').slice(0, 4000);

async function jsonOnce(c) {
  const r = await ask([{ role: 'system', content: sysJson }, { role: 'user', content: c.ask }], false);
  return { ...r, stage: 'json', requests: 1 };
}

async function nativeOnce(c) {
  const r = await ask([{ role: 'system', content: sysNative }, { role: 'user', content: c.ask }], true);
  return { ...r, stage: 'native', requests: 1 };
}

/** One turn, following the loop's escape route: native, nudge, JSON re-teach. */
async function nativeLoopOnce(c) {
  const messages = [{ role: 'system', content: sysNative }, { role: 'user', content: c.ask }];
  let r = await ask(messages, true);
  if (r.calls.length) return { ...r, stage: 'native', requests: 1 };

  messages.push({ role: 'assistant', content: said(r) }, { role: 'user', content: NUDGE });
  r = await ask(messages, true);
  if (r.calls.length) return { ...r, stage: 'after nudge', requests: 2 };

  // The loop rewinds past the failed native attempt rather than appending the
  // narration: nothing ran, and carrying the model's wrong idea forward biased
  // the choice it then made. This is the clean JSON turn.
  const clean = [{ role: 'system', content: sysJson }, { role: 'user', content: c.ask }];
  r = await ask(clean, false);
  return { ...r, stage: r.calls.length ? 'after fallback' : 'failed', requests: 3 };
}

/** One attempt at one case in whichever mode was asked for. */
async function runOne(c) {
  if (MODE === 'json') return jsonOnce(c);
  if (MODE === 'native') return nativeOnce(c);
  if (MODE === 'native-loop') return nativeLoopOnce(c);

  // turns: three consecutive turns of the same conversation. The memo is
  // written by the app only after a prompt-dialect turn executed cleanly, so a
  // recovered fallback turn is exactly what sets it -- and a memo means the
  // NEXT turn opens in the prompt dialect, one request instead of three.
  const memo = process.env.MEMO !== '0';
  const per = [];
  let remembered = false;
  let last = null;
  for (let t = 0; t < 3; t++) {
    last = (memo && remembered) ? await jsonOnce(c) : await nativeLoopOnce(c);
    per.push(last.requests);
    if (!last.calls.length) break;   // a failed turn ends the conversation
    remembered = true;               // rememberDialect(dialect) after an ok turn
  }
  return {
    ...last,
    stage: `turns ${per.join('/')}`,
    requests: per.reduce((a, b) => a + b, 0),
  };
}

/**
 * Our vocabulary vs the foreign one, same cases, same descriptions.
 *
 * A foreign call is parsed with the app's own parser, so `Bash` has to survive
 * the alias table to count at all -- this measures the aliases end to end as
 * well as the choice.
 */
async function runVocab() {
  const vocab = [
    { id: 'ours', sys: sysJson },
    { id: 'foreign', sys: foreignPrompt(sysJson) },
  ];
  const suite = [...CASES.map(c => ({ ...c, kind: 'display' })), ...ACT_CASES.map(c => ({ ...c, kind: 'act' }))];
  const fresh = () => ({ display: { n: 0, display: 0, ideal: 0, parsed: 0 }, act: { n: 0, ok: 0, parsed: 0, display: 0 } });
  const tot = Object.fromEntries(vocab.map(v => [v.id, fresh()]));
  for (const c of suite) {
    for (const v of vocab) {
      const seen = new Map();
      for (let i = 0; i < RUNS; i++) {
        let reply;
        try {
          reply = await ask([{ role: 'system', content: v.sys }, { role: 'user', content: c.ask }], false);
        } catch (err) {
          console.log(`  ${c.want} ${v.id}: error ${err.message}`);
          continue;
        }
        const tool = reply.calls.length ? String(reply.calls[0].tool) : '(none)';
        const t = tot[v.id][c.kind];
        t.n++;
        if (reply.calls.length) t.parsed++;
        if (c.kind === 'display') {
          if (isDisplayTool(tool)) t.display++;
          if (tool === c.want) t.ideal++;
        } else {
          if (tool === c.want) t.ok++;
          if (isDisplayTool(tool)) t.display++;   // wrong here: these asks need the result back
        }
        seen.set(tool, (seen.get(tool) || 0) + 1);
      }
      console.log(`  ${c.kind.padEnd(7)} ${c.want.padEnd(11)} ${v.id.padEnd(8)} ${[...seen.entries()]
        .sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(', ')}`);
    }
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  console.log('');
  console.log('                 ours                          foreign');
  for (const bucket of ['display', 'act']) {
    const line = v => {
      const t = tot[v][bucket];
      return bucket === 'display'
        ? `${String(t.display).padStart(2)}/${t.n} display, ${String(t.ideal).padStart(2)}/${t.n} ideal`
        : `${String(t.ok).padStart(2)}/${t.n} right tool, ${String(t.display).padStart(2)}/${t.n} wrongly shown`;
    };
    console.log(`  ${bucket.padEnd(8)}  ${line('ours').padEnd(30)} ${line('foreign')}`);
  }
  const d = tot.ours.display; const f = tot.foreign.display;
  console.log(`  display asks: ${pct(d.display, d.n)}% vs ${pct(f.display, f.n)}%   `
    + `act asks: ${pct(tot.ours.act.ok, tot.ours.act.n)}% vs ${pct(tot.foreign.act.ok, tot.foreign.act.n)}%`);
}

const fmt = n => Number(n).toLocaleString('en-US');
console.log('tool-choice measurement');
console.log('='.repeat(72));
console.log(`runner: ${MODEL}   runs ${RUNS}/case   temperature ${TEMP}   mode ${MODE}`);
console.log(`tools offered: ${names.join(', ')}`);
console.log('');

if (MODE === 'vocab') {
  await runVocab();
  process.exit(0);
}

const tally = new Map();
const stages = new Map();
let total = 0;
let reqTotal = 0;
let idealAll = 0;
let displayAll = 0;

for (const c of CASES) {
  const got = new Map();
  let parsed = 0;
  let ideal = 0;
  let anyDisplay = 0;
  let stageNote = '';
  for (let i = 0; i < RUNS; i++) {
    let reply;
    try {
      reply = await runOne(c);
    } catch (err) {
      console.log(`  ${c.want}: error ${err.message}`);
      continue;
    }
    total++;
    reqTotal += reply.requests || 0;
    const calls = reply.calls;
    const tool = calls.length ? String(calls[0].tool || '') : (reply.doneReason === 'length' ? '(truncated)' : '(none)');
    if (calls.length) parsed++;
    // Two scores, because they answer different questions. `anyDisplay` is the
    // one that saves tokens — show_file for a log still ends the turn and still
    // keeps the bytes out of the transcript. `ideal` is the tool the case was
    // written for.
    if (isDisplayTool(tool)) { anyDisplay++; displayAll++; }
    if (tool === c.want) { ideal++; idealAll++; }
    got.set(tool, (got.get(tool) || 0) + 1);
    tally.set(tool, (tally.get(tool) || 0) + 1);
    stages.set(reply.stage, (stages.get(reply.stage) || 0) + 1);
    if (i === 0) stageNote = `(first run recovered at: ${reply.stage}, ${reply.requests} request(s))`;
  }
  const spread = [...got.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`).join(', ');
  console.log(`  ${c.want.padEnd(13)} ideal ${String(ideal).padStart(2)}/${RUNS}   display ${String(anyDisplay).padStart(2)}/${RUNS}   ${spread || 'none'}   parsed ${parsed}/${RUNS}  ${stageNote}`);
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
console.log('');
if (MODE === 'turns') {
  console.log(`requests for three turns: ${reqTotal} total over ${total} runs`
    + ` (${(reqTotal / Math.max(1, total)).toFixed(1)} per conversation)`);
}
console.log(`chose a display tool: ${displayAll}/${total} (${pct(displayAll, total)}%)  <- the token-saving outcome`);
console.log(`chose the ideal tool: ${idealAll}/${total} (${pct(idealAll, total)}%)`);
console.log(`all tools seen: ${[...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ')}`);
if (MODE === 'native-loop') {
  const order = ['native', 'after nudge', 'after fallback', 'failed'];
  console.log('');
  console.log('where each run recovered:');
  for (const stage of order) {
    const n = stages.get(stage) || 0;
    if (n) console.log(`  ${stage.padEnd(14)} ${String(n).padStart(3)}  (${pct(n, total)}%)`);
  }
}
