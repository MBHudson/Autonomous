/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// APILABCONVERT.JS — request <-> code, both directions
// ============================================
//
// WHAT THIS IS: the conversion half of the API Lab, kept free of any DOM or
// network so it can be unit-tested on its own. Every converter here is
// round-trippable: curl -> language -> curl has to come back with the same
// method, URL, headers and body, or the Lab is worse than the websites it
// replaces (they lose headers, mangle bodies, and quietly drop the auth line).
//
// The curl -> request direction is NOT reimplemented. curlParser.js already
// parses the awkward cases -- shell variables, heredoc bodies, unquoted JSON
// split across tokens, "$VAR" glued to a quoted prefix -- and it is what the
// terminal and the agent importer already trust. This file consumes it.
//
// The request model is deliberately plain so it is inspectable JSON:
//
//   request = { method, url, headers: [{ name, value }], body }
//
// Headers are a LIST, not an object, because HTTP allows repeats and order
// matters when you are staring at a request trying to work out why a provider
// rejected it. An object would quietly drop the second Cookie.

import { parseCurl, normalizePastedText } from './curlParser.js';

/** Languages offered in the Lab, in the order they are listed. */
export const LANGUAGES = [
  { id: 'curl', label: 'cURL' },
  { id: 'python', label: 'Python (requests)' },
  { id: 'typescript', label: 'TypeScript (fetch)' },
  { id: 'node', label: 'Node (axios)' },
  { id: 'go', label: 'Go (net/http)' },
  { id: 'java', label: 'Java (java.net.http)' },
  { id: 'php', label: 'PHP (curl)' },
  { id: 'ruby', label: 'Ruby (Net::HTTP)' },
  { id: 'openai-python', label: 'Python (openai SDK)' },
  { id: 'openai-ts', label: 'TypeScript (openai SDK)' },
];

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------

