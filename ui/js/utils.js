/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// UTILS.JS — Helper functions
// ============================================

/** How many prior user turns an agent remembers by default. 0 = stateless. */
export const DEFAULT_HISTORY_TURNS = 5;

/** Characters of reasoning that count as "a lot" and open the panel by itself. */
export const REASONING_OPEN_CHARS = 400;

/**
 * Whether a Reasoning panel starts open.
 *
 * `remembered` is the saved preference: true = always open, false = always
 * collapsed, 'auto' (or nothing) = decide by length. The operator's last choice
 * wins once they have made one -- that is the remembering part, and it is saved
 * with the rest of the settings. Until then a reply that thought at length
 * opens, because a collapsed box hides the very thing the panel exists to show,
 * while a two-line thought stays shut so it cannot push the answer down the
 * transcript.
 */
export function reasoningOpenByDefault(text, remembered) {
  if (remembered === true || remembered === false) return remembered;
  return String(text ?? '').trim().length >= REASONING_OPEN_CHARS;
}

/** How much wrapper a provider may add around the reply and still be echoing. */
export const REASONING_ECHO_SLACK = 120;

/**
 * Is the reasoning channel just the reply again?
 *
 * Some providers echo the answer into the reasoning field -- exactly, or wrapped
 * in a short preamble -- and drawing both reads as a duplication bug, so those
 * are called echoes and the panel stays hidden.
 *
 * The comparison is one-directional and proportional. It used to hide the panel
 * whenever EITHER string contained the other, which meant any short reply that
 * happened to appear somewhere in a long trace counted as "reasoning is just
 * the reply": a local model that ends `\boxed{think}`, or restates a phrase
 * from its thinking, wiped out a thousand words of trace at the moment of
 * commit -- precisely when it was worth reading.
 */
export function isReasoningEcho(reasoning, content) {
  const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const r = norm(reasoning);
  const c = norm(content);
  // Nothing to compare, or nothing but thoughts. A reply that is all thinking
  // has no reply for the reasoning to duplicate, and that used to be the one
  // case that suppressed the panel outright.
  if (!r || !c) return false;
  if (r === c) return true;
  // Reasoning that IS the reply plus a wrapper ("Here is my answer: ...").
  if (r.includes(c) && r.length - c.length <= REASONING_ECHO_SLACK) return true;
  // The reply contains the reasoning: a runner that joins the two into one
  // body. Only an echo when the reasoning is most of what was said.
  return c.includes(r) && r.length >= c.length * 0.6;
}

/** Characters of a tool result that ride along in a no-answer notice. */
export const TOOL_RESULT_NOTICE_CHARS = 600;

/**
 * Is this reply nothing but the harness's own call placeholder?
 *
 * A tool call with no prose used to enter the conversation as `[called exec]`
 * so the following TOOL_RESULT had an assistant turn to attach to. Fake text in
 * a transcript is text a model can imitate, and one did: it answered with the
 * placeholder. Such a reply is not an answer, and a message already stored that
 * way should render as the tool-result notice instead.
 */
export function isPlaceholderReply(text) {
  return /^\[called[ \t]+[A-Za-z0-9_.:-]+\]$/.test(String(text ?? '').trim());
}

/**
 * The reply for a turn that ran tools and never wrote an answer.
 *
 * "Finished after running 2 tool calls" told the operator nothing about whether
 * the work happened, while the answer was sitting in the last tool's result.
 * That result is included -- whitespace collapsed, cut at
 * TOOL_RESULT_NOTICE_CHARS -- so `exec -> <stdout or refusal>` reaches the
 * transcript instead of a shrug.
 */
/**
 * Did a reply claim that tool work was already carried out?
 *
 * A model that cannot tell whether it acted will report the action as done in
 * the past tense -- "write_file completed the task" -- and the transcript then
 * says a file exists when nothing ran. Only a NAMED tool plus a completion verb
 * counts: a reply discussing a plan in the abstract is not a claim, and the
 * warning this drives must stay rare to stay believable.
 */
