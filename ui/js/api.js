/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// API.JS — PHP backend client
// ============================================

import { store } from './store.js?v=360';
import { acquire, note429 } from './rateGovernor.js?v=360';
import { latency } from './latency.js?v=360';
import { detectFamily } from './harness.js?v=360';
import { createNativeCallState, ingestNativeDelta, nativeCalls } from './nativeTools.js?v=360';

latency.bindStore(store);

// ============================================
// ERROR TEXT — never let an object become a message
// ============================================
//
// `new Error(obj)` stringifies the object to the literal "[object Object]",
// which is worse than no message at all: it hides the one thing the caller
// needs. Backends return nested shapes ({"error":{"message":..,"code":..}}),
// and several call sites passed such a value straight into `new Error()`.
// This walks to the first usable string so the reason survives.

export function errText(e, depth = 0) {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (typeof e !== 'object') return String(e);
  if (depth > 5) return '';
  if (typeof e.message === 'string') {
    const code = e.code || e.type || e.status;
    return code ? `${e.message} (${code})` : e.message;
  }
  for (const k of ['message', 'detail', 'error', 'reason', 'description']) {
    if (e[k] !== undefined && e[k] !== null) {
      const got = errText(e[k], depth + 1);
      if (got) return got;
    }
  }
  try {
    const s = JSON.stringify(e);
    return s && s !== '{}' ? s.slice(0, 300) : '';
  } catch { return ''; }
}

// Portable: works whether the page is served from ui/ or the router root,
// at any mount point. Strips optional index.html + optional trailing /ui.
const API_BASE = (() => {
  const p = window.location.pathname.replace(/\/?(index\.html)?$/, '');
  return p.replace(/\/ui\/?$/, '') + '/api';
})();

