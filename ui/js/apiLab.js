// ============================================
// APILAB.JS — the API Lab drawer
// ============================================
//
// WHAT THIS IS: the best of both converters you saved, in one screen, wired to
// the request the app actually has to make. Paste a curl (or any of the
// supported languages) and it becomes a request you can edit, send, and read
// the answer to; or send it and read the answer first and convert after. The
// point is the round trip -- the websites only do one direction, and the one
// that does both cannot send anything.
//
// TWO VIEWS OF THE SAME REQUEST, never two copies of it:
//   FIELDS — method, URL, headers, body. What you edit.
//   CODE   — the same request in the language you picked. What you paste out.
// Editing either updates the other, so a curl you pasted and a snippet you
// wrote cannot drift apart and leave you debugging the wrong request.
//
// SECRETS: key-shaped headers are masked on screen and never written to the log
// pane. The mask is display-only -- copy and send still use the real value.

import { api } from './api.js?v=311';
import { store } from './store.js?v=311';
import { persistence } from './persistence.js?v=311';
import { esc, copyToClipboard } from './utils.js?v=311';
import {
  LANGUAGES, reqFromCode, guessLanguage, generate,
  prettyJson, maskSecret, isSecretHeader,
} from './apiLabConvert.js?v=311';
// normalizePastedText belongs to the curl parser (it is what turns a pasted
// snippet into something a tokenizer can read) rather than to the Lab, so it
// is imported from its owner instead of being re-exported through the Lab.
import { normalizePastedText } from './curlParser.js?v=311';

