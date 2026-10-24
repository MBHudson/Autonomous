import { store } from './store.js?v=313';
import { persistence } from './persistence.js?v=313';
import { esc, escAttr, agentCode } from './utils.js?v=313';
import * as memory from './memory.js?v=313';
import {
  profiles, newProfileId, alwaysAppendFor,
  settingFor, isLocked, lockSetting, unlockSetting, setSetting, sandboxRootFor,
} from './agentConfig.js?v=313';
import {
  customToolDefs, defaultTools, loadCustomTools, validateCustomTool,
} from './tools.js?v=313';
import { SandboxFiles } from './sandboxFiles.js?v=313';
import { TOOL_PROTOCOLS, toolProtocolFor, protocolLabel, protocolHint, harnessFor } from './toolProtocol.js?v=313';

const ZOOM_KEY = 'als.brainLab.zoom.v1';
const ZOOM_STEPS = [130, 160, 190, 225, 270, 320];
const TITLE = 'BRAIN LAB';
const MAX_FILE_CHARS = 120000;
const MAX_AGENT_FILE_CHARS = 240000;
const MAX_AGENT_FILES = 20;

function fmtTokens(n) {
  const v = Math.round(n || 0);
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(v);
}

function fmtBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}

export class BrainLab {
  constructor() {
    this.el = null;
    this.open = false;
    this.selectedId = null;
    this._openSections = new Set();
    this.zoom = 1;
    this._notesTimer = null;
    this._profileModal = null;
    this._customToolModal = null;
    this.sandboxFiles = null;
    this.main = null;
  }

