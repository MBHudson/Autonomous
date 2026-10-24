// ============================================
// TOPOLOGY3D / MCPPANEL.JS — the card's Access + Permissions editors
// ============================================
//
// Two tabs on an MCP node's card, edited in place on the graph:
//   * Access      — per node. A server you call: its connection + a tool
//                   allow/deny list. A friend connected in: their scope and IP
//                   allowlist.
//   * Permissions — global. The shell allow/deny lists, interpreter levels,
//                   auto-approve / auto-deny and the code interpreter.
//
// Everything is read-modify-write against the same config the Config tab uses,
// chained so two savers can't clobber each other (PUT /config replaces the
// whole file).

import { api } from '../../api.js?v=313';
import { store } from '../../store.js?v=313';
import { persistence } from '../../persistence.js?v=313';
import { esc } from '../../utils.js?v=313';

const KNOWN_INTERPRETERS = [
  'bash', 'sh', 'zsh',
  'python3', 'python',
  'node', 'perl', 'php', 'ruby', 'lua',
];

const LEVEL_TEXT = {
  off: 'Refused. Cannot be approved.',
  scripts: 'Script files only; inline -c/-e/stdin refused.',
  full: 'Anything, including inline code. Same power as a shell.',
};

const lines = s => String(s || '').split(/[\r\n,]+/).map(x => x.trim()).filter(Boolean);
const escAttr = s => esc(String(s ?? ''));

export class McpPanel {
  constructor(opts = {}) {
    this.onSaved = opts.onSaved || (() => {});
    this.host = null;
    this._cfgChain = Promise.resolve();
  }

  clear() { this.host = null; }

  /** Render the right editor into `host` for `node` (kind: 'access' | 'perm'). */
  async mount(host, node, kind) {
    this.host = host;
    host.innerHTML = '<div class="form-hint">Loading…</div>';
    try {
      if (kind === 'perm') return await this._perm(host);
      if (node.type === 'mcp') return await this._server(host, node);
      return await this._friend(host, node);
    } catch (err) {
      host.innerHTML = `<div class="form-hint" style="color:var(--danger)">Could not load: ${esc(err.message || err)}</div>`;
    }
  }

  /** Serialise config writes so overlapping savers don't revert each other. */
  _patchConfig(mutator) {
    this._cfgChain = this._cfgChain.then(async () => {
      const cfg = await api.getConfig();
      mutator(cfg);
      await api.saveConfig(cfg);
      return cfg;
    });
    return this._cfgChain;
  }

  _done(msg) {
    try { store.emit('toast', { message: msg, type: 'success' }); } catch { /* no store */ }
    // Chart the change: a new server/friend appears, an edit recolours.
    try { store.emit('mcp:config-changed'); } catch { /* ignore */ }
    this.onSaved();
  }

  // ---------------- Access: a server we call ----------------

  async _server(host, node) {
    const id = String(node.id).replace(/^mcp_/, '');
    const res = await api.mcpServers();
    const srv = ((res && res.servers) || []).find(s => s.id === id);
    if (!srv) { host.innerHTML = '<div class="form-hint">That server is gone.</div>'; return; }
    const isHttp = srv.transport === 'http';
    const allow = (srv.allow_tools || []).join('\n');
    const deny = (srv.deny_tools || []).join('\n');
    const conn = isHttp
      ? `<label class="form-label">URL</label>
         <input class="form-input" data-f="url" value="${escAttr(srv.url || '')}">
         <label class="form-label">Headers <span class="form-hint-inline">one per line, Name: value</span></label>
         <textarea class="form-textarea" data-f="headers" rows="3">${esc(Object.entries(srv.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'))}</textarea>`
      : `<label class="form-label">Command</label>
         <input class="form-input" data-f="command" value="${escAttr(srv.command || '')}">
         <label class="form-label">Args <span class="form-hint-inline">one per line</span></label>
         <textarea class="form-textarea" data-f="args" rows="3">${esc((srv.args || []).join('\n'))}</textarea>
         <label class="form-label">Env <span class="form-hint-inline">one per line, KEY=value</span></label>
         <textarea class="form-textarea" data-f="env" rows="2">${esc(Object.entries(srv.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'))}</textarea>`;

    host.innerHTML = `
      <div class="mcp-editor">
        <div class="form-hint">Server <b>${esc(id)}</b> (${esc(srv.transport || 'stdio')}) — your agents call it with <code>mcp_call</code>.</div>
        ${conn}
        <label class="form-label">Tools allowed <span class="form-hint-inline">empty = all allowed</span></label>
        <textarea class="form-textarea" data-f="allow_tools" rows="3" placeholder="one tool per line">${esc(allow)}</textarea>
        <label class="form-label">Tools denied <span class="form-hint-inline">always refused</span></label>
        <textarea class="form-textarea" data-f="deny_tools" rows="3" placeholder="one tool per line">${esc(deny)}</textarea>
        <div class="mcp-edit-actions">
          <button class="btn btn-ghost" data-act="probe">Check now</button>
          <button class="btn btn-primary" data-act="save">Save</button>
        </div>
      </div>`;

    const val = f => host.querySelector(`[data-f="${f}"]`)?.value ?? '';
    host.querySelector('[data-act="probe"]')?.addEventListener('click', () => store.emit('mcp:probe'));
    host.querySelector('[data-act="save"]')?.addEventListener('click', async () => {
      try {
        const list = ((await api.mcpServers()).servers || []).map(s => {
          if (s.id !== id) return s;
          const out = { ...s };
          if (out.transport === 'http') {
            out.url = val('url').trim();
            out.headers = this._pairs(val('headers'), ':');
          } else {
            out.command = val('command').trim();
            out.args = lines(val('args'));
            out.env = this._pairs(val('env'), '=');
          }
          out.allow_tools = lines(val('allow_tools'));
          out.deny_tools = lines(val('deny_tools'));
          return out;
        });
        await api.mcpSaveServers(list);
        this._done(`Saved ${id}`);
      } catch (err) {
        store.emit('toast', { message: `Not saved: ${err.message || err}`, type: 'error' });
      }
    });
  }