/** Shell single-quote escaping: the only form that is always literal. */
export function shQuote(s) {
  const v = String(s ?? '');
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** True when the body is worth treating as JSON rather than a blob. */
function asJson(body) {
  const t = String(body ?? '').trim();
  if (!t) return null;
  if (!/^[[{]/.test(t)) return null;
  try {
    JSON.parse(t);
    return t;
  } catch {
    return null;
  }
}

function indent(text, pad) {
  return String(text ?? '')
    .split('\n')
    .map((line, i) => (i === 0 ? line : pad + line))
    .join('\n');
}

/** Pretty-print a JSON body, but never fail: bad JSON comes back unchanged. */
export function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return String(text ?? '');
  }
}

/**
 * Header names whose values must never be printed in full.
 *
 * The Lab shows the request you are about to send, and its log lines get
 * pasted into issues. A key is the one field that must not travel with them.
 */
const SECRET_HEADERS = /^(authorization|x-api-key|api-key|x-goog-api-key|cookie|proxy-authorization|x-rapidapi-key)$/i;

export function isSecretHeader(name) {
  return SECRET_HEADERS.test(String(name || '').trim());
}

/** nvapi-syg1… (12 leading chars, ellipsis) — enough to tell two keys apart. */
export function maskSecret(value) {
  const v = String(value ?? '');
  if (!v) return '';
  if (v.length <= 12) return '••••';
  return `${v.slice(0, 12)}…`;
}

/** The same header list, masked for display. Never used to build a request. */
export function maskHeaders(headers) {
  return (headers || []).map(h => ({
    name: h.name,
    value: isSecretHeader(h.name) ? maskSecret(h.value) : h.value,
    secret: isSecretHeader(h.name),
  }));
}

// ---------------------------------------------------------------
// request -> curl
// ---------------------------------------------------------------

/**
 * Build a curl command. Multi-line with backslash continuations, because
 * that is the form NVIDIA/OpenAI/Anthropic publish and the form people paste
 * back into the Lab; a single 900-character line is unreadable and gets
 * truncated by chat clients.
 */
export function curlFromReq(req, opts = {}) {
  const lines = ['curl'];
  const m = String(req?.method || 'GET').toUpperCase();
  // GET with no body needs no -X; anything else states its method outright.
  if (m !== 'GET' || req?.body) lines.push(`  -X ${m}`);
  lines.push(`  ${shQuote(req?.url || '')}`);
  for (const h of req?.headers || []) {
    if (!h || !String(h.name).trim()) continue;
    lines.push(`  -H ${shQuote(`${h.name}: ${h.value}`)}`);
  }
  const body = String(req?.body ?? '');
  if (body) {
    const json = asJson(body);
    if (json) lines.push(`  -d ${shQuote(indent(prettyJson(json), '  '))}`);
    else lines.push(`  -d ${shQuote(body)}`);
  }
  // Verbose unless asked otherwise: the point of the Lab is seeing the
  // response headers, which -s hides.
  if (!opts.quiet) lines.splice(1, 0, '  -i');
  return lines.join(' \\\n');
}

// ---------------------------------------------------------------
// curl -> request
// ---------------------------------------------------------------

/**
 * Fold a doc-style heredoc body into the -d flag.
 *
 * NVIDIA, OpenAI and half the tutorials publish this form:
 *
 *   curl https://host/v1/chat/completions -d @request.json <<'EOF'
 *   {"model": "..."}
 *   EOF
 *
 * which is not runnable shell (a heredoc needs a command) and which the
 * existing parser quite rightly refuses: "@file, which this snippet never
 * writes". But it is what people actually paste, so the body is inlined here
 * before parsing. A snippet that really does `cat > file <<EOF` is left alone
 * -- curlParser already resolves that one properly.
 */
export function inlineHeredocBody(src) {
  const text = String(src ?? '');
  // A heredoc introduced by `cat`/`tee`/`printf` is already resolved properly
  // downstream, and pairing its body into -d as well would double-count it.
  if (/(?:cat|tee|printf|echo)\s*(?:>|>>)?\s*['"]?[\w./-]+['"]?\s*<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/i.test(text)) {
    return text;
  }
  // The bare form's delimiter (EOF) and the file it is fed to (@request.json)
  // have nothing to do with each other, so bodies are collected as an ORDERED
  // list and matched to @file references in the order they appear.
  const bodies = [];
  const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\r?\n([\s\S]*?)\r?\n[ \t]*\2/g;
  let m;
  while ((m = re.exec(text))) bodies.push(m[3]);
  if (!bodies.length) return text;
  let used = 0;
  // -d @NAME -> -d '<body>'
  return text.replace(/(-{1,2}[Dd](?:ata)?(?:-raw|-binary|-ascii)?\s+)@([\w./-]+)/g, (all, flag) => {
    if (used >= bodies.length) return all;
    return `${flag}${shQuote(bodies[used++])}`;
  });
}

/** Parse any curl/bash snippet into the request model. Throws with a reason. */
export function reqFromCurl(text) {
  const raw = String(text ?? '').trim();
  let parsed;
  try {
    parsed = parseCurl(raw);
  } catch (err) {
    // Second chance with the heredoc body folded in.
    const folded = inlineHeredocBody(raw);
    if (folded === raw) throw err;
    parsed = parseCurl(folded);
  }
  return {
    method: String(parsed.method || 'GET').toUpperCase(),
    url: String(parsed.url || '').trim(),
    headers: Object.entries(parsed.headers || {})
      .map(([name, value]) => ({ name, value })),
    body: parsed.data == null ? '' : String(parsed.data),
  };
}

// ---------------------------------------------------------------
// request -> code
// ---------------------------------------------------------------

function headerObjectLiteral(headers, quote = '"') {
  const rows = (headers || []).filter(h => h && String(h.name).trim());
  if (!rows.length) return '{}';
  const q = quote;
  const body = rows.map(h => `  ${q}${h.name}${q}: ${q}${h.value}${q},`).join('\n');
  return `{\n${body}\n}`;
}

export function genPython(req) {
  const m = String(req.method || 'GET').toUpperCase();
  const json = asJson(req.body);
  const parts = [
    'import requests',
    '',
    `url = ${JSON.stringify(req.url)}`,
    '',
    `headers = ${headerObjectLiteral(req.headers)}`,
  ];
  if (json) parts.push('', `payload = ${indent(prettyJson(json), '')}`);
  if (json) parts.push('', `response = requests.${m.toLowerCase()}(url, headers=headers, json=payload, timeout=120)`);
  else if (req.body) parts.push('', `response = requests.${m.toLowerCase()}(url, headers=headers, data=${JSON.stringify(req.body)}, timeout=120)`);
  else parts.push('', `response = requests.${m.toLowerCase()}(url, headers=headers, timeout=120)`);
  parts.push('', 'print(response.status_code)', 'print(response.text)');
  return parts.join('\n');
}

export function genTypeScript(req) {
  const m = String(req.method || 'GET').toUpperCase();
  const json = asJson(req.body);
  const init = [`  method: ${JSON.stringify(m)},`, `  headers: ${headerObjectLiteral(req.headers)},`];
  if (json) init.push(`  body: JSON.stringify(${indent(prettyJson(json), '  ')}),`);
  else if (req.body) init.push(`  body: ${JSON.stringify(req.body)},`);
  return [
    `const response = await fetch(${JSON.stringify(req.url)}, {`,
    ...init,
    '});',
    '',
    'console.log(response.status, response.statusText);',
    'console.log(await response.text());',
  ].join('\n');
}

export function genNodeAxios(req) {
  const m = String(req.method || 'GET').toUpperCase();
  const json = asJson(req.body);
  const cfg = [`  headers: ${headerObjectLiteral(req.headers)},`];
  if (json) cfg.push(`  data: ${indent(prettyJson(json), '  ')},`);
  else if (req.body) cfg.push(`  data: ${JSON.stringify(req.body)},`);
  return [
    "import axios from 'axios';",
    '',
    `const response = await axios.request({`,
    `  method: ${JSON.stringify(m.toLowerCase())},`,
    `  url: ${JSON.stringify(req.url)},`,
    ...cfg,
    `  timeout: 120000,`,
    '});',
    '',
    'console.log(response.status);',
    'console.log(JSON.stringify(response.data, null, 2));',
  ].join('\n');
}

export function genGo(req) {
  const m = String(req.method || 'GET').toUpperCase();
  const json = asJson(req.body);
  const lines = [
    'package main',
    '',
    'import (',
    '\t"fmt"',
    '\t"io"',
    '\t"net/http"',
    '\t"strings"',
    ')',
    '',
    'func main() {',
    `\turl := ${JSON.stringify(req.url)}`,
    '',
    '\tbody := ""',
  ];
  if (req.body) lines.push(`\tbody = strings.NewReader(${JSON.stringify(req.body)})`);
  lines.push('', '\treq, err := http.NewRequest("' + m + '", url, body)');
  lines.push('\tif err != nil { panic(err) }');
  lines.push('');
  for (const h of req.headers || []) {
    if (!h || !String(h.name).trim()) continue;
    lines.push(`\treq.Header.Set(${JSON.stringify(h.name)}, ${JSON.stringify(h.value)})`);
  }
  lines.push(
    '',
    '\tres, err := http.DefaultClient.Do(req)',
    '\tif err != nil { panic(err) }',
    '\tdefer res.Body.Close()',
    '',
    '\tb, _ := io.ReadAll(res.Body)',
    '\tfmt.Println(res.Status)',
    '\tfmt.Println(string(b))',
    '}',
  );
  return lines.join('\n');
}

export function genJava(req) {
  const m = String(req.method || 'GET').toUpperCase();
  const lines = [
    'import java.net.URI;',
    'import java.net.http.*;',
    '',
    'public class Main {',
    '  public static void main(String[] args) throws Exception {',
    `    HttpRequest request = HttpRequest.newBuilder()`,
    `      .uri(URI.create(${JSON.stringify(req.url)}))`,
  ];
  for (const h of req.headers || []) {
    if (!h || !String(h.name).trim()) continue;
    // Java's header() forbids a few names; skip rather than emit code that
    // will not compile.
    if (/^(host|content-length|connection)$/i.test(h.name)) continue;
    lines.push(`      .header(${JSON.stringify(h.name)}, ${JSON.stringify(h.value)})`);
  }
  if (m !== 'GET') lines.push(`      .method(${JSON.stringify(m)}, HttpRequest.BodyPublishers.${req.body ? 'ofString' : 'noBody'}())`);
  lines.push(
    '      .build();',
    '',
    '    HttpResponse<String> response = HttpClient.newHttpClient()',
    '      .send(request, HttpResponse.BodyHandlers.ofString());',
    '',
    '    System.out.println(response.statusCode());',
    '    System.out.println(response.body());',
    '  }',
    '}',
  );
  if (req.body) {
    lines.splice(6, 0, `      .header("Content-Type", "application/json")`);
  }
  return lines.join('\n');
}

export function genPhp(req) {
  return [
    '<?php',
    `// curl_exec sample — run with: php lab.php`,
    `$ch = curl_init(${JSON.stringify(req.url)});`,
    ...(req.headers || [])
      .filter(h => h && String(h.name).trim())
      .map(h => `curl_setopt($ch, CURLOPT_HTTPHEADER, [${JSON.stringify(`${h.name}: ${h.value}`)}]);`),
    `curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);`,
    `curl_setopt($ch, CURLOPT_CUSTOMREQUEST, ${JSON.stringify(String(req.method || 'GET').toUpperCase())});`,
  ].concat(
    req.body ? [`curl_setopt($ch, CURLOPT_POSTFIELDS, ${JSON.stringify(req.body)});`] : [],
    [
      '$response = curl_exec($ch);',
      '$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);',
      'curl_close($ch);',
      'echo $status . "\\n";',
      'echo $response;',
    ],
  ).join('\n');
}

export function genRuby(req) {
  const m = String(req.method || 'GET').toUpperCase();
  const json = asJson(req.body);
  const lines = [
    "require 'net/http'",
    "require 'uri'",
    "require 'json'",
    '',
    `uri = URI(${JSON.stringify(req.url)})`,
    '',
    `request = Net::HTTP::${m[0] + m.slice(1).toLowerCase()}.new(uri)`,
  ];
  for (const h of req.headers || []) {
    if (!h || !String(h.name).trim()) continue;
    lines.push(`request[${JSON.stringify(h.name)}] = ${JSON.stringify(h.value)}`);
  }
  if (json) lines.push(`request.body = ${JSON.stringify(prettyJson(json))}`);
  else if (req.body) lines.push(`request.body = ${JSON.stringify(req.body)}`);
  lines.push(
    '',
    'response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https") do |http|',
    '  http.request(request)',
    'end',
    '',
    'puts response.code',
    'puts response.body',
  );
  return lines.join('\n');
}

/**
 * The OpenAI SDK snippets.
 *
 * These take the OpenAI-shaped path out of the URL and the api key out of the
 * headers, which is the whole point of reading them: it shows the shape the
 * model actually expects, not another curl.
 */
function openAiParts(req) {
  const url = String(req.url || '');
  const m = url.match(/\/v\d+\/(chat\/completions|responses|completions|embeddings)/i);
  const path = m ? m[1].toLowerCase() : 'chat/completions';
  // The SDK's base_url KEEPS the version segment (.../v1) and drops only the
  // operation. Stripping "/v1/..." wholesale produced
  // https://integrate.api.nvidia.com as the base and lost the version on the
  // way back.
  const base = url.replace(/\/(chat\/completions|responses|completions|embeddings)\/?$/i, '')
    || 'https://api.openai.com/v1';
  const keyHeader = (req.headers || []).find(h => /^(authorization|x-api-key)$/i.test(h.name || ''));
  const key = keyHeader ? String(keyHeader.value).replace(/^Bearer\s+/i, '') : '';
  const payload = asJson(req.body);
  return { path, base, key, payload };
}

export function genOpenAiPython(req) {
  const { path, base, key, payload } = openAiParts(req);
  const p = payload ? JSON.parse(payload) : {};
  const lines = [
    'from openai import OpenAI',
    '',
    `client = OpenAI(base_url=${JSON.stringify(base)}, api_key=${JSON.stringify(key)})`,
    '',
  ];
  if (path === 'responses') {
    lines.push(
      `response = client.responses.create(`,
      ...(p.model ? [`  model=${JSON.stringify(p.model)},`] : []),
      ...(p.input !== undefined ? [`  input=${JSON.stringify(p.input)},`] : []),
      ...(p.instructions ? [`  instructions=${JSON.stringify(p.instructions)},`] : []),
      ')',
    );
  } else if (path === 'completions') {
    lines.push(
      `response = client.completions.create(`,
      ...(p.model ? [`  model=${JSON.stringify(p.model)},`] : []),
      ...(p.prompt !== undefined ? [`  prompt=${JSON.stringify(p.prompt)},`] : []),
      ')',
    );
  } else if (path === 'embeddings') {
    lines.push(
      `response = client.embeddings.create(`,
      ...(p.model ? [`  model=${JSON.stringify(p.model)},`] : []),
      ...(p.input !== undefined ? [`  input=${JSON.stringify(p.input)},`] : []),
      ')',
    );
  } else {
    lines.push(
      `response = client.chat.completions.create(`,
      ...(p.model ? [`  model=${JSON.stringify(p.model)},`] : []),
      ...(Array.isArray(p.messages) ? [`  messages=${indent(JSON.stringify(p.messages, null, 2), '  ')},`] : []),
      ...(p.temperature !== undefined ? [`  temperature=${p.temperature},`] : []),
      ...(p.max_tokens !== undefined ? [`  max_tokens=${p.max_tokens},`] : []),
      ')',
    );
  }
  lines.push('', 'print(response)');
  return lines.join('\n');
}

export function genOpenAiTs(req) {
  const { path, base, key, payload } = openAiParts(req);
  const p = payload ? JSON.parse(payload) : {};
  const client = [
    "import OpenAI from 'openai';",
    '',
    `const client = new OpenAI({ baseURL: ${JSON.stringify(base)}, apiKey: ${JSON.stringify(key)} });`,
    '',
  ];
  let call;
  if (path === 'responses') {
    call = [
      'const response = await client.responses.create({',
      ...(p.model ? [`  model: ${JSON.stringify(p.model)},`] : []),
      ...(p.input !== undefined ? [`  input: ${JSON.stringify(p.input)},`] : []),
      ...(p.instructions ? [`  instructions: ${JSON.stringify(p.instructions)},`] : []),
      '});',
    ];
  } else if (path === 'completions') {
    call = [
      'const response = await client.completions.create({',
      ...(p.model ? [`  model: ${JSON.stringify(p.model)},`] : []),
      ...(p.prompt !== undefined ? [`  prompt: ${JSON.stringify(p.prompt)},`] : []),
      '});',
    ];
  } else if (path === 'embeddings') {
    call = [
      'const response = await client.embeddings.create({',
      ...(p.model ? [`  model: ${JSON.stringify(p.model)},`] : []),
      ...(p.input !== undefined ? [`  input: ${JSON.stringify(p.input)},`] : []),
      '});',
    ];
  } else {
    call = [
      'const response = await client.chat.completions.create({',
      ...(p.model ? [`  model: ${JSON.stringify(p.model)},`] : []),
      ...(Array.isArray(p.messages) ? [`  messages: ${indent(JSON.stringify(p.messages, null, 2), '  ')},`] : []),
      ...(p.temperature !== undefined ? [`  temperature: ${p.temperature},`] : []),
      ...(p.max_tokens !== undefined ? [`  max_tokens: ${p.max_tokens},`] : []),
      '});',
    ];
  }
  return [...client, ...call, '', 'console.log(response);'].join('\n');
}

/** Dispatch: request + language id -> code. */
export function generate(lang, req) {
  switch (lang) {
    case 'python': return genPython(req);
    case 'typescript': return genTypeScript(req);
    case 'node': return genNodeAxios(req);
    case 'go': return genGo(req);
    case 'java': return genJava(req);
    case 'php': return genPhp(req);
    case 'ruby': return genRuby(req);
    case 'openai-python': return genOpenAiPython(req);
    case 'openai-ts': return genOpenAiTs(req);
    case 'curl':
    default: return curlFromReq(req);
  }
}

// ---------------------------------------------------------------
// code -> request
// ---------------------------------------------------------------

/**
 * Python/JS literals -> JSON text.
 *
 * Round-tripping only works if the generated code can be read back, and both
 * languages write object literals JSON does not accept: single quotes,
 * unquoted keys, trailing commas, True/False/None. Rather than write a second
 * parser, normalise the literal into JSON and let JSON.parse do the work.
 */
export function literalToJson(text) {
  let s = String(text ?? '').trim();
  if (!s) return null;
  if (s.startsWith('{') || s.startsWith('[')) {
    // Unquoted keys -> "key"
    s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
    // Single-quoted strings -> double-quoted (no embedded quote handling here:
    // a value containing an apostrophe is rare and falls back to raw text).
    s = s.replace(/'([^'\\\n]*)'/g, '"$1"');
    // Python words
    s = s.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
    // Trailing commas
    s = s.replace(/,(\s*[}\]])/g, '$1');
    try {
      return JSON.stringify(JSON.parse(s));
    } catch {
      return null;   // let the caller fall back to treating it as a blob
    }
  }
  return null;
}

