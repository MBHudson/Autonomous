/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// AGENTEDITOR.JS — Agent CRUD modal
// ============================================

import { store } from '../store.js?v=351';
import { persistence } from '../persistence.js?v=351';
import { esc, uuid, makeAgentCode, agentCode, asText } from '../utils.js?v=351';
import { parseCurl, bearerFromHeaders, parseJsonLenient } from '../curlParser.js?v=351';
import { parseSnippet, snippetKind } from '../snippetParser.js?v=351';
import { TOOL_REGISTRY, defaultTools } from '../tools.js?v=351';
import { audio } from '../audio.js?v=351';
import { api } from '../api.js?v=351';
import * as memory from '../memory.js?v=351';

/** Toast wording per recognized snippet language. */
const KIND_LABEL = { curl: 'Curl', python: 'Python', node: 'Node', sdk: 'SDK', json: 'JSON API' };

const COLORS = [
  '#00e5ff', '#a855f7', '#00ff88', '#ff4757', '#ff9f43',
  '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#ffeaa7',
  '#dfe6e9', '#fd79a8', '#a29bfe', '#00b894', '#e17055',
];

export class AgentEditor {
  constructor() {
    this.modal = null;
    this.editingId = null;
  }

  init() {
    this._describeToolPermissions();
    store.on('agent:edit', (id) => this.open(id));
    store.on('agent:add', () => this.open(null));
  }

  /**
   * Spell out where each tool actually runs, and whether the sandbox is
   * configured at all. The tool list mixes browser-local tools with ones that
   * hit the server, so "nothing is executed on the server" would be a lie the
   * moment somebody ticks write_file.
   */
  _describeToolPermissions() {
    const hint = document.getElementById('toolHint');
    if (!hint) return;
    hint.innerHTML =
      'None selected = plain replies. <code>now</code>, <code>echo</code>, the note tools and '
      + 'custom JS tools run in this browser. The rest run on your server: they reach the '
      + 'internet, and read or write files inside the directories you allow in Settings → Sandbox. '
      + '<code>write_file</code> asks you before every write.';

    api.getSandboxStatus()
      .then(s => {
        if (s.enabled) return;
        hint.innerHTML += ' <b>No working directory is set</b>, so the file tools will report '
          + 'themselves as disabled — set one in the left panel\'s '
          + '<b>Config tab → Working Project Directory</b>. Web search works already.';
      })
      .catch(() => { /* the hint above still tells the truth */ });
  }