  /** "a: b" / "a=b" lines into an object. */
  _pairs(text, sep) {
    const out = {};
    String(text || '').split(/\r?\n/).forEach(raw => {
      const i = raw.indexOf(sep);
      if (i <= 0) return;
      const k = raw.slice(0, i).trim();
      const v = raw.slice(i + 1).trim();
      if (k) out[k] = v;
    });
    return out;
  }

  // ---------------- Access: a friend connected in ----------------

  async _friend(host, node) {
    const label = String(node.label || '');
    const cfg = await api.mcpServerConfig();
    const token = (cfg.tokens || []).find(t => (t.label || 'friend') === label);
    if (!token) { host.innerHTML = '<div class="form-hint">That friend is gone.</div>'; return; }
    const sc = token.scope || [];
    const has = s => sc.includes(s) ? 'checked' : '';
    host.innerHTML = `
      <div class="mcp-editor">
        <div class="form-hint">Friend <b>${esc(label)}</b> — a client connected to this machine.</div>
        <label class="form-label">Scope <span class="form-hint-inline">a ceiling, not a bypass</span></label>
        <div class="mcp-scopes">
          <label class="tool-option"><input type="checkbox" data-scope="read" ${has('read')}><span class="tool-name">read</span><span class="tool-desc">files, web, git read</span></label>
          <label class="tool-option"><input type="checkbox" data-scope="write" ${has('write')}><span class="tool-name">write</span><span class="tool-desc">edits and patches</span></label>
          <label class="tool-option"><input type="checkbox" data-scope="exec" ${has('exec')}><span class="tool-name">exec</span><span class="tool-desc">commands and code</span></label>
        </div>
        <label class="form-label">IP allowlist <span class="form-hint-inline">optional, comma-separated</span></label>
        <input class="form-input" data-f="ips" value="${escAttr((token.ips || []).join(', '))}">
        <div class="mcp-edit-actions">
          <button class="btn btn-primary" data-act="save">Save</button>
        </div>
      </div>`;

    host.querySelector('[data-act="save"]')?.addEventListener('click', async () => {
      try {
        const scope = ['read', 'write', 'exec']
          .filter(s => host.querySelector(`[data-scope="${s}"]`)?.checked);
        const ips = lines(host.querySelector('[data-f="ips"]')?.value);
        const tokens = (cfg.tokens || []).map(t => {
          if ((t.label || 'friend') !== label) return t;
          return { ...t, scope, ips };
        });
        await api.mcpServerSave({ ...cfg, tokens });
        this._done(`Saved ${label}`);
      } catch (err) {
        store.emit('toast', { message: `Not saved: ${err.message || err}`, type: 'error' });
      }
    });
  }

  // ---------------- Permissions (global) ----------------