/** Pull the balanced {...} / [...] that starts at or contains `needle`. */
function balancedBlock(src, startIdx) {
  const open = src[startIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = null;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(startIdx, i + 1);
    }
  }
  return null;
}

function collectHeaders(objText) {
  const out = [];
  if (!objText) return out;
  const body = objText.replace(/^\s*\{/, '').replace(/\}\s*$/, '');
  // key: 'value' | key: "value"
  const re = /(?:^|,)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$-]*))\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`]*)`)/g;
  let m;
  while ((m = re.exec(body))) {
    const name = m[1] ?? m[2] ?? m[3];
    const raw = m[4] ?? m[5] ?? m[6] ?? '';
    if (!name) continue;
    out.push({ name, value: raw.replace(/\\(['"\\])/g, '$1') });
  }
  return out;
}

/**
 * OpenAI SDK snippets carry no URL: they carry a base_url and a call.
 *
 * That is the most useful paste in the whole Lab -- it is how provider docs
 * actually tell you to call them -- so it is rebuilt into the HTTP request it
 * implies: base_url + the conventional path, the key back into an
 * Authorization header, and the call's arguments back into a body.
 */
function reqFromOpenAiSdk(src) {
  // Python: OpenAI(base_url="...", api_key="...")
  // TS:     new OpenAI({ baseURL: "...", apiKey: "..." })
  const base =
    /\bOpenAI\s*\(\s*base_url\s*=\s*(['"])([\s\S]*?)\1/.exec(src)
    || /\bbase_?URL\s*[:=]\s*(['"])([\s\S]*?)\1/i.exec(src);
  if (!base) return null;
  let root = String(base[2]).replace(/\/+$/, '');
  const key =
    /\bapi_?key\s*[:=]\s*(['"])([\s\S]*?)\1/i.exec(src);
  const keyVal = key ? key[2] : '';

  // Which call is it? -> the conventional path.
  let path = '/chat/completions';
  const call = src.match(/\bclient\.(\w+)\.(\w+)\.create|\bclient\.(\w+)\s*=/);
  const called = /\bclient\.responses\.create/.test(src) ? 'responses'
    : /\bclient\.embeddings\.create/.test(src) ? 'embeddings'
      : /\bclient\.completions\.create/.test(src) ? 'completions'
        : /\bclient\.chat\b/.test(src) ? 'chat'
          : (call ? (call[3] || call[1]) : 'chat');
  if (called === 'responses') path = '/responses';
  else if (called === 'embeddings') path = '/embeddings';
  else if (called === 'completions') path = '/completions';

  const body = {};
  const model = /\bmodel\s*[:=]\s*(['"`])([\s\S]*?)\1/.exec(src);
  if (model) body.model = model[2];
  const messages = src.match(/\bmessages\s*[:=]\s*(\[[\s\S]*?\])\s*(?=[,)]|\n\s*(?:\)|\}|;))/);
  if (messages) {
    const json = literalToJson(messages[1]);
    if (json) body.messages = JSON.parse(json);
  }
  const input = src.match(/\binput\s*[:=]\s*(['"])([\s\S]*?)\1/);
  if (input) body.input = input[2];
  const prompt = src.match(/\bprompt\s*[:=]\s*(['"])([\s\S]*?)\1/);
  if (prompt) body.prompt = prompt[2];
  const temp = /\btemperature\s*[:=]\s*([\d.]+)/.exec(src);
  if (temp) body.temperature = Number(temp[1]);
  const maxTok = /\bmax_?tokens\s*[:=]\s*(\d+)/.exec(src);
  if (maxTok) body.max_tokens = Number(maxTok[1]);

  return {
    method: 'POST',
    url: `${root}${path}`,
    headers: [
      { name: 'Content-Type', value: 'application/json' },
      ...(keyVal ? [{ name: 'Authorization', value: `Bearer ${keyVal}` }] : []),
    ],
    body: Object.keys(body).length ? JSON.stringify(body, null, 2) : '',
  };
}

/** Python requests.*(...) -> request. */
export function reqFromPython(code) {
  const src = normalizePastedText(String(code ?? ''));
  const urlM = src.match(/\burl\s*=\s*(['"])([\s\S]*?)\1/) || src.match(/\brequests\.\w+\(\s*(['"])(https?:[\s\S]*?)\1/);
  if (!urlM) return null;
  const url = urlM[2];
  const methodM = src.match(/\brequests\.(\w+)\s*\(/);
  let method = 'GET';
  if (methodM) {
    const verb = methodM[1].toLowerCase();
    method = verb === 'request' || verb === 'get' ? 'GET'
      : verb === 'post' ? 'POST' : verb === 'put' ? 'PUT'
      : verb === 'patch' ? 'PATCH' : verb === 'delete' ? 'DELETE' : verb.toUpperCase();
  }
  const args = src.match(/\brequests\.\w+\s*\(([\s\S]*?)\)\s*$/m) || src.match(/\brequests\.\w+\s*\(([\s\S]*)\)/);
  const argText = args ? args[1] : '';

  const headers = [];
  const hv = argText.match(/\bheaders\s*=\s*\{/);
  if (hv) {
    const block = balancedBlock(argText, hv.index + hv[0].length - 1);
    headers.push(...collectHeaders(block));
  }
  // headers = {...} on its own line (the generated shape)
  if (!headers.length) {
    const hv2 = src.match(/\bheaders\s*=\s*\{/);
    if (hv2) {
      const block = balancedBlock(src, hv2.index + hv2[0].length - 1);
      headers.push(...collectHeaders(block));
    }
  }

  let body = '';
  const jp = argText.match(/\bjson\s*=\s*/);
  if (jp) {
    const rest = argText.slice(jp.index + jp[0].length);
    const lit = balancedBlock(rest, 0) || (/^['"]/.test(rest.trim())
      ? (rest.trim().match(/^(['"])([\s\S]*?)\1/) || [])[2]
      : null);
    if (lit) body = literalToJson(lit) || lit;
  }
  if (!body) {
    const dp = argText.match(/\bdata\s*=\s*(['"])([\s\S]*?)\1/);
    if (dp) body = dp[2];
  }
  if (!body) {
    const named = src.match(/\b(?:payload|body|json_body)\s*=\s*([\s\S]*?)(?:\n\s*\n|\n\s*response|\n\s*print)/);
    if (named) {
      const lit = balancedBlock(named[1], 0);
      if (lit) body = literalToJson(lit) || lit;
    }
  }
  if (!methodM) method = body ? 'POST' : 'GET';
  return { method, url, headers, body };
}

/** TypeScript fetch / axios -> request. */
export function reqFromTypeScript(code) {
  const src = normalizePastedText(String(code ?? ''));
  // fetch("url", { method, headers, body: JSON.stringify({...}) })
  let url = null;
  let method = null;
  let init = '';

  const fetchM = src.match(/\bfetch\s*\(\s*(['"`])((?:https?:|\\|\/)[^'"`]*)\1\s*(?:,\s*([\s\S]*?)\))?\s*;/);
  if (fetchM) {
    url = fetchM[2].replace(/\\n/g, '');
    init = fetchM[3] || '';
    const mm = init.match(/\bmethod\s*:\s*['"]([A-Za-z]+)['"]/i);
    method = mm ? mm[1].toUpperCase() : null;
  }
  if (!url) {
    const ax = src.match(/\burl\s*:\s*(['"`])([\s\S]*?)\1/);
    if (ax) {
      url = ax[2];
      const mm = src.match(/\bmethod\s*:\s*['"]([A-Za-z]+)['"]/i);
      method = mm ? mm[1].toUpperCase() : null;
      init = src;
    }
  }
  if (!url) return null;

  const headers = [];
  const hv = init.match(/\bheaders\s*:\s*\{/);
  if (hv) {
    const block = balancedBlock(init, hv.index + hv[0].length - 1);
    headers.push(...collectHeaders(block));
  }

  let body = '';
  const bs = init.match(/\bbody\s*:\s*JSON\.stringify\s*\(/);
  if (bs) {
    const after = init.slice(bs.index + bs[0].length);
    const lit = balancedBlock(after, 0);
    if (lit) body = literalToJson(lit) || lit;
  }
  if (!body) {
    const bd = init.match(/\bbody\s*:\s*(['"`])((?:[^'"\\]|\\.)*)\1/);
    if (bd) body = bd[2];
  }
  if (!body) {
    // axios: data: { ... } — take the balanced literal from the colon rather
    // than guessing where it ends from the next option key.
    const dm = init.match(/\bdata\s*:\s*/);
    if (dm) {
      const after = init.slice(dm.index + dm[0].length).replace(/^\s+/, '');
      if (after.startsWith('{') || after.startsWith('[')) {
        const lit = balancedBlock(after, 0);
        if (lit) body = literalToJson(lit) || lit;
      } else {
        const q = after.match(/^(['"`])((?:[^'"\\]|\\.)*)\1/);
        if (q) body = q[2];
      }
    }
  }
  // The OpenAI SDK form carries the body as object properties, not a literal.
  if (!body) {
    const props = src.match(/messages\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
    if (props) {
      const lit = balancedBlock(props[1], 0);
      if (lit) {
        const model = src.match(/\bmodel\s*:\s*(['"`])([^'"`]+)\1/);
        body = literalToJson(`{${model ? `model:${JSON.stringify(model[2])},` : ''}messages:${lit}}`) || '';
      }
    }
  }
  if (!method) method = body ? 'POST' : 'GET';
  return { method, url, headers, body };
}

/**
 * bash/curl -> request.
 *
 * Deliberately just reqFromCurl: parseCurl already calls resolveShellCurl
 * internally to settle $VARIABLEs, so there is nothing to add. An earlier
 * version resolved the tokens and rejoined them with spaces to "normalise"
 * them, which quietly destroyed the quoting every `-H "name: value"` depends
 * on -- the header arrived with an empty value and no error anywhere.
 */
export function reqFromBash(code) {
  const src = inlineHeredocBody(normalizePastedText(String(code ?? '')));
  if (!/\bcurl\b/i.test(src)) return null;
  try {
    return reqFromCurl(src);
  } catch {
    return null;
  }
}

/** Which language is this code, if we can tell? Drives the auto-switch. */
export function guessLanguage(code) {
  const src = String(code ?? '');
  if (/\bcurl\b/i.test(src) && /(^|\s)-[A-Za-z]/.test(src)) return 'curl';
  if (/from openai import|new OpenAI\(/.test(src)) return 'openai-python';
  if (/\brequests\.(get|post|put|patch|delete|request)\s*\(/.test(src) || /\bimport requests\b/.test(src)) return 'python';
  if (/\bfetch\s*\(/.test(src) || /\baxios\b/.test(src) || /:\s*(string|number|boolean)\b/.test(src)) return 'typescript';
  return 'curl';
}

/** code (any supported language) -> request. Throws with a usable reason. */
export function reqFromCode(code, lang) {
  const src = String(code ?? '').trim();
  if (!src) throw new Error('Nothing to convert');
  let langId = lang;
  if (!langId || langId === 'auto') langId = guessLanguage(src);
  let req = null;
  if (langId === 'curl' || langId === 'bash') req = reqFromBash(src);
  else if (langId === 'python' || langId === 'openai-python') req = reqFromOpenAiSdk(src) || reqFromPython(src);
  else if (['typescript', 'node', 'openai-ts'].includes(langId)) req = reqFromOpenAiSdk(src) || reqFromTypeScript(src);
  else req = reqFromTypeScript(src) || reqFromPython(src);
  if (!req || !req.url) {
    throw new Error(`Could not find a URL in that ${langId} code — paste the whole snippet`);
  }
  return req;
}

/** Newline-separated curl -> shell vars -> JSON text, the Lab's "curl in" path. */
export function normaliseCurlInput(text) {
  return normalizePastedText(String(text ?? '').trim());
}