/**
 * Did the reply TRY to call a tool, in some syntax, and parse to nothing?
 *
 * This is the gate on the dialect re-teach: a reply shaped like a call in the
 * wrong dialect is worth re-asking in the next one. A reply that never mentions
 * a call shape is not — re-teaching cannot fix a model that ignored the tool
 * interface entirely, so the loop must not spend three requests pretending it
 * can. Extracted from the tool loop so this boundary can be tested without a
 * browser; the measured case is in tests/js/dialectRetry.test.mjs.
 */
export function looksLikeToolReply(text) {
  return /(\{\s*"tool"\s*:|<\|tool_call\||<function_calls|<invoke\s|\{"tool")/i
    .test(String(text ?? ''));
}

/**
 * Did the reply DESCRIBE using a tool instead of calling one?
 *
 * "I'll use the exec tool" is the failure this detects. It is deliberately
 * narrow: a real answer may mention a tool by name without meaning to run one,
 * so both a tool word and an intent phrase have to be present.
 */
export function narratesToolUse(text, toolNames = []) {
  const s = String(text ?? '');
  // The literal word "tool" is not enough on its own: a model that says "I'll
  // use read_file" never mentions it, and that phrasing is at least as common
  // as "I'll use the read tool". The loop passes the tools it actually offered,
  // so a named tool counts only when the agent could really call it.
  const names = Array.isArray(toolNames) ? toolNames.filter(Boolean).map(String) : [];
  const namedTool = names.some(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s));
  if (!/(\btool\b|\b\w+_?tool\b)/i.test(s) && !namedTool) return false;
  return /(i'?ll|i will|let me|i'?m going|going to|i would|now i|i'?d )/i.test(s);
}

/**
 * Should the loop drop native tool schemas and re-teach the prompt dialect?
 *
 * Only after a native-mode nudge has already failed to produce a call, and only
 * once per turn. A provider that REJECTS the schemas is a different case and is
 * handled where the request is made (HTTP 400/422); this is the quieter failure
 * where the schemas are accepted and the model simply never calls anything.
 */
// Tools whose result IS the answer: they end the turn and paint the output into
// the transcript instead of handing it back to the model. Declared here, in the
// module that imports nothing, so persistence can backfill them into old agents
// without pulling the whole tool harness (and its dialogs) into the boot path.
export const DISPLAY_TOOL_NAMES = ['show_file', 'show_command', 'show_find', 'show_url'];

/**
 * The operator-facing cap on a displayed result.
 *
 * Not a context budget: these bytes are never sent to a provider, so the only
 * cost is the session file that stores the tool-call record and the cost of
 * painting it. Sized against the case the tool exists for -- a 2,000-line log at
 * ~115 characters a line is ~230,000 characters, and a 120,000 cap clipped it.
 *
 * Lives here rather than in tools.js because the RENDERER needs it too: a
 * display result that is stored in full but painted up to 8,000 characters is
 * clipped exactly when the operator asked to see all of it.
 */
export const MAX_DISPLAY_CHARS = 400000;

/**
 * Add the display tools to an agent's saved tool list.
 *
 * `agent.tools` is a snapshot, so every agent saved before these existed has a
 * list that predates them. Absent already means "the defaults", which include
 * them; only an explicit list needs this.
 *
 * Returns the new list, or null when there is nothing to add. An EMPTY list is
 * left alone: that is an agent whose tools were deliberately switched off, and
 * handing it four new ones would override the operator. Denied tools are
 * skipped for the same reason.
 */
export function withDisplayTools(toolList, denied = []) {
  if (!Array.isArray(toolList) || !toolList.length) return null;
  const skip = new Set(Array.isArray(denied) ? denied : Object.keys(denied || {}));
  const missing = DISPLAY_TOOL_NAMES.filter(t => !toolList.includes(t) && !skip.has(t));
  return missing.length ? toolList.concat(missing) : null;
}

/**
 * Backfill every agent that has not been looked at yet. Returns how many gained
 * tools.
 *
 * The marker is PER AGENT, not a flag in settings, because the agent list is
 * what gets replaced: state sync adopts the server's copy wholesale, so a
 * settings flag can end up saying "already done" while the agents it was
 * supposed to fix are the old ones -- which is exactly what happened, leaving
 * four tools missing and no second chance. A marker travels with the agent it
 * describes, so the migration survives any ordering.
 *
 * It records the DECISION, not the result: an agent with no tools, or with its
 * tools switched off, is marked too. That is what keeps a later removal by the
 * operator from being undone on the next load.
 */
export function backfillDisplayTools(agents, denied = []) {
  let added = 0;
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!agent || agent.displayToolsBackfilled) continue;
    const next = withDisplayTools(agent.tools, denied);
    if (next) { agent.tools = next; added++; }
    agent.displayToolsBackfilled = true;
  }
  return added;
}

