// ============================================
// TERMINALPANEL.JS — Interactive in-page terminal
// Supports: help, clear, echo + a curl subset
// (complex quoted/multiline curl commands included).
// Direct fetch first; CORS-blocked hosts auto-retry
// through the server-side relay (POST /api/llm).
// ============================================

import { store } from '../store.js?v=314';
import { api } from '../api.js?v=314';
import { esc } from '../utils.js?v=314';
import { tokenizeCurl, parseCurl, bearerFromHeaders, resolveShellCurl } from '../curlParser.js?v=314';
import { parseSnippet, snippetKind } from '../snippetParser.js?v=314';

export class TerminalPanel {
  constructor() {
    this.panel = null;
    this.content = null;
    this.input = null;
    this.log = [];
    this.history = [];
    this.histIdx = -1;
  }

  init() {
    this.panel = document.getElementById('terminalPanel');
    this.content = document.getElementById('terminalContent');

    document.getElementById('terminalClose')?.addEventListener('click', () => this.hide());

    // Listen for terminal events (system log lines)
    store.on('terminal:add', (entry) => this.addEntry(entry));

    // Interactive input row
    if (this.panel && !document.getElementById('terminalInput')) {
      const row = document.createElement('div');
      row.className = 'terminal-input-row';
      row.innerHTML = `<span class="terminal-prompt">$</span>`
        + `<input id="terminalInput" class="terminal-input" type="text" `
        + `placeholder="type 'help' — paste curl commands, Enter to run" autocomplete="off" spellcheck="false"/>`;
      this.panel.appendChild(row);
      this.input = document.getElementById('terminalInput');
      this.input.addEventListener('keydown', (e) => this._onKey(e));
    }
  }

  toggle() {
    this.panel.classList.toggle('hidden');
    if (!this.panel.classList.contains('hidden') && this.input) this.input.focus();
  }
  show() { this.panel.classList.remove('hidden'); }
  hide() { this.panel.classList.add('hidden'); }

  addEntry(entry) {
    this.log.unshift(entry);
    if (this.log.length > 100) this.log.pop();
    this._render();
  }

  _print(text, type = 'output') {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    this.addEntry({ text, type, time });
  }

  _render() {
    if (!this.content) return;
    this.content.innerHTML = this.log.map(e => `
      <div class="terminal-line ${e.type}">[${e.time}] ${esc(e.text)}</div>
    `).join('');
  }

  _onKey(e) {
    if (e.key === 'Enter') {
      const cmd = this.input.value;
      this.input.value = '';
      this.histIdx = -1;
      if (cmd.trim()) {
        this.history.unshift(cmd);
        if (this.history.length > 50) this.history.pop();
        this._run(cmd);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.histIdx < this.history.length - 1) {
        this.histIdx += 1;
        this.input.value = this.history[this.histIdx] || '';
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.histIdx > 0) {
        this.histIdx -= 1;
        this.input.value = this.history[this.histIdx] || '';
      } else {
        this.histIdx = -1;
        this.input.value = '';
      }
    }
  }

  async _run(raw) {
    // Chain with && — each step runs only if the previous succeeded.
    // Split on unquoted && so JSON bodies / quoted strings are safe.
    for (const part of this._splitChain(raw)) {
      const ok = await this._exec(part);
      if (!ok) break;
    }
  }