const STORAGE_KEY = 'als.apiLab.v1';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export class ApiLab {
  constructor() {
    this.el = null;
    this.open = false;
    this.req = { method: 'POST', url: '', headers: [], body: '' };
    this.lang = 'curl';
    this.mode = 'fields';          // 'fields' | 'code'
    this.response = null;
    this.sending = false;
    this.expanded = false;
    this.placement = 'global';
    this._placeObserver = null;
    this._placeTargets = null;
    this._placeRaf = 0;
    this.timer = null;
    // The last code, kept so switching language swaps text rather than
    // regenerating from a request that may have been edited by hand.
    this._codeCache = {};
  }

  init() {
    this._buildDom();
    this._load();
    this._applySize();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) this.close();
    });
    window.addEventListener('resize', () => {
      if (this.open && this.placement === 'brainlab') this._applyPlacement();
    });
  }

  // ---------------------------------------------------------------
  // Persistence (view state, localStorage)
  // ---------------------------------------------------------------
  _load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw) {
        this.expanded = raw.expanded === true;
        if (raw.req) {
          this.req = { ...this.req, ...raw.req };
          this.lang = raw.lang || 'curl';
          // A restored request is never sent on sight: a request left over from
          // yesterday should not fire because the Lab was reopened.
          this.response = null;
        }
      }
    } catch { /* a corrupt blob just means defaults */ }
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        req: this.req, lang: this.lang, expanded: this.expanded,
      }));
    } catch { /* storage full or blocked: the Lab still works */ }
  }

  _applySize() {
    if (!this.el) return;
    const inBrain = this.placement === 'brainlab';
    const full = this.expanded && !inBrain;
    this.el.classList.toggle('full', full);
    const btn = this.el.querySelector('#labSize');
    if (!btn) return;
    btn.hidden = inBrain;
    btn.textContent = full ? 'HALF' : 'FULL';
    btn.title = full ? 'Shrink to half screen' : 'Expand to full screen';
    btn.setAttribute('aria-pressed', String(full));
  }

  _applyPlacement() {
    if (!this.el) return;
    const inBrain = this.placement === 'brainlab';
    this.el.classList.toggle('in-brainlab', inBrain);
    if (!inBrain) {
      this._placeObserver?.disconnect();
      this._placeTargets = null;
      if (this._placeRaf) {
        cancelAnimationFrame(this._placeRaf);
        this._placeRaf = 0;
      }
      this.el.style.removeProperty('--lab-top');
      this.el.style.removeProperty('--lab-left');
      return;
    }
    const topEl = document.querySelector('.brainlab.open .bl-top');
    const railEl = document.querySelector('.brainlab.open .bl-rail');
    this._measurePlacement(topEl, railEl);
    if (typeof ResizeObserver === 'undefined') return;
    this._placeObserver ||= new ResizeObserver(() => {
      if (!this.open || this.placement !== 'brainlab' || this._placeRaf) return;
      this._placeRaf = requestAnimationFrame(() => {
        this._placeRaf = 0;
        if (!this.open || this.placement !== 'brainlab') return;
        this._measurePlacement(
          document.querySelector('.brainlab.open .bl-top'),
          document.querySelector('.brainlab.open .bl-rail'),
        );
      });
    });
    const targets = this._placeTargets;
    if (!targets || targets.top !== topEl || targets.rail !== railEl) {
      this._placeObserver.disconnect();
      if (topEl) this._placeObserver.observe(topEl);
      if (railEl) this._placeObserver.observe(railEl);
      this._placeTargets = { top: topEl, rail: railEl };
    }
  }

  _measurePlacement(topEl, railEl) {
    if (!this.el) return;
    const top = topEl?.getBoundingClientRect().bottom || 0;
    const rail = railEl?.getBoundingClientRect().right || 0;
    this.el.style.setProperty('--lab-top', `${Math.max(0, Math.round(top))}px`);
    this.el.style.setProperty('--lab-left', `${Math.max(0, Math.round(rail))}px`);
  }

  _toggleSize() {
    this.expanded = !this.expanded;
    this._applySize();
    this._save();
  }

  // ---------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------
  _buildDom() {
    const wrap = document.createElement('div');
    wrap.className = 'lab-drawer';
    wrap.id = 'apiLab';
    wrap.innerHTML = `
      <div class="lab-top">
        <div class="lab-title">API LAB</div>
        <div class="lab-sub" id="labSub"></div>
        <button class="lab-mini lab-size" id="labSize" title="Expand to full screen">FULL</button>
        <button class="lab-x" id="labClose" title="Close (Esc)">✕</button>
      </div>

      <div class="lab-tabs">
        <button class="lab-tab active" data-labmode="fields">Request</button>
        <button class="lab-tab" data-labmode="code">Code</button>
        <button class="lab-tab" data-labtab="response">Response <span class="lab-pill" id="labStatusPill"></span></button>
      </div>

      <div class="lab-body">
        <!-- ---------- fields ---------- -->
        <div class="lab-pane" id="labPaneFields">
          <div class="lab-row lab-row-url">
            <select class="lab-select lab-method" id="labMethod">
              ${METHODS.map(m => `<option>${m}</option>`).join('')}
            </select>
            <input class="lab-input lab-url" id="labUrl" placeholder="https://integrate.api.nvidia.com/v1/chat/completions" spellcheck="false" autocomplete="off">
          </div>

          <div class="lab-label">
            <span>Headers</span>
            <button class="lab-mini" id="labAddHeader">+ header</button>
          </div>
          <div class="lab-headers" id="labHeaders"></div>

          <div class="lab-label"><span>Body</span>
            <span class="lab-hintline" id="labBodyHint"></span>
            <button class="lab-mini" id="labPretty">Pretty</button>
          </div>
          <textarea class="lab-textarea lab-body" id="labBody" spellcheck="false" placeholder='{"model": "...", "messages": [...]}'></textarea>

          <div class="lab-label"><span>Convert from / paste anything</span></div>
          <textarea class="lab-textarea lab-paste" id="labPaste" spellcheck="false"
            placeholder="Paste a curl, or Python / TypeScript / an OpenAI SDK snippet, and press Convert. Everything else on this screen is rebuilt from what you paste."></textarea>
          <div class="lab-row lab-actions">
            <button class="lab-btn primary" id="labConvert">Convert</button>
            <button class="lab-btn go" id="labSend">Send ▸</button>
            <span class="lab-note" id="labNote"></span>
          </div>
        </div>

        <!-- ---------- code ---------- -->
        <div class="lab-pane" id="labPaneCode" hidden>
          <div class="lab-row">
            <select class="lab-select" id="labLang">
              ${LANGUAGES.map(l => `<option value="${l.id}">${l.label}</option>`).join('')}
            </select>
            <button class="lab-mini" id="labCopyCode">Copy</button>
            <button class="lab-mini" id="labUseCode">Use as request</button>
          </div>
          <textarea class="lab-textarea lab-code" id="labCode" spellcheck="false"></textarea>
          <div class="lab-row lab-actions">
            <button class="lab-btn primary" id="labApplyCode">Convert this into the request</button>
            <span class="lab-note">Editing here does not change the request until you press Convert — so a half-typed snippet cannot rewrite what you are sending.</span>
          </div>
        </div>

        <!-- ---------- response ---------- -->
        <div class="lab-pane" id="labPaneResponse" hidden>
          <div class="lab-row">
            <div class="lab-meta" id="labMeta">Nothing sent yet.</div>
            <button class="lab-mini" id="labCopyBody">Copy body</button>
          </div>
          <div class="lab-subhead">Response headers</div>
          <pre class="lab-pre lab-respheaders" id="labRespHeaders"></pre>
          <div class="lab-subhead">Body</div>
          <pre class="lab-pre" id="labRespBody"></pre>
        </div>
      </div>

      <div class="lab-savebar">
        <button class="lab-btn ghost" id="labSaveProvider">Save as provider…</button>
        <button class="lab-btn ghost" id="labSaveAgent">Use for an agent…</button>
        <span class="lab-note" id="labSaveNote"></span>
      </div>
    `;
    document.body.appendChild(wrap);
    this.el = wrap;

    const on = (sel, ev, fn) => wrap.querySelector(sel)?.addEventListener(ev, fn);
    on('#labClose', 'click', () => this.close());
    on('#labSize', 'click', () => this._toggleSize());
    wrap.querySelectorAll('.lab-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const mode = tab.dataset.labmode;
        const tabName = tab.dataset.labtab;
        if (mode) this._setMode(mode);
        if (tabName === 'response') this._setMode('response');
        wrap.querySelectorAll('.lab-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
      });
    });
    on('#labMethod', 'change', (e) => { this.req.method = e.target.value; this._touch(); });
    on('#labUrl', 'input', (e) => { this.req.url = e.target.value; this._touch(); });
    on('#labBody', 'input', (e) => { this.req.body = e.target.value; this._touch(); });
    on('#labAddHeader', 'click', () => {
      this.req.headers.push({ name: '', value: '' });
      this._renderHeaders();
      wrap.querySelector('.lab-header-row:last-child .lab-hname')?.focus();
    });
    on('#labPretty', 'click', () => {
      this.req.body = prettyJson(this.req.body);
      wrap.querySelector('#labBody').value = this.req.body;
      this._touch();
    });
    on('#labConvert', 'click', () => this._convertFromPaste());
    on('#labSend', 'click', () => this.send());
    on('#labLang', 'change', (e) => { this.lang = e.target.value; this._renderCode(); this._save(); });
    on('#labCopyCode', 'click', () => {
      copyToClipboard(wrap.querySelector('#labCode').value);
      store.emit('toast', { message: 'Copied the snippet', type: 'success' });
    });
    on('#labApplyCode', 'click', () => this._applyCode());
    on('#labCopyBody', 'click', () => {
      copyToClipboard(wrap.querySelector('#labRespBody').textContent || '');
      store.emit('toast', { message: 'Copied the response body', type: 'success' });
    });
    on('#labSaveProvider', 'click', () => this._saveAsProvider());
    on('#labSaveAgent', 'click', () => this._useForAgent());
  }

  _setMode(mode) {
    const panes = {
      fields: '#labPaneFields',
      code: '#labPaneCode',
      response: '#labPaneResponse',
    };
    for (const [name, sel] of Object.entries(panes)) {
      const el = this.el.querySelector(sel);
      if (el) el.hidden = name !== mode;
    }
    this.mode = mode;
    this.el.querySelectorAll('.lab-tab').forEach(t => t.classList.remove('active'));
    const active = this.el.querySelector(mode === 'response' ? '[data-labtab="response"]' : `[data-labmode="${mode}"]`);
    active?.classList.add('active');
  }

  // ---------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------
  _renderHeaders() {
    const host = this.el.querySelector('#labHeaders');
    host.innerHTML = '';
    if (!this.req.headers.length) {
      const empty = document.createElement('div');
      empty.className = 'lab-note';
      empty.textContent = 'No headers. Most providers need at least Authorization and Content-Type — Convert a curl to get them.';
      host.appendChild(empty);
      return;
    }
    this.req.headers.forEach((h, i) => {
      const row = document.createElement('div');
      row.className = 'lab-header-row';
      const secret = isSecretHeader(h.name);
      const name = document.createElement('input');
      name.className = 'lab-input lab-hname';
      name.value = h.name;
      name.placeholder = 'Header';
      name.spellcheck = false;
      const val = document.createElement('input');
      val.className = 'lab-input lab-hvalue';
      // Masked when secret, but the VALUE is untouched underneath: this is
      // display only, so copy and send still carry the real key.
      val.type = secret ? 'password' : 'text';
      val.value = h.value;
      val.placeholder = secret ? maskSecret(h.value) || 'value' : 'value';
      val.spellcheck = false;
      if (secret) val.title = 'Masked on screen. Copy and Send use the real value.';
      const del = document.createElement('button');
      del.className = 'lab-mini danger';
      del.textContent = '✕';
      del.title = 'Remove this header';
      name.addEventListener('input', () => {
        this.req.headers[i].name = name.value;
        this._touch();
      });
      val.addEventListener('input', () => {
        this.req.headers[i].value = val.value;
        this._touch();
      });
      del.addEventListener('click', () => {
        this.req.headers.splice(i, 1);
        this._renderHeaders();
        this._touch();
      });
      row.append(name, val, del);
      host.appendChild(row);
    });
  }

  _renderFields() {
    this.el.querySelector('#labMethod').value = this.req.method || 'POST';
    this.el.querySelector('#labUrl').value = this.req.url || '';
    this.el.querySelector('#labBody').value = this.req.body || '';
    this._renderHeaders();
    this._updateHints();
  }

  _renderCode() {
    this.el.querySelector('#labLang').value = this.lang;
    this.el.querySelector('#labCode').value = this._codeFor(this.lang);
  }

  /** Generated code for a language, cached so edits are not stomped. */
  _codeFor(lang) {
    const key = JSON.stringify(this.req);
    if (this._codeCache[lang] && this._codeCache[lang].key === key) {
      return this._codeCache[lang].text;
    }
    let text = '';
    try {
      text = generate(lang, this.req);
    } catch (err) {
      text = `// could not generate: ${err.message}`;
    }
    this._codeCache[lang] = { key, text };
    return text;
  }

  _updateHints() {
    const url = this.req.url || '';
    const hint = this.el.querySelector('#labBodyHint');
    if (!hint) return;
    const notes = [];
    if (!url) notes.push('paste a curl below and press Convert');
    else {
      const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
      if (host) notes.push(host);
    }
    if (this.req.body.trim()) {
      try { JSON.parse(this.req.body); notes.push('body is valid JSON'); }
      catch { notes.push('body is not JSON yet'); }
    }
    hint.textContent = notes.join(' · ');
  }

  _note(text, kind = '') {
    const el = this.el.querySelector('#labNote');
    el.className = `lab-note ${kind}`;
    el.textContent = text || '';
  }

  /** Any edit to the request invalidates generated code and saves. */
  _touch() {
    this._codeCache = {};
    this._save();
    this._updateHints();
    this._updateSub();
    if (this.mode === 'code') this._renderCode();
  }

  /** The one-line summary in the header. Said once at open; after that it has
   *  to follow the request, or it goes on claiming there is nothing here. */
  _updateSub() {
    const sub = this.el?.querySelector('#labSub');
    if (!sub) return;
    sub.textContent = this.req.url
      ? `${this.req.method} · ${(this.req.headers || []).length} header(s) · saved in this browser only`
      : 'Paste a curl to begin';
  }

  // ---------------------------------------------------------------
  // Conversion
  // ---------------------------------------------------------------
  _convertFromPaste() {
    const raw = this.el.querySelector('#labPaste').value;
    if (!raw.trim()) {
      this._note('Paste something first.', 'warn');
      return;
    }
    try {
      const lang = guessLanguage(normalizePastedText(raw));
      const req = reqFromCode(raw, lang);
      this.req = req;
      this._codeCache = {};
      this._renderFields();
      this._renderCode();
      this._save();
      const hdrs = req.headers.length;
      this._note(`Converted from ${lang} — ${req.method} ${hdrs} header${hdrs === 1 ? '' : 's'}.`, 'good');
    } catch (err) {
      this._note(err.message, 'warn');
    }
  }

  _applyCode() {
    const raw = this.el.querySelector('#labCode').value;
    try {
      this.req = reqFromCode(raw, this.lang === 'curl' ? 'curl' : this.lang);
      this._codeCache = {};
      this._renderFields();
      this._save();
      this._setMode('fields');
      this._note('Request rebuilt from the snippet.', 'good');
    } catch (err) {
      this._note(err.message, 'warn');
    }
  }

  // ---------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------
  async send() {
    if (this.sending) return;
    if (!/^https?:\/\//i.test(this.req.url || '')) {
      this._note('That URL cannot be sent — it needs to start with http:// or https://.', 'warn');
      return;
    }
    this.sending = true;
    const btn = this.el.querySelector('#labSend');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    this.el.querySelector('#labMeta').textContent = 'Sending…';
    const started = Date.now();
    try {
      const res = await api.labRequest({
        method: this.req.method,
        url: this.req.url,
        headers: this.req.headers.filter(h => h.name && h.name.trim()),
        body: this.req.body,
        timeoutSec: 60,
      });
      this.response = res;
      this._renderResponse(res, Date.now() - started);
      this._setMode('response');
    } catch (err) {
      this.response = { ok: false, error: err.message || String(err) };
      this._renderResponse(this.response, Date.now() - started);
      this._setMode('response');
    } finally {
      this.sending = false;
      btn.disabled = false;
      btn.textContent = 'Send ▸';
    }
  }

  _renderResponse(res, wallMs) {
    const pill = this.el.querySelector('#labStatusPill');
    const meta = this.el.querySelector('#labMeta');
    const hdrs = this.el.querySelector('#labRespHeaders');
    const body = this.el.querySelector('#labRespBody');
    pill.textContent = '';
    pill.className = 'lab-pill';

    // `ok !== true`, not `ok === false`: the server marks every failure
    // explicitly, and a reply that arrives with no `ok` at all is a failure
    // too. Checking for false let an unmarked error render as "status 0",
    // which looks like the provider answered with nothing.
    if (!res || res.ok !== true) {
      const stage = res?.stage ? `${res.stage} · ` : '';
      pill.textContent = 'failed';
      pill.className = 'lab-pill bad';
      meta.innerHTML = `<b>${esc(stage + (res?.error || 'The request could not be sent.'))}</b>`
        + (res?.hint ? `<div class="lab-hint">${esc(res.hint)}</div>` : '')
        + (res?.curl_errno ? `<div class="lab-hint">curl errno ${res.curl_errno}</div>` : '');
      hdrs.textContent = '';
      body.textContent = '';
      return;
    }
    const status = res.status || 0;
    const good = status >= 200 && status < 300;
    pill.textContent = String(status);
    pill.className = `lab-pill ${good ? 'good' : 'bad'}`;
    meta.innerHTML = `<b>${status}</b> in ${res.ms ?? wallMs}ms`
      + ` · ${esc(res.content_type || 'no content-type')}`
      + (res.final_url && res.final_url !== this.req.url
        ? ` · <span class="lab-hint">followed to ${esc(res.final_url)}</span>` : '')
      + (res.truncated ? ' · <span class="lab-hint">body truncated at 2 MB</span>' : '');
    hdrs.textContent = Object.entries(res.headers || {})
      .map(([k, v]) => `${k}: ${v}`).join('\n') || '(none)';
    body.textContent = prettyJson(res.body || '');
  }

  // ---------------------------------------------------------------
  // Save as provider / agent
  // ---------------------------------------------------------------
  _guessName() {
    const url = this.req.url || '';
    try {
      const u = new URL(url);
      const h = u.hostname.replace(/^www\./, '');
      const seg = u.pathname.match(/\/(v\d+)\//);
      return seg ? `${h} ${seg[1]}` : h;
    } catch {
      return 'New provider';
    }
  }

  /** The Authorization / x-api-key value, and the name it arrived under. */
  _keyFrom() {
    const h = this.req.headers.find(x => /^(authorization|x-api-key)$/i.test(x.name || ''));
    if (!h) return { name: 'Authorization', value: '' };
    const isBearer = /^bearer\s+/i.test(h.value);
    return {
      name: isBearer ? 'Authorization' : h.name,
      value: isBearer ? h.value.replace(/^Bearer\s+/i, '') : h.value,
    };
  }

  _saveAsProvider() {
    if (!/^https?:\/\//i.test(this.req.url || '')) {
      store.emit('toast', { message: 'Convert a request first — there is no URL to save.', type: 'error' });
      return;
    }
    const key = this._keyFrom();
    const body = this.req.body ? (() => { try { return JSON.parse(this.req.body); } catch { return {}; } })() : {};
    const model = body.model || '';
    const name = this._guessName();
    const existing = store.get('providers') || [];
    const dup = existing.find(p => p.endpoint === this.req.url);
    if (dup) {
      store.emit('toast', {
        message: `Provider "${dup.name}" already points at that exact endpoint.`, type: 'info',
      });
      return;
    }
    const provider = {
      id: 'lab_' + Date.now().toString(36),
      name,
      endpoint: this.req.url,
      apiKey: key.value,
      authType: key.name === 'x-api-key' ? 'x-api-key' : undefined,
      models: model ? [model] : [],
      active: true,
    };
    store.set('providers', [...existing, provider]);
    persistence.set('providers', store.get('providers'));
    store.emit('providers:changed', { added: provider.id });
    store.emit('toast', {
      message: `Saved provider "${name}"${model ? ` with model ${model}` : ''} — check the key, then point an agent at it.`,
      type: 'success',
    });
    this.el.querySelector('#labSaveNote').textContent = `Saved "${name}".`;
  }

  _useForAgent() {
    const url = this.req.url || '';
    if (!/^https?:\/\//i.test(url)) {
      store.emit('toast', { message: 'Convert a request first.', type: 'error' });
      return;
    }
    const body = this.req.body ? (() => { try { return JSON.parse(this.req.body); } catch { return {}; } })() : {};
    const agents = (store.get('agents') || []).filter(a => a.active !== false);
    if (!agents.length) {
      store.emit('toast', { message: 'No active agents to point at this endpoint yet.', type: 'error' });
      return;
    }
    const pick = agents
      .map((a, i) => `${i + 1}. ${a.name || a.id}${a.model ? ` (${a.model})` : ''}`)
      .join('\n');
    const answer = window.prompt(
      `Point an agent at this endpoint?\n\n${pick}\n\nEnter the number.`,
      '1'
    );
    const n = parseInt(String(answer || '').trim(), 10);
    if (!Number.isFinite(n) || n < 1 || n > agents.length) {
      if (answer !== null) store.emit('toast', { message: 'Nothing changed.', type: 'info' });
      return;
    }
    const agent = agents[n - 1];
    const key = this._keyFrom();
    store.set('agents', (store.get('agents') || []).map(a => (
      a.id === agent.id
        ? {
          ...a,
          endpointOverride: url,
          model: body.model || a.model,
          ...(key.value ? { apiKeyOverride: key.value } : {}),
        }
        : a
    )));
    persistence.set('agents', store.get('agents'));
    store.emit('agents:changed', { id: agent.id });
    store.emit('toast', {
      message: `"${agent.name || agent.id}" now calls ${url}${body.model ? ` as ${body.model}` : ''}.`,
      type: 'success',
    });
    this.el.querySelector('#labSaveNote').textContent = `Pointed "${agent.name || agent.id}" at this endpoint.`;
  }

  // ---------------------------------------------------------------
  // Open / close
  // ---------------------------------------------------------------
  show(placement = 'global') {
    this.open = true;
    this.placement = placement;
    // On the main screen the Lab opens full-window; the HALF button shrinks it.
    // Inside Brain Lab it keeps its embedded placement and its own sizing.
    if (placement !== 'brainlab') this.expanded = true;
    this._applyPlacement();
    this._applySize();
    void this.el.offsetWidth;
    this.el.classList.add('open');
    document.body.style.overflow = 'hidden';
    this._renderFields();
    this._renderCode();
    if (this.response) this._renderResponse(this.response, 0);
    this._updateSub();
    if (placement === 'brainlab') requestAnimationFrame(() => this._applyPlacement());
  }

  close() {
    this.open = false;
    this.el.classList.remove('open');
    if (!document.querySelector('.brainlab.open')) document.body.style.overflow = '';
  }

  toggle(placement = 'global') {
    this.open ? this.close() : this.show(placement);
  }
}

export default ApiLab;