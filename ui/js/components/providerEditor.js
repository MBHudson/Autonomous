/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// PROVIDEREDITOR.JS — Provider CRUD modal
// ============================================

import { store } from '../store.js?v=325';
import { api } from '../api.js?v=325';
import { persistence } from '../persistence.js?v=325';
import { esc, uuid } from '../utils.js?v=325';

export class ProviderEditor {
  constructor() {
    this.modal = null;
    this.editingId = null;
  }

  init() {
    store.on('provider:edit', (id) => this.open(id));
    store.on('provider:add', () => this.open(null));
  }

  open(providerId) {
    this.editingId = providerId;
    const provider = providerId ? store.get('providers').find(p => p.id === providerId) : null;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'providerModalOverlay';

    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">${provider ? 'Edit Provider' : 'Add Provider'}</span>
          <button class="modal-close" id="providerModalClose">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Name</label>
            <input type="text" class="form-input" id="providerName" value="${provider ? esc(provider.name) : ''}" placeholder="Provider name">
          </div>
          <div class="form-group">
            <label class="form-label">Endpoint URL</label>
            <input type="text" class="form-input" id="providerEndpoint" value="${provider ? esc(provider.endpoint) : ''}" placeholder="https://...">
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Auth Type</label>
              <select class="form-select" id="providerAuthType">
                <option value="bearer" ${provider?.authType === 'bearer' ? 'selected' : ''}>Bearer Token</option>
                <option value="x-api-key" ${provider?.authType === 'x-api-key' ? 'selected' : ''}>X-API-Key</option>
                <option value="none" ${provider?.authType === 'none' ? 'selected' : ''}>None</option>
                <option value="custom" ${provider?.authType === 'custom' ? 'selected' : ''}>Custom Header</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">API Key</label>
              <input type="password" class="form-input" id="providerApiKey" value="${provider ? esc(provider.apiKey) : ''}" placeholder="sk-...">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Models (comma-separated)</label>
            <div class="form-label-row">
              <span class="form-label">Models</span>
              <button class="btn btn-ghost btn-sm" id="providerFetchModels" type="button">Fetch available models</button>
            </div>
            <textarea class="form-textarea" id="providerModels" placeholder="model1, model2, model3">${provider ? esc(provider.models.join(', ')) : ''}</textarea>
            <div class="form-hint" id="providerFetchHint">Reads the provider's live catalog and replaces the list below. Works for any OpenAI-compatible endpoint, Anthropic, and Ollama.</div>
          </div>
          <div class="form-group">
            <div class="form-label-row">
              <span class="form-label">API pool <span class="form-hint-inline">extra keys that rotate</span></span>
              <button class="btn btn-ghost btn-sm" id="providerAddKeyPool" type="button">+ key</button>
            </div>
            <div id="providerKeys"></div>
            <label class="form-label">Rotate after N requests <span class="form-hint-inline">0 = every call</span></label>
            <input type="number" class="form-input" id="providerRotate" min="0" max="100000" value="${provider ? (provider.rotateAfter ?? 0) : 0}">
            <div class="form-hint" id="providerPoolHint">Active only when Config → Labs → “API pool” is on. The agent's own Key Override always wins. Tick <b>Only this model</b> and enter a model # (like <code>#63BET7</code>) or a model id to rotate a key around just that model. A 429 puts a key on a 60s cooldown and the next call uses another.</div>
          </div>
          <div class="toggle-row">
            <span class="toggle-label">Active</span>
            <div class="toggle ${provider ? (provider.active ? 'active' : '') : 'active'}" id="providerActive">
              <div class="toggle-knob"></div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          ${provider ? '<button class="btn btn-danger" id="providerDelete">Delete</button>' : ''}
          <button class="btn btn-ghost" id="providerCancel">Cancel</button>
          <button class="btn btn-primary" id="providerSave">${provider ? 'Save' : 'Add'}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    this.modal = overlay;

    // Close handlers
    document.getElementById('providerModalClose').addEventListener('click', () => this.close());
    document.getElementById('providerCancel').addEventListener('click', () => this.close());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });

    // Toggle
    document.getElementById('providerActive').addEventListener('click', function() {
      this.classList.toggle('active');
    });

    // Fetch the provider's live model catalog and fill the list
    document.getElementById('providerFetchModels').addEventListener('click', () => this._fetchModels());

    // API pool rows. Kept in this._pool so removing a row cannot shuffle ids.
    this._pool = provider && Array.isArray(provider.apiKeys)
      ? provider.apiKeys.map(k => ({ id: k.id || uuid('key'), label: k.label || '', key: k.key || '' }))
      : [];
    document.getElementById('providerAddKeyPool')?.addEventListener('click', () => {
      this._pool = this._collectKeys();
      this._pool.push({ id: uuid('key'), label: '', key: '' });
      this._renderKeys();
    });
    this._renderKeys();

    // Save
    document.getElementById('providerSave').addEventListener('click', () => this._save());

    // Delete
    const deleteBtn = document.getElementById('providerDelete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => this._delete());
    }
  }

  /**
 * Ask the server for this provider's live catalog and replace the models list.
 * The existing list is kept if the fetch fails, so a bad key or an offline
 * provider can never wipe what the user already had.
 */