  _splitChain(raw) {
    const parts = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
      } else if (ch === '&' && raw[i + 1] === '&') {
        parts.push(cur);
        cur = '';
        i++;
      } else {
        cur += ch;
      }
    }
    parts.push(cur);
    return parts.map(p => p.trim()).filter(p => p.length > 0);
  }

  async _exec(raw) {
    const cmd = raw.trim();
    if (!cmd) return true;
    // A provider snippet may start with `invoke_url='…'` or a heredoc; if it
    // contains a curl invocation anywhere, treat the whole thing as a curl.
    const kind = snippetKind(cmd);
    const hasCurl = resolveShellCurl(cmd) !== null;
    const [head, ...rest] = tokenizeCurl(cmd);
    const name = (kind === 'python' || kind === 'node') ? 'curl'
      : hasCurl && head && head.includes('=') ? 'curl'
      : (head || '').toLowerCase();

    if (name === 'help') {
      this._print('commands: help, clear, echo <text>, sleep <seconds>, viewport, curl [options] <url>', 'output');
      this._print('curl flags: -X/--request, -H/--header (repeatable), -d/--data[-raw|-binary], -sSki (ignored)', 'output');
      this._print('shell snippets work too — paste a doc block with invoke_url=\'…\' or a <<JSON heredoc and the curl is extracted.', 'output');
      this._print('python and node snippets also work: requests.post / urllib / fetch / axios are translated to the same request (nothing is executed).', 'output');
      this._print('chain with && — next runs only if previous succeeded', 'output');
      this._print('CORS-blocked hosts auto-retry through the server relay.', 'output');
      this._print('note: only curl really runs. echo/sleep/viewport/clear are local helpers — this is not a real shell.', 'output');
      return true;
    }
    if (name === 'clear') {
      this.log = [];
      this._render();
      return true;
    }
    if (name === 'echo') {
      this._print(rest.join(' '), 'output');
      return true;
    }
    if (name === 'sleep') {
      const secs = parseFloat(rest[0]);
      if (!isFinite(secs) || secs < 0) {
        this._print('usage: sleep <seconds>', 'error');
        return false;
      }
      if (secs > 300) {
        this._print('max sleep is 300 seconds', 'error');
        return false;
      }
      this._print(`sleeping ${secs}s…`, 'output');
      if (secs >= 3) {
        // Countdown so you can time what's next (e.g. dismissing the keyboard)
        const end = Date.now() + secs * 1000;
        let last = Math.ceil(secs) + 1;
        await new Promise(resolve => {
          const tick = () => {
            const left = Math.ceil((end - Date.now()) / 1000);
            if (left <= 0) {
              resolve();
            } else {
              if (left < last) {
                last = left;
                this._print(`${left}…`, 'output');
              }
              setTimeout(tick, 200);
            }
          };
          tick();
        });
      } else {
        await new Promise(r => setTimeout(r, secs * 1000));
      }
      this._print('done', 'success');
      return true;
    }
    if (name === 'viewport') {
      const vv = window.visualViewport;
      const app = document.querySelector('.app');
      const r = app ? app.getBoundingClientRect() : null;
      this._print(`inner: ${window.innerWidth}x${window.innerHeight}`, 'output');
      this._print(`visualViewport: ${vv ? Math.round(vv.width) + 'x' + Math.round(vv.height) : 'n/a'}`, 'output');
      this._print(`DPR: ${window.devicePixelRatio} orientation: ${screen.orientation?.type || 'n/a'}`, 'output');
      this._print(`docEl: ${document.documentElement.clientWidth}x${document.documentElement.clientHeight}`, 'output');
      this._print(`app rect: ${r ? Math.round(r.width) + 'x' + Math.round(r.height) + ' @y=' + Math.round(r.top) : 'missing!'}`, 'output');
      this._print(`body scroll: ${document.body.scrollWidth}x${document.body.scrollHeight}`, 'output');
      return true;
    }
    if (name === 'curl') {
      return await this._runCurl(cmd);
    }
    this._print(`unknown command: ${name} — try 'help'`, 'error');
    return false;
  }

  _redact(cmd) {
    return cmd
      .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/=]{4}[A-Za-z0-9\-._~+/=]*/g, '$1****(redacted)')
      .replace(/((?:x-api-key|api-key)\s*[:=]\s*['"]?)[^'"\s]+/gi, '$1****(redacted)');
  }

  async _runCurl(cmd) {
    let parsed;
    const kind = snippetKind(cmd);
    try {
      parsed = (kind === 'python' || kind === 'node') ? parseSnippet(cmd) : parseCurl(cmd);
    } catch (err) {
      this._print(`curl: ${err.message}`, 'error');
      return false;
    }
    if (kind === 'python' || kind === 'node') {
      this._print(`translated ${kind} snippet → ${parsed.method} ${parsed.url}`, 'output');
    }
    let { url, method, headers, data } = parsed;
    if (data && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const bearer = bearerFromHeaders(headers);

    this._print('$ ' + this._redact(cmd), 'command');
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method, headers, body: data ?? undefined });
      await this._printResponse(res, Date.now() - t0);
      return res.ok;
    } catch (err) {
      if (err instanceof TypeError) {
        this._print(`direct fetch blocked (${err.message || 'CORS/network'}) — retrying via server relay…`, 'output');
        return await this._relayCurl({ url, method, data, bearer, t0 });
      } else {
        this._print(`curl failed: ${err.message}`, 'error');
        return false;
      }
    }
  }

  async _printResponse(res, ms) {
    const text = await res.text();
    this._print(`< HTTP ${res.status} ${res.statusText} (${ms}ms)`, res.ok ? 'success' : 'error');
    this._print(this._snip(this._pretty(text)), res.ok ? 'output' : 'error');
    try {
      const data = JSON.parse(text);
      const u = data.usage || data.usageMetadata;
      if (u) {
        const p = u.prompt_tokens ?? u.promptTokenCount ?? 0;
        const c = u.completion_tokens ?? u.candidatesTokenCount ?? 0;
        this._print(`tokens: in=${p} out=${c}`, 'output');
      }
    } catch { /* non-JSON body already printed */ }
  }

  async _relayCurl({ url, method, data, bearer, t0 }) {
    if (method !== 'POST') {
      this._print('relay supports POST only — cannot retry this request', 'error');
      return false;
    }
    let body = {};
    try { body = JSON.parse(data || '{}'); }
    catch { this._print('relay needs a JSON body — cannot retry this request', 'error'); return false; }
    try {
      const res = await api.relayCall({
        provider: 'auto',
        endpoint: url,
        api_key: bearer,
        model: body.model || '',
        temperature: body.temperature ?? 0.7,
        max_tokens: body.max_tokens ?? 1024,
        messages: body.messages || [],
      });
      const ms = Date.now() - t0;
      if (res?.success) {
        this._print(`< HTTP 200 via relay (${ms}ms)`, 'success');
        this._print(this._snip(typeof res.content === 'string' ? res.content : JSON.stringify(res.content)), 'output');
        if (res.usage) {
          this._print(`tokens: in=${res.usage.prompt || 0} out=${res.usage.completion || 0}`, 'output');
        }
        return true;
      } else {
        this._print(`< relay error (${ms}ms): ${res?.error || 'unknown'}`, 'error');
        return false;
      }
    } catch (err) {
      this._print(`relay failed: ${err.message}`, 'error');
      return false;
    }
  }

  _pretty(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }

  _snip(text, max = 8000) {
    if (text.length <= max) return text;
    return text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
  }
}

export default TerminalPanel;