/** Per-call copy budget for a tool value painted in the transcript. */
export const TOOL_DISPLAY_LIMIT = 8000;

/**
 * How much of a tool result to paint.
 *
 * A display result IS the answer: it was never sent to a provider, and the
 * operator asked to see it, so it gets MAX_DISPLAY_CHARS. Everything else is a
 * detail panel and stays at the small budget, because those bytes exist to
 * explain a step, not to be read like a document.
 */
export function renderLimitFor(display) {
  return display ? MAX_DISPLAY_CHARS : TOOL_DISPLAY_LIMIT;
}

/**
 * Merge an incoming settings bundle into this browser's copy.
 *
 * `settings` travelled between devices as ONE slot and the bundle REPLACED it,
 * so a device that pushed an older copy silently erased what this one had
 * learned: the tool dialect remembered for a model, and the context window a
 * runner reported. Those two maps are measurements taken on this machine -- a
 * key missing from the other copy means "never learned there", not "forget
 * it" -- so they are unioned, while every other setting follows the incoming
 * copy (the server's version wins on a conflict, same rule memory uses).
 */
export function mergeLearnedSettings(local, incoming) {
  if (!incoming || typeof incoming !== 'object') return local;
  if (!local || typeof local !== 'object') return incoming;
  const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const merged = { ...incoming };
  for (const key of ['toolDialectMap', 'contextLimits']) {
    if (!isMap(local[key]) && !isMap(incoming[key])) continue;
    merged[key] = {
      ...(isMap(local[key]) ? local[key] : {}),
      ...(isMap(incoming[key]) ? incoming[key] : {}),
    };
  }
  return merged;
}

/**
 * Sandbox roots worth telling a model about: the ones that exist HERE.
 *
 * A Windows install can carry a Linux root in its config (the MCP server's
 * /var/www/... sandbox), and the manifest listed it as readable anyway. Models
 * dutifully probed a path that cannot exist and collected `not a file` errors.
 * When NONE of the roots exist the full list comes back: a broken config is
 * still better described than hidden.
 */
export function visibleRoots(roots, missing) {
  const list = Array.isArray(roots) ? roots.filter(Boolean) : [];
  const gone = new Set(Array.isArray(missing) ? missing : []);
  const present = list.filter(r => !gone.has(r));
  return present.length ? present : list;
}

/** JSON for an argument, never throwing on a cyclic value. */
function summaryArg(arg) {
  try { return JSON.stringify(arg === undefined ? null : arg); } catch { return String(arg); }
}

/**
 * Counts for the tool-call box header: calls, FAILURES, and retries.
 *
 * The header used to say only "5 tool calls", so a drill that burned six
 * attempts on one step read as a clean five-call turn unless every box was
 * opened by hand. A retry is the same tool + the same arguments sent again
 * after an attempt that failed -- the shape almost every correction takes.
 * A step the app skipped (a display tool already answered) is neither.
 */
export function toolCallSummary(calls) {
  const list = Array.isArray(calls) ? calls.filter(Boolean) : [];
  const lastStatus = new Map();
  let failed = 0, retries = 0;
  for (const call of list) {
    const status = String((call && call.status) || '');
    const key = `${(call && call.tool) || 'tool'}|${summaryArg(call && call.arg)}`;
    if (lastStatus.get(key) === 'error') retries++;
    if (status === 'error') failed++;
    lastStatus.set(key, status);
  }
  return { total: list.length, failed, retries };
}

/**
 * Text for a tool value, cut honestly: a clip says how much was left out.
 *
 * Measured against the case that matters -- show_command on a 2,000-line log
 * stores ~230,000 characters, and painting it with the 8,000 default printed
 * "… (50963 more characters)" instead of the log the operator asked for.
 */