  async _perm(host) {
    const [cfg, info] = await Promise.all([
      api.getConfig(),
      api.execAllowlist().catch(() => ({ allow: [], deny: [], interpreters: [], interpreters_full: [] })),
    ]);
    const sb = cfg.sandbox || {};
    const settings = store.get('settings') || {};
    const optedScripts = Array.isArray(info.interpreters) ? info.interpreters : [];
    const optedFull = Array.isArray(info.interpreters_full) ? info.interpreters_full : [];
    const levelOf = n => optedFull.includes(n) ? 'full' : (optedScripts.includes(n) ? 'scripts' : 'off');

    host.innerHTML = `
      <div class="mcp-editor">
        <div class="form-hint">App-wide. These are the same lists as Config → Permissions.</div>
        <div class="mcp-toggles">
          <label class="mcp-toggle-row"><span>Auto-approve</span><span class="toggle ${settings.autoApprove ? 'active' : ''}" data-t="autoApprove"><span class="toggle-knob"></span></span></label>
          <label class="mcp-toggle-row"><span>Auto-deny</span><span class="toggle ${settings.autoDeny ? 'active' : ''}" data-t="autoDeny"><span class="toggle-knob"></span></span></label>
          <label class="mcp-toggle-row"><span>Code interpreter</span><span class="toggle ${sb.code_enabled ? 'active' : ''}" data-t="code"><span class="toggle-knob"></span></span></label>
        </div>
        <label class="form-label">Shell commands allowed <span class="form-hint-inline">one per line; replaces the defaults</span></label>
        <textarea class="form-textarea" data-f="exec_allow" rows="4" placeholder="grep&#10;curl">${esc((info.allow || []).join('\n'))}</textarea>
        <label class="form-label">Shell commands denied <span class="form-hint-inline">absolute</span></label>
        <textarea class="form-textarea" data-f="exec_deny" rows="4" placeholder="sh&#10;rm">${esc((info.deny || []).join('\n'))}</textarea>
        <label class="form-label">Interpreters</label>
        <div class="mcp-interps" data-interps>
          ${KNOWN_INTERPRETERS.map(n => `
            <div class="interp-row">
              <span class="tool-name">${esc(n)}</span>
              <select class="form-select interp-level" data-interp="${esc(n)}">
                <option value="off" ${levelOf(n) === 'off' ? 'selected' : ''}>Blocked</option>
                <option value="scripts" ${levelOf(n) === 'scripts' ? 'selected' : ''}>Scripts only</option>
                <option value="full" ${levelOf(n) === 'full' ? 'selected' : ''}>Full access</option>
              </select>
              <span class="tool-desc" data-desc="${esc(n)}">${LEVEL_TEXT[levelOf(n)]}</span>
            </div>`).join('')}
        </div>
        <div class="mcp-edit-actions">
          <button class="btn btn-primary" data-act="save">Save</button>
        </div>
      </div>`;

    host.querySelectorAll('[data-t]').forEach(tg => tg.addEventListener('click', () => tg.classList.toggle('active')));
    const interpBox = host.querySelector('[data-interps]');
    interpBox.addEventListener('change', () => {
      interpBox.querySelectorAll('[data-interp]').forEach(sel => {
        const d = interpBox.querySelector(`[data-desc="${sel.dataset.interp}"]`);
        if (d) d.textContent = LEVEL_TEXT[sel.value] || '';
      });
    });

    host.querySelector('[data-act="save"]')?.addEventListener('click', async () => {
      try {
        const on = t => host.querySelector(`[data-t="${t}"]`)?.classList.contains('active');
        // Client settings: auto-approve / auto-deny live in the store.
        store.set('settings.autoApprove', on('autoApprove'));
        store.set('settings.autoDeny', on('autoDeny'));
        persistence.set('settings', store.get('settings'));

        const level = n => (interpBox.querySelector(`[data-interp="${n}"]`) || {}).value || 'off';
        const interps = KNOWN_INTERPRETERS.filter(n => level(n) === 'scripts');
        const interpsFull = KNOWN_INTERPRETERS.filter(n => level(n) === 'full');
        const allow = lines(host.querySelector('[data-f="exec_allow"]')?.value);
        const deny = lines(host.querySelector('[data-f="exec_deny"]')?.value);

        await this._patchConfig((c) => {
          c.sandbox = c.sandbox || {};
          c.sandbox.code_enabled = on('code');
          if (allow.length) c.sandbox.exec_allow = allow; else delete c.sandbox.exec_allow;
          if (deny.length) c.sandbox.exec_deny = deny; else delete c.sandbox.exec_deny;
          if (interps.length) c.sandbox.exec_interpreters = interps; else delete c.sandbox.exec_interpreters;
          if (interpsFull.length) c.sandbox.exec_interpreters_full = interpsFull; else delete c.sandbox.exec_interpreters_full;
        });
        this._done('Permissions saved');
      } catch (err) {
        store.emit('toast', { message: `Not saved: ${err.message || err}`, type: 'error' });
      }
    });
  }
}

export default McpPanel;