class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl || API_BASE;
  }

  /**
   * Retry-After arrives either as seconds ("120") or an HTTP date. Upstream
   * providers send seconds; either way this returns milliseconds or null.
   */
  _retryAfterMs(value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (/^\d+$/.test(s)) return Number(s) * 1000;
    const t = Date.parse(s);
    return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
  }

  /**
   * The token headers every call to our own API must carry.
   *
   * These three requests used to hand-roll their own `headers` object and so
   * sent neither token: audioSpeak, audioTranscribe and — the one that actually
   * mattered — relayStream. The server gates every endpoint, so the streaming
   * path (which chat.js tries FIRST for every agent) came back 401
   * "unauthorized", which surfaced as "Stream request failed (HTTP 401)" and
   * looked like every model on the server had gone down at once.
   *
   * Sent on EVERY request, not just the sandbox ones. Sending a custom header
   * is also what makes a cross-origin attempt fail preflight rather than
   * silently succeeding.
   */
  _authHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const read = key => {
      try { return store.get(key) || ''; } catch { return ''; }
    };
    const routerToken = read('settings.routerToken');
    if (routerToken) headers['X-Router-Token'] = routerToken;
    // Older server builds gate on the sandbox header name only.
    const sandboxToken = read('settings.sandboxToken');
    if (sandboxToken) headers['X-Sandbox-Token'] = sandboxToken;
    return headers;
  }

  async request(method, path, body, signal) {
    const url = `${this.baseUrl}${path}`;
    const options = {
      method,
      headers: this._authHeaders(),
    };

    if (signal) options.signal = signal;
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    const text = await res.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      // 401 means the access token is missing or wrong. That is a different
      // problem from every other failure and needs saying out loud, because
      // otherwise the whole UI just quietly stops working and looks like a
      // backend outage.
      if (res.status === 401) {
        try { store.emit('token:required'); } catch { /* no store */ }
      }
      // A non-JSON body (data.raw set) is almost always an HTML error page from
      // the web server, not our API. Never dump that wall of markup into the UI.
      const nonJson = data && data.raw !== undefined;
      const err = new Error(res.status === 401
        ? 'Access token required or wrong — set it in Config'
        : (errText(data.error)
            || (nonJson
              ? `API ${res.status}: the server sent a web page instead of JSON — check the app URL and API path`
              : `API ${res.status}`)));
      // Carry the status so callers can tell "slow down" (429) from "the key
      // is wrong, retrying is pointless" (401/403) instead of regex-matching
      // the message.
      err.status = res.status;
      err.retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      throw err;
    }

    // A call got through: whatever locked us out before is over. Hides the
    // API lock banner if a 401 showed it earlier.
    try {
      document.getElementById('apiLockedBanner')?.setAttribute('hidden', '');
    } catch { /* non-DOM context */ }

    return data;
  }

  // --- Models ---
  listModels() {
    return this.request('GET', '/models');
  }

  addModel(model) {
    return this.request('POST', '/models', model);
  }

  updateModel(id, data) {
    return this.request('PUT', `/models/${id}`, data);
  }

  deleteModel(id) {
    return this.request('DELETE', `/models/${id}`);
  }

  // --- Sessions ---
  listSessions() {
    return this.request('GET', '/sessions');
  }

  getSession(id) {
    return this.request('GET', `/sessions/${id}`);
  }

  createSession(title) {
    return this.request('POST', '/sessions', { title: title || 'New Session' });
  }

  updateSession(id, data) {
    return this.request('PUT', `/sessions/${id}`, data);
  }

  deleteSession(id) {
    return this.request('DELETE', `/sessions/${id}`);
  }

  closeSession(id) {
    return this.request('DELETE', `/sessions/close/${id}`);
  }

  // --- Query — the main chat endpoint ---
  async query(prompt, sessionId, excludeIds) {
    return this.request('POST', '/query', {
      prompt,
      session_id: sessionId,
      exclude: excludeIds || [],
    });
  }

  // --- Topology ---
  getTopology() {
    return this.request('GET', '/topology');
  }

  // --- Config ---
  getConfig() {
    return this.request('GET', '/config');
  }

  saveConfig(config) {
    // POST, not PUT: some hosts block or reroute PUT at the web-server level, so
    // the request never reaches the app and the site's own 404/405 page comes
    // back — which showed up as "Not saved: API 404: <html>…". The API accepts
    // POST for the same route.
    return this.request('POST', '/config', config);
  }

  // --- Shell execution ---
  /**
   * Run one command on the server. `argv` is an ARRAY on purpose: the endpoint
   * refuses a command string, because running one would need a shell and a
   * shell turns model output into arbitrary code.
   */
  execCommand(argv, opts = {}) {
    return this.request('POST', '/exec', {
      argv: (argv || []).map(String),
      cwd: opts.cwd || null,
      timeout: opts.timeout || null,
      max_bytes: opts.maxBytes || null,
      // Who asked. The audit line is the only record a command ran at all, so
      // without this the log can say WHAT ran but never WHOSE turn it was.
      agent: opts.agent || null,
    });
  }

  /**
   * Read back storage/exec.log, parsed server-side.
   *
   * `lines` bounds how far back to look; `agent` narrows to one agent's runs for
   * the per-agent drawer. Read-only: this never writes or clears the log.
   */
  execLog(opts = {}) {
    return this.sandbox('exec-log', {
      lines: opts.lines || 300,
      agent: opts.agent || '',
    });
  }

  /**
   * Why can't the agents reach their providers?
   *
   * The browser can only report "NetworkError", which hides whether the
   * machine has no route out, DNS failed, TLS was refused, or the provider
   * rejected the key. This asks the SERVER to test each one and name the
   * failing layer.
   */
  diagnoseProviders(providers) {
    return this.request('POST', '/diag', { providers: providers || [] });
  }

  /**
   * How this copy is being served, and whether it can answer more than one
   * request at a time.
   *
   * PHP's built-in server (start-php.bat) takes ONE request at a time: while a
   * streamed reply is open, the next agent's call waits outside in the kernel's
   * backlog, so a fan-out runs in single file and every agent looks hung until
   * the one ahead of it lands. That is the server, not the loop, and there is
   * nothing a page can do about it -- so the operator is told which server they
   * are on instead of being left to guess.
   *
   * Apache (start.bat) and php-fpm answer many at once and report nothing.
   */
  serverInfo() {
    return this.request('GET', '/diag');
  }

  /**
   * Run one request on the server and report exactly what came back.
   *
   * Server-side because the browser cannot: NVIDIA, Anthropic and plenty of
   * other hosts send no CORS headers, so a fetch() from the page dies before
   * the reply is readable and the browser's error names nothing useful.
   */
  labRequest({ method, url, headers, body, timeoutSec }) {
    return this.request('POST', '/lab', { method, url, headers, body, timeoutSec });
  }

  execAllowlist() {
    return this.request('GET', '/exec/allowlist');
  }

  execPending() {
    return this.request('GET', '/exec/pending');
  }

  /** decision: 'once' | 'always' | 'deny' */
  execDecide(id, decision) {
    return this.request('POST', '/exec/decide', { id, decision });
  }

  // --- Updates ---
  //
  // Two halves. Downloading fetches the published release into storage/updates,
  // verifies it and diffs it against the app without touching a single app
  // file. Installing is a separate, explicit call, and it is the only thing in
  // the client that can replace a file on the server.
  updateStatus() {
    return this.request('GET', '/update');
  }

  // The cheap probe: reads only the published ui/js/store.js and compares its
  // APP_VERSION with this copy's. The server caches the answer, so calling
  // this on every page load is one small request and usually no network at all.
  // It reports THAT a newer release exists, never what changed inside one.
  updateCheck() {
    return this.request('GET', '/update/check');
  }

  // Force a fresh probe. "Check now" in Config uses this, so a hand-pressed
  // check never returns a cached answer.
  updateCheckNow() {
    return this.request('POST', '/update/check', {});
  }

  updateDownload() {
    return this.request('POST', '/update/download', {});
  }

  updateDiscard() {
    return this.request('POST', '/update/discard', {});
  }

  // A rollback copy of the current tree in storage/backups. Taken
  // automatically by install, but offered on its own so it can be made (and
  // copied somewhere else) before anything is replaced.
  updateBackup() {
    return this.request('POST', '/update/backup', {});
  }

  // Replaces the app files with the staged release. The fourth argument of
  // request() is an AbortSignal, not an options bag, so there is deliberately
  // none here: an install that the browser abandoned halfway is the one
  // outcome this feature must not produce.
  updateInstall() {
    return this.request('POST', '/update/install', {});
  }

  // Undo: restores a copy from storage/backups. With no argument the server
  // picks the newest one, which is what the button after a failed install does.
  updateRollback(dir) {
    return this.request('POST', '/update/rollback', dir ? { dir } : {});
  }

  // Phase, preflight and the tail of storage/updates/install.log.
  updateState() {
    return this.request('GET', '/update/state');
  }

  // Swaps in files an install had to defer because the server was executing
  // them. Usually unnecessary — a detached finisher does it a second after the
  // install returns — but on a host where spawning a process is disabled this
  // is the step that closes the gap. It may 404: during the window when
  // api/index.php is the one file still waiting, the OLD api answers.
  updateFinish() {
    return this.request('POST', '/update/finish', {});
  }

  // --- Export ---
  exportSession(id) {
    return this.request('GET', `/export/${id}`);
  }

  // --- Proxy ---
  getProxies() {
    return this.request('GET', '/proxies');
  }

  pingProxy(ip, port) {
    return this.request('POST', '/proxy-ping', { ip, port });
  }

  /**
   * Ping a whole list in ONE request.
   *
   * The per-proxy call is still there for testing a single row, but sweeping
   * 255 of them one request at a time took up to 64 minutes against a 15s
   * timeout, which looked like a dead button. This runs them concurrently.
   */
  pingProxiesBatch(proxies) {
    return this.request('POST', '/proxy-ping-all', { proxies });
  }

  getActiveProxy() {
    return this.request('GET', '/proxy-active');
  }

  /** @param {string} proxy host:port, or '' to stop routing through a proxy. */
  setActiveProxy(proxy) {
    return this.request('PUT', '/proxy-active', { proxy });
  }

  // --- Cross-device state bundle ---
  // The whole per-copy bundle (agents, providers, settings, memory, …) so two
  // devices opening the same install see the same thing.
  getState() {
    return this.request('GET', '/state');
  }

  /**
   * Cheap "has anything changed?" check. The server compares revisions and
   * answers with a handful of bytes when nothing has, so polling costs almost
   * nothing. Pass rev to get the full bundle back only when it moved.
   */
  getStateSince(rev) {
    return this.request('GET', `/state?rev=${encodeURIComponent(rev)}`);
  }

  saveState(state) {
    // POST, not PUT: some hosts block or reroute PUT at the web-server level, so
    // the request never reaches the app and the site's own 404 page comes back.
    // The API accepts POST for the same route.
    return this.request('POST', '/state', { state });
  }

  // --- Full backup & restore ---
  // downloadBackup returns the whole copy (state bundle, every session file,
  // config incl. allow/deny lists and token, approval grants) as one JSON
  // object for the caller to save to disk. importBackup posts such an object
  // back; the server replaces everything (true restore semantics).
  downloadBackup() {
    return this.request('GET', '/backup');
  }

  importBackup(backup) {
    return this.request('POST', '/import', { backup });
  }

  // --- Sandbox: server-side search / fetch / filesystem ---
  // getSandboxStatus reads whether anything is configured; every other action
  // is a POST so long queries and file contents travel in the body.
  getSandboxStatus() {
    return this.request('GET', '/sandbox/status');
  }

  /**
   * Sends the sandbox token when one is configured. Set it in Settings →
   * Sandbox (or storage/config.json under "sandbox") if the install is
   * reachable by anyone but you — the API allows cross-origin POSTs.
   */
  sandbox(action, params, signal) {
    const token = store.get('settings.sandboxToken');
    if (token) {
      return fetch(`${this.baseUrl}/sandbox/${action}`, {
        method: 'POST',
        headers: this._authHeaders(),
        body: JSON.stringify(params || {}),
        signal,
      }).then(async res => {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (!res.ok) throw new Error(errText(data.error) || `API ${res.status}`);
        return data;
      });
    }
    return this.request('POST', `/sandbox/${action}`, params || {}, signal);
  }

  // --- MCP: tools exposed by operator-configured MCP servers ---
  mcpServers() { return this.request('GET', '/mcp/servers'); }
  mcpStatus() { return this.request('GET', '/mcp/status'); }
  mcpSaveServers(servers) { return this.request('POST', '/mcp/servers', { servers: servers || [] }); }
  mcpTools(server) { return this.request('POST', '/mcp/tools', { server }); }
  mcpCall(server, tool, args) {
    return this.request('POST', '/mcp/call', { server, tool, arguments: args || {} });
  }

  // --- MCP server (this app AS a server friends can connect to) ---
  mcpServerConfig() { return this.request('GET', '/mcp-server/config'); }
  mcpServerSave(config) { return this.request('POST', '/mcp-server/config', config || {}); }
  mcpActivity() { return this.request('GET', '/mcp-server/activity'); }

  // --- Browser (Config → Labs → Browser). Server-side gate: 403 when off. ---
  browserStatus() { return this.request('GET', '/browser/status'); }
  browserLaunch(headless) { return this.request('POST', '/browser/launch', { headless: !!headless }); }
  browserStop() { return this.request('POST', '/browser/stop', {}); }
  browserNavigate(url) { return this.request('POST', '/browser/navigate', { url }); }
  browserScreenshot() { return this.request('POST', '/browser/screenshot', {}); }
  browserClick(x, y) { return this.request('POST', '/browser/click', { x, y }); }
  browserType(text) { return this.request('POST', '/browser/type', { text }); }
  browserKey(key) { return this.request('POST', '/browser/key', { key }); }
  browserEval(expression) { return this.request('POST', '/browser/eval', { expression }); }
  browserRead() { return this.request('POST', '/browser/read', {}); }

  // --- Audio: speech synthesis and transcription, proxied server-side ---

  /** Providers that can do speech, with their voices and default models. */
  audioCapabilities() {
    return this.request('GET', '/audio/capabilities');
  }

  /**
   * Synthesize speech. Resolves to an audio Blob, not JSON, so this bypasses
   * request() and keeps the response type check out of the way.
   */
  async audioSpeak(spec, signal) {
    const res = await fetch(`${this.baseUrl}/audio/speak`, {
      method: 'POST',
      headers: this._authHeaders(),
      body: JSON.stringify(spec),
      signal,
    });
    if (!res.ok) {
      const msg = await res.json().then(d => d.error).catch(() => null);
      throw new Error(msg || `Speech request failed (HTTP ${res.status})`);
    }
    return await res.blob();
  }

  /** Transcribe a recorded clip. `form` carries the file plus provider fields. */
  async audioTranscribe(form, signal) {
    // FormData, so Content-Type is deliberately NOT set: the browser has to
    // supply the multipart boundary itself. The tokens still have to go, or
    // the gated endpoint turns the request away.
    const headers = this._authHeaders();
    delete headers['Content-Type'];
    const res = await fetch(`${this.baseUrl}/audio/transcribe`, {
      method: 'POST',
      headers,
      body: form,
      signal,
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(data.error || `Transcription failed (${res.status})`);
    return data.text;
  }

  // --- Server-side relay (for providers blocked by browser CORS) ---
  async relayCall(spec, signal) {
    // Timed for the topology's ping figures. A one-shot failure rides inside
    // HTTP 200, so success is read from the payload, not the status.
    const lat = latency.begin(spec?.agent_id, 'relay');
    try {
      const data = await this._relayCallCore(spec, signal, lat);
      lat.end(!!data?.success, data?.success ? null : new Error(errText(data?.error) || 'relay failed'));
      return data;
    } catch (err) {
      lat.end(false, err);
      throw err;
    }
  }

  async _relayCallCore(spec, signal, lat) {
    // Paced like every other model call: a burst of one-shot fallbacks spends
    // the same shared bucket as the streams do.
    const gov = await acquire(spec || {}, { signal });
    lat?.started();
    let data;
    try {
      data = await this.request('POST', '/llm', spec, signal);
    } catch (err) {
      if (Number(err?.status) === 429) { try { note429(gov.key, err.retryAfterMs); } catch {} }
      throw err;
    }
    // One-shot failures ride inside HTTP 200, so the status never throws.
    // Still teach the bucket: the next caller waits instead of refusing.
    if (!data?.success && Number(data?.status) === 429) {
      try { note429(gov.key, undefined); } catch {}
    }
    return data;
  }

  /**
   * Streaming relay. Consumes the SSE stream from POST /llm with stream:true
   * and calls onDelta / onReasoning as text arrives, so the reply can be
   * rendered token by token and cancelled while keeping whatever arrived.
   *
   * Chunks are OpenAI-compatible ({choices:[{delta:{content}}]}). Anything
   * that isn't parseable is still appended so no text is ever silently lost.
   * Token usage, when the provider sends it, is returned as `usage` — it
   * arrives on a final frame that carries no content.
   *
   * @returns {Promise<{content, reasoning, usage, finishReason, reasoningOnly}>}
   */
  async relayStream(spec, opts = {}) {
    // Timed for the topology's ping figures: total time from the governor slot
    // to the last frame, plus time to the first content/reasoning token.
    const lat = latency.begin(spec?.agent_id, 'stream');
    const { onDelta, onReasoning } = opts;
    try {
      const res = await this._relayStreamCore(spec, {
        ...opts,
        onDelta: (...a) => { lat.first(); return onDelta?.(...a); },
        onReasoning: (...a) => { lat.first(); return onReasoning?.(...a); },
      }, lat);
      lat.end(true);
      return res;
    } catch (err) {
      lat.end(false, err);
      throw err;
    }
  }

  async _relayStreamCore(spec, { onDelta, onReasoning, signal } = {}, lat = null) {
    // The single choke point: every streaming agent call waits for a slot on
    // its host+key bucket first, so a fan-out queues instead of 429ing.
    const gov = await acquire(spec || {}, { signal });
    lat?.started();
    const res = await fetch(`${this.baseUrl}/llm`, {
      method: 'POST',
      headers: this._authHeaders(),
      body: JSON.stringify({ ...spec, stream: true }),
      signal,
    });
    if (!res.ok || !res.body) {
      // Say WHICH 401 this is. The generic message below made a token problem
      // look like an upstream outage, which sent the hunt in the wrong
      // direction entirely — the models were fine, we were being turned away
      // at the door.
      if (res.status === 401) {
        try { store.emit('token:required'); } catch { /* no store */ }
        throw new Error('Access token required or wrong — set it in Config');
      }
      const detail = await res.text().catch(() => '');
      // The server's own "I can't reach the internet" (curl disabled) is a
      // setup problem, not a hiccup: show its message as-is and don't retry.
      let parsed = null;
      try { parsed = JSON.parse(detail); } catch { /* not JSON */ }
      if (parsed && parsed.code === 'curl_missing') {
        const e = new Error(String(parsed.error));
        e.status = res.status;
        e.retryable = false;
        throw e;
      }
      const err = new Error(`Stream request failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`);
      // Our own server almost always answers 200 here (upstream failures ride
      // inside the stream), but when it doesn't the status still decides
      // whether the caller waits or gives up.
      err.status = res.status;
      err.retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      const ra = this._retryAfterMs(res.headers?.get?.('Retry-After'));
      if (ra != null) err.retryAfterMs = ra;
      if (res.status === 429) { try { note429(gov.key, err.retryAfterMs); } catch {} }
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let sawDelta = false;
    let streamError = null;
    let usage = null;
    let finishReason = null;
    // Machine-readable half of a stream error. The SSE body carries the
    // provider's text, but the server re-emits the upstream HTTP status (and
    // Retry-After) as a structured frame AFTER the body frames, so the last
    // structured frame wins. Without this a 429 ("wait") and a 401 ("the key
    // is wrong") were the same anonymous string.
    const streamMeta = {};
    // Native tool calls arrive on their own stream frames, not in content.
    // Accumulate them even when no tools were requested; the state stays empty
    // and the caller simply sees toolCalls: [].
    const family = detectFamily(spec);
    const nativeState = createNativeCallState();

    const handleLine = line => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) return;
      const payloadText = trimmed.slice(5).trim();
      if (!payloadText || payloadText === '[DONE]') return;
      let obj;
      try { obj = JSON.parse(payloadText); } catch { return; }

      // The server reports an upstream failure (a curl timeout, a dropped
      // connection) as one of these frames. Without this the stream looks
      // like a successful reply that happened to be empty, and the caller
      // takes it as the model's final answer.
      if (obj && obj.error) {
        // Providers nest the useful text: {error:{message, type, code}} or
        // {error:{message:{...}}} on some relays. String() on an object gives
        // the literal text "[object Object]", which told the user nothing about
        // why the call failed. Walk down to the first string we find.
        streamError = (function describe(e, depth) {
          if (e == null) return 'unknown error';
          if (typeof e === 'string') return e;
          if (typeof e !== 'object') return String(e);
          if (depth > 4) return 'unknown error';
          if (typeof e.message === 'string') {
            const code = e.code || e.type || e.status;
            return code ? `${e.message} (${code})` : e.message;
          }
          for (const k of ['message', 'detail', 'error', 'reason', 'description']) {
            if (e[k] !== undefined && e[k] !== null) return describe(e[k], depth + 1);
          }
          try { return JSON.stringify(e).slice(0, 300); } catch { return 'unknown error'; }
        })(obj.error, 0);
        // Structured half, when the server sent it (see the status frames in
        // ModelManager::relayStream). The server frame comes after the body
        // frames, so the last one wins. An upstream body forwarded verbatim
        // has no top-level status/retryable keys, so it cannot poison this.
        const st = Number(obj.status ?? obj.httpStatus);
        if (Number.isFinite(st) && st > 0) streamMeta.status = st;
        if (typeof obj.retryable === 'boolean') streamMeta.retryable = obj.retryable;
        const raMs = Number(obj.retryAfterMs ?? obj.retry_after_ms);
        if (Number.isFinite(raMs) && raMs >= 0) streamMeta.retryAfterMs = raMs;
        return;
      }

      ingestNativeDelta(nativeState, obj, family);

      // finish_reason is the difference between "the model had nothing to say"
      // and "the model ran out of tokens mid-thought". Without it both look
      // like an empty reply. Read it BEFORE the usage branch below, because
      // some providers (Groq among them) put usage and finish_reason on the
      // same final frame and that branch returns early.
      const reason = obj.choices && obj.choices[0] && obj.choices[0].finish_reason;
      if (reason) finishReason = reason;

      // Usage arrives as a final frame with no choices, so it would otherwise
      // be dropped. Take the highest figures seen rather than summing, because
      // some providers repeat the running total on every chunk. `usage` is
      // still null at this point on the first frame, hence the guards.
      // Anthropic sends input tokens early, on the message_start event.
      if (obj.type === 'message_start' && obj.message && obj.message.usage) {
        const u = obj.message.usage;
        const p = Number(u.input_tokens) || 0;
        const prev = usage || {};
        usage = {
          prompt: Math.max(prev.prompt || 0, p),
          completion: Math.max(prev.completion || 0, 0),
          total: Math.max(prev.total || 0, p + (prev.completion || 0)),
        };
        return;
      }
      if (obj && obj.usage && typeof obj.usage === 'object') {
        const u = obj.usage;
        const p = Number(u.prompt_tokens ?? u.input_tokens) || 0;
        const c = Number(u.completion_tokens ?? u.output_tokens) || 0;
        const prev = usage || {};
        usage = {
          prompt: Math.max(prev.prompt || 0, p),
          completion: Math.max(prev.completion || 0, c),
          total: Math.max(prev.total || 0, Number(u.total_tokens) || 0 || p + c),
        };
        return;
      }

      const delta = (obj.choices && obj.choices[0] && obj.choices[0].delta) || {};
      const piece = delta.content || '';
      const thought = delta.reasoning_content || delta.reasoning || '';
      if (piece) {
        sawDelta = true;
        content += piece;
        onDelta?.(piece, content);
      }
      if (thought) {
        reasoning += thought;
        onReasoning?.(thought, reasoning);
      }
      // Non-OpenAI shapes: keep whatever text we can find rather than drop it.
      if (!piece && !thought && typeof obj.content === 'string') {
        sawDelta = true;
        content += obj.content;
        onDelta?.(obj.content, content);
      }
      if (!piece && !thought && obj.delta && typeof obj.delta.text === 'string') {
        sawDelta = true;
        content += obj.delta.text;
        onDelta?.(obj.delta.text, content);
      }
      // Google's streamGenerateContent (alt=sse): text rides in candidates,
      // usageMetadata carries the counts. Without this branch a corrected
      // Google stream would arrive and be silently thrown away.
      if (!piece && !thought && Array.isArray(obj.candidates)) {
        const parts = obj.candidates?.[0]?.content?.parts || [];
        const gtext = parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
        if (gtext) {
          sawDelta = true;
          content += gtext;
          onDelta?.(gtext, content);
        }
        if (obj.usageMetadata) {
          const p = Number(obj.usageMetadata.promptTokenCount) || 0;
          const c = Number(obj.usageMetadata.candidatesTokenCount) || 0;
          const prev = usage || {};
          usage = {
            prompt: Math.max(prev.prompt || 0, p),
            completion: Math.max(prev.completion || 0, c),
            total: Math.max(prev.total || 0, Number(obj.usageMetadata.totalTokenCount) || (p + c)),
          };
        }
      }
      // Same for a Google frame that only carries usage.
      if (!piece && !thought && !Array.isArray(obj.candidates) && obj.usageMetadata) {
        const p = Number(obj.usageMetadata.promptTokenCount) || 0;
        const c = Number(obj.usageMetadata.candidatesTokenCount) || 0;
        const prev = usage || {};
        usage = {
          prompt: Math.max(prev.prompt || 0, p),
          completion: Math.max(prev.completion || 0, c),
          total: Math.max(prev.total || 0, Number(obj.usageMetadata.totalTokenCount) || (p + c)),
        };
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      lines.forEach(handleLine);
    }
    if (buffer.trim()) handleLine(buffer);

    // Upstream failure mid-stream. Throw so the caller can retry rather than
    // hand an empty string to the model loop, which would end the turn as if
    // the agent had answered.
    if (streamError) {
      const err = new Error(streamError);
      // What the caller does next hinges on these: 429 waits, 401/403/404
      // give up, network blips retry. Previously every stream error threw a
      // bare Error, so all three behaved the same (retry blindly, twice).
      if (streamMeta.status) err.status = streamMeta.status;
      if (typeof streamMeta.retryable === 'boolean') {
        err.retryable = streamMeta.retryable;
      } else if (streamMeta.status === 429) {
        err.retryable = true;
      } else if ([400, 401, 403, 404, 422].includes(streamMeta.status)) {
        err.retryable = false;
      } else {
        err.retryable = true;
      }
      if (streamMeta.retryAfterMs != null) err.retryAfterMs = streamMeta.retryAfterMs;
      if (streamMeta.status === 429) { try { note429(gov.key, err.retryAfterMs); } catch {} }
      throw err;
    }

    return {
      content, reasoning, usage, finishReason,
      reasoningOnly: !sawDelta && !!reasoning,
      toolCalls: nativeCalls(nativeState),
    };
  }

  // --- Direct provider call (client-side, for per-agent routing) ---
  async callProvider(provider, messages, options = {}, signal) {
    const lat = latency.begin(options?.agentId, 'direct');
    try {
      const res = await this._callProviderCore(provider, messages, options, signal, lat);
      lat.end(true);
      return res;
    } catch (err) {
      // A CORS block surfaces as TypeError and is retried through the relay,
      // which times itself; counting it here would double-book one failure.
      if (err instanceof TypeError) lat.end(false, Object.assign(new Error('aborted'), { name: 'AbortError' }));
      else lat.end(false, err);
      throw err;
    }
  }

  async _callProviderCore(provider, messages, options = {}, signal, lat = null) {
    // Same bucket as the relayed calls: a direct call spends the same key.
    const gov = await acquire({ endpoint: provider?.endpoint, api_key: provider?.apiKey, agent_id: options.agentId }, { signal });
    lat?.started();
    const headers = { 'Content-Type': 'application/json' };

    if (provider.authType === 'bearer' && provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    } else if (provider.authType === 'x-api-key' && provider.apiKey) {
      headers['x-api-key'] = provider.apiKey;
    }

    const payload = {
      model: options.model || '',
      messages,
      temperature: options.temperature ?? store.get('settings.temperature') ?? 0.7,
      max_tokens: options.maxTokens ?? store.get('settings.maxTokens') ?? 4096,
      stream: false,
    };

    const res = await fetch(provider.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Provider error ${res.status}: ${text}`);
      // Direct calls see the provider's real HTTP headers, which is the only
      // place Retry-After is genuinely readable (the SSE relay has to have it
      // forwarded by the server instead).
      err.status = res.status;
      err.retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      const ra = this._retryAfterMs(res.headers?.get?.('Retry-After'));
      if (ra != null) err.retryAfterMs = ra;
      if (res.status === 429) { try { note429(gov.key, err.retryAfterMs); } catch {} }
      throw err;
    }

    const data = await res.json();
    return {
      content: this._parseProviderResponse(data, provider),
      usage: this._parseUsage(data, provider),
      reasoning: this._parseReasoning(data),
    };
  }

  _parseReasoning(data) {
    if (!data || typeof data !== 'object') return null;
    // OpenAI-compatible reasoning fields (DeepSeek, NVIDIA, OpenRouter)
    const msg = data.choices?.[0]?.message;
    if (msg) {
      if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
        return msg.reasoning_content;
      }
      if (typeof msg.reasoning === 'string' && msg.reasoning.trim()) {
        return msg.reasoning;
      }
    }
    if (typeof data.reasoning_content === 'string' && data.reasoning_content.trim()) {
      return data.reasoning_content;
    }
    if (typeof data.reasoning === 'string' && data.reasoning.trim()) {
      return data.reasoning;
    }
    // Anthropic thinking blocks
    if (Array.isArray(data.content)) {
      const thinking = data.content
        .filter(b => b && (b.type === 'thinking' || b.type === 'redacted_thinking'))
        .map(b => b.thinking || '')
        .filter(Boolean)
        .join('\n\n');
      if (thinking) return thinking;
    }
    // Ollama
    if (typeof data.thinking === 'string' && data.thinking.trim()) {
      return data.thinking;
    }
    return null;
  }

  _parseUsage(data, provider) {
    if (!data || typeof data !== 'object') return null;
    // OpenAI-compatible (OpenRouter, NVIDIA, OpenAI, Groq, Together, LM Studio)
    if (data.usage && typeof data.usage.prompt_tokens === 'number') {
      return {
        prompt: data.usage.prompt_tokens || 0,
        completion: data.usage.completion_tokens || 0,
        total: data.usage.total_tokens || ((data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0)),
      };
    }
    // Anthropic
    if (data.usage && typeof data.usage.input_tokens === 'number') {
      return {
        prompt: data.usage.input_tokens || 0,
        completion: data.usage.output_tokens || 0,
        total: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
      };
    }
    // Google
    if (data.usageMetadata) {
      const p = data.usageMetadata.promptTokenCount || 0;
      const c = data.usageMetadata.candidatesTokenCount || 0;
      return { prompt: p, completion: c, total: data.usageMetadata.totalTokenCount || (p + c) };
    }
    // Ollama
    if (typeof data.prompt_eval_count === 'number' || typeof data.eval_count === 'number') {
      const p = data.prompt_eval_count || 0;
      const c = data.eval_count || 0;
      return { prompt: p, completion: c, total: p + c };
    }
    return null;
  }

  _parseProviderResponse(data, provider) {
    // OpenAI-compatible
    if (data.choices?.[0]?.message?.content) {
      return data.choices[0].message.content;
    }
    if (data.choices?.[0]?.text) {
      return data.choices[0].text;
    }
    // Anthropic
    if (data.content?.[0]?.text) {
      return data.content[0].text;
    }
    // Google
    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text;
    }
    // Ollama
    if (data.response) {
      return data.response;
    }
    // Fallback
    return typeof data === 'string' ? data : JSON.stringify(data);
  }
}

// Singleton instance
export const api = new ApiClient();
export default api;
