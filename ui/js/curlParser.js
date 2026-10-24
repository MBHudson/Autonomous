/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// CURLPARSER.JS — Shared curl parsing + template substitution
// Used by the terminal (literal curl) and by agents
// (curl templates with $VARIABLEs).
// ============================================

export const TEMPLATE_VARS = {
  ENDPOINT: 'ENDPOINT-VARIABLE',
  API_KEY: 'GENERATED-API-KEY-VARIABLE',
  PROMPT: 'USER-PROMPT-VARIABLE',
  TEMP: 'TEMP',
  MAX_TOKENS: 'MAX-TOKENS',
  SYSTEM_PROMPT: 'SYSTEM-PROMPT',
};

/** Every placeholder we know about, longest first so $MAX-TOKENS beats $TEMP. */
export const ALL_VARS = Object.values(TEMPLATE_VARS).sort((a, b) => b.length - a.length);

/** Clean mobile/keyboard paste artifacts: smart quotes, NBSP, zero-width chars. */
export function normalizePastedText(s) {
  return String(s ?? '')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/ /g, ' ')
    .replace(/[‌‍﻿]/g, '')
    .replace(/\r\n?/g, '\n');
}

// ============================================
// Shell wrappers
// ============================================
// Provider docs increasingly ship a shell snippet instead of a bare curl:
//
//   invoke_url='https://host/v1/chat/completions'
//   payload=$(cat <<'JSON'
//   { "model": "..." }
//   JSON
//   )
//   curl -sS -N --request POST --url "$invoke_url" \
//        --header "Authorization: Bearer $KEY" --data "$payload"
//
// resolveShellCurl turns that whole snippet into a plain argv array so the
// normal flag parser never has to think about shell variables or heredocs.

