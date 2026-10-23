// ============================================
// UTILS.JS — Helper functions
// ============================================

/** How many prior user turns an agent remembers by default. 0 = stateless. */
export const DEFAULT_HISTORY_TURNS = 5;

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
  const reserve = Math.max(1024, Math.min(Number.isFinite(out) && out > 0 ? out : 4096,
    Math.floor(limit * 0.5)));
  return Math.max(4096, Math.floor(limit - reserve - 2048));
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