export function toolValueText(value, limit = TOOL_DISPLAY_LIMIT) {
  if (value === undefined || value === null) return '';
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  text = String(text || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\u2026 (${text.length - limit} more characters)`;
}

export function shouldFallBackFromNative(state) {
  const s = state || {};
  if (!s.nativeMode || !s.nudgedInNative || s.fallbackUsed) return false;
  return s.hasCall !== true;
}

export function claimsCompletedToolWork(text) {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  const named = /\b(write_file|edit_file|multi_edit|apply_patch|str_replace_editor|exec_start|exec|run_code|git_commit|mcp_call)\b/i.test(s);
  if (!named) return false;
  return /\b(completed|created|written|wrote|saved|succeeded|applied|done|finished)\b/i.test(s);
}

/**
 * Why the file tools cannot work right now, in one sentence, or ''.
 *
 * Checked at the top of a turn so the warning lands BEFORE the reply: a model
 * that could not write still reports the file as written, and the transcript
 * then contradicts the disk. There are two independent halves -- the browser
 * may never have bound the tools, and the server may have no allowed directory
 * -- so both are named when both are true.
 */
export function fileToolWarning(unbound, status) {
  const names = Array.isArray(unbound) ? unbound.filter(n => typeof n === 'string' && n) : [];
  const jail = status && typeof status === 'object' ? status : null;
  const parts = [];
  if (names.length) {
    const head = names.slice(0, 4).join(', ');
    parts.push(`this page never bound ${head}${names.length > 4 ? ` and ${names.length - 4} more` : ''}`);
  }
  if (jail && jail.enabled === false) parts.push('the server has no allowed directory');
  if (!parts.length) return '';
  const fix = names.length
    ? 'Press BIND FILE TOOLS to retry in this page; if it still fails, the sandbox route is not answering.'
    : 'Set Working Project Directory in Config.';
  return `⚠ File tools are unavailable — ${parts.join('; ')}. Anything an agent reports writing is not on disk. ${fix}`;
}

/**
 * Whether one agent's file tools can actually reach a directory, for the agent
 * editor.
 *
 * The chat warns before a turn and Config reports this page's binding, but the
 * editor is where the tools are chosen for a particular agent -- and a
 * per-agent root can name a folder the server will not allow. Both halves are
 * one line here, with `tone` ('ok' | 'warn' | 'unknown') so the panel can colour
 * it without re-reading the prose.
 */
export function agentToolState({ unbound, status, root } = {}) {
  const names = Array.isArray(unbound) ? unbound.filter(n => typeof n === 'string' && n) : [];
  const jail = status && typeof status === 'object' ? status : null;
  const own = String(root ?? '').trim();
  const norm = p => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const allow = [];
  if (jail) {
    for (const r of [...(jail.read_roots || []), ...(jail.write_roots || [])]) {
      if (typeof r === 'string' && r) allow.push(norm(r));
    }
  }
  const insideAllowed = p => {
    const q = norm(p);
    return !!q && allow.some(a => q === a || q.startsWith(a + '/'));
  };
  const jailRoot = jail && typeof (jail.read_roots || [])[0] === 'string' ? jail.read_roots[0] : '';

  const problems = [];
  if (names.length) {
    const head = names.slice(0, 4).join(', ');
    problems.push(`this page never bound ${head}${names.length > 4 ? ` and ${names.length - 4} more` : ''}`);
  }
  if (jail && jail.enabled === false) problems.push('the server has no working directory');
  else if (jail && own && !insideAllowed(own)) {
    problems.push(`this agent is set to ${own}, which is not one of the server's allowed directories`);
  }

  if (problems.length) {
    return {
      tone: 'warn',
      text: `⚠ File tools are unavailable for this agent — ${problems.join('; ')}.`
        + (names.length
          ? ' Press BIND FILE TOOLS to retry in this page.'
          : ' Set a working directory in Config.'),
    };
  }
  if (!jail) {
    return {
      tone: 'unknown',
      text: 'File tools are bound in this page, but the server\'s working directory could not be checked.',
    };
  }
  return {
    tone: 'ok',
    text: own
      ? `File tools: bound, and this agent is jailed to ${own}.`
      : `File tools: bound. This agent follows the server's working directory${jailRoot ? ` (${jailRoot})` : ''}.`,
  };
}

/** How every "the file tools are unusable" note in a transcript begins. */
export const FILE_TOOL_WARNING_PREFIX = '⚠ File tools are unavailable';

