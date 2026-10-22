// ============================================
// SNIPPETPARSER.JS — Python / Node / fetch snippet → normalized request
// ============================================
//
// NVIDIA (and others) publish the SAME request as curl, Python, or Node. All
// three are just descriptions of an HTTP call, so we read the request out of
// them and hand it to the relay. NOTHING IS EXECUTED — this is parsing.
//
//   requests.post(url, headers={...}, json={...})     → normalized
//   urllib.request.Request(url, data=..., headers=..) → normalized
//   fetch(url, {method, headers, body: JSON.stringify})→ normalized
//   axios.post(url, {...}, {headers: {...}})          → normalized
//
// Output shape matches parseCurl(): { url, method, headers, data } so the
// agent editor's box-filling works identically for every input language.

/**
 * Tolerant literal parser for object/array literals.
 * Accepts JSON, JavaScript object literals, and Python dicts:
 * unquoted keys, 'single', "double", `backtick` strings, true/false/null,
 * True/False/None, trailing commas, // and # comments.
 */
export function parseLiteral(src) {
  const s = String(src || '');
  let i = 0;

  const ws = () => {
    while (i < s.length) {
      if (/\s/.test(s[i])) { i++; continue; }
      if (s[i] === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (s[i] === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (s[i] === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
      break;
    }
  };

  function value() {
    ws();
    const c = s[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"' || c === "'" || c === '`') return str();
    if (s.startsWith('true', i)) { i += 4; return true; }
    if (s.startsWith('false', i)) { i += 5; return false; }
    if (s.startsWith('null', i)) { i += 4; return null; }
    if (s.startsWith('True', i)) { i += 4; return true; }
    if (s.startsWith('False', i)) { i += 5; return false; }
    if (s.startsWith('None', i)) { i += 4; return null; }
    if (s.startsWith('undefined', i)) { i += 9; return undefined; }
    return num();
  }

  function str() {
    const quote = s[i++];
    let out = '';
    while (i < s.length && s[i] !== quote) {
      if (s[i] === '\\') {
        const nx = s[++i];
        out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx === 'r' ? '\r' : nx;
        i++;
      } else if (quote === '`' && s[i] === '$' && s[i + 1] === '{') {
        // Template expression: keep it visible as a placeholder-ish token
        // rather than trying to evaluate it.
        let depth = 1; let j = i + 2;
        while (j < s.length && depth) {
          if (s[j] === '{') depth++;
          else if (s[j] === '}') depth--;
          j++;
        }
        out += '${' + s.slice(i + 2, j - 1).trim() + '}';
        i = j;
      } else {
        out += s[i++];
      }
    }
    i++;   // closing quote
    return out;
  }

  function num() {
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i));
    if (!m) { i++; return null; }
    i += m[0].length;
    return Number(m[0]);
  }

  function key() {
    ws();
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') return str();
    const m = /^[A-Za-z_$][\w$-]*/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  }

  function object() {
    i++;   // {
    const out = {};
    for (;;) {
      ws();
      if (s[i] === '}') { i++; break; }
      if (s[i] === ',') { i++; continue; }
      const k = key();
      if (k === null) break;
      ws();
      if (s[i] === ':' || s[i] === '=') i++;
      out[k] = value();
      ws();
      if (s[i] === ',' || s[i] === ';') i++;
    }
    return out;
  }

  function array() {
    i++;   // [
    const out = [];
    for (;;) {
      ws();
      if (s[i] === ']') { i++; break; }
      if (s[i] === ',') { i++; continue; }
      out.push(value());
      ws();
      if (s[i] === ',') i++;
    }
    return out;
  }

  const v = value();
  return v;
}

/** Find the balanced {...} / [...] starting at `from` (index of the opener). */
function balanced(src, from, open, close) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return src.slice(from, i + 1); }
  }
  return null;
}

