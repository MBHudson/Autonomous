// ============================================
// PROVIDEREDITOR.JS — Provider CRUD modal
// ============================================

import { store } from '../store.js?v=304';
import { api } from '../api.js?v=304';
import { persistence } from '../persistence.js?v=304';
import { esc, uuid } from '../utils.js?v=304';

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

    const providers = store.get('providers');

    if (this.editingId) {
      const idx = providers.findIndex(p => p.id === this.editingId);
      if (idx >= 0) {
        providers[idx] = { ...providers[idx], name, endpoint, authType, apiKey, models, active };
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