/** Shell variables: NAME='v', NAME="v", NAME=$(cat <<'D'…D), NAME=$(…). */
function collectShellVars(text) {
  const vars = new Map();

  // Heredoc written to a FILE, later referenced with curl's `-d @file` syntax:
  //   cat > payload.json <<JSON
  //   { ...json... }
  //   JSON
  //   curl ... -d @payload.json
  // Stored under the filename so `@payload.json` can resolve to its contents.
  const fileHeredocRe = /cat\s*>\s*([A-Za-z0-9_./-]+)\s*<<-?\s*(['"]?)([A-Za-z0-9_]+)\2[^\n]*\n([\s\S]*?)\n[ \t]*\3[ \t]*(?:\n|$)/g;
  let fh;
  while ((fh = fileHeredocRe.exec(text)) !== null) {
    vars.set(fh[1], dedent(fh[4]));
  }

  // Heredoc: NAME=$(cat <<'DELIM' … DELIM)  /  NAME=<<'DELIM' … DELIM
  const heredocRe = /(?:^|\n)\s*(?:export\s+|local\s+|declare\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\$?\(\s*cat\s*<<-?\s*(['"]?)([A-Za-z0-9_]+)\2\s*\n([\s\S]*?)\n?\s*\3\s*\)?/g;
  let m;
  while ((m = heredocRe.exec(text)) !== null) {
    vars.set(m[1], dedent(m[4]));
  }

  // Command substitution without a heredoc: NAME=$(printf 'x')
  const cmdSubRe = /(?:^|\n)\s*(?:export\s+|local\s+|declare\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\$\(\s*(.*?)\s*\)/g;
  while ((m = cmdSubRe.exec(text)) !== null) {
    if (vars.has(m[1])) continue;                 // heredoc already won
    const inner = m[2].trim();
    const printf = /^printf\s+(['"])([\s\S]*)\1$/.exec(inner);
    if (printf) {
      vars.set(m[1], printf[2].replace(/\\n/g, '\n'));
      continue;
    }
    if (/^cat\s/.test(inner) || inner === 'cat') continue;   // heredoc form
    // Unknown command: keep the literal text so nothing silently vanishes.
    vars.set(m[1], inner);
  }

  // Plain assignment: NAME='v' or NAME="v"
  const plainRe = /(?:^|\n)\s*(?:export\s+|local\s+|declare\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(['"])([\s\S]*?)\2/g;
  while ((m = plainRe.exec(text)) !== null) {
    vars.set(m[1], m[3]);
  }

  return vars;
}

/** Remove common leading indentation (heredoc bodies are usually indented). */
function dedent(body) {
  const lines = body.split('\n');
  const indents = lines.filter(l => l.trim()).map(l => l.match(/^[ \t]*/)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map(l => l.slice(min)).join('\n').trim();
}

/**
 * Tokenize one curl statement, substituting shell variables.
 * A token that is entirely a variable reference ("$payload", ${x}, $x) is
 * replaced by the variable's value AS A SINGLE TOKEN, so its contents are
 * never re-examined for quotes or word breaks.
 */
function tokenizeCurlStatement(stmt, vars) {
  // Pull heredocs/braces apart first: a JSON body must stay one token even
  // though it contains spaces and double quotes.
  const tokens = [];
  let cur = '';
  let quote = null;
  // Brace depth OUTSIDE shell quotes. While >0 we are inside an unquoted JSON
  // body (or similar structure), where `"` is JSON string quoting rather than
  // shell quoting and whitespace does not split tokens. Without this,
  // -d {"a": "b c"} tokenized the inner quotes away and the body reassembled
  // as non-JSON.
  let depth = 0;
  // Set to a quote character after an escaped quote outside quotes, so the
  // quote that follows it in the '\'' idiom reopens the string. Null otherwise.
  let reopenQuote = null;
  const joined = stmt.replace(/\\\n/g, ' ');

  const varValue = name => (vars.has(name) ? vars.get(name) : undefined);

  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];

    // $NAME / ${NAME} / "$NAME" / "${NAME}" / '$NAME'
    if (ch === '$' && vars.size) {
      const rest = joined.slice(i);
      const v = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}|^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
      if (v) {
        const name = v[1] || v[2];
        const val = varValue(name);
        if (quote !== null) {
          // Inside a quoted region: append so "Bearer $KEY" stays ONE token,
          // and leave the quote state alone so the closing quote still closes.
          cur += (val !== undefined ? val : '$' + name);
          i += v[0].length - 1;
          continue;
        }
        const after = rest[v[0].length];
        if (after === '"' || after === "'") {
          // A whole token that is just "$var" → the value IS the token,
          // contents never re-scanned for quotes.
          if (cur) { tokens.push(cur); cur = ''; }
          if (val !== undefined) tokens.push(val);
          i += v[0].length;          // skip the variable AND its closing quote
          continue;
        }
        cur += (val !== undefined ? val : '$' + name);
        i += v[0].length - 1;
        continue;
      }
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && i + 1 < joined.length) {
        const nx = joined[++i];
        if (quote === '"' && (nx === '"' || nx === '\\' || nx === '$' || nx === 'n')) {
          cur += nx === 'n' ? '\n' : nx;
        } else {
          cur += ch + nx;
        }
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      // Open a quoted region only at a token boundary (or after '=') and only
      // outside braces. A mid-token quote is literal — this tolerates pasted
      // curl with unbalanced quotes like: -H "Bearer "KEY
      if (depth > 0) {
        cur += ch;
      } else if (reopenQuote === ch) {
        // The other half of the POSIX '\'' idiom: 'it'\''s' is one string with
        // a literal apostrophe. The escaped quote has already been consumed as
        // content, so this quote REOPENS the region rather than being taken as
        // another literal -- which used to turn "it's" into "it''s".
        quote = ch;
        reopenQuote = null;
      } else if (cur === '' || joined[i - 1] === '=') {
        quote = ch;
      } else {
        cur += ch;
      }
    } else if (ch === '\\' && i + 1 < joined.length && /\s/.test(joined[i + 1])) {
      i++;
      cur += ' ';
    } else if (ch === '\\' && i + 1 < joined.length) {
      // Inside braces the backslash is JSON content (\" or \\), not a shell
      // escape: keep it, or "a\nb" becomes "anb".
      if (depth > 0) cur += ch;
      const nx = joined[++i];
      cur += nx;
      // An escaped quote outside quotes is content, and the NEXT same quote
      // reopens the string (see the idiom note above).
      reopenQuote = (nx === "'" || nx === '"') ? nx : null;
    } else if (/\s/.test(ch)) {
      // Whitespace inside braces does not split: the JSON body stays one
      // token even unquoted. Normal collapse would split {"a": 1} after
      // {"a": and the body would truncate to `{`.
      if (depth > 0) {
        cur += ' ';
      } else if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
      if (ch === '{' || ch === '[') depth++;
      else if ((ch === '}' || ch === ']') && depth > 0) depth--;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/**
 * Find the curl statement in a pasted snippet and tokenize it with shell
 * variables resolved. Returns null when there is no curl at all.
 */
export function resolveShellCurl(text) {
  const src = normalizePastedText(text);
  if (!/\bcurl\b/.test(src)) return null;
  const vars = collectShellVars(src);

  // The curl statement runs from `curl` up to the first line that starts a
  // new command (no leading whitespace, not a continuation, not a var).
  const lines = src.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*curl\b/.test(lines[i])) { start = i; break; }
  }
  if (start === -1) {
    // curl buried in a chain like `python -c "…"; curl …` — fall back to the
    // first occurrence and take everything after it.
    const idx = src.search(/\bcurl\b/);
    return idx === -1 ? null : tokenizeCurlStatement(src.slice(idx), vars);
  }

  // Walk forward to the end of the curl statement. A line that starts at
  // column 0 normally begins a new command — but NOT while we are inside an
  // unterminated quote, because a JSON body passed as -d '{ … }' is often
  // pasted with its lines flush left. Ignoring that truncated the body to `{`.
  const stmt = [];
  let inQuote = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (i > start && !inQuote && /^\S/.test(line) && !/^\s*curl\b/.test(line)) break;
    stmt.push(line);
    // Track quote state across lines so we know when the body really ends.
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '\\') { c++; continue; }
      if (inQuote) { if (ch === inQuote) inQuote = null; }
      else if (ch === '"' || ch === "'") inQuote = ch;
    }
  }
  return tokenizeCurlStatement(stmt.join('\n'), vars);
}

// ============================================
// Tokenizer / parser
// ============================================

/** Shell-ish tokenizer: quotes, backslash escapes, line continuations. */
export function tokenizeCurl(cmd) {
  return tokenizeCurlStatement(cmd, new Map());
}

function isVarToken(t) {
  return /^\$/.test(t);
}

/**
 * Parse a curl command or a whole shell snippet containing one.
 * Returns { url, method, headers, data }.
 */
export function parseCurl(cmd) {
  // Shell-snippet form first (NVIDIA-style docs). Falls back to the plain
  // tokenizer when there are no shell variables to resolve.
  const shellVars = collectShellVars(normalizePastedText(cmd));
  let tokens = resolveShellCurl(cmd);
  if (!tokens || tokens.length === 0) {
    tokens = tokenizeCurl(cmd);
  }
  if (tokens.length === 0 || tokens[0].toLowerCase() !== 'curl') {
    throw new Error('Not a curl command (no curl invocation found)');
  }
  tokens = tokens.slice(1);
  let method = null;
  const headers = {};
  let data = null;
  let url = null;

  const takeValue = (i) => {
    let val = tokens[i] ?? '';
    // Glue split pieces: quoted-prefix followed by $VAR or bare token
    // e.g. "Authorization: Bearer " + nvapi-XXX
    const depth = (s) => (s.match(/[{[]/g) || []).length - (s.match(/[}\]]/g) || []).length;
    // ...plus brace-unbalanced pieces: an UNQUOTED JSON body tokenizes apart
    // (`-d {"a": 1}` splits after `{"a":`), which truncated the body to `{`.
    // Keep gluing while braces/brackets are unbalanced so the body survives as
    // one value. Quoted spans tokenize whole, so only JSON-insignificant
    // whitespace between tokens is lost. Stops at flags all the same, so
    // `-d a=1 -d b=2` still parses as two values.
    while (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')
        && (/[\s"']$/.test(val) || depth(val) > 0)) {
      val += tokens[++i];
    }
    return [val, i];
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-X' || t === '--request') {
      method = (tokens[++i] || 'GET').toUpperCase();
    } else if (t === '-H' || t === '--header') {
      i++;
      const [val, ni] = takeValue(i);
      i = ni;
      const idx = val.indexOf(':');
      if (idx > 0) headers[val.slice(0, idx).trim()] = val.slice(idx + 1).trim();
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii') {
      i++;
      const [val, ni] = takeValue(i);
      i = ni;
      // curl's `-d @file` means "read the body from this file". When the file
      // was written by a heredoc earlier in the same snippet, substitute its
      // contents so the body parses as JSON.
      let bodyVal = val;
      const at = /^@(.+)$/.exec(val.trim());
      if (at) {
        const fname = at[1].trim();
        bodyVal = (shellVars && shellVars.get(fname)) || '';
        if (!bodyVal) {
          throw new Error(`curl: body read from @${fname}, which this snippet never writes`);
        }
      }
      data = (data ? data + '&' : '') + bodyVal;
    } else if (t.startsWith('-')) {
      continue; // -s -S -k -i --compressed etc: no-ops
    } else if (!url) {
      url = t;
    } else if (!/\/\//.test(url) && /\/\//.test(t)) {
      // A leftover artifact ("n" from a mangled line continuation) must not
      // win over the real URL that follows it.
      url = t;
    }
  }

  if (!url) throw new Error('curl: no URL');
  if (!/\/\//.test(url)) {
    throw new Error(`curl: "${url}" does not look like a URL`);
  }
  if (!method) method = data ? 'POST' : 'GET';
  // Strip stray wrapping quotes (paste artifacts) from URL and headers
  url = url.replace(/^["']+|["']+$/g, '');
  Object.keys(headers).forEach(k => {
    headers[k] = headers[k].replace(/^["']+|["']+$/g, '');
  });
  return { url, method, headers, data };
}

/** True when a JSON body has no system message to carry a system prompt. */
export function bodyHasSystemMessage(body) {
  return !!(body && Array.isArray(body.messages) && body.messages.some(m => m && m.role === 'system'));
}

/** Lenient JSON parse: fixes trailing commas after smart-quote cleanup. */
export function parseJsonLenient(text) {
  const clean = normalizePastedText(text).trim();
  try {
    return { value: JSON.parse(clean), repaired: false };
  } catch {}
  try {
    const fixed = clean
      .replace(/,\s*([}\]])/g, '$1');
    return { value: JSON.parse(fixed), repaired: true };
  } catch (err) {
    throw err;
  }
}
export function escapeForJson(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

// ============================================
// Template substitution
// ============================================
//
// The tricky part: prompt and system-prompt text is arbitrary user input. If
// we paste it straight into the shell text, a single apostrophe terminates the
// `-d '{...}'` quoting and the request dies with "body is not JSON". So those
// two values are swapped for shell-inert sentinels first and restored AFTER
// the command has been parsed — the shell tokenizer never sees them.

const SENTINEL_PREFIX = '\u0002R';
const SENTINEL_SUFFIX = '\u0003';

/**
 * Spellings we accept for each variable. Users paste templates from all over
 * the place and write `$SYSTEM_PROMPT`, `$SYSTEM-PROMPT-VARIABLE`, `${temp}`
 * and so on; all of them should work instead of being sent to the model
 * verbatim.
 */
const VAR_ALIASES = {
  [TEMPLATE_VARS.ENDPOINT]: ['ENDPOINT-VARIABLE', 'ENDPOINT_VARIABLE', 'ENDPOINT', 'URL', 'URL-VARIABLE'],
  [TEMPLATE_VARS.API_KEY]: ['GENERATED-API-KEY-VARIABLE', 'GENERATED_API_KEY_VARIABLE', 'API-KEY', 'API-KEY-VARIABLE', 'API_KEY', 'APIKEY', 'KEY'],
  [TEMPLATE_VARS.PROMPT]: ['USER-PROMPT-VARIABLE', 'USER_PROMPT_VARIABLE', 'USER-PROMPT', 'USER_PROMPT', 'PROMPT-VARIABLE', 'PROMPT'],
  [TEMPLATE_VARS.TEMP]: ['TEMP', 'TEMPERATURE'],
  [TEMPLATE_VARS.MAX_TOKENS]: ['MAX-TOKENS', 'MAX_TOKENS', 'MAXTOKENS', 'MAX-TOKEN', 'MAX_TOKENS_VARIABLE'],
  [TEMPLATE_VARS.SYSTEM_PROMPT]: ['SYSTEM-PROMPT', 'SYSTEM_PROMPT', 'SYSTEM-PROMPT-VARIABLE', 'SYSTEM_PROMPT_VARIABLE', 'SYSTEMPROMPT'],
};

/**
 * Substitute template variables.
 * Returns { text, restore } — call restore(rawString) to put the real prompt
 * and system prompt back into the parsed output.
 */
export function substituteCurlTemplate(tpl, {
  endpoint = '', apiKey = '', prompt = '', temperature = 0.7,
  maxTokens = 1024, systemPrompt = '',
} = {}) {
  const sentinels = [];

  // Scalars are safe to inline (no quotes/newlines expected in them).
  const safe = {
    [TEMPLATE_VARS.ENDPOINT]: endpoint,
    [TEMPLATE_VARS.API_KEY]: apiKey,
    [TEMPLATE_VARS.TEMP]: String(temperature ?? 0.7),
    [TEMPLATE_VARS.MAX_TOKENS]: String(maxTokens ?? 1024),
  };

  // Free text goes behind a sentinel. It is stored JSON-escaped because it
  // lands back inside a JSON string literal in the request body.
  const guarded = {
    [TEMPLATE_VARS.PROMPT]: escapeForJson(prompt),
    [TEMPLATE_VARS.SYSTEM_PROMPT]: escapeForJson(systemPrompt || DEFAULT_SYSTEM_PROMPT),
  };

  let out = String(tpl ?? '');

  // Longest aliases first so $MAX-TOKENS is never eaten by $MAX or $TEMP.
  const replaceGroup = (canonical, value) => {
    const names = (VAR_ALIASES[canonical] || [canonical]).slice()
      .sort((a, b) => b.length - a.length);
    names.forEach(name => {
      const re = new RegExp('\\$\\{' + name + '\\}|\\$' + name + '(?![A-Za-z0-9_-])', 'g');
      out = out.replace(re, () => value);
    });
  };

  // Free text first: their values must not be scanned for other variables.
  Object.entries(guarded).forEach(([name, value]) => {
    const token = `${SENTINEL_PREFIX}${sentinels.length}${SENTINEL_SUFFIX}`;
    sentinels.push(value);
    replaceGroup(name, token);
  });
  Object.entries(safe).forEach(([name, value]) => replaceGroup(name, value));

  const restore = raw => {
    let s = String(raw ?? '');
    sentinels.forEach((value, i) => {
      const token = `${SENTINEL_PREFIX}${i}${SENTINEL_SUFFIX}`;
      s = s.split(token).join(value);
    });
    return s;
  };

  return { text: out, restore };
}

/** Back-compat: plain string in, plain string out (no sentinels). */
export function substituteCurlTemplateRaw(tpl, opts = {}) {
  return substituteCurlTemplate(tpl, opts).text;
}

/** Every spelling we would substitute, used to spot ones we failed to. */
const ALL_ALIASES = [...new Set(Object.values(VAR_ALIASES).flat())]
  .sort((a, b) => b.length - a.length);

/**
 * Does this template carry ANY Router Studio placeholder (endpoint, key,
 * temperature, tokens, prompt, system)? The send path used to gate on the
 * user-prompt placeholder alone, so a template with only $ENDPOINT-VARIABLE
 * skipped substitution entirely and the literal went out as the URL.
 */
export function hasTemplateVars(tpl) {
  const s = String(tpl || '');
  if (!s.includes('$')) return false;
  return ALL_ALIASES.some(name => s.includes('$' + name) || s.includes('${' + name + '}'));
}

/** A string that is nothing but an unsubstituted placeholder, e.g. $SYS-PROMPT-XYZ. */
function isLonePlaceholder(text) {
  return /^\s*\$[A-Z][A-Z0-9_.-]*\s*$/.test(text);
}

/**
 * Placeholders still visible in a built request body.
 *
 * Message contents are skipped, because real user text is allowed to contain
 * `$HOME` and friends — but a message whose content is *nothing but* a
 * placeholder is reported, since that is always a mistake.
 */
export function findLeftoverVars(body) {
  const found = new Set();
  const walk = (v, inMessageContent) => {
    if (typeof v === 'string') {
      if (isLonePlaceholder(v)) { found.add(v.trim()); return; }
      if (inMessageContent) return;
      ALL_ALIASES.forEach(name => {
        if (v.includes('$' + name)) found.add('$' + name);
      });
      // Any other placeholder-shaped token: multi-word ($SYSTEM_PROMPT,
      // $MAX-TOKENS). Single words like $HOME are left alone — they are
      // ordinary text.
      const inline = /\$[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)+/g;
      let m2;
      while ((m2 = inline.exec(v)) !== null) found.add(m2[0]);
      return;
    }
    if (Array.isArray(v)) { v.forEach(x => walk(x, inMessageContent)); return; }
    if (v && typeof v === 'object') {
      Object.values(v).forEach(x => walk(x, inMessageContent));
    }
  };
  if (body && Array.isArray(body.messages)) {
    body.messages.forEach(m => {
      if (!m || typeof m !== 'object') return;
      Object.entries(m).forEach(([k, val]) => walk(val, k === 'content'));
    });
    const { messages, ...rest } = body;
    walk(rest, false);
  } else {
    walk(body, false);
  }
  return [...found];
}

/** Pull a Bearer token out of parsed headers (for relay). */
export function bearerFromHeaders(headers = {}) {
  const auth = headers['Authorization'] || headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}