/** Argument-aware split of a call's argument list on top-level commas. */
function splitArgs(src) {
  const out = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += src[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    if (c === '}' || c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map(a => a.trim());
}

/**
 * Python/JS kwargs in an argument: headers={...} json={...} data="…"
 * The value may itself be a bare variable (headers=headers), so `syms`
 * (from collectSymbols) is consulted before giving up.
 */
function kwargs(argText, syms) {
  const out = {};
  // `name=value` (Python kwargs) and `name: value` (JS object literal).
  const re = /([A-Za-z_$][\w$]*)\s*[=:]\s*/g;
  let m;
  while ((m = re.exec(argText)) !== null) {
    const name = m[1];
    const rest = argText.slice(m.index + m[0].length);
    const first = rest[0];
    if (first === '{' || first === '[') {
      const open = first, close = first === '{' ? '}' : ']';
      const lit = balanced(rest, 0, open, close);
      if (lit) { out[name] = parseLiteral(lit); re.lastIndex = m.index + m[0].length + lit.length; continue; }
    }
    const sm = /^(['"`])([\s\S]*?)\1/.exec(rest);
    if (sm) { out[name] = sm[2]; re.lastIndex = m.index + m[0].length + sm[0].length; continue; }
    // value is a bare identifier → resolve from the symbol table
    const id = asIdentifier(rest);
    if (id && syms && syms.has(id)) { out[name] = syms.get(id); re.lastIndex = argText.length; continue; }
    // numbers, booleans, None/null
    const nm = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (nm) { out[name] = Number(nm[0]); re.lastIndex = m.index + m[0].length + nm[0].length; continue; }
    const bm = /^(true|True|false|False)\b/.exec(rest);
    if (bm) { out[name] = /^(true|True)$/.test(bm[0]); re.lastIndex = m.index + m[0].length + bm[0].length; continue; }
    const nm2 = /^(none|None|null)\b/.exec(rest);
    if (nm2) { out[name] = null; re.lastIndex = m.index + m[0].length + nm2[0].length; continue; }
  }
  return out;
}

/**
 * fetch(url, { method, headers, body }) — the options object uses `:` rather
 * than `=`, so the kwargs reader can't parse it. Read the three fields we
 * care about directly, including body: JSON.stringify({...}).
 */
function parseFetchOptions(text, syms) {
  const src = String(text || '').trim();
  const out = {};

  const mm = /['"]?method['"]?\s*:\s*['"]([A-Za-z]+)['"]/.exec(src);
  if (mm) out.method = mm[1];

  const hm = /['"]?headers['"]?\s*:\s*/.exec(src);
  if (hm) {
    const rest = src.slice(hm.index + hm[0].length);
    if (rest[0] === '{') {
      const lit = balanced(rest, 0, '{', '}');
      if (lit) out.headers = parseLiteral(lit);
    } else {
      const id = asIdentifier(rest);
      if (id && syms && syms.has(id)) out.headers = syms.get(id);
    }
  }

  const bm = /['"]?body['"]?\s*:\s*/.exec(src);
  if (bm) {
    const rest = src.slice(bm.index + bm[0].length).trim();
    const js = /^JSON\s*\.\s*stringify\s*\(/.exec(rest);
    if (js) {
      const after = rest.slice(js[0].length - 1);   // keep the '('
      const lit = balanced(after, 0, '(', ')');
      if (lit) out.body = parseLiteral(lit.slice(1, -1));   // strip the parens
    } else {
      const sm = /^(['"`])([\s\S]*?)\1/.exec(rest);
      if (sm) out.body = sm[2];
      else {
        const id = asIdentifier(rest);
        if (id && syms && syms.has(id)) out.body = syms.get(id);
      }
    }
  }
  return out;
}

const HTTP_METHODS = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE', head: 'HEAD' };

/**
 * Snippets usually define things first and pass the variable along:
 *   url = "https://…"
 *   headers = {…}
 *   payload = {…}
 *   requests.post(url, headers=headers, json=payload)
 * Collect those simple literal assignments so the call site can resolve them.
 */
export function collectSymbols(src) {
  const vars = new Map();
  const re = /(?:^|\n)\s*(?:export\s+|local\s+|declare\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?!=)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const rest = src.slice(m.index + m[0].length);
    const first = rest[0];
    if (first === '{' || first === '[') {
      const lit = balanced(rest, 0, first, first === '{' ? '}' : ']');
      if (lit) { try { vars.set(name, parseLiteral(lit)); } catch { /* ignore */ } re.lastIndex = m.index + m[0].length + lit.length; }
      continue;
    }
    const sm = /^(['"`])([\s\S]*?)\1/.exec(rest);
    if (sm) { vars.set(name, sm[2]); re.lastIndex = m.index + m[0].length + sm[0].length; }
  }
  return vars;
}

/** A bare identifier that names a collected variable. */
function asIdentifier(text) {
  const t = String(text || '').trim();
  return /^[A-Za-z_$][\w$]*$/.test(t) ? t : null;
}

function normalizeHeaders(obj) {
  const headers = {};
  if (!obj || typeof obj !== 'object') return headers;
  Object.entries(obj).forEach(([k, v]) => {
    if (v === null || v === undefined) return;
    headers[k] = String(v);
  });
  return headers;
}

/** Pick a body out of whatever the snippet called it (json / data / body / payload). */
function bodyFrom(kw) {
  const cand = kw.json !== undefined ? kw.json
    : kw.body !== undefined ? kw.body
    : kw.data !== undefined ? kw.data
    : kw.payload !== undefined ? kw.payload
    : undefined;
  if (cand === undefined) return null;
  if (typeof cand === 'string') {
    // Already a string (fetch body / json.dumps result): parse if it looks
    // like JSON, otherwise send it through verbatim.
    const t = cand.trim();
    if (!t) return null;
    try { return JSON.parse(t); } catch {}
    if (/^[[{]/.test(t)) {
      try { return parseLiteral(t); } catch {}
    }
    return null;
  }
  if (typeof cand === 'object') return cand;
  return null;
}

// ---------- Python ----------

export function looksLikePython(text) {
  return /\b(requests|urllib|http\.client|httpx)\b/.test(text) && /import|from\s+\w+\s+import/.test(text);
}

export function parsePythonSnippet(text) {
  const src = String(text || '');
  const syms = collectSymbols(src);

  // Resolve an argument that is either a literal or a variable name.
  const argValue = a => {
    const id = asIdentifier(a);
    if (id && syms.has(id)) return syms.get(id);
    const sm = /^(['"`])([\s\S]*)\1$/.exec(String(a || '').trim());
    if (sm) return sm[2];
    return undefined;
  };
  // kwargs that may point at a variable: headers=headers
  const kwArgs = args => {
    const merged = {};
    args.slice(1).forEach(a => {
      const text = a.trim();
      const id = asIdentifier(text);
      if (id && syms.has(id)) { merged[id] = syms.get(id); return; }
      Object.assign(merged, kwargs(text, syms));
    });
    return merged;
  };

  // requests.post("url", headers={...}, json={...})
  let m = /\b(?:requests|httpx|session)\s*\.\s*(get|post|put|patch|delete)\s*\(/i.exec(src);
  if (m) {
    const method = HTTP_METHODS[m[1].toLowerCase()] || 'GET';
    // Keep the opening paren so balanced() starts at index 0.
    const after = src.slice(m.index + m[0].length - 1);
    const argsSrc = balanced(after, 0, '(', ')') || '';
    const args = splitArgs(argsSrc.replace(/^\(/, '').replace(/\)$/, ''));
    let url = args[0] !== undefined ? String(argValue(args[0]) ?? '') : '';
    const kw = kwArgs(args);
    const headers = normalizeHeaders(kw.headers);
    if (kw.params && typeof kw.params === 'object') {
      const qs = new URLSearchParams(kw.params).toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    const data = bodyFrom(kw);
    if (!url) throw new Error('python: no URL');
    return { url, method, headers, data: data === null ? null : JSON.stringify(data), kind: 'python' };
  }

  // urllib.request.Request(url, data=..., headers=..., method="POST")
  m = /urllib(?:\.request)?\s*\.\s*Request\s*\(/i.exec(src) || /urlopen\s*\(/i.exec(src);
  if (m) {
    const after = src.slice(m.index + m[0].length - 1);
    const argsSrc = balanced(after, 0, '(', ')') || '';
    const args = splitArgs(argsSrc.replace(/^\(/, '').replace(/\)$/, ''));
    let url = args[0] !== undefined ? String(argValue(args[0]) ?? '') : '';
    const kw = kwArgs(args);
    const headers = normalizeHeaders(kw.headers);
    let method = (kw.method || '').toUpperCase();
    let data = bodyFrom(kw);
    if (!method) method = data ? 'POST' : 'GET';
    if (!url) throw new Error('python: no URL');
    return { url, method, headers, data: data === null ? null : JSON.stringify(data), kind: 'python' };
  }

  throw new Error('No recognizable Python HTTP call');
}

// ---------- Node / JS ----------

export function looksLikeNode(text) {
  return /\b(fetch|axios)\s*\(/.test(text) || /require\s*\(\s*['"]https?/.test(text);
}

export function parseNodeSnippet(text) {
  const src = String(text || '');
  const syms = collectSymbols(src);
  const argValue = a => {
    const id = asIdentifier(a);
    if (id && syms.has(id)) return syms.get(id);
    const sm = /^(['"`])([\s\S]*)\1$/.exec(String(a || '').trim());
    if (sm) return sm[2];
    return undefined;
  };

  // fetch(url, { method, headers, body })
  let m = /\b(?:await\s+)?fetch\s*\(/.exec(src);
  if (m) {
    const after = src.slice(m.index + m[0].length - 1);
    const argsSrc = balanced(after, 0, '(', ')') || '';
    const args = splitArgs(argsSrc.replace(/^\(/, '').replace(/\)$/, ''));
    const url = args[0] !== undefined ? String(argValue(args[0]) ?? '') : '';
    // options object may be inline or a variable
    let opts = {};
    args.slice(1).forEach(a => {
      const t = a.trim();
      const id = asIdentifier(t);
      if (id && syms.has(id)) {
        const v = syms.get(id);
        if (v && typeof v === 'object') opts = { ...opts, ...v };
        return;
      }
      if (t[0] === '{') { Object.assign(opts, parseFetchOptions(t, syms)); return; }
      Object.assign(opts, kwargs(t, syms));
    });
    const headers = normalizeHeaders(opts.headers);
    const method = (opts.method || (opts.body ? 'POST' : 'GET')).toUpperCase();
    const data = bodyFrom(opts);
    if (!url) throw new Error('node: no URL');
    return { url, method, headers, data: data === null ? null : JSON.stringify(data), kind: 'node' };
  }

  // axios.post(url, body, { headers })
  m = /\baxios\s*\.\s*(get|post|put|patch|delete)\s*\(/.exec(src);
  if (m) {
    const method = HTTP_METHODS[m[1].toLowerCase()] || 'GET';
    const after = src.slice(m.index + m[0].length - 1);
    const argsSrc = balanced(after, 0, '(', ')') || '';
    const args = splitArgs(argsSrc.replace(/^\(/, '').replace(/\)$/, ''));
    const url = args[0] !== undefined ? String(argValue(args[0]) ?? '') : '';
    let data = null;
    let headers = {};
    args.slice(1).forEach(a => {
      const t = a.trim();
      const id = asIdentifier(t);
      const lit = id && syms.has(id) ? syms.get(id) : (() => {
        const s2 = t[0];
        if (s2 !== '{' && s2 !== '[') return null;
        return parseLiteral(balanced(t, 0, s2, s2 === '{' ? '}' : ']') || '{}');
      })();
      if (lit && typeof lit === 'object') {
        if (lit.headers) headers = normalizeHeaders(lit.headers);
        else if (data === null) data = lit;
      } else {
        const sm = /^(['"`])([\s\S]*?)\1/.exec(t);
        if (sm) { try { data = JSON.parse(sm[2]); } catch { data = null; } }
      }
    });
    if (!url) throw new Error('node: no URL');
    return { url, method, headers, data: data === null ? null : JSON.stringify(data), kind: 'node' };
  }

  throw new Error('No recognizable Node HTTP call');
}

// ---------- OpenAI-compatible SDK snippets ----------
//
//   from openai import OpenAI
//   client = OpenAI(base_url="https://integrate.api.nvidia.com/v1", api_key="nvapi-…")
//   client.chat.completions.create(model="z-ai/glm-5.3", messages=[...])
//
// These carry NO url — the base lives in the client construction. That is the
// caveat: when no base_url is present we fall back to a per-provider default
// and the caller is told we guessed, because a wrong guess posts to the wrong
// host. Nothing is executed.

export function looksLikeSdk(text) {
  return /(?:from\s+openai\s+import|require\(\s*['"]openai['"]\s*\))/.test(text)
    || /\.chat\.completions\.create\s*\(/.test(text);
}

const SDK_BASE_DEFAULTS = {
  openai: 'https://api.openai.com/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  deepseek: 'https://api.deepseek.com/v1',
  ollama: 'http://localhost:11434/v1',
};

export function parseSdkSnippet(text) {
  const src = String(text || '');

  // Base URL: explicit first, then any literal URL in the file, then a guess.
  // Accepts Python (base_url="…") and JS ({ baseURL: '…' }) spellings.
  let base = null;
  let guessed = false;
  let alreadyFull = false;
  const explicit = /(?:base_url|baseURL|api_base|apiBase)\s*[=:]\s*['"]([^'"]+)['"]/.exec(src);
  if (explicit) {
    base = explicit[1].trim().replace(/\/+$/, '');
  } else {
    const anyUrl = /['"](https?:\/\/[^'"]+)['"]/.exec(src);
    if (anyUrl) base = anyUrl[1].trim().replace(/\/+$/, '');
    else { base = SDK_BASE_DEFAULTS.openai; guessed = true; }
  }
  if (/\/chat\/completions$/.test(base)) alreadyFull = true;
  else if (!/\/v\d+$/.test(base)) base += '/v1';

  // The call itself.
  const m = /\.chat\.completions\.create\s*\(/.exec(src);
  if (!m) throw new Error('sdk: no chat.completions.create call');
  const after = src.slice(m.index + m[0].length - 1);
  const argsSrc = balanced(after, 0, '(', ')') || '';
  const args = splitArgs(argsSrc.replace(/^\(/, '').replace(/\)$/, ''));
  const kw = Object.assign({}, ...args.map(a => kwargs(a, collectSymbols(src))));

  const body = {};
  if (kw.model !== undefined) body.model = kw.model;
  if (kw.messages !== undefined) body.messages = kw.messages;
  if (kw.temperature !== undefined) body.temperature = kw.temperature;
  if (kw.top_p !== undefined) body.top_p = kw.top_p;
  if (kw.max_tokens !== undefined) body.max_tokens = kw.max_tokens;
  if (kw.max_completion_tokens !== undefined) body.max_completion_tokens = kw.max_completion_tokens;
  if (kw.stream !== undefined) body.stream = kw.stream;
  if (typeof kw.stop === 'string' || Array.isArray(kw.stop)) body.stop = kw.stop;

  const headers = { 'Content-Type': 'application/json' };
  // A literal key is usable; an env reference (os.environ / process.env) is
  // not, so we omit the header and let the agent's provider key apply.
  const litKey = /(?:api_key|apiKey|API_KEY)\s*[=:]\s*['"]([^'"]+)['"]/.exec(src);
  if (litKey) headers['Authorization'] = `Bearer ${litKey[1]}`;

  return {
    url: alreadyFull ? base : base + '/chat/completions',
    method: 'POST',
    headers,
    data: JSON.stringify(body),
    kind: 'sdk',
    baseGuessed: guessed,
  };
}

// ---------- Dispatch ----------

/**
 * Parse any supported snippet into { url, method, headers, data }.
 * `data` is a JSON string (or null) so it matches parseCurl's output.
 */
export function parseSnippet(text) {
  const src = String(text || '');
  const errors = [];
  if (looksLikeSdk(src)) {
    try { return parseSdkSnippet(src); } catch (e) { errors.push(e.message); }
  }
  if (looksLikePython(src)) {
    try { return parsePythonSnippet(src); } catch (e) { errors.push(e.message); }
  }
  if (looksLikeNode(src)) {
    try { return parseNodeSnippet(src); } catch (e) { errors.push(e.message); }
  }
  try { return parseSdkSnippet(src); } catch (e) { errors.push(e.message); }
  try { return parsePythonSnippet(src); } catch (e) { errors.push(e.message); }
  try { return parseNodeSnippet(src); } catch (e) { errors.push(e.message); }
  throw new Error(errors[0] || 'Unrecognized snippet');
}

/** Which language a pasted snippet looks like, for UI feedback. */
export function snippetKind(text) {
  const src = String(text || '');
  if (/\bcurl\b/.test(src)) return 'curl';
  if (looksLikeSdk(src)) return 'sdk';
  if (looksLikePython(src)) return 'python';
  if (looksLikeNode(src)) return 'node';
  return null;
}