  init() {
    this._restoreOpenSections();
    this.zoom = this._loadZoom();
    this._buildDom();
    this._applyZoom();
    this._bind();
    this.sandboxFiles = new SandboxFiles();
    this.sandboxFiles.init(this.main, () => this._agent());
    this.sandboxFiles.prefetch().then(() => {
      if (this.open) this.renderRail();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this._customToolModal) { this._closeCustomToolEditor(); return; }
      if (this._profileModal) { this._closeProfileEditor(); return; }
      if (this.sandboxFiles?.open) { this.sandboxFiles.close(); return; }
      if (this.notes && !this.notes.hidden) { this._toggleNotes(false); return; }
      if (this.open) this.close();
    });
    store.on('agents:changed', () => { if (this.open) this.render(); });
    store.on('providers:changed', () => { if (this.open) this.render(); });
    store.on('metrics:changed', () => { if (this.open) this.renderCards(); });
    store.on('customTools:changed', () => { if (this.open) this.renderRail(); });
    window.addEventListener('router:memory-changed', () => { if (this.open) this.renderRail(); });
    window.addEventListener('resize', () => {
      if (this.apiLab?.open && this.apiLab.placement === 'brainlab') this.apiLab._applyPlacement();
    });
  }

  // ---------------------------------------------------------------- shell

  // Section open/closed state is SESSION-ONLY: every section starts collapsed
  // on a fresh load, the ones you open stay open until you reload, and nothing
  // is written to localStorage or sent anywhere.
  _restoreOpenSections() {
    this._openSections = new Set();
  }

  _saveOpenSections() {
    // Intentionally empty: kept so the toggle handler still reads cleanly.
  }

  _loadZoom() {
    try {
      const raw = localStorage.getItem(ZOOM_KEY);
      if (raw === null) return 1;
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 0 && n < ZOOM_STEPS.length) return n;
    } catch { /* default */ }
    return 1;
  }

  _applyZoom() {
    const width = ZOOM_STEPS[this.zoom] || ZOOM_STEPS[1];
    this.el?.style.setProperty('--bl-card-w', `${width}px`);
    const readout = this.el?.querySelector('#blZoomVal');
    if (readout) readout.textContent = `${Math.round(width / ZOOM_STEPS[1] * 100)}%`;
    const out = this.el?.querySelector('#blZoomOut');
    if (out) out.disabled = this.zoom === 0;
    const inn = this.el?.querySelector('#blZoomIn');
    if (inn) inn.disabled = this.zoom === ZOOM_STEPS.length - 1;
  }

  _changeZoom(delta) {
    const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, this.zoom + delta));
    if (next === this.zoom) return;
    this.zoom = next;
    this._applyZoom();
    try { localStorage.setItem(ZOOM_KEY, String(this.zoom)); } catch { /* view-only */ }
  }

  _setAllActive(active) {
    const agents = store.get('agents') || [];
    if (!agents.length) {
      store.emit('toast', { message: 'No agents to update', type: 'error' });
      return;
    }
    const changed = agents.filter(a => !!a.active !== active).length;
    if (!changed) {
      store.emit('toast', {
        message: active ? 'All agents are already active' : 'All agents are already inactive',
        type: 'info',
      });
      return;
    }
    const next = agents.map(a => ({ ...a, active }));
    store.set('agents', next);
    persistence.set('agents', next);
    store.emit('agents:changed');
    store.emit('toast', {
      message: active ? `Activated ${agents.length} agents` : `Deactivated ${agents.length} agents`,
      type: 'success',
    });
  }

  _buildDom() {
    const el = document.createElement('div');
    el.className = 'brainlab';
    el.id = 'brainLab';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Brain Lab');
    el.innerHTML = `
      <div class="bl-top">
        <span class="bl-title">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
            <path d="M6 2.6A2.3 2.3 0 0 0 3.7 4.9c-1 .5-1.6 1.4-1.6 2.5 0 .7.3 1.4.8 1.9-.3.4-.5.9-.5 1.4 0 1.3 1 2.4 2.3 2.6.2.7.8 1.2 1.5 1.2.5 0 .9-.2 1.2-.6V3.2c-.3-.4-.8-.6-1.4-.6Z"/>
            <path d="M10 2.6a2.3 2.3 0 0 1 2.3 2.3c1 .5 1.6 1.4 1.6 2.5 0 .7-.3 1.4-.8 1.9.3.4.5.9.5 1.4 0 1.3-1 2.4-2.3 2.6-.2.7-.8 1.2-1.5 1.2-.5 0-.9-.2-1.2-.6V3.2c.3-.4.8-.6 1.4-.6Z"/>
          </svg>
          ${TITLE}
        </span>
        <span class="bl-sub" id="blSub"></span>
        <button class="bl-btn" id="blSandbox" title="Browse this agent's sandbox files">FILES</button>
        <button class="bl-btn" id="blApiLab" title="Open the API Lab over the cards">API LAB</button>
        <button class="bl-btn" id="blAddAgent" title="Create an agent">+ AGENT</button>
        <button class="bl-btn" id="blAddProvider" title="Create a provider">+ PROVIDER</button>
        <button class="bl-btn" id="blAllOn" title="Activate every agent">ALL ON</button>
        <button class="bl-btn" id="blAllOff" title="Deactivate every agent">ALL OFF</button>
        <button class="bl-btn" id="blNotesBtn" title="Your own saved scratchpad — never sent to an agent">NOTES</button>
        <button class="bl-x" id="blClose" title="Close (Esc)">✕</button>
      </div>
      <div class="bl-body">
        <aside class="bl-rail" id="blRail"></aside>
        <main class="bl-main">
          <div class="bl-main-head">
            <span class="bl-main-title">AGENTS</span>
            <span class="bl-main-meta" id="blMainMeta"></span>
            <div class="bl-zoom" role="group" aria-label="Card size">
              <button class="bl-mini" id="blZoomOut" title="Smaller cards">−</button>
              <span class="bl-zoom-val" id="blZoomVal">100%</span>
              <button class="bl-mini" id="blZoomIn" title="Bigger cards">+</button>
            </div>
          </div>
          <div class="bl-grid" id="blGrid"></div>
        </main>
      </div>
      <div class="bl-notes" id="blNotes" hidden>
        <div class="bl-notes-head">
          <span>NOTES</span>
          <span class="bl-notes-hint">yours · saved · never in a prompt</span>
          <button class="bl-mini" id="blNotesClose">✕</button>
        </div>
        <textarea class="form-textarea" id="blNotesText" rows="12" placeholder="Scratchpad, plans, reminders — this box is for you. It is not injected into any agent."></textarea>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.main = el.querySelector('.bl-main');
    this.rail = el.querySelector('#blRail');
    this.grid = el.querySelector('#blGrid');
    this.sub = el.querySelector('#blSub');
    this.notes = el.querySelector('#blNotes');
    this.notesText = el.querySelector('#blNotesText');
  }

  _bind() {
    this.el.querySelector('#blClose')?.addEventListener('click', () => this.close());
    this.el.querySelector('#blSandbox')?.addEventListener('click', () => this._openSandbox());
    this.el.querySelector('#blApiLab')?.addEventListener('click', () => this._openApiLab());
    this.el.querySelector('#blAddAgent')?.addEventListener('click', () => store.emit('agent:add'));
    this.el.querySelector('#blAddProvider')?.addEventListener('click', () => store.emit('provider:add'));
    this.el.querySelector('#blAllOn')?.addEventListener('click', () => this._setAllActive(true));
    this.el.querySelector('#blAllOff')?.addEventListener('click', () => this._setAllActive(false));
    this.el.querySelector('#blZoomOut')?.addEventListener('click', () => this._changeZoom(-1));
    this.el.querySelector('#blZoomIn')?.addEventListener('click', () => this._changeZoom(1));
    this.el.querySelector('#blNotesBtn')?.addEventListener('click', () => this._toggleNotes());
    this.el.querySelector('#blNotesClose')?.addEventListener('click', () => this._toggleNotes(false));

    this.grid.addEventListener('click', (e) => {
      const edit = e.target.closest('[data-bl-edit]');
      if (edit) {
        e.stopPropagation();
        store.emit('agent:edit', edit.dataset.blEdit);
        return;
      }
      const card = e.target.closest('[data-agent-id]');
      if (!card) return;
      this.selectedId = card.dataset.agentId;
      this.render();
    });

    this.rail.addEventListener('change', (e) => {
      if (e.target.id === 'blFileInput') { this._addFiles(e.target.files); return; }
      const custom = e.target.dataset.blCustomTool;
      if (custom) { this._toggleCustomTool(custom, e.target.checked); return; }
      const field = e.target.dataset.blField;
      if (field) this._onField(field, e.target);
    });

    this.rail.addEventListener('click', (e) => {
      const lock = e.target.closest('[data-bl-lock]');
      if (lock) { this._toggleLock(lock.dataset.blLock); return; }
      const fileDel = e.target.closest('[data-bl-file-del]');
      if (fileDel) { this._removeFile(fileDel.dataset.blFileDel); return; }
      const memDel = e.target.closest('[data-bl-mem-del]');
      if (memDel) { memory.removeEntry(memDel.dataset.blMemDel); this.render(); return; }
      const memAdd = e.target.closest('[data-bl-mem-add]');
      if (memAdd) { this._addMemory(memAdd.dataset.blMemAdd); return; }
      const act = e.target.closest('[data-bl-act]');
      if (act) { this._onRailAction(act.dataset.blAct); return; }
    });

    this.notesText?.addEventListener('input', () => {
      clearTimeout(this._notesTimer);
      this._notesTimer = setTimeout(() => this._saveNotes(), 350);
    });
  }

  show() {
    if (!this.el) this.init();
    this.open = true;
    this.el.classList.add('open');
    document.body.style.overflow = 'hidden';
    const agents = store.get('agents') || [];
    if (!this.selectedId || !agents.some(a => a.id === this.selectedId)) {
      this.selectedId = agents[0]?.id || null;
    }
    this.render();
  }

  close() {
    this._saveNotes();
    if (this.apiLab?.open && this.apiLab.placement === 'brainlab') this.apiLab.close();
    this.sandboxFiles?.close();
    this.open = false;
    this.el?.classList.remove('open');
    document.body.style.overflow = '';
  }

  _openSandbox() {
    if (!this.sandboxFiles) {
      store.emit('toast', { message: 'File manager is not ready yet', type: 'error' });
      return;
    }
    if (this.sandboxFiles.open) { this.sandboxFiles.close(); return; }
    if (!this._agent()) {
      store.emit('toast', { message: 'Select an agent first', type: 'error' });
      return;
    }
    if (this.apiLab?.open && this.apiLab.placement === 'brainlab') this.apiLab.close();
    this.sandboxFiles.show(this.selectedId);
  }

  _openApiLab() {
    if (!this.apiLab) {
      store.emit('toast', { message: 'API Lab is not ready yet', type: 'error' });
      return;
    }
    if (this.apiLab.open && this.apiLab.placement === 'brainlab') this.apiLab.close();
    else {
      this.sandboxFiles?.close();
      this.apiLab.show('brainlab');
    }
  }

  toggle() { this.open ? this.close() : this.show(); }

  // ---------------------------------------------------------------- render

  render() {
    const agents = store.get('agents') || [];
    if (!this.selectedId || !agents.some(a => a.id === this.selectedId)) {
      this.selectedId = agents[0]?.id || null;
    }
    this.renderCards();
    this.renderRail();
    if (this.sub) {
      const providers = (store.get('providers') || []).length;
      this.sub.textContent = `${agents.length} agent${agents.length === 1 ? '' : 's'} · ${providers} provider${providers === 1 ? '' : 's'}`;
    }
  }

  _agent() {
    return (store.get('agents') || []).find(a => a.id === this.selectedId) || null;
  }

  _usageFor(agentId) {
    const metrics = store.get('metrics') || { sessions: {} };
    let prompt = 0, completion = 0, calls = 0;
    Object.values(metrics.sessions || {}).forEach(sess => {
      const e = sess?.agents?.[agentId];
      if (!e) return;
      prompt += e.prompt || 0;
      completion += e.completion || 0;
      calls += e.calls || 0;
    });
    return { prompt, completion, calls, total: prompt + completion };
  }

  _lastUsed(agentId) {
    const convs = store.get('conversations') || [];
    let last = 0;
    for (const c of convs) {
      for (const m of (c.messages || [])) {
        if (m && m.agentId === agentId && Number(m.timestamp) > last) last = Number(m.timestamp);
      }
    }
    return last;
  }

  renderCards() {
    const agents = store.get('agents') || [];
    const providers = store.get('providers') || [];
    if (!agents.length) {
      this.grid.innerHTML = '<div class="bl-empty">No agents yet. Use <b>+ AGENT</b> above.</div>';
      return;
    }
    const cards = agents.map(agent => {
      const provider = providers.find(p => p.id === agent.provider);
      const u = this._usageFor(agent.id);
      const last = this._lastUsed(agent.id);
      const mem = memory.usageFor(agent.id);
      const locks = ['temperature', 'maxTokens', 'historyTurns', 'rateEnabled', 'rateRpm', 'rateMaxWaitMs', 'rateStealth', 'tokenBudget', 'autoApprove', 'autoDeny', 'toolPolicy']
        .filter(k => isLocked(agent, k)).length;
      const temp = settingFor(agent, 'temperature');
      const max = settingFor(agent, 'maxTokens');
      const rpm = settingFor(agent, 'rateRpm');
      const files = Array.isArray(agent.files) ? agent.files.length : 0;
      const badges = [
        agent.alwaysOn ? '<span class="bl-badge loop">LOOP</span>' : '',
        locks ? `<span class="bl-badge lock">${locks} LOCKED</span>` : '',
        `<span class="bl-badge mem">${mem.mine}/${mem.shared} MEM</span>`,
        files ? `<span class="bl-badge file">${files} FILE${files === 1 ? '' : 'S'}</span>` : '',
      ].join('');
      return `<div class="bl-card${agent.id === this.selectedId ? ' selected' : ''}"
          data-agent-id="${esc(agent.id)}" tabindex="0" role="button"
          aria-label="${esc(agent.name)} details">
        <div class="bl-card-top">
          <span class="bl-dot ${agent.active ? 'on' : ''}" style="background:${esc(agent.color || '#00e5ff')}"></span>
          <span class="bl-card-code">${esc(agentCode(agent))}</span>
          <span class="bl-card-name">${esc(agent.name)}</span>
          <span class="bl-card-edit" data-bl-edit="${esc(agent.id)}" title="Open the full agent editor">✎</span>
        </div>
        <div class="bl-card-role">${esc(agent.role || 'agent')}${agent.label ? ` · ${esc(agent.label)}` : ''}</div>
        <div class="bl-card-model" title="${esc(agent.model || '')}">${esc(agent.model || 'no model')}</div>
        <div class="bl-card-provider">${esc(provider?.name || 'no provider')}</div>
        <div class="bl-card-stats">
          <div><b>${esc(String(temp))}</b><span>TEMP</span></div>
          <div><b>${fmtTokens(max)}</b><span>MAX</span></div>
          <div><b>${esc(String(rpm))}</b><span>RPM</span></div>
          <div><b>${fmtTokens(u.total)}</b><span>TOKENS</span></div>
        </div>
        <div class="bl-card-foot">
          <span class="bl-state ${agent.active ? 'on' : ''}">${agent.active ? 'ACTIVE' : 'IDLE'}</span>
          <span class="bl-card-last">${last ? this._ago(last) : 'never used'}</span>
        </div>
        <div class="bl-card-badges">${badges}</div>
      </div>`;
    }).join('');
    this.grid.innerHTML = cards;
  }

  _ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  _sec(id, label, badge, body) {
    const b = badge && badge.text
      ? `<span class="cfg-section-badge ${badge.cls || ''}">${esc(badge.text)}</span>`
      : '';
    return `<details class="cfg-section bl-sec" data-bl-sec="${id}"${this._openSections.has(id) ? ' open' : ''}>
      <summary class="cfg-section-head">
        <span class="cfg-chevron" aria-hidden="true">▸</span>
        <span class="cfg-section-title">${esc(label)}</span>
        ${b}
      </summary>
      <div class="cfg-body">${body}</div>
    </details>`;
  }

  renderRail() {
    const agent = this._agent();
    if (!agent) {
      this.rail.innerHTML = '<div class="bl-empty">Select an agent card, or create one.</div>';
      return;
    }
    const samplingLocks = ['temperature', 'maxTokens', 'historyTurns'].filter(k => isLocked(agent, k)).length;
    const files = Array.isArray(agent.files) ? agent.files : [];
    const sandboxRoots = this.sandboxFiles?.roots || [];
    const ownRoot = String(agent.sandboxRoot || '');
    const rootSeen = new Set(sandboxRoots.map(r => r.path));
    const rootOpts = [
      `<option value=""${ownRoot ? '' : ' selected'}>GLOBAL / FOLLOW SETTINGS</option>`,
      ...sandboxRoots.map(r => `<option value="${escAttr(r.path)}"${ownRoot === r.path ? ' selected' : ''}>${esc(r.path)}${r.write ? '' : ' (read only)'}</option>`),
      ...(ownRoot && !rootSeen.has(ownRoot)
        ? [`<option value="${escAttr(ownRoot)}" selected>${esc(ownRoot)} (missing from allowlist)</option>`]
        : []),
    ].join('');
    const chosenRoot = sandboxRootFor(agent);
    const rootAllowed = p => {
      const clean = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
      return !!clean && sandboxRoots.some(r => {
        const q = r.path.replace(/\\/g, '/').replace(/\/+$/, '');
        return clean === q || clean.startsWith(q + '/');
      });
    };
    const effectiveRoot = rootAllowed(chosenRoot)
      ? chosenRoot
      : (sandboxRoots[0]?.path || chosenRoot);
    const providers = store.get('providers') || [];
    const provOpts = [
      ...providers.map(p => ({ id: p.id, name: p.name })),
      ...(providers.some(p => p.id === agent.provider) ? [] : [{ id: agent.provider, name: agent.provider || '(missing)' }]),
    ].map(p => `<option value="${esc(p.id)}"${p.id === agent.provider ? ' selected' : ''}>${esc(p.name)}</option>`).join('');

    const protoSelected = String(agent.toolProtocol || 'auto').toLowerCase();
    const protoEffective = toolProtocolFor(agent);
    const protoHint = protoSelected === 'auto'
      ? `Auto -> ${protocolLabel(protoEffective)} for ${agent.provider || 'this provider'}${agent.model ? ' / ' + agent.model : ''}.`
      : protocolHint(protoEffective);
    // What the harness registry detected for this agent, so the operator can
    // see which API shape and tool dialect it will be fitted with.
    const providerEndpoint = (store.get('providers') || []).find(p => p.id === agent.provider)?.endpoint || '';
    const detected = harnessFor({ provider: agent.provider, endpoint: providerEndpoint, model: agent.model });
    const harnessHint = `Detected: ${detected.label} - ${protocolLabel(detected.toolProtocol).replace(/ \(.*\)$/, '')} tools`;
    const protoOpts = TOOL_PROTOCOLS.map(p =>
      `<option value="${p.id}"${p.id === protoSelected ? ' selected' : ''} title="${escAttr(p.hint)}">${esc(p.label)}</option>`
    ).join('');

    this.rail.innerHTML = `
      ${this._sec('identity', 'Identity', { text: agent.active ? 'ACTIVE' : 'IDLE', cls: agent.active ? 'ok' : '' }, `
        <div class="form-group"><label class="form-label">Name</label>
          <input class="form-input" data-bl-field="name" value="${esc(agent.name || '')}"></div>
        <div class="form-group"><label class="form-label">Label</label>
          <input class="form-input" data-bl-field="label" value="${esc(agent.label || '')}" maxlength="24"></div>
        <div class="form-group"><label class="form-label">Role</label>
          <input class="form-input" data-bl-field="role" value="${esc(agent.role || '')}"></div>
        <div class="form-group"><label class="form-label">Provider</label>
          <select class="form-select" data-bl-field="provider">${provOpts}</select></div>
        <div class="form-group"><label class="form-label">Model</label>
          <input class="form-input" data-bl-field="model" value="${esc(agent.model || '')}" spellcheck="false"></div>
        <div class="form-group"><label class="form-label">Colour</label>
          <input class="form-input" type="color" data-bl-field="color" value="${esc(agent.color || '#00e5ff')}" style="height:34px;padding:2px"></div>
        <div class="form-group"><label class="form-label">Active</label>
          <select class="form-select" data-bl-field="active">
            <option value="on"${agent.active ? ' selected' : ''}>On</option>
            <option value="off"${agent.active ? '' : ' selected'}>Off</option>
          </select></div>
        <button class="btn btn-ghost btn-block" data-bl-act="edit-agent">OPEN FULL AGENT EDITOR</button>
      `)}

      ${this._sec('sampling', 'Sampling & Context', { text: samplingLocks ? `${samplingLocks} LOCKED` : 'GLOBAL' }, `
        ${this._lockRow(agent, 'temperature', 'Temperature',
          `<input class="form-input" type="number" min="0" max="2" step="0.1" data-bl-field="temperature" value="${esc(String(settingFor(agent, 'temperature')))}"${isLocked(agent, 'temperature') ? '' : ' disabled'}>`)}
        ${this._lockRow(agent, 'maxTokens', 'Max tokens',
          `<input class="form-input" type="number" min="256" max="131072" step="256" data-bl-field="maxTokens" value="${esc(String(settingFor(agent, 'maxTokens')))}"${isLocked(agent, 'maxTokens') ? '' : ' disabled'}>`)}
        ${this._lockRow(agent, 'historyTurns', 'History turns',
          `<input class="form-input" type="number" min="0" max="50" data-bl-field="historyTurns" value="${esc(String(settingFor(agent, 'historyTurns')))}"${isLocked(agent, 'historyTurns') ? '' : ' disabled'}>`,
          'How many earlier user messages this agent is shown.')}
      `)}

      ${this._sec('rate', 'Rate / Throttle / Pacer', { text: settingFor(agent, 'rateEnabled') ? `${settingFor(agent, 'rateRpm') || 'AUTO'}/min` : 'OFF', cls: settingFor(agent, 'rateEnabled') ? 'ok' : '' }, `
        ${this._lockRow(agent, 'rateEnabled', 'Pace this agent',
          `<select class="form-select" data-bl-field="rateEnabled"${isLocked(agent, 'rateEnabled') ? '' : ' disabled'}>
            <option value="on"${settingFor(agent, 'rateEnabled') ? ' selected' : ''}>On</option>
            <option value="off"${settingFor(agent, 'rateEnabled') ? '' : ' selected'}>Off</option>
          </select>`)}
        ${this._lockRow(agent, 'rateRpm', 'Requests per minute',
          `<input class="form-input" type="number" min="1" max="600" data-bl-field="rateRpm" value="${esc(String(settingFor(agent, 'rateRpm')))}"${isLocked(agent, 'rateRpm') ? '' : ' disabled'}>`)}
        ${this._lockRow(agent, 'rateMaxWaitMs', 'Longest single wait (seconds)',
          `<input class="form-input" type="number" min="5" max="600" data-bl-field="rateMaxWaitMs" value="${esc(String(Math.round(settingFor(agent, 'rateMaxWaitMs') / 1000)))}"${isLocked(agent, 'rateMaxWaitMs') ? '' : ' disabled'}>`)}
        ${this._lockRow(agent, 'rateStealth', 'Stealth waits',
          `<select class="form-select" data-bl-field="rateStealth"${isLocked(agent, 'rateStealth') ? '' : ' disabled'}>
            <option value="on"${settingFor(agent, 'rateStealth') ? ' selected' : ''}>On — no toast while queuing</option>
            <option value="off"${settingFor(agent, 'rateStealth') ? '' : ' selected'}>Off — say how long it waited</option>
          </select>`)}
        ${this._lockRow(agent, 'tokenBudget', 'Token budget (0 = off)',
          `<input class="form-input" type="number" min="0" step="1000" data-bl-field="tokenBudget" value="${esc(String(settingFor(agent, 'tokenBudget')))}"${isLocked(agent, 'tokenBudget') ? '' : ' disabled'}>`)}
        <div class="form-hint">A locked rate gives this agent its own bucket, so a global rate change never moves it. Unlocked agents share the key bucket exactly as before. The token budget only drives the agent card's spent / budget line.</div>
      `)}

      ${this._sec('approvals', 'Approvals & Tools', {
        text: settingFor(agent, 'autoDeny') ? 'AUTO DENY' : (settingFor(agent, 'autoApprove') ? 'AUTO OK' : ''),
        cls: settingFor(agent, 'autoDeny') ? 'danger' : '',
      }, `
        ${this._lockRow(agent, 'autoApprove', 'Auto approve',
          `<select class="form-select" data-bl-field="autoApprove"${isLocked(agent, 'autoApprove') ? '' : ' disabled'}>
            <option value="on"${settingFor(agent, 'autoApprove') ? ' selected' : ''}>On</option>
            <option value="off"${settingFor(agent, 'autoApprove') ? '' : ' selected'}>Off</option>
          </select>`)}
        ${this._lockRow(agent, 'autoDeny', 'Auto deny',
          `<select class="form-select" data-bl-field="autoDeny"${isLocked(agent, 'autoDeny') ? '' : ' disabled'}>
            <option value="on"${settingFor(agent, 'autoDeny') ? ' selected' : ''}>On</option>
            <option value="off"${settingFor(agent, 'autoDeny') ? '' : ' selected'}>Off</option>
          </select>`)}
        ${this._lockRow(agent, 'toolPolicy', 'Per-tool policy',
          ['exec', 'write_file', 'write_note', 'remember'].map(t => {
            const pol = settingFor(agent, 'toolPolicy') || {};
            const mode = pol[t] || 'ask';
            return `<div class="toggle-row">
              <span class="toggle-label">${t === 'exec' ? 'Shell commands' : t === 'write_file' ? 'File writes' : t === 'write_note' ? 'Notes' : 'Private memory'}</span>
              <select class="form-select" data-bl-field="toolPolicy:${t}" style="max-width:120px"${isLocked(agent, 'toolPolicy') ? '' : ' disabled'}>
                ${['allow', 'ask', 'deny'].map(m => `<option value="${m}"${mode === m ? ' selected' : ''}>${m[0].toUpperCase() + m.slice(1)}</option>`).join('')}
              </select>
            </div>`;
          }).join(''))}
        <div class="form-group">
          <label class="form-label">Tool protocol</label>
          <select class="form-select" data-bl-field="toolProtocol">${protoOpts}</select>
          <div class="form-hint">${esc(protoHint)}</div>
          <div class="form-hint" style="opacity:.75">${esc(harnessHint)}</div>
        </div>
        ${this._customToolsHtml(agent)}
      `)}

      ${this._sec('prompt', 'Prompts & Profiles', {
        text: alwaysAppendFor(agent) ? 'APPEND ON' : '',
        cls: alwaysAppendFor(agent) ? 'ok' : '',
      }, `
        <div class="form-group">
          <label class="form-label">System prompt</label>
          <textarea class="form-textarea" rows="5" data-bl-field="systemPrompt" placeholder="This agent's own system prompt...">${esc(agent.systemPrompt || '')}</textarea>
          <div class="form-hint">The global pre-prompt <b>replaces</b> this while armed. Use the box below for anything that must survive that.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Always append <span class="form-hint-inline">cannot be overwritten</span></label>
          <textarea class="form-textarea" rows="4" data-bl-field="customPrompt" placeholder="Directions appended after the system prompt on every call...">${esc(agent.customPrompt || '')}</textarea>
          <div class="form-hint">Appended on every call, including while the global pre-prompt is armed. Locked profiles below are appended here too.</div>
        </div>
        ${this._profilesHtml(agent)}
      `)}

      ${this._sec('files', 'Agent Files', { text: files.length ? `${files.length} FILE${files.length === 1 ? '' : 'S'}` : '', cls: files.length ? 'ok' : '' }, this._filesHtml(agent))}

      ${this._sec('sandbox', 'Sandbox', {
        text: ownRoot ? 'OWN ROOT' : 'GLOBAL',
        cls: ownRoot ? 'ok' : '',
      }, `
        <div class="form-group">
          <label class="form-label">File jail</label>
          <select class="form-select" data-bl-field="sandboxRoot">${rootOpts}</select>
          <div class="form-hint" title="${escAttr(effectiveRoot)}">${esc(effectiveRoot || 'No sandbox root configured.')}</div>
        </div>
        <div class="bl-sandbox-actions">
          <button class="btn btn-ghost" data-bl-act="sandbox-open">OPEN FILES</button>
          <button class="btn btn-ghost" data-bl-act="sandbox-all">USE FOR ALL</button>
        </div>
        <div class="form-hint">This is the root for read_file, list_dir, glob_files, grep_code and write_file, and the working directory for exec. The server still enforces the global allowlist.</div>
        <div class="form-hint">${sandboxRoots.length > 1
          ? 'Assign a different root to each agent; the file manager follows the selected card.'
          : 'Add more paths under Config &rarr; Sandbox to give agents separate jails.'}</div>
      `)}

      ${this._sec('memory', 'Memory', {
        text: `${memory.usageFor(agent.id).mine}/${memory.usageFor(agent.id).shared}`,
      }, this._memoryHtml(agent))}

      ${this._sec('loop', 'Always-On', { text: agent.alwaysOn ? 'LOOP' : '', cls: agent.alwaysOn ? 'ok' : '' }, `
        <div class="toggle-row">
          <span class="toggle-label">Standing goal</span>
          <select class="form-select" data-bl-field="alwaysOn" style="max-width:110px">
            <option value="on"${agent.alwaysOn ? ' selected' : ''}>On</option>
            <option value="off"${agent.alwaysOn ? '' : ' selected'}>Off</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Goal</label>
          <textarea class="form-textarea" rows="3" data-bl-field="alwaysOnGoal" placeholder="What this agent keeps working on...">${esc(agent.alwaysOnGoal || '')}</textarea>
        </div>
        <div class="form-hint">Cadence stays global in Config. The agent only runs while the master Always-On switch is on.</div>
      `)}

      <div class="bl-rail-foot">
        <button class="btn btn-ghost btn-block" data-bl-act="notes">NOTES</button>
        <button class="btn btn-danger btn-block" data-bl-act="delete-agent" style="margin-top:8px">DELETE AGENT</button>
      </div>
    `;

    this.rail.querySelectorAll('details.bl-sec').forEach(det => {
      det.addEventListener('toggle', () => {
        const id = det.dataset.blSec;
        if (det.open) this._openSections.add(id);
        else this._openSections.delete(id);
        this._saveOpenSections();
      });
    });
  }

  _lockRow(agent, key, label, control, hint) {
    const locked = isLocked(agent, key);
    return `<div class="bl-lockrow">
      <div class="bl-lockrow-head">
        <span class="bl-locklabel">${esc(label)}</span>
        <button type="button" class="bl-lock ${locked ? 'on' : ''}" data-bl-lock="${key}"
          title="${locked ? 'Unlock — follow the global setting again' : 'Lock — freeze the current global value on this agent'}">${locked ? 'LOCKED' : 'GLOBAL'}</button>
      </div>
      ${control}
      <div class="form-hint">${locked ? (hint || 'Owned by this agent; global changes do not touch it.') : 'Following the global setting.'}</div>
    </div>`;
  }

  _profilesHtml(agent) {
    const all = profiles();
    const attached = new Set(Array.isArray(agent.profileIds) ? agent.profileIds : []);
    const rows = all.length
      ? all.map(p => `<div class="bl-profile ${attached.has(p.id) ? 'attached' : ''}">
          <div class="bl-profile-name">${esc(p.name || 'Untitled')}</div>
          <div class="bl-profile-text">${esc(String(p.text || '').slice(0, 140))}</div>
          <div class="bl-profile-actions">
            <button class="bl-mini" data-bl-act="prof-lock:${esc(p.id)}">${attached.has(p.id) ? 'UNLOCK' : 'LOCK'}</button>
            <button class="bl-mini" data-bl-act="prof-append:${esc(p.id)}">APPEND</button>
            <button class="bl-mini" data-bl-act="prof-edit:${esc(p.id)}">EDIT</button>
            <button class="bl-mini danger" data-bl-act="prof-del:${esc(p.id)}">✕</button>
          </div>
        </div>`).join('')
      : '<div class="form-hint">No profiles yet. A profile is a reusable block of directions you can append or lock to any number of agents.</div>';
    return `<div class="bl-profiles">
      <div class="bl-profiles-head">
        <span>Profiles</span>
        <button class="bl-mini" data-bl-act="prof-new">+ NEW</button>
      </div>
      ${rows}
    </div>`;
  }

  _filesHtml(agent) {
    const files = Array.isArray(agent.files) ? agent.files : [];
    const rows = files.length
      ? files.map(f => {
          const name = String(f.name || 'file');
          const size = f.size || String(f.text || '').length;
          return `<div class="bl-file-row">
            <span class="bl-file-name" title="${esc(name)}">${esc(name)}</span>
            <span class="bl-file-size">${fmtBytes(size)}</span>
            <button class="bl-mini danger" data-bl-file-del="${esc(f.id)}" title="Remove this file">✕</button>
          </div>`;
        }).join('')
      : '<div class="form-hint">No files attached.</div>';
    return `<div class="bl-files">
      <div class="form-hint">Plain text or Markdown only. Every attached file is included in this agent's prompt on every call.</div>
      <label class="btn btn-ghost btn-block bl-file-add" for="blFileInput">+ ADD TXT / MD</label>
      <input type="file" id="blFileInput" class="bl-file-input" accept=".txt,.md,.markdown,text/plain,text/markdown" multiple>
      <div class="bl-file-list">${rows}</div>
    </div>`;
  }

  async _addFiles(list) {
    const targetId = this.selectedId;
    const input = this.rail.querySelector('#blFileInput');
    if (!targetId) return;
    const picked = [...(list || [])];
    if (!picked.length) return;
    const agent = (store.get('agents') || []).find(a => a.id === targetId);
    const existing = Array.isArray(agent?.files) ? agent.files : [];
    let total = existing.reduce((n, f) => n + String(f.text || '').length, 0);
    const accepted = [];
    let skipped = 0;
    for (const file of picked) {
      const name = String(file.name || 'file');
      if (!/\.(txt|md|markdown)$/i.test(name)) { skipped++; continue; }
      if (file.size > MAX_FILE_CHARS * 4) { skipped++; continue; }
      let text = '';
      try { text = await file.text(); } catch { skipped++; continue; }
      if (!text.trim() || text.includes('\u0000')) { skipped++; continue; }
      if (text.length > MAX_FILE_CHARS
        || total + text.length > MAX_AGENT_FILE_CHARS
        || existing.length + accepted.length >= MAX_AGENT_FILES) {
        skipped++;
        continue;
      }
      accepted.push({
        id: 'file_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name,
        size: file.size || text.length,
        text,
        addedAt: Date.now(),
      });
      total += text.length;
    }
    if (input) input.value = '';
    if (!accepted.length) {
      store.emit('toast', { message: 'No files added — use .txt or .md within the size limit', type: 'error' });
      return;
    }
    this._updateAgent(a => {
      a.files = [...(Array.isArray(a.files) ? a.files : []), ...accepted];
    }, targetId);
    store.emit('toast', {
      message: `Added ${accepted.length} file${accepted.length === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}`,
      type: 'success',
    });
  }

  _removeFile(id) {
    if (!id) return;
    this._updateAgent(agent => {
      agent.files = (Array.isArray(agent.files) ? agent.files : []).filter(f => f.id !== id);
    });
  }

  _memoryHtml(agent) {
    const mine = memory.privateNotes(agent.id);
    const shared = memory.collectiveNotes();
    const row = e => `<div class="bl-mem-row">
      <span class="bl-mem-text">${esc(e.text)}</span>
      <button class="bl-mini danger" data-bl-mem-del="${esc(e.id)}" title="Forget this note">✕</button>
    </div>`;
    return `
      <div class="toggle-row">
        <span class="toggle-label">Long-term memory</span>
        <select class="form-select" data-bl-field="memory" style="max-width:120px">
          <option value="on"${agent.memory !== false ? ' selected' : ''}>On</option>
          <option value="off"${agent.memory === false ? ' selected' : ''}>Off</option>
        </select>
      </div>
      <div class="form-hint" style="margin-bottom:10px">When off, notes are kept but neither read nor offered as tools.</div>
      <div class="bl-mem-block">
        <div class="bl-mem-head"><span>Private</span><span class="bl-mem-count">${mine.length}</span></div>
        <div class="bl-mem-list">${mine.length ? mine.map(row).join('') : '<div class="form-hint">No private notes.</div>'}</div>
        <div class="bl-mem-add">
          <input class="form-input" id="blMemPrivate" placeholder="Add a private note...">
          <button class="bl-mini" data-bl-mem-add="private">ADD</button>
        </div>
      </div>
      <div class="bl-mem-block">
        <div class="bl-mem-head"><span>Collective</span><span class="bl-mem-count">${shared.length}</span></div>
        <div class="bl-mem-list">${shared.length ? shared.map(row).join('') : '<div class="form-hint">No collective notes.</div>'}</div>
        <div class="bl-mem-add">
          <input class="form-input" id="blMemShared" placeholder="Add a note every agent reads...">
          <button class="bl-mini" data-bl-mem-add="shared">SHARE</button>
        </div>
      </div>`;
  }

  _customToolsHtml(agent) {
    const tools = customToolDefs();
    const chosen = new Set(Array.isArray(agent.tools) ? agent.tools : defaultTools());
    const rows = tools.map(def => {
      const on = chosen.has(def.label);
      return `<div class="bl-custom-tool">
        <label class="bl-custom-main">
          <input type="checkbox" data-bl-custom-tool="${esc(def.label)}"${on ? ' checked' : ''}>
          <span class="bl-custom-name">${esc(def.label)}</span>
        </label>
        <span class="bl-custom-pill ${def.needsApproval ? 'ask' : 'run'}">${def.needsApproval ? 'ASK' : 'RUN'}</span>
        <button type="button" class="bl-mini" data-bl-act="custom-edit:${esc(def.label)}">EDIT</button>
        <button type="button" class="bl-mini danger" data-bl-act="custom-del:${esc(def.label)}" title="Delete this tool">✕</button>
        <div class="bl-custom-desc">${esc(def.describe)}</div>
      </div>`;
    }).join('');
    return `<div class="bl-custom-tools">
      <div class="bl-custom-head">
        <span class="bl-custom-title">Custom JS tools</span>
        <button type="button" class="bl-mini" data-bl-act="custom-new">+ NEW TOOL</button>
      </div>
      ${rows || '<div class="form-hint">No custom tools defined yet.</div>'}
      <div class="form-hint">Runs in this browser with your session. Only paste code you trust. The body receives <code>arg</code> and <code>ctx</code>; return the result.</div>
    </div>`;
  }

  _toggleCustomTool(name, on) {
    const agent = this._agent();
    if (!agent || !customToolDefs().some(def => def.label === name)) return;
    const tools = new Set(Array.isArray(agent.tools) ? agent.tools : defaultTools());
    if (on) tools.add(name);
    else tools.delete(name);
    this._updateAgent(a => { a.tools = [...tools]; });
  }

  // ---------------------------------------------------------------- actions

  _updateAgent(mutate, id = this.selectedId) {
    if (!id) return;
    const agents = (store.get('agents') || []).map(a => {
      if (a.id !== id) return a;
      const copy = { ...a, overrides: { ...(a.overrides || {}) } };
      mutate(copy);
      return copy;
    });
    store.set('agents', agents);
    persistence.set('agents', agents);
    store.emit('agents:changed');
  }

  _toggleLock(key) {
    this._updateAgent(agent => {
      if (isLocked(agent, key)) unlockSetting(agent, key);
      else lockSetting(agent, key);
    });
  }

  _onField(field, el) {
    const value = el.value;
    if (field.startsWith('toolPolicy:')) {
      const tool = field.slice('toolPolicy:'.length);
      this._updateAgent(agent => {
        const pol = { ...(settingFor(agent, 'toolPolicy') || {}) };
        pol[tool] = value;
        setSetting(agent, 'toolPolicy', pol);
      });
      return;
    }
    switch (field) {
      case 'temperature':
        this._updateAgent(agent => setSetting(agent, 'temperature', Math.min(2, Math.max(0, parseFloat(value) || 0))));
        break;
      case 'maxTokens':
        this._updateAgent(agent => setSetting(agent, 'maxTokens', Math.min(131072, Math.max(256, parseInt(value, 10) || 256))));
        break;
      case 'historyTurns':
        this._updateAgent(agent => setSetting(agent, 'historyTurns', Math.max(0, parseInt(value, 10) || 0)));
        break;
      case 'rateRpm':
        this._updateAgent(agent => setSetting(agent, 'rateRpm', Math.min(600, Math.max(1, parseInt(value, 10) || 20))));
        break;
      case 'rateMaxWaitMs':
        this._updateAgent(agent => setSetting(agent, 'rateMaxWaitMs', Math.min(600000, Math.max(5000, (parseInt(value, 10) || 65) * 1000))));
        break;
      case 'tokenBudget':
        this._updateAgent(agent => setSetting(agent, 'tokenBudget', Math.max(0, parseInt(value, 10) || 0)));
        break;
      case 'rateEnabled':
      case 'rateStealth':
      case 'autoApprove':
      case 'autoDeny':
        this._updateAgent(agent => setSetting(agent, field, value === 'on'));
        break;
      case 'active':
        this._updateAgent(agent => { agent.active = value === 'on'; });
        break;
      case 'alwaysOn':
        this._updateAgent(agent => { agent.alwaysOn = value === 'on'; });
        break;
      case 'memory':
        this._updateAgent(agent => { agent.memory = value === 'on'; });
        break;
      case 'name':
      case 'label':
      case 'role':
      case 'provider':
      case 'model':
      case 'color':
      case 'systemPrompt':
      case 'customPrompt':
      case 'alwaysOnGoal':
        this._updateAgent(agent => { agent[field] = value; });
        break;
      case 'sandboxRoot':
        this._updateAgent(agent => {
          if (value) agent.sandboxRoot = value;
          else delete agent.sandboxRoot;
        });
        break;
      case 'toolProtocol':
        this._updateAgent(agent => {
          if (value && value !== 'auto') agent.toolProtocol = value;
          else delete agent.toolProtocol;
        });
        break;
      default:
        break;
    }
  }

  _onRailAction(action) {
    if (action === 'edit-agent') { store.emit('agent:edit', this.selectedId); return; }
    if (action === 'custom-new') { this._openCustomToolEditor(null); return; }
    if (action.startsWith('custom-edit:')) {
      const name = action.slice('custom-edit:'.length);
      this._openCustomToolEditor(customToolDefs().find(def => def.label === name) || null);
      return;
    }
    if (action.startsWith('custom-del:')) {
      this._deleteCustomTool(action.slice('custom-del:'.length));
      return;
    }
    if (action === 'notes') { this._toggleNotes(); return; }
    if (action === 'sandbox-open') { this._openSandbox(); return; }
    if (action === 'sandbox-all') { this.sandboxFiles?._useForAll(); return; }
    if (action === 'delete-agent') {
      const agent = this._agent();
      if (!agent) return;
      if (confirm(`Delete ${agent.name}? This cannot be undone.`)) {
        store.emit('agent:delete', agent.id);
      }
      return;
    }
    if (action === 'prof-new') { this._openProfileEditor(null); return; }
    if (action.startsWith('prof-lock:')) {
      const id = action.slice('prof-lock:'.length);
      this._updateAgent(agent => {
        const ids = new Set(Array.isArray(agent.profileIds) ? agent.profileIds : []);
        ids.has(id) ? ids.delete(id) : ids.add(id);
        agent.profileIds = [...ids];
      });
      return;
    }
    if (action.startsWith('prof-append:')) {
      const id = action.slice('prof-append:'.length);
      const p = profiles().find(x => x.id === id);
      if (!p) return;
      this._updateAgent(agent => {
        const add = String(p.text || '').trim();
        if (!add) return;
        agent.customPrompt = [String(agent.customPrompt || '').trim(), add].filter(Boolean).join('\n\n');
      });
      store.emit('toast', { message: 'Profile appended to this agent', type: 'success' });
      return;
    }
    if (action.startsWith('prof-edit:')) {
      this._openProfileEditor(profiles().find(p => p.id === action.slice('prof-edit:'.length)) || null);
      return;
    }
    if (action.startsWith('prof-del:')) {
      const id = action.slice('prof-del:'.length);
      const p = profiles().find(x => x.id === id);
      if (!p || !confirm(`Delete profile "${p.name}"? It will be removed from every agent.`)) return;
      const next = profiles().filter(x => x.id !== id);
      store.set('settings.brainProfiles', next);
      persistence.set('settings', store.get('settings'));
      const agents = (store.get('agents') || []).map(a => {
        if (!Array.isArray(a.profileIds) || !a.profileIds.includes(id)) return a;
        return { ...a, profileIds: a.profileIds.filter(x => x !== id) };
      });
      store.set('agents', agents);
      persistence.set('agents', agents);
      store.emit('agents:changed');
      return;
    }
  }

  // ---------------------------------------------------------------- memory

  _addMemory(pool) {
    const agent = this._agent();
    if (!agent) return;
    const input = this.rail.querySelector(pool === 'shared' ? '#blMemShared' : '#blMemPrivate');
    const text = String(input?.value || '').trim();
    if (!text) return;
    if (pool === 'shared') memory.share(agent.id, text);
    else memory.remember(agent.id, text);
    input.value = '';
    this.render();
    store.emit('toast', { message: pool === 'shared' ? 'Shared with every agent' : 'Private note saved', type: 'success' });
  }

  // ---------------------------------------------------------------- profiles modal

  _openProfileEditor(profile) {
    this._closeProfileEditor();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">${profile ? 'Edit' : 'New'} profile</span>
          <button class="modal-close" data-bl-prof-x>&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Name</label>
            <input class="form-input" id="blProfName" value="${esc(profile?.name || '')}" placeholder="e.g. Terse reviewer">
          </div>
          <div class="form-group">
            <label class="form-label">Directions</label>
            <textarea class="form-textarea" id="blProfText" rows="8" placeholder="Text appended to an agent's prompt when this profile is locked, or copied once when appended.">${esc(profile?.text || '')}</textarea>
          </div>
          <div class="form-hint">Lock keeps a live link: editing this profile updates every agent carrying it. Append copies the text once and leaves it alone afterwards.</div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-bl-prof-cancel>Cancel</button>
          <button class="btn btn-primary" data-bl-prof-save>${profile ? 'Save' : 'Create'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    this._profileModal = overlay;
    const close = () => this._closeProfileEditor();
    overlay.querySelector('[data-bl-prof-x]')?.addEventListener('click', close);
    overlay.querySelector('[data-bl-prof-cancel]')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-bl-prof-save]')?.addEventListener('click', () => {
      const name = String(overlay.querySelector('#blProfName').value || '').trim();
      const text = String(overlay.querySelector('#blProfText').value || '').trim();
      if (!name) { store.emit('toast', { message: 'Give the profile a name', type: 'error' }); return; }
      const list = profiles().slice();
      if (profile) {
        const i = list.findIndex(p => p.id === profile.id);
        if (i >= 0) list[i] = { ...list[i], name, text };
      } else {
        list.push({ id: newProfileId(), name, text });
      }
      store.set('settings.brainProfiles', list);
      persistence.set('settings', store.get('settings'));
      close();
      this.render();
      store.emit('toast', { message: profile ? 'Profile saved' : 'Profile created', type: 'success' });
    });
    setTimeout(() => overlay.querySelector('#blProfName')?.focus(), 0);
  }

  _closeProfileEditor() {
    this._profileModal?.remove();
    this._profileModal = null;
  }

  _openCustomToolEditor(tool = null) {
    this._closeCustomToolEditor();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal bl-custom-modal">
        <div class="modal-header">
          <span class="modal-title">${tool ? 'Edit' : 'New'} custom tool</span>
          <button class="modal-close" data-bl-custom-x>&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Name</label>
            <input class="form-input" id="blCustomName" value="${esc(tool?.label || '')}"
              placeholder="e.g. lookup_order" maxlength="40" spellcheck="false"${tool ? ' disabled' : ''}>
            <div class="form-hint">Lowercase letters, numbers and underscores. ${tool ? 'The name is permanent so agent assignments keep working.' : 'This becomes the tool name the model calls.'}</div>
          </div>
          <div class="form-group">
            <label class="form-label">Description</label>
            <textarea class="form-textarea" id="blCustomDesc" rows="2" maxlength="300"
              placeholder="What it does, and when the model should use it.">${esc(tool?.describe || '')}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Usage instructions <span class="form-hint-inline">optional</span></label>
            <textarea class="form-textarea" id="blCustomInstr" rows="3" maxlength="4000"
              placeholder="Extra rules, limits or examples shown to the model when this tool is enabled.">${esc(tool?.instructions || '')}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Argument hint <span class="form-hint-inline">optional</span></label>
            <input class="form-input" id="blCustomArg" value="${esc(tool?.arg || '')}"
              placeholder="e.g. order id, a URL, or JSON like {&quot;path&quot;:&quot;...&quot;}" maxlength="120" spellcheck="false">
          </div>
          <label class="mem-toggle">
            <input type="checkbox" id="blCustomApproval"${tool?.needsApproval === false ? '' : ' checked'}>
            <span>Ask before running this tool</span>
          </label>
          <div class="form-group" style="margin-top:12px">
            <label class="form-label">JavaScript <span class="form-hint-inline">runs in this page</span></label>
            <textarea class="form-textarea bl-custom-code" id="blCustomCode" rows="14" spellcheck="false"
              placeholder="const res = await fetch('https://example.com/?q=' + encodeURIComponent(arg));&#10;return await res.text();">${esc(tool?.code || '')}</textarea>
            <div class="form-hint">Top-level <code>await</code> and <code>return</code> are allowed. Available: <code>arg</code>, <code>ctx.agentId</code>, <code>ctx.agentName</code>, <code>ctx.sessionId</code>.</div>
          </div>
          <div class="form-hint bl-custom-warn">This code runs with your page session and can reach anything this tab can. Only paste code you trust.</div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-bl-custom-cancel>Cancel</button>
          <button class="btn btn-primary" data-bl-custom-save>${tool ? 'Save' : 'Create'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    this._customToolModal = overlay;
    const close = () => this._closeCustomToolEditor();
    overlay.querySelector('[data-bl-custom-x]')?.addEventListener('click', close);
    overlay.querySelector('[data-bl-custom-cancel]')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-bl-custom-save]')?.addEventListener('click', () => {
      const name = tool ? tool.label : String(overlay.querySelector('#blCustomName')?.value || '').trim();
      const def = {
        name,
        description: String(overlay.querySelector('#blCustomDesc')?.value || '').trim(),
        instructions: String(overlay.querySelector('#blCustomInstr')?.value || '').trim(),
        arg: String(overlay.querySelector('#blCustomArg')?.value || '').trim(),
        needsApproval: !!overlay.querySelector('#blCustomApproval')?.checked,
        code: String(overlay.querySelector('#blCustomCode')?.value || ''),
      };
      const error = validateCustomTool(def, tool?.label || '');
      if (error) {
        store.emit('toast', { message: error, type: 'error' });
        return;
      }
      const raw = store.get('settings.customTools');
      const list = Array.isArray(raw) ? raw.slice() : [];
      const index = list.findIndex(item => item && item.name === name);
      const record = { ...def, createdAt: tool?.createdAt || Date.now(), updatedAt: Date.now() };
      if (index >= 0) list[index] = record;
      else list.push(record);
      store.set('settings.customTools', list);
      persistence.set('settings', store.get('settings'));
      loadCustomTools();
      close();
      this.render();
      store.emit('toast', { message: tool ? 'Custom tool saved' : 'Custom tool created', type: 'success' });
    });
    setTimeout(() => {
      const focus = tool ? overlay.querySelector('#blCustomDesc') : overlay.querySelector('#blCustomName');
      focus?.focus();
    }, 0);
  }

  _closeCustomToolEditor() {
    this._customToolModal?.remove();
    this._customToolModal = null;
  }

  _deleteCustomTool(name) {
    const raw = store.get('settings.customTools');
    const list = Array.isArray(raw) ? raw.slice() : [];
    if (!list.some(item => item && item.name === name)) return;
    if (!confirm(`Delete custom tool "${name}"? It will be removed from every agent.`)) return;
    store.set('settings.customTools', list.filter(item => !item || item.name !== name));
    persistence.set('settings', store.get('settings'));
    const agents = (store.get('agents') || []).map(agent => {
      if (!Array.isArray(agent.tools) || !agent.tools.includes(name)) return agent;
      return { ...agent, tools: agent.tools.filter(t => t !== name) };
    });
    store.set('agents', agents);
    persistence.set('agents', agents);
    store.emit('agents:changed');
    loadCustomTools();
    this.render();
    store.emit('toast', { message: 'Custom tool deleted', type: 'success' });
  }

  // ---------------------------------------------------------------- notes

  _toggleNotes(force) {
    const show = force === undefined ? this.notes.hidden : force;
    if (show) {
      this.notesText.value = String(store.get('settings.brainNotes') || '');
      this.notes.hidden = false;
      setTimeout(() => this.notesText.focus(), 0);
    } else {
      this._saveNotes();
      this.notes.hidden = true;
    }
  }

  _saveNotes() {
    if (!this.notesText) return;
    const text = this.notesText.value;
    if (text === String(store.get('settings.brainNotes') || '')) return;
    store.set('settings.brainNotes', text);
    persistence.set('settings', store.get('settings'));
  }
}

export default BrainLab;