/**
 * Is this stored message a file-tool warning?
 *
 * The flag is the reliable answer for notes written since the field existed;
 * the prefix catches the ones already in saved conversations, which have no
 * flag because nothing put one there. The role/agentId guard keeps a model's
 * own reply from being deleted just because it quoted the sentence: these notes
 * are written with `agentId: null`, and a real reply carries its author.
 */
export function isFileToolWarning(msg) {  if (!msg || typeof msg !== 'object') return false;
  if (msg.fileToolWarning === true) return true;
  if (msg.role !== 'agent' || msg.agentId) return false;
  return asText(msg.content).trim().startsWith(FILE_TOOL_WARNING_PREFIX);
}

/**
 * Drop stale file-tool warnings from a message list.
 *
 * A warning is true when it is written and false the moment the tools come
 * back, but a transcript is a record of what was said, so nothing removed it:
 * every fixed install kept telling the operator that its writes were not
 * landing. This returns the list without those notes plus how many went, so the
 * caller can say whether anything changed.
 */
export function withoutFileToolWarnings(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const kept = list.filter(m => !isFileToolWarning(m));
  return { messages: kept, removed: list.length - kept.length };
}

export function finishedWithoutAnswer(calls) {
  const list = Array.isArray(calls) ? calls.filter(Boolean) : [];
  if (!list.length) return 'The agent finished without writing a reply.';
  const n = list.length;
  const head = `Finished after running ${n} tool call${n === 1 ? '' : 's'} without writing an answer.`;
  const last = list[n - 1];
  const detail = String(last && last.result != null ? last.result : '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!detail) return head;
  const name = String((last && last.tool) || 'tool');
  return `${head}\n\n${name} → ${detail.slice(0, TOOL_RESULT_NOTICE_CHARS)}`;
}

/**
 * Rough token estimate for budgeting. Deliberately conservative: prose is
 * usually ~4 chars/token, but code and JSON tokenize denser, and non-ASCII
 * text is closer to one token per character. Underestimating the budget is
 * safer than overflowing the provider's context window.
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let nonAscii = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) nonAscii++;
  }
  const ascii = s.length - nonAscii;
  return Math.ceil(ascii / 4 + nonAscii);
}

/**
 * Character budget for replayed history, given a model's context window.
 *
 * The old fixed 24k ceiling made a 128k-token model behave like a 6k-token
 * one. Reserve room for the output and the system prompt, then convert the
 * remainder to characters at 2.5 chars/token. Unknown models keep the old
 * conservative budget.
 */
export function historyCharBudget(contextLimit) {
  const limit = Number(contextLimit);
  if (!Number.isFinite(limit) || limit <= 0) return 24000;
  // Keep a fixed reserve for the output, system prompt, memory and tool
  // instructions. Without it a 128k window can still overflow once a large
  // agent prompt is prepended to a maximal history.
  //
  // This is only the FIRST pass: compactMessages() trims the live list to the
  // input budget, which is what actually enforces a small window (an 8k runner
  // would otherwise inherit this floor and overflow before compaction runs).
  const usable = Math.max(4096, limit - 32768);
  return Math.max(24000, Math.min(160000, Math.floor(usable * 2.5)));
}

/**
 * Keep the head and tail of an oversized value. Tool output is often a long
 * file or command log where both ends matter and the middle is filler; cutting
 * only the tail loses the error or the final diff.
 */
export function compactText(text, maxChars = 12000) {
  const s = String(text ?? '');
  const cap = Math.max(256, Number(maxChars) || 12000);
  if (s.length <= cap) return s;
  const tail = Math.min(2000, Math.floor(cap * 0.2));
  const head = Math.max(128, cap - tail - 80);
  const omitted = Math.max(0, s.length - head - tail);
  return s.slice(0, head)
    + `\n…[${omitted} chars omitted]…\n`
    + s.slice(-tail);
}

/**
 * Text inside a message content value. OpenAI-style content is either a plain
 * string or an array of parts; tool results and history are strings, but the
 * live user turn may carry text + image parts.
 */
export function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  let out = '';
  for (const part of content) {
    if (typeof part === 'string') out += part;
    else if (part && typeof part === 'object' && typeof part.text === 'string') out += part.text;
  }
  return out;
}

