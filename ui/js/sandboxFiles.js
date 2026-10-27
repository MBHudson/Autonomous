/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

import { store } from './store.js?v=353';
import { persistence } from './persistence.js?v=353';
import { api } from './api.js?v=353';
import { esc, escAttr } from './utils.js?v=353';
import { renderMarkdown } from './markdown.js?v=353';
import { sandboxRootFor } from './agentConfig.js?v=353';

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  'json', 'jsonc', 'xml', 'svg', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env',
  'php', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'bash',
  'ps1', 'sql', 'log', 'csv', 'tsv', 'gitignore', 'htaccess', 'lock', 'vue', 'svelte',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const MEDIA_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'mp4', 'webm', 'mov', 'ogv']);
const MAX_UPLOAD = 24 * 1024 * 1024;
const MAX_PREVIEW = 2 * 1024 * 1024;

function extOf(name) {
  const i = String(name || '').lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
}

function joinPath(dir, name) {
  const a = String(dir || '').replace(/^\/+|\/+$/g, '');
  const b = String(name || '').replace(/^\/+|\/+$/g, '');
  return a && b ? `${a}/${b}` : (a || b);
}

function parentOf(rel) {
  const clean = String(rel || '').replace(/\/+$/g, '');
  const i = clean.lastIndexOf('/');
  return i < 0 ? '' : clean.slice(0, i);
}

function baseOf(rel) {
  const clean = String(rel || '').replace(/\/+$/g, '');
  const i = clean.lastIndexOf('/');
  return i < 0 ? clean : clean.slice(i + 1);
}

function fmtBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}