  /**
   * List both memory pools with a delete button on every note.
   *
   * This panel is the whole answer to "how does a bad memory get forgotten".
   * Without a visible, editable list, the only remedy is clearing site data,
   * which throws away the agents, providers and sessions too.
   */
  _renderMemoryPanel(panel, agentId) {
    const mine = agentId ? memory.privateNotes(agentId) : [];
    const shared = memory.collectiveNotes();

    const row = (e, tag, tagClass) => `
      <li class="mem-row">
        <span class="mem-tag ${tagClass}">${tag}</span>
        <span class="mem-text">${esc(asText(e.text))}</span>
        <button type="button" class="mem-del" data-id="${esc(e.id)}" title="Forget this">&times;</button>
      </li>`;

    const section = (title, hint, entries, tag, tagClass, empty) => `
      <div class="mem-section">
        <div class="mem-head">
          <span>${title}</span>
          <span class="mem-count">${entries.length}</span>
          ${entries.length ? `<button type="button" class="mem-clear" data-clear="${tagClass === 'mem-tag-shared' ? 'collective' : 'private'}">clear all</button>` : ''}
        </div>
        ${hint ? `<div class="form-hint">${hint}</div>` : ''}
        ${entries.length
          ? `<ul class="mem-list">${entries.map(e => row(e, tag, tagClass)).join('')}</ul>`
          : `<div class="mem-empty">${empty}</div>`}
      </div>`;

    panel.innerHTML =
      section('Private notes', 'Only this agent reads these.',
        mine, 'private', 'mem-tag-private',
        agentId ? 'Nothing saved yet.' : 'Save the agent first to see its notes.')
      + section('Collective', 'Shared with every agent. Deleting here forgets it everywhere.',
        shared, 'collective', 'mem-tag-shared', 'Nothing shared yet.');

    panel.querySelectorAll('.mem-del').forEach(b => b.addEventListener('click', () => {
      memory.removeEntry(b.dataset.id);
      this._renderMemoryPanel(panel, agentId);
      store.emit('toast', { message: 'Note forgotten', type: 'info' });
    }));
    panel.querySelectorAll('.mem-clear').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.clear === 'collective') memory.clearCollective();
      else if (agentId) memory.clearPrivate(agentId);
      this._renderMemoryPanel(panel, agentId);
      store.emit('toast', { message: 'Memory cleared', type: 'info' });
    }));
  }

  open(agentId) {
    this.editingId = agentId;
    const agent = agentId ? store.get('agents').find(a => a.id === agentId) : null;
    const providers = store.get('providers') || [];
    const activeProviders = providers.filter(p => p.active);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'agentModalOverlay';

    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">${agent ? 'Edit Agent' : 'Add Agent'}</span>
          <button class="modal-close" id="agentModalClose">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Name</label>
            <input type="text" class="form-input" id="agentName" value="${agent ? esc(agent.name) : ''}" placeholder="Agent name">
          <div class="form-group">
            <label class="form-label">Label <span class="form-hint-inline">optional, shown beside the name</span></label>
            <input type="text" class="form-input" id="agentLabel" maxlength="24"
              value="${agent ? esc(agent.label || '') : ''}" placeholder="e.g. Account A">
            <div class="form-hint">Use this when you run several copies of the same model on different accounts &mdash; it tells them apart at a glance instead of looking like duplicates.</div>
          </div>
          </div>
          <div class="form-group">
            <label class="form-label">Role</label>
            <select class="form-select" id="agentRole">
              ${['Admin', 'Code', 'Research', 'Review'].map(r => `<option value="${r}" ${agent && agent.role === r ? 'selected' : ''}>${r}</option>`).join('')}
              <option value="__custom" ${agent && !['Admin', 'Code', 'Research', 'Review'].includes(agent.role) ? 'selected' : ''}>Custom…</option>
            </select>
          </div>
          <div class="form-group" id="agentCustomRoleGroup" style="display:${agent && !['Admin', 'Code', 'Research', 'Review'].includes(agent.role) ? 'block' : 'none'}">
            <label class="form-label">Custom Role</label>
            <input type="text" class="form-input" id="agentCustomRole" value="${agent && !['Admin', 'Code', 'Research', 'Review'].includes(agent.role) ? esc(agent.role) : ''}" placeholder="e.g. coordinator">
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Provider</label>
              <select class="form-select" id="agentProvider">
                ${activeProviders.map(p => `<option value="${esc(p.id)}" ${agent && agent.provider === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Model (type custom or pick suggested)</label>
              <input type="text" class="form-input" id="agentModel" list="agentModelList"
                value="${agent ? esc(agent.model || '') : ''}" placeholder="e.g. openai/gpt-4o-mini">
              <datalist id="agentModelList">
                ${this._getModelOptions(agent?.provider || activeProviders[0]?.id, agent?.model)}
              </datalist>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Color</label>
            <div class="color-picker" id="agentColorPicker">
              ${COLORS.map(c => `<div class="color-swatch ${agent && agent.color === c ? 'selected' : ''}" data-color="${c}" style="background:${c}"></div>`).join('')}
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Tools <span class="form-hint-inline">the model may call these by replying with JSON</span></label>
            <div class="tool-picker" id="agentTools">
              ${Object.entries(TOOL_REGISTRY)
                .filter(([id]) => !memory.MEMORY_TOOLS.includes(id))
                .filter(([id]) => !this._deniedTools().includes(id))
                .map(([id, def]) => {
                  // No tools array = an agent saved before everything was on
                  // by default, so show the full set ticked rather than an
                  // empty list that looks like the agent has no powers.
                  // The deny list is applied on top, so a tool hidden by the
                  // policy editor cannot be re-enabled here even by accident.
                  const chosen = (Array.isArray(agent?.tools) ? agent.tools : defaultTools())
                    .filter(t => !this._deniedTools().includes(t));
                  const on = chosen.includes(id);
                  return `
                <label class="tool-option">
                  <input type="checkbox" value="${esc(id)}" ${on ? 'checked' : ''}>
                  <span class="tool-name">${esc(id)}</span>
                  <span class="tool-desc">${esc(def.describe)}</span>
                </label>`;
                }).join('')}
            </div>
            <div class="tool-actions" style="margin-top:8px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
              <label class="tool-option" style="font-size:11px; margin:0; display:flex; align-items:center; gap:6px;">
                <input type="checkbox" id="agentToolsSelectAll">
                <span>Select all</span>
              </label>
              <button type="button" class="btn btn-ghost btn-sm" id="agentToolsApplyAll">Apply All to Agents</button>
            </div>
            <div class="form-hint" id="toolHint">None selected = plain replies.</div>
          </div>

          <div class="form-group">
            <label class="form-label">Memory <span class="form-hint-inline">private notes, and a collective it can share to</span></label>
            <label class="mem-toggle">
              <input type="checkbox" id="agentMemory" ${agent && agent.memory === false ? '' : 'checked'}>
              <span>Let this agent remember between sessions</span>
            </label>
            <div class="form-hint">
              Adds <code>remember</code>, <code>recall</code>, <code>share</code> and <code>adopt</code>.
              On by default; untick it to stop this agent keeping or sharing notes.
              The agent decides what is worth keeping privately, and shares a fact to the collective
              only when it believes it holds for every agent. Notes stay in this browser.
            </div>
            <div id="agentMemoryPanel" class="mem-panel"></div>
          </div>
          <div class="form-group">
            <label class="form-label">Always on <span class="form-hint-inline">work on this without being asked</span></label>
            <label class="mem-toggle">
              <input type="checkbox" id="agentAlwaysOn" ${agent && agent.alwaysOn ? 'checked' : ''}>
              <span>Let this agent work on its own</span>
            </label>
            <div class="form-hint">
              Gives this agent a standing goal it re-prompts itself on the interval set in
              Config. It stops when it decides the goal is met. Every iteration is billed,
              so the goal has to be something that actually terminates.
            </div>
            <textarea class="form-textarea" id="agentAlwaysOnGoal" rows="3"
              placeholder="e.g. Run the test suite and fix the failures until it is green">${agent ? esc(agent.alwaysOnGoal || '') : ''}</textarea>
            <div style="margin-top:6px">
              <button type="button" class="btn btn-ghost btn-sm" id="agentApplyGoalAll">Apply to All</button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">System Prompt <span class="form-hint-inline">defaults to "You are a helpful assistant."</span></label>
            <textarea class="form-textarea" id="agentSystemPrompt" placeholder="Custom system prompt...">${agent ? esc(agent.systemPrompt || '') : ''}</textarea>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Temperature</label>
              <input type="number" class="form-input" id="agentTemp" min="0" max="2" step="0.1" value="${agent?.temperature ?? 0.7}">
            </div>
            <div class="form-group">
              <label class="form-label">Max Tokens</label>
              <input type="number" class="form-input" id="agentMaxTokens" min="256" max="32768" step="256" value="${agent?.maxTokens ?? 4096}">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Voice <span class="form-hint-inline">used when replies are read aloud</span></label>
            <select class="form-select" id="agentVoice">
              <option value="">Use the global voice</option>
              <option value="off" ${agent && agent.voice === 'off' ? 'selected' : ''}>Never read aloud (mute this agent)</option>
            </select>
            <div class="form-hint" id="agentVoiceHint">Voices come from this computer unless a cloud speech provider is configured.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Pitch <span class="form-hint-inline">higher reads as female, lower as male</span></label>
            <div class="pitch-row">
              <input type="range" class="form-range" id="agentPitch" min="0.5" max="1.6" step="0.05"
                value="${agent && agent.pitch !== undefined && agent.pitch !== null ? Number(agent.pitch) : ''}">
              <span class="pitch-label" id="agentPitchLabel">inherit</span>
              <button type="button" class="btn btn-ghost btn-sm" id="agentVoiceTest">Test</button>
            </div>
            <div class="form-hint">Overrides the global pitch for this agent only. With few voices installed this is what gives each one its own register.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Endpoint Override (optional)</label>
            <input type="text" class="form-input" id="agentEndpoint" value="${agent ? esc(agent.endpoint || '') : ''}" placeholder="blank = use provider endpoint ($ENDPOINT-VARIABLE)">
          </div>
          <div class="form-group">
            <label class="form-label">API Key Override (optional)</label>
            <input type="password" class="form-input" id="agentKeyOverride" value="${agent ? esc(agent.keyOverride || '') : ''}" placeholder="blank = use provider key ($GENERATED-API-KEY-VARIABLE)">
          </div>
          <div class="form-group">
            <label class="form-label">Custom Curl Template (optional)</label>
            <textarea class="form-textarea" id="agentCurlTemplate" rows="8" placeholder="curl $ENDPOINT-VARIABLE -H &quot;Authorization: Bearer $GENERATED-API-KEY-VARIABLE&quot; -d '{... &quot;$USER-PROMPT-VARIABLE&quot; ... $TEMP ...}'">${agent ? esc(agent.curlTemplate || '') : ''}</textarea>
            <div class="form-hint">$ENDPOINT-VARIABLE · $GENERATED-API-KEY-VARIABLE · $USER-PROMPT-VARIABLE · $TEMP · $MAX-TOKENS · $SYSTEM-PROMPT (agent's system prompt, else default) — substituted at send time, run via server relay</div>
            <div class="toggle-row">
              <span class="toggle-label">Auto-detect from pasted curl / shell / JSON <span class="form-hint-inline">off = you write the $VARIABLEs yourself</span></span>
              <div class="toggle ${agent ? (agent.curlTemplateAuto !== false ? 'active' : '') : 'active'}" id="agentCurlAuto"><div class="toggle-knob"></div></div>
            </div>
          </div>
          <div class="toggle-row">
            <span class="toggle-label">Active</span>
            <div class="toggle ${agent ? (agent.active ? 'active' : '') : 'active'}" id="agentActive">
              <div class="toggle-knob"></div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          ${agent ? '<button class="btn btn-danger" id="agentDelete">Delete</button>' : ''}
          <button class="btn btn-ghost" id="agentCancel">Cancel</button>
          <button class="btn btn-primary" id="agentSave">${agent ? 'Save' : 'Add'}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    this.modal = overlay;

    // Close handlers
    document.getElementById('agentModalClose').addEventListener('click', () => this.close());
    document.getElementById('agentCancel').addEventListener('click', () => this.close());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });

    // Role dropdown -> toggle custom input
    document.getElementById('agentRole').addEventListener('change', (e) => {
      document.getElementById('agentCustomRoleGroup').style.display =
        e.target.value === '__custom' ? 'block' : 'none';
    });

    // Provider change -> update models
    document.getElementById('agentProvider').addEventListener('change', (e) => {
      this._updateModelDropdown(e.target.value);
    });

    // Memory panel: show/hide, and re-render on every change.
    const memToggle = document.getElementById('agentMemory');
    const memPanel = document.getElementById('agentMemoryPanel');
    const renderMem = () => {
      memPanel.hidden = !memToggle.checked;
      if (!memToggle.checked) { memPanel.innerHTML = ''; return; }
      // A brand-new agent has no id yet, so its notes cannot be listed; show
      // the collective (which is shared by everyone) and say so plainly.
      this._renderMemoryPanel(memPanel, agent ? agent.id : null);
    };
    memToggle.addEventListener('change', renderMem);
    renderMem();

    // Color picker
    overlay.querySelectorAll('.color-swatch').forEach(swatch => {
      swatch.addEventListener('click', () => {
        overlay.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        swatch.classList.add('selected');
      });
    });

    // Toggle
    document.getElementById('agentActive').addEventListener('click', function() {
      this.classList.toggle('active');
    });
    document.getElementById('agentCurlAuto')?.addEventListener('click', function() {
      this.classList.toggle('active');
    });

    // Paste (or drop, or type) a curl command into the template box → auto-fill
    // the boxes (endpoint, key, model, system prompt, temp, max tokens) and
    // rewrite the template with $VARIABLEs. The paste event alone was not
    // enough: drag-and-drop and typing never triggered it.
    const tplBox = document.getElementById('agentCurlTemplate');
    let fillTimer = null;
    const scheduleAutoFill = (immediate) => {
      if (!this._curlAutoEnabled()) return;
      clearTimeout(fillTimer);
      fillTimer = setTimeout(() => this._autoFillFromCurl(), immediate ? 0 : 400);
    };
    tplBox.addEventListener('paste', () => scheduleAutoFill(true));
    tplBox.addEventListener('drop', () => scheduleAutoFill(true));
    tplBox.addEventListener('input', () => scheduleAutoFill(false));

    // Save
    this._fillAgentVoices(agent);
    this._initPitch(agent);
    document.getElementById('agentApplyGoalAll')?.addEventListener('click', () => this._applyGoalToAll());

    // Select all / deselect all tool checkboxes for this agent
    document.getElementById('agentToolsSelectAll')?.addEventListener('change', (e) => {
      const checked = e.target.checked;
      document.getElementById('agentTools')?.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = checked;
      });
    });

    // Copy the currently selected tools to every agent
    document.getElementById('agentToolsApplyAll')?.addEventListener('click', () => {
      const deniedNow = this._deniedTools();
      const tools = [...(document.getElementById('agentTools')?.querySelectorAll('input:checked') || [])]
        .map(i => i.value).filter(t => !deniedNow.includes(t));

      if (!tools.length) {
        store.emit('toast', { message: 'Select at least one tool first', type: 'error' });
        return;
      }

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title">Apply tools to all agents?</span>
            <button class="modal-close" id="toolsAllClose">&times;</button>
          </div>
          <div class="modal-body">
            <div>Apply these <b>${tools.length}</b> tool(s) to all agents?</div>
            <div class="form-hint" style="margin-top:8px">${tools.map(t => `<code>${esc(t)}</code>`).join(', ')}</div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" id="toolsAllCancel">Cancel</button>
            <button class="btn btn-primary" id="toolsAllYes">Apply to All</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const close = () => overlay.remove();
      overlay.querySelector('#toolsAllClose')?.addEventListener('click', close);
      overlay.querySelector('#toolsAllCancel')?.addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      overlay.querySelector('#toolsAllYes')?.addEventListener('click', () => {
        const updated = (store.get('agents') || []).map(a => ({ ...a, tools }));
        store.set('agents', updated);
        persistence.set('agents', updated);
        store.emit('agents:changed');
        store.emit('toast', { message: `Tools applied to ${updated.length} agent(s)`, type: 'success' });
        close();
      });
    });

    document.getElementById('agentSave').addEventListener('click', () => this._save());

    // Delete
    const deleteBtn = document.getElementById('agentDelete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => this._delete());
    }
  }

  _getModelOptions(providerId, selectedModel) {
    const providers = store.get('providers') || [];
    const provider = providers.find(p => p.id === providerId);
    const models = [...(provider?.models || [])];
    // Include the agent's current (possibly custom) model in suggestions
    if (selectedModel && !models.includes(selectedModel)) {
      models.push(selectedModel);
    }
    if (models.length === 0) return '<option value="">No models</option>';
    return models.map(m => `<option value="${esc(m)}">`).join('');
  }

  _updateModelDropdown(providerId) {
    const list = document.getElementById('agentModelList');
    if (list) {
      list.innerHTML = this._getModelOptions(providerId, null);
    }
  }

  _getSelectedColor() {
    const selected = this.modal?.querySelector('.color-swatch.selected');
    return selected ? selected.dataset.color : COLORS[0];
  }

  /**
   * Paste a provider snippet (curl, shell, Python, or Node) into the template
   * box → populate endpoint, key, model, system prompt, temp + max-token boxes
   * and rewrite the template with $VARIABLEs. All four input languages share
   * this one code path once normalized.
   */
    _autoFillFromCurl() {
      if (!this._curlAutoEnabled()) return;
      const tplEl = document.getElementById('agentCurlTemplate');
    if (!tplEl) return;
    const raw = tplEl.value || '';
    const kind = snippetKind(raw);
    // A raw JSON payload (no curl) is still a JSON API call - give it a
    // template so the user only has to add $ENDPOINT-VARIABLE.
    if (!kind && /^\s*[{\[]/.test(raw)) kind = 'json';

    let parsed;
    if (kind === 'json') {
      parsed = { url: '', method: 'POST', headers: { 'Content-Type': 'application/json' }, data: raw };
    } else {
      try {
        parsed = kind === 'curl' ? parseCurl(raw) : parseSnippet(raw);
      } catch {
        return; // not parseable - leave it alone
      }
    }

    // Endpoint box
    if (parsed.url) {
      document.getElementById('agentEndpoint').value = parsed.url;
    }
    // Key box (Bearer or x-api-key)
    const bearer = bearerFromHeaders(parsed.headers);
    const xkey = parsed.headers['x-api-key'] || parsed.headers['X-API-Key'] || '';
    if (bearer || xkey) {
      document.getElementById('agentKeyOverride').value = bearer || xkey;
    }

    // Body values → model / temp / max boxes + canonical template.
    // Accepts chat-style (messages[]) AND other shapes (input/prompt/...).
    let body = null;
    try {
      body = parsed.data ? parseJsonLenient(parsed.data).value : null;
    } catch {
      body = null;
    }
    if (body === null && parsed.data) {
      // Last resort: salvage model/temp/max via regex so boxes still fill
      body = {};
      const mModel = /"model"\s*:\s*"([^"]+)"/.exec(parsed.data);
      const mTemp = /"temperature"\s*:\s*([0-9.]+)/.exec(parsed.data);
      const mMax = /"max_tokens"\s*:\s*([0-9]+)/.exec(parsed.data);
      if (mModel) body.model = mModel[1];
      if (mTemp) body.temperature = parseFloat(mTemp[1]);
      if (mMax) body.max_tokens = parseInt(mMax[1], 10);
      body.__raw = true;
    }

    if (body && typeof body === 'object') {
      if (body.model) {
        const modelInput = document.getElementById('agentModel');
        const modelList = document.getElementById('agentModelList');
        if (modelList && ![...modelList.options].some(o => o.value === body.model)) {
          const opt = document.createElement('option');
          opt.value = body.model;
          modelList.appendChild(opt);
        }
        if (modelInput) modelInput.value = body.model;
      }
      if (body.temperature !== undefined) {
        document.getElementById('agentTemp').value = body.temperature;
      }
      if (body.max_tokens !== undefined) {
        document.getElementById('agentMaxTokens').value = body.max_tokens;
      }

      // System Prompt box: take the system message out of the pasted body so the
      // text is visible and editable here (and so $SYSTEM-PROMPT has a source).
      const sysBox = document.getElementById('agentSystemPrompt');
      let sysNote = '';
      if (sysBox && body && typeof body === 'object') {
        let found = null;
        if (Array.isArray(body.messages)) {
          const sysMsg = body.messages.find(m => m && m.role === 'system' && typeof m.content === 'string');
          if (sysMsg) found = sysMsg.content;
        } else if (typeof body.system === 'string') {
          found = body.system;
        } else if (typeof body.system_prompt === 'string') {
          found = body.system_prompt;
        } else if (typeof body.instructions === 'string') {
          found = body.instructions;
        }
        if (found && !sysBox.value.trim()) {
          sysBox.value = found;
          sysNote = ' + system prompt';
        }
      }

      // Rewrite template with variables (chat shape AND other shapes)
      const varBody = { ...body };
      delete varBody.__raw;
      let promptNote = '';
      if (Array.isArray(varBody.messages)) {
        varBody.messages = varBody.messages.map(m => {
          if (m && m.role === 'user') return { ...m, content: '$USER-PROMPT-VARIABLE' };
          if (m && m.role === 'system') return { ...m, content: '$SYSTEM-PROMPT' };
          return m;
        });
      } else {
        // Non-chat payload: point the prompt var at the largest string leaf
        const best = this._largestStringLeaf(varBody);
        if (best) {
          this._setPath(varBody, best.path, '$USER-PROMPT-VARIABLE');
          promptNote = ` (prompt → '${best.path.join('.')}')`;
        }
      }
      if (varBody.temperature !== undefined) varBody.temperature = '$TEMP';
      if (varBody.max_tokens !== undefined) varBody.max_tokens = '$MAX-TOKENS';
      // The relay is non-streaming: a pasted "stream": true would otherwise
      // be sent as-is and come back as an unreadable SSE stream.
      let streamNote = '';
      if (varBody.stream !== undefined && varBody.stream !== false) {
        varBody.stream = false;
        streamNote = ' · stream off';
      }
      // SDK snippets carry no URL: if we had to guess the base, say so.
      let baseNote = '';
      if (parsed.baseGuessed) {
        baseNote = ' · base URL guessed — check the Endpoint box';
      }
      // $TEMP/$MAX-TOKENS must be bare numbers, not strings — unquote them
      let bodyStr = JSON.stringify(varBody, null, 2)
        .replace(/"\$TEMP"/g, '$TEMP')
        .replace(/"\$MAX-TOKENS"/g, '$MAX-TOKENS');
      const headerLines = Object.entries(parsed.headers || {})
        .map(([k, v]) => {
          const vv = (v === bearer || (v && bearer && v.includes(bearer)))
            ? v.replace(bearer, '$GENERATED-API-KEY-VARIABLE') : v;
          return `  -H "${k}: ${vv}" \\`;
        })
        .join('\n') || '  -H "Content-Type: application/json" \\';
      tplEl.value = 'curl $ENDPOINT-VARIABLE \\\n'
        + headerLines + '\n'
        + `  -d '${bodyStr}'`;
      store.emit('toast', { message: `${KIND_LABEL[kind] || 'Snippet'} parsed — boxes filled${sysNote}, template ready${promptNote}${streamNote || ''}${baseNote || ''}`, type: 'success' });
    } else if (parsed.url || bearer) {
      store.emit('toast', { message: 'Endpoint/key filled — add $VARIABLEs to the template', type: 'success' });
    }
  }

  /** Auto-fill only runs when the user has not switched it off. */
  _curlAutoEnabled() {
    const el = document.getElementById('agentCurlAuto');
    return !el || el.classList.contains('active');
  }

  /** Find the largest string leaf in an object (best prompt candidate). */
  _largestStringLeaf(obj, path = [], best = null) {
    if (typeof obj === 'string') {
      if (!best || obj.length > best.value.length) {
        return { path, value: obj };
      }
      return best;
    }
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => { best = this._largestStringLeaf(v, [...path, i], best); });
      return best;
    }
    if (obj && typeof obj === 'object') {
      Object.entries(obj).forEach(([k, v]) => {
        if (k.toLowerCase() === 'model') return; // never treat the model id as the prompt
        best = this._largestStringLeaf(v, [...path, k], best);
      });
      return best;
    }
    return best;
  }

  _setPath(obj, path, value) {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
    cur[path[path.length - 1]] = value;
  }

  /**
   * Populate the per-agent voice list.
   *
   * Browser voices arrive asynchronously in Chrome, so the list is filled now
   * and refilled when `audio:voices` fires. Falls back to the cloud provider's
   * voice list when that engine is selected.
   */
  /**
   * Per-agent pitch.
   *
   * Left EMPTY when the agent has no opinion, which means "follow the global
   * setting". Storing a number instead would freeze the agent at whatever the
   * global value happened to be when it was saved.
   */
  _initPitch(agent) {
    const input = document.getElementById('agentPitch');
    const label = document.getElementById('agentPitchLabel');
    const test = document.getElementById('agentVoiceTest');
    if (!input) return;

    const stored = agent && agent.pitch !== undefined && agent.pitch !== null ? Number(agent.pitch) : null;
    // No stored value: park the slider at the global default but report
    // "inherit", so the user can tell inherited from explicitly chosen.
    input.value = String(stored !== null ? stored : (store.get('settings.audioPitch') ?? 1));

    const describe = () => {
      if (!label) return;
      const v = Number(input.value);
      const isInherited = stored === null;
      label.textContent = isInherited
        ? `inherit (${v.toFixed(2)})`
        : v > 1.15 ? `${v.toFixed(2)} — higher`
          : v < 0.85 ? `${v.toFixed(2)} — lower`
            : v.toFixed(2);
    };
    input.addEventListener('input', describe);
    describe();

    // Auditioning matters here: the whole point is choosing by ear, and
    // picking blind from a list of similar names is guesswork.
    test?.addEventListener('click', async () => {
      const voiceSel = document.getElementById('agentVoice');
      const voiceVal = voiceSel && voiceSel.value && voiceSel.value !== 'off' ? voiceSel.value : '';
      try {
        await audio.speak('Testing. This is how I will sound from now on.', {
          voice: voiceVal, pitch: Number(input.value),
        });
      } catch (err) {
        store.emit('toast', { message: `Voice test failed: ${err.message}`, type: 'error' });
      }
    });
  }

  /** Tools the policy editor has hidden. Empty when nothing is denied. */
  _deniedTools() {
    try {
      const d = store.get('settings.deniedTools');
      return Array.isArray(d) ? d : [];
    } catch { return []; }
  }

  _fillAgentVoices(agent) {
    const sel = document.getElementById('agentVoice');
    if (!sel) return;
    const current = (agent && agent.voice) || '';
    const paint = () => {
      sel.innerHTML = '';
      const add = (value, label) => {
        const o = document.createElement('option');
        o.value = value; o.textContent = label;
        sel.appendChild(o);
      };
      add('', 'Use the global voice');
      add('off', 'Never read aloud (mute this agent)');
      let voices = [];
      try { voices = audio.voiceList() || []; } catch { voices = []; }
      voices.forEach(v => add(v.value, v.label || v.value));
      sel.value = (voices.some(v => v.value === current) || current === 'off') ? current : '';
      const hint = document.getElementById('agentVoiceHint');
      if (hint) {
        hint.textContent = voices.length
          ? `${voices.length} voice(s) available.`
          : 'No voices found. This browser reports none - on Linux install a speech-dispatcher voice, or configure a cloud speech provider.';
      }
    };
    paint();
    store.on('audio:voices', () => {
      if (document.getElementById('agentVoice') === sel) paint();
    });
  }

  _save() {
    const name = document.getElementById('agentName').value.trim();
    if (!name) {
      store.emit('toast', { message: 'Name is required', type: 'error' });
      return;
    }

    let role = document.getElementById('agentRole').value;
    if (role === '__custom') {
      role = document.getElementById('agentCustomRole').value.trim() || 'assistant';
    }
    const provider = document.getElementById('agentProvider').value;
    const model = document.getElementById('agentModel').value.trim();
    const color = this._getSelectedColor();
    const systemPrompt = document.getElementById('agentSystemPrompt').value.trim();
    // Read BEFORE the array that filters on it. It used to be declared two
    // lines below that array, which is a temporal-dead-zone crash: the code is
    // perfectly valid and node --check passes, but it throws the moment an
    // agent is saved.
    // Never persist a tool the policy editor has since denied.
    const deniedNow = this._deniedTools();
    const tools = [...(document.getElementById('agentTools')?.querySelectorAll('input:checked') || [])]
      .map(i => i.value).filter(t => !deniedNow.includes(t));
    const memoryOn = !!document.getElementById('agentMemory')?.checked;
    const label = (document.getElementById('agentLabel')?.value || '').trim();
    const voice = document.getElementById('agentVoice')?.value || '';
    // Empty means "inherit the global pitch", stored as null rather than a
    // number so changing the global setting later still reaches this agent.
    const pitchRaw = document.getElementById('agentPitch')?.value;
    const pitch = (pitchRaw === '' || pitchRaw === undefined) ? null : Number(pitchRaw);
    // Always-on is opt-in per agent. The goal is kept even when the switch is
    // off, so turning it off and back on does not lose what you typed.
    const alwaysOnGoal = (document.getElementById('agentAlwaysOnGoal')?.value || '').trim();
    const alwaysOn = !!document.getElementById('agentAlwaysOn')?.checked && !!alwaysOnGoal;
    const temperature = parseFloat(document.getElementById('agentTemp').value) || 0.7;
    const maxTokens = parseInt(document.getElementById('agentMaxTokens').value, 10) || 4096;
    const active = document.getElementById('agentActive').classList.contains('active');
    const endpoint = document.getElementById('agentEndpoint').value.trim();
    const keyOverride = document.getElementById('agentKeyOverride').value.trim();
    const curlTemplate = document.getElementById('agentCurlTemplate').value.trim();
    const curlTemplateAuto = document.getElementById('agentCurlAuto').classList.contains('active');

    // Custom model names are stored onto the provider's model list
    // so they keep showing up as suggestions.
    if (model) {
      const providers = store.get('providers') || [];
      const prov = providers.find(p => p.id === provider);
      if (prov) {
        prov.models = prov.models || [];
        if (!prov.models.includes(model)) {
          prov.models.push(model);
          persistence.set('providers', providers);
          store.emit('providers:changed');
        }
      }
    }

    const agents = store.get('agents');

    if (this.editingId) {
      // Update existing
      const idx = agents.findIndex(a => a.id === this.editingId);
      if (idx >= 0) {
        // The code is a permanent handle: renaming must never change it.
        agents[idx] = { ...agents[idx], code: agentCode(agents[idx]), name, role, provider, model, color, systemPrompt, temperature, maxTokens, active, endpoint, keyOverride, curlTemplate, curlTemplateAuto, tools, memory: memoryOn, voice, pitch, label, alwaysOn, alwaysOnGoal };
      }
      store.emit('toast', { message: 'Agent updated', type: 'success' });
    } else {
      // Create new
      const newAgent = {
        id: uuid('agent'),
        code: makeAgentCode(),
        name,
        role,
        provider,
        model,
        color,
        systemPrompt,
        temperature,
        maxTokens,
        active,
        endpoint,
        keyOverride,
        curlTemplate,
        curlTemplateAuto,
        tools,
        memory: memoryOn,
        voice,
        pitch,
        label,
        alwaysOn,
        alwaysOnGoal,
      };
      agents.push(newAgent);
      store.emit('toast', { message: 'Agent added', type: 'success' });
    }

    store.set('agents', agents);
    persistence.set('agents', agents);
    this.close();
    store.emit('agents:changed');
  }

  _delete() {
    if (!this.editingId) return;
    if (!confirm('Delete this agent?')) return;

    const agents = store.get('agents').filter(a => a.id !== this.editingId);
    store.set('agents', agents);
    persistence.set('agents', agents);
    store.emit('toast', { message: 'Agent deleted', type: 'info' });
    this.close();
    store.emit('agents:changed');
  }

  /**
   * Copy Always-On to every agent — in BOTH directions.
   *
   * This used to send the goal text only, and to refuse when the box was empty,
   * so "clear it everywhere" — the state an operator most often wants to hand
   * out after experimenting — could not be expressed at all: the one thing the
   * button would not do was remove. The switch and the sentence now travel
   * together, exactly as the box shows them: ticked copies the goal and turns
   * Always-On on for everyone; unticked deletes every standing goal and turns
   * Always-On off. Their conversations, memory and other settings are not
   * touched — only the switch and the goal.
   */
  _applyGoalToAll() {
    const goal = (document.getElementById('agentAlwaysOnGoal')?.value || '').trim();
    const on = !!document.getElementById('agentAlwaysOn')?.checked;
    if (on && !goal) {
      store.emit('toast', {
        message: 'Type a standing goal first — or clear the box to switch Always-On off everywhere',
        type: 'error',
      });
      return;
    }
    const agents = store.get('agents') || [];
    if (!agents.length) {
      store.emit('toast', { message: 'There are no agents to apply this to yet', type: 'error' });
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">${on ? 'Apply to all agents?' : 'Turn Always-On off everywhere?'}</span>
          <button class="modal-close" id="goalAllClose">&times;</button>
        </div>
        <div class="modal-body">
          ${on
            ? `<div>This standing goal will replace the goal on all
                 <b>${agents.length} agent(s)</b>, and <b>Always-On will be turned on</b> for them.</div>
               <div class="form-hint" style="margin-top:8px">“${esc(goal.slice(0, 160))}${goal.length > 160 ? '…' : ''}”</div>`
            : `<div><b>Always-On will be turned off for all ${agents.length} agent(s)</b>,
                 and every standing goal will be deleted.</div>
               <div class="form-hint" style="margin-top:8px">Only the switch and the goal
                 change — their conversations, memory and other settings stay as they are.</div>`}
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="goalAllCancel">Cancel</button>
          <button class="btn btn-primary" id="goalAllYes">${on ? 'Apply to all' : 'Turn off everywhere'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#goalAllClose').addEventListener('click', close);
    overlay.querySelector('#goalAllCancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#goalAllYes').addEventListener('click', () => {
      const updated = (store.get('agents') || [])
        .map(a => ({ ...a, alwaysOn: on, alwaysOnGoal: goal }));
      store.set('agents', updated);
      persistence.set('agents', updated);
      // This editor is still open on one agent. Leave its switch showing what
      // now applies to everyone, or a later Save would quietly put the old
      // one back and undo half of what was just applied.
      const box = document.getElementById('agentAlwaysOn');
      if (box) box.checked = on;
      store.emit('agents:changed');
      store.emit('toast', {
        message: on
          ? `Standing goal applied to ${updated.length} agent(s)`
          : `Always-On switched off on ${updated.length} agent(s); goals cleared`,
        type: 'success',
      });
      close();
    });
  }

  close() {
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }
  }
}

export default AgentEditor;