async _fetchModels() {
    const btn = document.getElementById('providerFetchModels');
    const hint = document.getElementById('providerFetchHint');
    const endpoint = document.getElementById('providerEndpoint').value.trim();
    const apiKey = document.getElementById('providerApiKey').value.trim();
    if (!endpoint) {
      store.emit('toast', { message: 'Enter the provider endpoint first', type: 'error' });
      return;
    }
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    if (hint) hint.textContent = 'Contacting ' + endpoint + '…';
    try {
      const data = await api.request('POST', '/catalog', { endpoint, api_key: apiKey });
      if (!data || data.error || !Array.isArray(data.models) || data.models.length === 0) {
        throw new Error(data?.error || 'No models returned');
      }
      const box = document.getElementById('providerModels');
      const previous = box.value.split(',').map(m => m.trim()).filter(Boolean);
      box.value = data.models.join(', ');
      if (hint) {
        hint.textContent = `Loaded ${data.count} models from ${data.catalog_url}`
          + (previous.length ? ` (replaced ${previous.length} previous)` : '');
      }
      store.emit('toast', { message: `Fetched ${data.count} models`, type: 'success' });
    } catch (err) {
      if (hint) hint.textContent = `Fetch failed: ${err.message} — list left unchanged`;
      store.emit('toast', { message: `Model fetch failed: ${err.message}`, type: 'error' });
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  _renderKeys() {
    const host = document.getElementById('providerKeys');
    if (!host) return;
    if (!this._pool.length) {
      host.innerHTML = '<div class="form-hint" style="margin:0 0 6px">No extra keys — the single API Key above is used.</div>';
      return;
    }
    host.innerHTML = this._pool.map((k, i) => `
      <div class="pool-row" data-pool-row="${i}">
        <div class="pool-row-main">
          <input class="form-input" data-pool="label" value="${esc(k.label || '')}" placeholder="label (optional)">
          <input class="form-input" type="password" data-pool="key" value="${esc(k.key || '')}" placeholder="sk-…">
          <button class="btn btn-ghost btn-sm" data-pool-remove="${i}" type="button" title="Remove">&times;</button>
        </div>
        <div class="pool-row-scope">
          <button class="pool-scope${k.only ? ' active' : ''}" data-pool-only type="button"
            title="Use this key only for the model below">Only this model</button>
          <input class="form-input" data-pool="model" value="${esc(k.model || '')}"
            placeholder="model # like #63BET7, or a model id — blank = all models">
        </div>
      </div>`).join('');
    host.querySelectorAll('[data-pool-only]').forEach((btn) => {
      btn.addEventListener('click', () => btn.classList.toggle('active'));
    });
    host.querySelectorAll('[data-pool-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._pool = this._collectKeys();
        this._pool.splice(Number(btn.dataset.poolRemove), 1);
        this._renderKeys();
      });
    });
  }

  /** Read the pool rows back out of the DOM (empty keys dropped). */
  _collectKeys() {
    const host = document.getElementById('providerKeys');
    if (!host) return this._pool || [];
    const rows = [...host.querySelectorAll('[data-pool-row]')];
    if (!rows.length) return this._pool || [];
    return rows.map((row, i) => ({
      id: (this._pool && this._pool[i] && this._pool[i].id) || uuid('key'),
      label: row.querySelector('[data-pool="label"]')?.value.trim() || '',
      key: row.querySelector('[data-pool="key"]')?.value.trim() || '',
      model: row.querySelector('[data-pool="model"]')?.value.trim() || '',
      only: !!row.querySelector('[data-pool-only]')?.classList.contains('active'),
    })).filter((k) => k.key);
  }

  _save() {
    const name = document.getElementById('providerName').value.trim();
    if (!name) {
      store.emit('toast', { message: 'Name is required', type: 'error' });
      return;
    }

    const endpoint = document.getElementById('providerEndpoint').value.trim();
    const authType = document.getElementById('providerAuthType').value;
    const apiKey = document.getElementById('providerApiKey').value.trim();
    const modelsStr = document.getElementById('providerModels').value.trim();
    const models = modelsStr ? modelsStr.split(',').map(m => m.trim()).filter(Boolean) : [];
    const active = document.getElementById('providerActive').classList.contains('active');
    const apiKeys = this._collectKeys();
    const rotateAfter = Math.max(0, parseInt(document.getElementById('providerRotate')?.value, 10) || 0);

    const providers = store.get('providers');

    if (this.editingId) {
      const idx = providers.findIndex(p => p.id === this.editingId);
      if (idx >= 0) {
        providers[idx] = { ...providers[idx], name, endpoint, authType, apiKey, models, active, apiKeys, rotateAfter };
      }
      store.emit('toast', { message: 'Provider updated', type: 'success' });
    } else {
      const newProvider = {
        id: uuid('provider'),
        name,
        endpoint,
        authType,
        apiKey,
        models,
        active,
        apiKeys,
        rotateAfter,
      };
      providers.push(newProvider);
      store.emit('toast', { message: 'Provider added', type: 'success' });
    }

    store.set('providers', providers);
    persistence.set('providers', providers);
    this.close();
    store.emit('providers:changed');
  }

  _delete() {
    if (!this.editingId) return;
    if (!confirm('Delete this provider?')) return;

    const providers = store.get('providers').filter(p => p.id !== this.editingId);
    store.set('providers', providers);
    persistence.set('providers', providers);
    store.emit('toast', { message: 'Provider deleted', type: 'info' });
    this.close();
    store.emit('providers:changed');
  }

  close() {
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }
  }
}

export default ProviderEditor;