/**
 * Token estimate for one content value. Images are charged a flat,
 * conservative amount because their real cost depends on the provider and the
 * resolution; pretending they are free is how a vision turn overflows.
 */
export function estimateContentTokens(content) {
  if (typeof content === 'string') return estimateTokens(content);
  if (!Array.isArray(content)) return estimateTokens(contentText(content));
  let tokens = 0;
  for (const part of content) {
    if (typeof part === 'string') { tokens += estimateTokens(part); continue; }
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') { tokens += estimateTokens(part.text); continue; }
    if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') {
      tokens += 1500;
    } else if (part.type === 'tool_result') {
      tokens += estimateContentTokens(part.content);
    }
  }
  return tokens;
}

/** Token estimate for a whole message list, including per-message overhead. */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let tokens = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    tokens += 4 + estimateContentTokens(m.content);
    if (m.tool_calls) tokens += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return tokens;
}

/**
 * Input-token budget for one request: the model window minus the requested
 * output and a safety margin for the provider's own framing. Unknown windows
 * get a conservative 32k assumption.
 */
export function contextInputBudget(contextLimit, maxTokens) {
  const limit = Number(contextLimit);
  const out = Number(maxTokens);
  if (!Number.isFinite(limit) || limit <= 0) return 16000;
  // Reserve at most a QUARTER of the window for the reply, however many tokens
  // the agent asked for. Asking for 4096 out of an 8192 window left no room for
  // chat at all: the reserve plus the tool schemas already exceeded the model.
  const ask = Number.isFinite(out) && out > 0 ? out : 4096;
  const reserve = Math.min(ask, Math.max(512, Math.floor(limit / 4)));
  return Math.max(512, Math.floor(limit - reserve - 512));
}

/**
 * A refusal that means "the prompt did not fit", however the runner words it.
 *
 * This has to be told apart from every other 400: the fix is to shorten the
 * prompt and try again, not to change dialect or give up.
 */
export function isContextOverflow(message) {
  const m = String(message || '');
  if (!m) return false;
  return /exceeds the (?:available )?context|context (?:size|length|window)|maximum context|too many tokens|input is too long|prompt is too long|reduce the length of the messages|"n_ctx"|n_prompt_tokens/i.test(m);
}

/**
 * The window a refusal actually names, or null when it names none.
 *
 * A model NAME is a guess at the context size; the runner knows the truth. LM
 * Studio loads an 8k session of a 131k model and says so in the refusal --
 * "request (8836 tokens) exceeds the available context size (8192 tokens)" --
 * so the number is worth keeping.
 */
export function contextLimitFromError(message) {
  const m = String(message || '');
  if (!m) return null;
  const patterns = [
    /"n_ctx"\s*:\s*(\d{3,})/i,
    /available context size\D{0,12}(\d{3,})/i,
    /maximum context length is\D{0,12}(\d{3,})/i,
    /context length of (?:only )?(\d{3,})/i,
    /context (?:size|length|window) is\D{0,12}(\d{3,})/i,
  ];
  for (const re of patterns) {
    const hit = re.exec(m);
    if (!hit) continue;
    const n = Number(hit[1]);
    if (Number.isFinite(n) && n >= 256 && n <= 20000000) return n;
  }
  return null;
}

/**
 * Keep a live prompt inside a model's window.
 *
 * Replayed history already has a budget, but a tool-using turn grows in the
 * other direction: every tool exchange is appended to the live message list and
 * is never reconsidered. On a long task that silently walks past the window
 * even when the history itself is small.
 *
 * Strategy, in order:
 *   1. shrink old assistant + TOOL_RESULT pairs, keeping their head and tail;
 *   2. drop the oldest non-system history turns;
 *   3. as a last resort, shrink an oversized system message.
 *
 * The newest four messages and every system message are preserved as long as
 * possible. Returns a new array; the caller's transcript is untouched.
 */