function fmtDate(sec) {
  if (!sec) return '';
  try {
    return new Date(Number(sec) * 1000).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
}

function b64ToBlob(data, mime) {
  const raw = atob(String(data || ''));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function iconFor(entry) {
  if (entry.type === 'dir') return 'DIR';
  const e = extOf(entry.name);
  if (IMAGE_EXT.has(e)) return 'IMG';
  if (e === 'pdf') return 'PDF';
  if (MEDIA_EXT.has(e)) return 'AV';
  if (['zip', 'gz', 'tgz', 'tar', '7z', 'rar'].includes(e)) return 'ZIP';
  if (TEXT_EXT.has(e)) return 'TXT';
  return 'BIN';
}

/**
 * The sandbox file manager.
 *
 * It is deliberately a view inside Brain Lab, not a separate modal: the rail
 * keeps the selected agent visible while the drawer uses that agent's root.
 * Every server action still goes through the allowlist; selecting a root here
 * narrows the jail, it never widens it.
 */
export class SandboxFiles {
  constructor() {
    this.el = null;
    this.host = null;
    this.getAgent = null;
    this.open = false;
    this.agentId = null;
    this.root = '';
    this.rel = '';
    this.entries = [];
    this.roots = [];
    this.writable = false;
    this.selected = new Set();
    this._token = 0;
    this._previewToken = 0;
    this._previewPath = null;
    this._previewEntry = null;
    this._blobUrl = null;
    this._busy = 0;
  }

  init(host, getAgent) {
    this.host = host;
    this.getAgent = getAgent;
    this.el = document.createElement('section');
    this.el.className = 'sf-panel';
    this.el.id = 'sandboxFiles';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Sandbox files');
    this.el.innerHTML = `
      <header class="sf-head">
        <div class="sf-head-main">
          <span class="sf-eyebrow">BRAIN LAB / SANDBOX</span>
          <span class="sf-title">FILES <span class="sf-agent" id="sfAgent"></span></span>
        </div>
        <label class="sf-root-label" title="The directory this agent is jailed to">
          <span>ROOT</span>
          <select class="sf-root" id="sfRoot"></select>
        </label>
        <button class="sf-btn" id="sfAll" title="Give every agent the same root">USE FOR ALL</button>
        <button class="sf-x" id="sfClose" title="Close (Esc)">&times;</button>
      </header>
      <div class="sf-bar">
        <div class="sf-crumbs" id="sfCrumbs"></div>
        <div class="sf-bulk" id="sfBulk" hidden></div>
      </div>
      <div class="sf-toolbar">
        <button class="sf-btn" data-sf-tool="new-file" title="Create a file here">+ FILE</button>
        <button class="sf-btn" data-sf-tool="new-dir" title="Create a directory here">+ DIR</button>
        <button class="sf-btn" data-sf-tool="upload" title="Upload files">UPLOAD</button>
        <button class="sf-btn" data-sf-tool="upload-folder" title="Upload a folder">UPLOAD DIR</button>
        <span class="sf-tool-sep"></span>
        <button class="sf-btn" data-sf-tool="download" title="Download selected">DOWNLOAD</button>
        <button class="sf-btn" data-sf-tool="zip" title="Zip selected">ZIP</button>
        <button class="sf-btn" data-sf-tool="unzip" title="Extract the selected .zip">UNZIP</button>
        <span class="sf-tool-sep"></span>
        <button class="sf-btn" data-sf-tool="copy" title="Copy selected">COPY</button>
        <button class="sf-btn" data-sf-tool="move" title="Move selected">MOVE</button>
        <button class="sf-btn" data-sf-tool="chmod" title="Change permissions">CHMOD</button>
        <button class="sf-btn sf-danger" data-sf-tool="remove" title="Delete selected">DELETE</button>
        <button class="sf-btn" data-sf-tool="refresh" title="Reload this directory">REFRESH</button>
        <input type="file" id="sfUpload" multiple hidden>
        <input type="file" id="sfUploadDir" webkitdirectory directory multiple hidden>
      </div>
      <div class="sf-body">
        <div class="sf-list" id="sfList"></div>
        <div class="sf-preview" id="sfPreview" hidden></div>
      </div>
      <footer class="sf-status" id="sfStatus">Ready</footer>`;
    host.appendChild(this.el);
    this._bind();
    store.on('agents:changed', () => {
      if (!this.open) return;
      const agent = this._agent();
      if (!agent) { this.close(); return; }
      this._syncAgent();
    });
  }

  _agent() {
    const id = this.agentId;
    return (store.get('agents') || []).find(a => a.id === id) || this.getAgent?.() || null;
  }

  _bind() {
    this.el.querySelector('#sfClose')?.addEventListener('click', () => this.close());
    this.el.querySelector('#sfAll')?.addEventListener('click', () => this._useForAll());
    this.el.querySelector('#sfRoot')?.addEventListener('change', (e) => {
      this._setAgentRoot(e.target.value);
    });
    this.el.querySelector('#sfUpload')?.addEventListener('change', (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      this._upload(files);
    });
    this.el.querySelector('#sfUploadDir')?.addEventListener('change', (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      this._upload(files);
    });
    this.el.querySelector('.sf-toolbar')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sf-tool]');
      if (btn) this._tool(btn.dataset.sfTool);
    });
    this.el.querySelector('#sfCrumbs')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sf-nav]');
      if (b) this.loadDir(b.dataset.sfNav);
    });
    this.el.querySelector('#sfList')?.addEventListener('click', (e) => {
      const pick = e.target.closest('[data-sf-pick]');
      if (pick) { this._togglePick(pick.dataset.sfPick); return; }
      const act = e.target.closest('[data-sf-act]');
      if (act) {
        this._rowAction(act.dataset.sfAct, act.dataset.sfPath, act.dataset.sfType);
        return;
      }
      const open = e.target.closest('[data-sf-open]');
      if (open) {
        const path = open.dataset.sfOpen;
        if (open.dataset.sfType === 'dir') this.loadDir(path);
        else this.preview(path);
      }
    });
    this._dragDepth = 0;
    this.el.addEventListener('dragenter', (e) => {
      if (!this._hasFiles(e)) return;
      e.preventDefault();
      this._dragDepth++;
      this.el.classList.add('sf-drop');
    });
    this.el.addEventListener('dragover', (e) => {
      if (!this._hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    this.el.addEventListener('dragleave', (e) => {
      if (!this._hasFiles(e)) return;
      this._dragDepth = Math.max(0, this._dragDepth - 1);
      if (!this._dragDepth) this.el.classList.remove('sf-drop');
    });
    this.el.addEventListener('drop', (e) => {
      if (!this._hasFiles(e)) return;
      e.preventDefault();
      this._dragDepth = 0;
      this.el.classList.remove('sf-drop');
      this._filesFromDrop(e.dataTransfer)
        .then(files => this._upload(files))
        .catch(err => {
          this._status(err.message || String(err), true);
          store.emit('toast', { message: err.message || String(err), type: 'error' });
        });
    });
  }

  _hasFiles(e) {
    const dt = e.dataTransfer;
    return !!dt && [...(dt.types || [])].includes('Files');
  }

  async _filesFromDrop(dt) {
    const items = [...(dt.items || [])];
    const entries = items
      .map(item => item.kind === 'file' && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null)
      .filter(Boolean);
    if (!entries.length) return [...(dt.files || [])];
    const out = [];
    const readAll = reader => new Promise((resolve, reject) => {
      const chunks = [];
      const next = () => reader.readEntries(batch => {
        if (!batch.length) { resolve(chunks); return; }
        chunks.push(...batch);
        next();
      }, reject);
      next();
    });
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        try { file.__sfRel = prefix + file.name; } catch { /* read-only File */ }
        out.push(file);
        return;
      }
      if (!entry.isDirectory) return;
      const children = await readAll(entry.createReader());
      for (const child of children) await walk(child, `${prefix}${entry.name}/`);
    };
    for (const entry of entries) await walk(entry, '');
    return out;
  }

  async prefetch() {
    try {
      const res = await api.getSandboxStatus();
      this.roots = this._rootsFrom(res);
    } catch { this.roots = []; }
    return this.roots;
  }

  _rootsFrom(res) {
    const map = new Map();
    for (const r of res?.read_roots || res?.roots || []) {
      if (typeof r === 'string' && r) map.set(r, { path: r, write: false });
    }
    for (const r of res?.write_roots || []) {
      if (typeof r !== 'string' || !r) continue;
      map.set(r, { path: r, write: true });
    }
    return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  _isAllowedRoot(root) {
    const p = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!p) return false;
    return this.roots.some(r => {
      const q = r.path.replace(/\\/g, '/').replace(/\/+$/, '');
      return p === q || p.startsWith(q + '/');
    });
  }

  _effectiveRoot(agent) {
    const chosen = sandboxRootFor(agent);
    if (chosen && this._isAllowedRoot(chosen)) return chosen;
    return this.roots[0]?.path || chosen || '';
  }

  _isWritableRoot(root) {
    const p = String(root || '').replace(/\/+$/, '');
    return this.roots.some(r => {
      const q = r.path.replace(/\/+$/, '');
      return r.write && (p === q || p.startsWith(q + '/'));
    });
  }

  async show(agentId) {
    if (!this.el) return;
    if (this._agentIdFrom(agentId)) this.agentId = agentId;
    await this.prefetch();
    this.open = true;
    this.el.hidden = false;
    this.host?.classList.add('sf-open');
    this.el.closest('.brainlab')?.classList.add('sf-open');
    const agent = this._agent();
    this._renderAgent(agent);
    await this._syncAgent(true);
  }

  _agentIdFrom(id) {
    return (store.get('agents') || []).some(a => a.id === id);
  }

  close() {
    this.open = false;
    if (this.el) this.el.hidden = true;
    this.host?.classList.remove('sf-open');
    this.el?.closest('.brainlab')?.classList.remove('sf-open');
    this._clearPreview();
  }

  toggle(agentId) {
    if (this.open) this.close();
    else this.show(agentId);
  }

  async _syncAgent(reset = false) {
    const agent = this._agent();
    if (!agent) { this.close(); return; }
    this.agentId = agent.id;
    this._renderAgent(agent);
    this._renderRoot();
    const next = this._effectiveRoot(agent);
    if (reset || next !== this.root) {
      this.root = next;
      this.rel = '';
      this.selected.clear();
      await this.loadDir('');
    } else {
      this._renderRoot();
    }
  }

  _renderAgent(agent) {
    const name = agent ? agent.name : 'No agent';
    const el = this.el?.querySelector('#sfAgent');
    if (el) el.textContent = name ? `/ ${name}` : '';
  }

  _renderRoot() {
    const sel = this.el?.querySelector('#sfRoot');
    if (!sel) return;
    const agent = this._agent();
    const own = String(agent?.sandboxRoot || '');
    const fallback = own ? '' : this._effectiveRoot(agent);
    const globalLabel = `GLOBAL / FOLLOW SETTINGS${fallback ? ` -> ${fallback}` : ''}`;
    const opts = [`<option value="">${esc(globalLabel)}</option>`];
    const seen = new Set();
    for (const r of this.roots) {
      seen.add(r.path);
      const label = `${r.path}${r.write ? '' : ' (read only)'}`;
      opts.push(`<option value="${escAttr(r.path)}">${esc(label)}</option>`);
    }
    if (own && !seen.has(own)) {
      opts.push(`<option value="${escAttr(own)}">${esc(own)} (missing from allowlist)</option>`);
    }
    sel.innerHTML = opts.join('');
    sel.value = own;
  }

  _setAgentRoot(value) {
    const agents = store.get('agents') || [];
    const idx = agents.findIndex(a => a.id === this.agentId);
    if (idx < 0) return;
    const next = agents.map((a, i) => {
      if (i !== idx) return a;
      const copy = { ...a };
      if (value) copy.sandboxRoot = value;
      else delete copy.sandboxRoot;
      return copy;
    });
    store.set('agents', next);
    persistence.set('agents', next);
    store.emit('agents:changed');
    this.root = value && this._isAllowedRoot(value)
      ? value
      : (this.roots[0]?.path || String(store.get('settings.projectDir') || ''));
    this.rel = '';
    this.selected.clear();
    this.loadDir('');
    store.emit('toast', {
      message: value ? `Sandbox for ${this._agent()?.name || 'agent'} set` : 'Agent follows global sandbox',
      type: 'success',
    });
  }

  async _useForAll() {
    const agents = store.get('agents') || [];
    if (!agents.length) return;
    const value = String(this._agent()?.sandboxRoot || '');
    const label = value || 'the global sandbox';
    if (!await this._confirm('Use for all', `Give all ${agents.length} agent(s) ${label}?`, 'APPLY')) return;
    const next = agents.map(a => {
      const copy = { ...a };
      if (value) copy.sandboxRoot = value;
      else delete copy.sandboxRoot;
      return copy;
    });
    store.set('agents', next);
    persistence.set('agents', next);
    store.emit('agents:changed');
    store.emit('toast', { message: `All agents now use ${label}`, type: 'success' });
  }

  async loadDir(rel = '') {
    if (!this.root) {
      this.entries = [];
      this._renderList();
      this._status('No sandbox root configured. Add one in Config, or pick a root above.');
      return;
    }
    const token = ++this._token;
    this._status('Loading...');
    try {
      const res = await api.sandbox('list', { path: rel || '.', limit: 500, root: this.root });
      if (token !== this._token) return;
      this.rel = rel;
      this.entries = res.entries || [];
      this.selected.clear();
      this._renderCrumbs();
      this._renderList();
      this._status(`${this.entries.length} item${this.entries.length === 1 ? '' : 's'}${res.writable === false ? ' - read only' : ''}`);
    } catch (err) {
      if (token !== this._token) return;
      this.entries = [];
      this._renderList();
      this._status(`Cannot list ${rel || this.root}: ${err.message}`, true);
    }
  }

  _renderCrumbs() {
    const el = this.el?.querySelector('#sfCrumbs');
    if (!el) return;
    const parts = String(this.rel || '').split('/').filter(Boolean);
    let path = '';
    const out = [`<button class="sf-crumb" data-sf-nav="" title="${escAttr(this.root)}">${esc(baseOf(this.root) || this.root)}</button>`];
    for (const part of parts) {
      path = joinPath(path, part);
      out.push('<span class="sf-slash">/</span>');
      out.push(`<button class="sf-crumb" data-sf-nav="${escAttr(path)}">${esc(part)}</button>`);
    }
    el.innerHTML = out.join('');
    this._bulkCount();
  }

  _bulkCount() {
    const el = this.el?.querySelector('#sfBulk');
    if (!el) return;
    el.hidden = this.selected.size === 0;
    el.textContent = this.selected.size ? `${this.selected.size} selected` : '';
  }

  _sortEntries() {
    return [...this.entries].sort((a, b) => {
      if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
    });
  }

  _renderList() {
    const el = this.el?.querySelector('#sfList');
    if (!el) return;
    if (!this.root) {
      el.innerHTML = '<div class="sf-empty">No sandbox directory is available for this agent.<br><span>Set a working directory in Config, then reopen this drawer.</span></div>';
      return;
    }
    const rows = this._sortEntries();
    if (!rows.length) {
      el.innerHTML = '<div class="sf-empty">This directory is empty.<br><span>Drop files here, or use + FILE / UPLOAD.</span></div>';
      return;
    }
    const writable = this._isWritableRoot(this.root);
    el.innerHTML = rows.map(entry => {
      const path = joinPath(this.rel, entry.name);
      const type = entry.type || 'file';
      const meta = type === 'dir'
        ? `${entry.mode || ''}`
        : `${fmtBytes(entry.size)} | ${fmtDate(entry.mtime)}${entry.mode ? ' | ' + entry.mode : ''}`;
      const checked = this.selected.has(path) ? ' checked' : '';
      return `
        <div class="sf-row ${checked ? 'picked' : ''}" data-sf-row="${escAttr(path)}">
          <input class="sf-check" type="checkbox" data-sf-pick="${escAttr(path)}"${checked} title="Select">
          <span class="sf-kind">${iconFor(entry)}</span>
          <button class="sf-name" data-sf-open="${escAttr(path)}" data-sf-type="${escAttr(type)}" title="${escAttr(path)}">${esc(entry.name)}${type === 'dir' ? '/' : ''}</button>
          <span class="sf-meta">${esc(meta)}</span>
          <span class="sf-acts">
            <button class="sf-act" data-sf-act="download" data-sf-path="${escAttr(path)}" data-sf-type="${escAttr(type)}" title="Download">DL</button>
            <button class="sf-act" data-sf-act="rename" data-sf-path="${escAttr(path)}" data-sf-type="${escAttr(type)}" title="Rename">REN</button>
            <button class="sf-act" data-sf-act="copy" data-sf-path="${escAttr(path)}" data-sf-type="${escAttr(type)}" title="Copy">CP</button>
            <button class="sf-act" data-sf-act="move" data-sf-path="${escAttr(path)}" data-sf-type="${escAttr(type)}" title="Move">MV</button>
            <button class="sf-act" data-sf-act="chmod" data-sf-path="${escAttr(path)}" data-sf-type="${escAttr(type)}" title="Permissions">755</button>
            ${writable ? `<button class="sf-act sf-danger" data-sf-act="remove" data-sf-path="${escAttr(path)}" data-sf-type="${escAttr(type)}" title="Delete">DEL</button>` : ''}
          </span>
        </div>`;
    }).join('');
  }

  _togglePick(path) {
    const on = !this.selected.has(path);
    if (on) this.selected.add(path);
    else this.selected.delete(path);
    const row = [...this.el.querySelectorAll('[data-sf-row]')].find(r => r.dataset.sfRow === path);
    if (row) {
      row.classList.toggle('picked', on);
      const box = row.querySelector('[data-sf-pick]');
      if (box) box.checked = on;
    }
    this._bulkCount();
  }

  _selectedPaths() {
    return [...this.selected];
  }

  _status(text, error = false) {
    const el = this.el?.querySelector('#sfStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', !!error);
  }

  _busyStart(text) {
    this._busy++;
    this._status(text);
  }

  _busyEnd(text, error = false) {
    this._busy = Math.max(0, this._busy - 1);
    if (!this._busy) this._status(text, error);
  }

  async _tool(name) {
    try {
      if (name === 'new-file') return await this._newFile();
      if (name === 'new-dir') return await this._newDir();
      if (name === 'upload') return this.el.querySelector('#sfUpload')?.click();
      if (name === 'upload-folder') return this.el.querySelector('#sfUploadDir')?.click();
      if (name === 'refresh') return this.loadDir(this.rel);
      if (name === 'download') return await this._downloadSelected();
      if (name === 'zip') return await this._zipSelected();
      if (name === 'unzip') return await this._unzipSelected();
      if (name === 'copy') return await this._copyMoveSelected(false);
      if (name === 'move') return await this._copyMoveSelected(true);
      if (name === 'chmod') return await this._chmodSelected();
      if (name === 'remove') return await this._removeSelected();
    } catch (err) {
      this._status(err.message || String(err), true);
      store.emit('toast', { message: err.message || String(err), type: 'error' });
    }
  }

  _needWritable() {
    if (this._isWritableRoot(this.root)) return true;
    store.emit('toast', { message: 'This sandbox is read only', type: 'error' });
    return false;
  }

  async _newFile() {
    if (!this._needWritable()) return;
    const name = await this._ask('New file', 'Name', 'untitled.txt');
    if (!name) return;
    const path = joinPath(this.rel, name);
    if (!String(name).includes('/') && this.entries.some(e => e.name === name)) {
      throw new Error(`${name} already exists here`);
    }
    this._busyStart(`Creating ${path}...`);
    await api.sandbox('write', { path, content: '', root: this.root });
    this._busyEnd(`Created ${path}`);
    await this.loadDir(this.rel);
    await this.preview(path);
  }

  async _newDir() {
    if (!this._needWritable()) return;
    const name = await this._ask('New directory', 'Name', 'new-folder');
    if (!name) return;
    const path = joinPath(this.rel, name);
    this._busyStart(`Creating ${path}...`);
    await api.sandbox('mkdir', { path, root: this.root });
    this._busyEnd(`Created ${path}`);
    await this.loadDir(this.rel);
  }

  async _upload(files) {
    if (!this._needWritable() || !files.length) return;
    if (files.length > 200) throw new Error('Too many files at once (limit 200)');
    const token = ++this._token;
    let done = 0;
    for (const file of files) {
      if (token !== this._token) return;
      if (file.size > MAX_UPLOAD) throw new Error(`${file.name} is over the 24 MB upload limit`);
      const relName = String(file.__sfRel || file.webkitRelativePath || file.name).replace(/\\/g, '/').replace(/^\/+/, '');
      if (relName.split('/').includes('..')) throw new Error(`Refusing unsafe path: ${relName}`);
      const path = joinPath(this.rel, relName);
      this._status(`Uploading ${++done}/${files.length}: ${relName}`);
      const data = await this._readBase64(file);
      await api.sandbox('upload', { path, data, root: this.root });
    }
    if (token !== this._token) return;
    this._status(`Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`);
    await this.loadDir(this.rel);
  }

  _readBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.onload = () => {
        const s = String(reader.result || '');
        resolve(s.slice(s.indexOf(',') + 1));
      };
      reader.readAsDataURL(file);
    });
  }

  async _rowAction(action, path, type) {
    try {
      if (action === 'download') return await this._download(path);
      if (action === 'rename') return await this._rename(path);
      if (action === 'copy') return await this._copyMove([path], false, parentOf(path) || this.rel);
      if (action === 'move') return await this._copyMove([path], true, parentOf(path) || this.rel);
      if (action === 'chmod') return await this._chmod([path]);
      if (action === 'remove') return await this._remove([path]);
    } catch (err) {
      this._status(err.message || String(err), true);
      store.emit('toast', { message: err.message || String(err), type: 'error' });
    }
  }

  async _download(path) {
    const entry = this.entries.find(e => joinPath(this.rel, e.name) === path);
    if (entry?.type === 'dir') {
      const temp = joinPath(this.rel, `.sf-${Date.now()}.zip`);
      this._busyStart(`Packing ${baseOf(path)}...`);
      try {
        await api.sandbox('zip', { paths: [path], dest: temp, root: this.root });
        await this._download(temp);
      } finally {
        await api.sandbox('remove', { path: temp, root: this.root }).catch(() => {});
      }
      this._busyEnd('Download ready');
      return;
    }
    this._busyStart(`Downloading ${baseOf(path)}...`);
    const res = await api.sandbox('read_binary', { path, root: this.root });
    const blob = b64ToBlob(res.data, res.mime);
    downloadBlob(blob, res.name || baseOf(path));
    this._busyEnd(`Downloaded ${res.name || baseOf(path)}`);
  }

  async _downloadSelected() {
    const paths = this._selectedPaths();
    if (!paths.length) throw new Error('Select something first');
    if (paths.length === 1) {
      const entry = this.entries.find(e => joinPath(this.rel, e.name) === paths[0]);
      if (entry?.type !== 'dir') return this._download(paths[0]);
    }
    const name = `download-${Date.now()}.zip`;
    const dest = joinPath(this.rel, name);
    this._busyStart('Packing download...');
    try {
      await api.sandbox('zip', { paths, dest, root: this.root });
      await this._download(dest);
    } finally {
      await api.sandbox('remove', { path: dest, root: this.root }).catch(() => {});
    }
    this._busyEnd('Download ready');
  }

  async _rename(path) {
    if (!this._needWritable()) return;
    const name = await this._ask('Rename', 'New name', baseOf(path));
    if (!name || name === baseOf(path)) return;
    const to = joinPath(parentOf(path), name);
    this._busyStart(`Renaming ${baseOf(path)}...`);
    await api.sandbox('move', { from: path, to, root: this.root });
    this._busyEnd(`Renamed to ${name}`);
    await this.loadDir(this.rel);
  }

  async _copyMoveSelected(move) {
    const paths = this._selectedPaths();
    if (!paths.length) throw new Error('Select something first');
    return this._copyMove(paths, move, this.rel);
  }

  async _copyMove(paths, move, base) {
    if (!this._needWritable()) return;
    const verb = move ? 'Move' : 'Copy';
    const copyName = (() => {
      const name = baseOf(paths[0]);
      const i = name.lastIndexOf('.');
      return i > 0 ? `${name.slice(0, i)}-copy${name.slice(i)}` : `${name}-copy`;
    })();
    const dest = await this._ask(
      verb,
      paths.length === 1 ? 'Destination path or new name' : 'Destination directory',
      paths.length === 1 && !move ? joinPath(base, copyName) : '',
    );
    if (!dest) return;
    this._busyStart(`${verb}ing ${paths.length} item(s)...`);
    for (const from of paths) {
      const to = paths.length === 1 ? dest : joinPath(dest, baseOf(from));
      await api.sandbox(move ? 'move' : 'copy', { from, to, root: this.root });
    }
    this._busyEnd(`${verb === 'Copy' ? 'Copied' : 'Moved'} ${paths.length} item(s)`);
    this.selected.clear();
    await this.loadDir(this.rel);
  }

  async _chmodSelected() {
    const paths = this._selectedPaths();
    if (!paths.length) throw new Error('Select something first');
    return this._chmod(paths);
  }

  async _chmod(paths) {
    if (!this._needWritable()) return;
    const mode = await this._ask('Permissions', 'Octal mode (e.g. 644 or 755)', '644');
    if (!mode) return;
    this._busyStart('Changing permissions...');
    for (const path of paths) await api.sandbox('chmod', { path, mode, root: this.root });
    this._busyEnd(`Permissions set to ${mode}`);
    await this.loadDir(this.rel);
  }

  async _removeSelected() {
    const paths = this._selectedPaths();
    if (!paths.length) throw new Error('Select something first');
    return this._remove(paths);
  }

  async _remove(paths) {
    if (!this._needWritable()) return;
    const label = paths.length === 1 ? baseOf(paths[0]) : `${paths.length} items`;
    if (!await this._confirm('Delete', `Delete ${label}? This cannot be undone.`)) return;
    this._busyStart(`Deleting ${label}...`);
    for (const path of paths) await api.sandbox('remove', { path, root: this.root });
    this._busyEnd(`Deleted ${label}`);
    this.selected.clear();
    await this.loadDir(this.rel);
  }

  async _zipSelected() {
    const paths = this._selectedPaths();
    if (!paths.length) throw new Error('Select what to zip');
    const name = await this._ask('Zip', 'Archive name', 'archive.zip');
    if (!name) return;
    await this._zip(paths, name, true);
  }

  async _zip(paths, dest, reload = true) {
    if (!this._needWritable()) return;
    const target = dest.toLowerCase().endsWith('.zip') ? dest : dest + '.zip';
    this._busyStart('Creating zip...');
    const res = await api.sandbox('zip', { paths, dest: target, root: this.root });
    this._busyEnd(`Created ${res.name} (${fmtBytes(res.bytes)})`);
    if (reload) await this.loadDir(this.rel);
  }

  async _unzipSelected() {
    const paths = this._selectedPaths();
    if (paths.length !== 1) throw new Error('Select exactly one .zip');
    const zip = paths[0];
    if (extOf(zip) !== 'zip') throw new Error('That is not a .zip file');
    const def = baseOf(zip).replace(/\.zip$/i, '');
    const dest = await this._ask('Unzip', 'Extract into', joinPath(this.rel, def));
    if (!dest) return;
    this._busyStart(`Extracting ${baseOf(zip)}...`);
    const res = await api.sandbox('unzip', { path: zip, dest, root: this.root });
    this._busyEnd(`Extracted ${res.extracted} item(s)`);
    await this.loadDir(this.rel);
  }

  // -------------------------------------------------------------- preview

  async preview(path) {
    const entry = this.entries.find(e => joinPath(this.rel, e.name) === path);
    if (!entry || entry.type === 'dir') return;
    this._clearPreview();
    this._previewPath = path;
    this._previewEntry = entry;
    const box = this.el?.querySelector('#sfPreview');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = this._previewHead(entry, path) + '<div class="sf-preview-body" id="sfPreviewBody"><div class="sf-empty">Loading...</div></div>';
    box.querySelector('#sfPreviewBack')?.addEventListener('click', () => this._closePreview());
    box.querySelector('#sfPreviewDl')?.addEventListener('click', () => this._download(path).catch(err => {
      this._status(err.message, true);
    }));
    const ext = extOf(entry.name);
    const textLike = entry.mime?.startsWith('text/') || TEXT_EXT.has(ext);
    const token = ++this._previewToken;
    try {
      if (IMAGE_EXT.has(ext) || ext === 'pdf' || MEDIA_EXT.has(ext)) {
        const res = await api.sandbox('read_binary', { path, root: this.root });
        if (token !== this._previewToken) return;
        this._renderMedia(res, entry, ext);
      } else if (textLike) {
        let res;
        try {
          res = await api.sandbox('read_text', { path, root: this.root, max_bytes: MAX_PREVIEW });
        } catch (err) {
          if (!/binary/i.test(err.message || '')) throw err;
          res = await api.sandbox('read_binary', { path, root: this.root });
          if (token !== this._previewToken) return;
          this._renderMedia(res, entry, ext, true);
          return;
        }
        if (token !== this._previewToken) return;
        this._renderText(res.content, entry, ext, res.truncated);
      } else {
        const res = await api.sandbox('stat', { path, root: this.root });
        if (token !== this._previewToken) return;
        this._renderBinaryInfo(entry, path, res);
      }
    } catch (err) {
      if (token !== this._previewToken) return;
      const body = this.el?.querySelector('#sfPreviewBody');
      if (body) body.innerHTML = `<div class="sf-empty error">${esc(err.message || String(err))}</div>`;
    }
  }

  _previewHead(entry, path) {
    const ext = extOf(entry.name);
    const editable = (TEXT_EXT.has(ext) || entry.mime?.startsWith('text/'))
      && this._isWritableRoot(this.root);
    return `
      <div class="sf-preview-head">
        <button class="sf-btn" id="sfPreviewBack" title="Back to files">&larr; BACK</button>
        <span class="sf-kind">${iconFor(entry)}</span>
        <span class="sf-preview-name" title="${escAttr(path)}">${esc(entry.name)}</span>
        <span class="sf-meta">${entry.type === 'dir' ? '' : fmtBytes(entry.size)}${entry.mode ? ' | ' + esc(entry.mode) : ''}</span>
        <span class="sf-spacer"></span>
        ${editable ? '<button class="sf-btn" id="sfPreviewEdit" title="Edit this file">EDIT</button>' : ''}
        <button class="sf-btn" id="sfPreviewDl" title="Download">DOWNLOAD</button>
      </div>`;
  }

  _clearPreview() {
    if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
    const box = this.el?.querySelector('#sfPreview');
    if (box) { box.hidden = true; box.innerHTML = ''; }
    this._previewPath = null;
    this._previewEntry = null;
  }

  _closePreview() {
    this._clearPreview();
    this.loadDir(this.rel);
  }

  _renderText(text, entry, ext, truncated) {
    const body = this.el?.querySelector('#sfPreviewBody');
    if (!body) return;
    const isMd = ext === 'md' || ext === 'markdown';
    const isHtml = ext === 'html' || ext === 'htm';
    const initial = isMd || isHtml ? 'render' : 'source';
    body.innerHTML = `
      ${isMd || isHtml ? `<div class="sf-tabs"><button class="sf-tab active" data-sf-mode="render">${isHtml ? 'PREVIEW' : 'RENDERED'}</button><button class="sf-tab" data-sf-mode="source">SOURCE</button></div>` : ''}
      ${truncated ? '<div class="sf-note">Showing the first 2 MB. Download the file to inspect or edit the rest.</div>' : ''}
      <div class="sf-doc" id="sfDoc"></div>
      ${isHtml ? '<div class="sf-note">HTML preview is sandboxed: scripts can run, but cannot read this page or its storage.</div>' : ''}`;
    const doc = body.querySelector('#sfDoc');
    const show = mode => {
      body.querySelectorAll('[data-sf-mode]').forEach(b => b.classList.toggle('active', b.dataset.sfMode === mode));
      doc.innerHTML = '';
      doc.classList.remove('sf-markdown');
      if (mode === 'render' && isHtml) {
        const frame = document.createElement('iframe');
        frame.className = 'sf-frame';
        frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
        frame.srcdoc = text;
        doc.appendChild(frame);
      } else if (mode === 'render' && isMd) {
        const rendered = renderMarkdown(text);
        rendered.classList.add('sf-markdown');
        doc.appendChild(rendered);
      } else {
        const pre = document.createElement('pre');
        pre.className = 'sf-code';
        pre.textContent = text;
        doc.appendChild(pre);
      }
    };
    body.querySelectorAll('[data-sf-mode]').forEach(b => b.addEventListener('click', () => show(b.dataset.sfMode)));
    show(initial);
    if (truncated) {
      this.el?.querySelector('#sfPreviewEdit')?.remove();
    } else {
      this.el?.querySelector('#sfPreviewEdit')?.addEventListener('click', () => this._renderEditor(entry, text));
    }
  }

  _renderEditor(entry, text) {
    const body = this.el?.querySelector('#sfPreviewBody');
    if (!body) return;
    body.innerHTML = `
      <div class="sf-editor-bar">
        <span>Editing ${esc(entry.name)}</span>
        <span class="sf-spacer"></span>
        <button class="sf-btn" id="sfCancelEdit">CANCEL</button>
        <button class="sf-btn sf-primary" id="sfSaveEdit">SAVE</button>
      </div>
      <textarea class="sf-editor" id="sfEditor" spellcheck="false"></textarea>`;
    const ta = body.querySelector('#sfEditor');
    ta.value = text;
    body.querySelector('#sfCancelEdit')?.addEventListener('click', () => this.preview(this._previewPath));
    body.querySelector('#sfSaveEdit')?.addEventListener('click', async () => {
      const path = this._previewPath;
      if (!path) return;
      if (!this._needWritable()) return;
      try {
        this._busyStart(`Saving ${baseOf(path)}...`);
        await api.sandbox('write', { path, content: ta.value, root: this.root });
        this._busyEnd(`Saved ${baseOf(path)}`);
        await this.loadDir(this.rel);
        await this.preview(path);
        store.emit('toast', { message: `${baseOf(path)} saved`, type: 'success' });
      } catch (err) {
        this._status(err.message || String(err), true);
        store.emit('toast', { message: err.message || String(err), type: 'error' });
      }
    });
    ta.focus();
  }

  _renderMedia(res, entry, ext, binary = false) {
    const body = this.el?.querySelector('#sfPreviewBody');
    if (!body) return;
    const blob = b64ToBlob(res.data, res.mime);
    this._blobUrl = URL.createObjectURL(blob);
    body.innerHTML = '';
    if (IMAGE_EXT.has(ext)) {
      const img = document.createElement('img');
      img.className = 'sf-image';
      img.src = this._blobUrl;
      img.alt = entry.name;
      body.appendChild(img);
      return;
    }
    if (ext === 'pdf') {
      const frame = document.createElement('iframe');
      frame.className = 'sf-frame';
      frame.src = this._blobUrl;
      body.appendChild(frame);
      return;
    }
    if (MEDIA_EXT.has(ext)) {
      const media = document.createElement(['mp4', 'webm', 'mov', 'ogv'].includes(ext) ? 'video' : 'audio');
      media.className = 'sf-media';
      media.controls = true;
      media.src = this._blobUrl;
      body.appendChild(media);
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'sf-empty';
    wrap.innerHTML = binary
      ? 'This file contains binary data.<br><span>Download it to inspect it.</span>'
      : 'No inline preview for this file type.<br><span>Download it to inspect it.</span>';
    body.appendChild(wrap);
    const b = document.createElement('button');
    b.className = 'sf-btn';
    b.textContent = 'DOWNLOAD';
    b.onclick = () => this._download(this._previewPath);
    body.appendChild(b);
  }

  _renderBinaryInfo(entry, path, stat) {
    const body = this.el?.querySelector('#sfPreviewBody');
    if (!body) return;
    body.innerHTML = `
      <div class="sf-empty">
        ${esc(entry.name)}<br>
        <span>${fmtBytes(entry.size)} | ${esc(entry.mime || 'unknown type')} | ${esc(stat.mode || entry.mode || '')}</span><br><br>
        No inline preview for this file type.
      </div>
      <div class="sf-center"><button class="sf-btn" id="sfBinDl">DOWNLOAD</button></div>`;
    body.querySelector('#sfBinDl')?.addEventListener('click', () => this._download(path));
  }

  // -------------------------------------------------------------- dialogs

  _ask(title, label, value = '') {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'sf-modal';
      wrap.innerHTML = `
        <div class="sf-modal-card">
          <div class="sf-modal-title">${esc(title)}</div>
          <label class="sf-modal-label">${esc(label)}
            <input class="form-input sf-modal-input" type="text" value="${escAttr(value)}">
          </label>
          <div class="sf-modal-actions">
            <button class="sf-btn" data-sf-cancel>CANCEL</button>
            <button class="sf-btn sf-primary" data-sf-ok>OK</button>
          </div>
        </div>`;
      this.el.appendChild(wrap);
      const input = wrap.querySelector('input');
      const done = val => {
        document.removeEventListener('keydown', key, true);
        wrap.remove();
        resolve(val);
      };
      const key = e => {
        if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        if (e.key === 'Enter') { e.preventDefault(); done(String(input.value || '').trim() || null); }
      };
      document.addEventListener('keydown', key, true);
      wrap.querySelector('[data-sf-cancel]')?.addEventListener('click', () => done(null));
      wrap.querySelector('[data-sf-ok]')?.addEventListener('click', () => done(String(input.value || '').trim() || null));
      wrap.addEventListener('click', e => { if (e.target === wrap) done(null); });
      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  }

  _confirm(title, message, okLabel = 'DELETE') {
    return new Promise(resolve => {
      const danger = okLabel === 'DELETE';
      const wrap = document.createElement('div');
      wrap.className = 'sf-modal';
      wrap.innerHTML = `
        <div class="sf-modal-card">
          <div class="sf-modal-title">${esc(title)}</div>
          <div class="sf-modal-text">${esc(message)}</div>
          <div class="sf-modal-actions">
            <button class="sf-btn" data-sf-cancel>CANCEL</button>
            <button class="sf-btn ${danger ? 'sf-danger' : 'sf-primary'}" data-sf-ok>${esc(okLabel)}</button>
          </div>
        </div>`;
      this.el.appendChild(wrap);
      const key = e => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        done(false);
      };
      const done = val => {
        document.removeEventListener('keydown', key, true);
        wrap.remove();
        resolve(val);
      };
      document.addEventListener('keydown', key, true);
      wrap.querySelector('[data-sf-cancel]')?.addEventListener('click', () => done(false));
      wrap.querySelector('[data-sf-ok]')?.addEventListener('click', () => done(true));
      wrap.addEventListener('click', e => { if (e.target === wrap) done(false); });
    });
  }
}