export function compactMessages(messages, maxTokens) {
  const cap = Math.max(2048, Number(maxTokens) || 16000);
  if (!Array.isArray(messages) || !messages.length) return messages;
  const out = messages.map(m => (m && typeof m === 'object' ? { ...m } : m));
  const total = () => estimateMessagesTokens(out);
  if (total() <= cap) return out;

  const textOf = m => contentText(m && m.content);
  const isToolResult = m => !!m && m.role === 'user' && textOf(m).startsWith('TOOL_RESULT:');
  const tailStart = Math.max(0, out.length - 4);

  // 1. Compact old tool exchanges. Leave the last two exchanges intact: the
  // model needs the result it is currently reasoning about in full.
  for (let i = 0; i < out.length - 1 && total() > cap; i++) {
    if (i >= tailStart) break;
    const a = out[i];
    const r = out[i + 1];
    if (!a || a.role !== 'assistant' || !isToolResult(r)) continue;
    const before = estimateMessagesTokens([a, r]);
    const aText = compactText(textOf(a), 800) || '[tool call]';
    const rText = textOf(r);
    const nextR = rText.startsWith('TOOL_RESULT:')
      ? `TOOL_RESULT: ${compactText(rText.slice('TOOL_RESULT:'.length).trim(), 1400)}`
      : `TOOL_RESULT: ${compactText(rText, 1400)}`;
    const next = [
      { ...a, content: aText },
      { ...r, content: nextR },
    ];
    const after = estimateMessagesTokens(next);
    if (after >= before) continue;
    out.splice(i, 2, ...next);
  }

  // 2. Drop the oldest non-system turns, but never the current user turn or
  // the last few messages that carry the immediate context.
  while (total() > cap) {
    const keepFrom = Math.max(0, out.length - 4);
    let drop = -1;
    for (let i = 0; i < keepFrom; i++) {
      if (!out[i] || out[i].role === 'system') continue;
      drop = i;
      break;
    }
    if (drop === -1) break;
    out.splice(drop, 1);
  }

  // 3. A huge agent prompt/attached-file block can still dominate. Shrink it
  // only after the conversation has been reduced.
  if (total() > cap) {
    const allowedChars = Math.max(2000, Math.floor(cap * 0.5 * 4));
    for (let i = 0; i < out.length; i++) {
      const m = out[i];
      if (!m || m.role !== 'system') continue;
      const text = textOf(m);
      if (text.length > allowedChars) out[i] = { ...m, content: compactText(text, allowedChars) };
    }
  }
  return out;
}

/**
 * Human-facing agent reference, e.g. "#K7M4QX".
 *
 * Deliberately excludes 0/O and 1/I so a code read off a screen or spoken
 * aloud can't be mistyped. Generated once per agent and never changed, so it
 * stays a stable handle in logs, exports and stored dialogs even after the
 * agent is renamed.
 */
export function makeAgentCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `#${out}`;
}

/** An agent's code, minting one on first sight so older agents get one too. */
export function agentCode(agent) {
  if (!agent) return '';
  if (!agent.code) agent.code = makeAgentCode();
  return agent.code;
}

/** Escape HTML entities to prevent XSS */
export function esc(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

/** Escape HTML for use in attributes */
export function escAttr(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Sleep for ms milliseconds */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Debounce function */
export function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/**
 * Whether a scroll container is at (or near) its bottom.
 *
 * Pure numbers in, boolean out, so the follow/pause decision is testable
 * without a DOM. Anything within `tolerance` px of the bottom counts — a
 * freshly filled line or a sub-pixel rounding should never read as
 * "scrolled up". Unscrollable content (scrollHeight <= clientHeight) is
 * trivially at the bottom.
 */
export function isNearBottom(scrollTop, scrollHeight, clientHeight, tolerance = 24) {
  const top = Number(scrollTop) || 0;
  const full = Number(scrollHeight) || 0;
  const shown = Number(clientHeight) || 0;
  const tol = Number(tolerance) || 0;
  return full - (top + shown) <= tol;
}

/**
 * Whether new chat output should pull the transcript to the bottom.
 *
 * `autoScroll` is the Config toggle (opt-out: only an explicit `false`
 * disables it, a missing/garbage value keeps the old behaviour).
 * `override` is the operator's gesture since: `true` after pressing the
 * scroll-to-latest button (temporary follow), `false` after scrolling up
 * while something was following (paused), `null` when neither happened.
 * The gesture always wins over the toggle.
 */
export function scrollFollowWanted(autoScroll, override) {
  if (override === true) return true;
  if (override === false) return false;
  return autoScroll !== false;
}

/** Generate unique ID */
export function uuid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Format timestamp to HH:MM:SS */
export function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Format timestamp to readable date */
export function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Normalize a timestamp to milliseconds (backend uses seconds). */
export function toMs(ts) {
  ts = Number(ts) || 0;
  if (ts > 0 && ts < 1e12) return ts * 1000;
  return ts;
}

/** Format relative time (e.g., "2m ago") */
export function timeAgo(ts) {
  ts = toMs(ts);
  if (!ts) return 'never';
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Copy text to clipboard */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(ta);
    }
  }
}

/** Download text as file */
/**
 * Coerce anything to displayable text. Objects become JSON, never the useless
 * "[object Object]" that template literals and String() produce for them --
 * that string kept showing up in transcripts, memory lists and tool results
 * whenever a structured value reached a text slot.
 */
export function asText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    const j = JSON.stringify(v);
    return typeof j === 'string' ? j : String(v);
  } catch {
    try { return String(v); } catch { return ''; }
  }
}

export function downloadFile(content, filename, mimeType = 'text/plain') {  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Parse markdown-like content into sections (thinking, code, terminal) */
export function parseContentSections(content) {
  if (!content) return [];

  const sections = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Text before code block
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index).trim();
      if (text) {
        sections.push({ type: 'text', content: text });
      }
    }
    // Code block
    sections.push({
      type: 'code',
      language: match[1] || 'text',
      content: match[2].trim()
    });
    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trim();
    if (text) {
      sections.push({ type: 'text', content: text });
    }
  }

  // If no sections found, return as single text section
  if (sections.length === 0 && content.trim()) {
    sections.push({ type: 'text', content: content.trim() });
  }

  return sections;
}

/**
 * Simple syntax highlighting (regex-based, no external deps).
 *
 * Single tokenizer pass: one alternation regex, then each match is escaped and
 * wrapped. Doing it as sequential .replace() calls corrupts the output, because
 * a later rule happily matches inside the markup an earlier rule just inserted
 * (the `class` in `<span class="...">` gets highlighted, and the HTML breaks).
 */
export function highlightSyntax(code, language = '') {
  if (!code) return '';

  const KEYWORDS = [
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
    'switch', 'case', 'break', 'continue', 'class', 'extends', 'import', 'export',
    'from', 'default', 'new', 'this', 'super', 'try', 'catch', 'finally', 'throw',
    'async', 'await', 'yield', 'typeof', 'instanceof', 'in', 'of', 'true', 'false',
    'null', 'undefined', 'void', 'delete', 'def', 'elif', 'lambda', 'pass', 'self',
    'echo', 'package', 'func', 'struct', 'impl', 'pub', 'use', 'mod', 'fn', 'val',
    'mut', 'require', 'include', 'namespace', 'public', 'private', 'static',
    'SELECT', 'FROM', 'WHERE', 'JOIN', 'GROUP', 'ORDER', 'LIMIT', 'INSERT', 'UPDATE'
  ];

  const re = new RegExp([
    '(?<comment>//[^\\n]*|#[^\\n]*|<!--[\\s\\S]*?-->)',
    '(?<string>"[^"\\n]*"|\'[^\'\\n]*\'|`[^`\\n]*`)',
    '(?<keyword>\\b(?:' + KEYWORDS.join('|') + ')\\b)',
    '(?<number>\\b\\d+(?:\\.\\d+)?\\b)',
    '(?<func>[A-Za-z_$][\\w$]*)(?=\\()'
  ].join('|'), 'g');

  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(String(code))) !== null) {
    out += esc(code.slice(last, m.index));
    const cls = m.groups.comment ? 'syntax-comment'
      : m.groups.string ? 'syntax-string'
      : m.groups.keyword ? 'syntax-keyword'
      : m.groups.number ? 'syntax-number'
      : 'syntax-function';
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;  // never stall
  }
  out += esc(String(code).slice(last));
  return out;
}

/** Truncate string with ellipsis */
export function truncate(str, maxLen = 50) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/** Deep clone an object */
export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Get nested property by dot notation */
export function getNested(obj, path, defaultValue = undefined) {
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return defaultValue;
    current = current[key];
  }
  return current !== undefined ? current : defaultValue;
}

/** Set nested property by dot notation */
export function setNested(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}
