// ============================================
// SIDEBAR.JS — Sidebar tabs controller
// ============================================

import { store } from '../store.js?v=305';
import { K } from '../storage.js?v=305';
import { persistence } from '../persistence.js?v=305';
import { api } from '../api.js?v=305';
import { esc, escAttr, timeAgo, agentCode, copyToClipboard, downloadFile, DEFAULT_HISTORY_TURNS } from '../utils.js?v=305';
import { TOOL_REGISTRY } from '../tools.js?v=305';
import { refreshAgentClocks, initClocks } from '../agentClock.js?v=305';
import { snapshot } from '../rateGovernor.js?v=305';

// Config section open/closed state. Session-only on purpose: a fresh load
// always starts with every section collapsed, and the ones you open stay open
// until you reload. It is a view preference, so it is never persisted and
// never reaches the server or another device.

export class Sidebar {
  constructor() {
    this.bodyEl = null;
    this.activeTab = 'sessions';
    this.busySessionId = null;
    this.workingAgents = new Set();
    // Set by app.js. The Agents-tab header carries the API Lab and Brain Lab
    // buttons; both screens are drawers this tab only has to point at.
    this.apiLab = null;
    this.brainLab = null;
    // Config section ids currently expanded, for THIS session only. Starts
    // empty so every section is collapsed on load; opening one keeps it open
    // for the session and a reload resets them all to collapsed.
    this._cfgOpen = new Set();
    // A working directory the user typed but has not saved yet. The field is
    // rebuilt on every render and refetched from the server, so without this
    // the text vanished when they changed tabs.
    this._cfgPendingDir = null;
    // MCP servers this app CALLS (client), cached from the server; null = not fetched yet.
    this._mcpServers = null;
    // MCP *server* config (this app AS a server): tokens, scopes, root, protect.
    this._mcpSrv = null;
    // Agents with a standing goal that are mid-tick right now, so the ALWAYS ON
    // badge can show it and offer the stop control only when it would do
    // something.
    this._alwaysOnRunning = new Set();
    // Agents the user has stopped by hand: their badge becomes the release.
    this._alwaysOnHeld = new Set();
  }

  init() {
    this.bodyEl = document.getElementById('sidebarBody');
    // Token clocks repaint on usage + governor events; the module owns its
    // listeners and its minute ticker from here.
    try { initClocks(); } catch { /* clocks are decorative */ }
    // Governor status line in Config, repainted live while the tab is open.
    store.on('governor:changed', () => {
      if (this.activeTab === 'config') this._renderGovStatus();
    });

    // The scheduler announces when an agent starts and stops a tick; the badge
    // is only useful as a stop button while there is something to stop.
    store.on('alwaysOn:running', ({ agentId, running } = {}) => {
      if (!agentId) return;
      if (running) this._alwaysOnRunning.add(agentId);
      else this._alwaysOnRunning.delete(agentId);
      if (this.activeTab === 'agents') this.render();
    });
    // A held agent is stopped, not idle-armed: redraw so the badge says so.
    store.on('alwaysOn:held', (ev = {}) => {
      // A full list means "this is the authoritative set now" -- used when
      // restoring from storage and when the master switch clears everyone.
      // Rebuilding rather than merging is what makes a reload show the badges
      // the user left behind instead of an empty list.
      if (Array.isArray(ev.agentIds)) {
        this._alwaysOnHeld = new Set(ev.agentIds);
      } else if (ev.agentId) {
        if (ev.held) this._alwaysOnHeld.add(ev.agentId);
        else this._alwaysOnHeld.delete(ev.agentId);
      } else {
        this._alwaysOnHeld.clear();
      }
      if (this.activeTab === 'agents') this.render();
    });

    // Tab navigation
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeTab = btn.dataset.tab;
        store.set('ui.activeTab', this.activeTab);
        this.render();
      });
    });

    // Set initial active tab
    const initialTab = store.get('ui.activeTab') || 'sessions';
    const tabBtn = document.querySelector(`.nav-btn[data-tab="${initialTab}"]`);
    if (tabBtn) {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      tabBtn.classList.add('active');
      this.activeTab = initialTab;
    }

    this.render();

    // Working-state tracking: session busy/idle, agent active/idle.
    // Lights update in place so open menus/inputs are not disturbed.
    store.on('session:busy', ({ sessionId } = {}) => {
      this.busySessionId = sessionId || true;
      this._updateSessionLights();
    });
    store.on('session:idle', () => {
      this.busySessionId = null;
      this._updateSessionLights();
    });
    store.on('agent:status', ({ agentId, status } = {}) => {
      if (!agentId) return;
      if (status === 'active' || status === 'thinking') this.workingAgents.add(agentId);
      else this.workingAgents.delete(agentId);
      this._updateAgentLights();
    });
  }

  _updateSessionLights() {
    if (!this.bodyEl) return;
    this.bodyEl.querySelectorAll('[data-session-id]').forEach(row => {
      const light = row.querySelector('.agent-light');
      if (!light) return;
      const isBusy = this.busySessionId && (this.busySessionId === true || row.dataset.sessionId === this.busySessionId);
      light.className = 'agent-light ' + (isBusy ? 'active' : 'idle');
    });
  }

  _updateAgentLights() {
    if (!this.bodyEl) return;
    const agents = store.get('agents') || [];
    agents.forEach(agent => {
      const light = this.bodyEl.querySelector(`[data-agent-id="${agent.id}"] .agent-light`);
      if (!light) return;
      if (this.workingAgents.has(agent.id)) {
        light.className = 'agent-light active';
        light.style.background = agent.color;
        light.style.boxShadow = `0 0 8px ${agent.color}`;
      } else if (agent.active) {
        light.className = 'agent-light ready';
        light.style.background = agent.color;
        light.style.boxShadow = 'none';
      } else {
        light.className = 'agent-light idle';
        light.style.background = '';
        light.style.boxShadow = '';
      }
    });
  }

  render() {
    switch (this.activeTab) {
      case 'sessions':
        this.renderSessions();
        break;
      case 'agents':
        this.renderAgents();
        break;
      case 'providers':
        this.renderProviders();
        break;
      case 'config':
        this.renderConfig();
        break;
      case 'proxy':
        this.renderProxy();
        break;
    }
  }

  renderSessions() {
    const conversations = store.get('conversations') || [];

    let html = `<div class="sidebar-section-header">
      <span class="sidebar-section-title">${conversations.length} sessions</span>
      <button class="btn btn-primary btn-sm" id="addSessionBtn">+ ADD</button>
    </div>`;

    if (conversations.length === 0) {
      html += '<div class="empty"><div class="empty-icon">&#9670;</div><div>No sessions yet</div></div>';
      this.bodyEl.innerHTML = html;
      document.getElementById('addSessionBtn')?.addEventListener('click', () => this.createSession());
      return;
    }

    conversations.forEach(conv => {
      const initial = (conv.title || '?').charAt(0).toUpperCase();
      const msgCount = (conv.messages || []).length;
      const isActive = store.get('currentConversation')?.id === conv.id;
      html += `<div class="agent-row ${isActive ? 'active' : ''}" data-session-id="${esc(conv.id)}">
        <div class="agent-avatar" style="border-color:var(--accent-cyan);color:var(--accent-cyan)">${initial}</div>
        <div class="agent-meta">
          <div class="agent-name">${esc(conv.title)}</div>
          <div class="agent-role">${msgCount} messages &middot; ${timeAgo(conv.updatedAt || conv.createdAt)}</div>
        </div>
        <button class="agent-menu-btn" data-session-rename="${esc(conv.id)}" title="Rename session">&#9998;</button>
        <button class="agent-menu-btn" data-session-delete="${esc(conv.id)}" title="Delete session">&times;</button>
        <div class="agent-light ${this.busySessionId && (this.busySessionId === true || this.busySessionId === conv.id) ? 'active' : 'idle'}"></div>
      </div>`;
    });

    this.bodyEl.innerHTML = html;

    // Add click handlers
    this.bodyEl.querySelectorAll('[data-session-id]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-session-delete]')) return;
        if (e.target.closest('[data-session-rename]')) return;
        this.selectSession(el.dataset.sessionId);
      });
    });

    // Rename buttons (inline edit)
    this.bodyEl.querySelectorAll('[data-session-rename]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.startRename(btn.dataset.sessionRename, btn);
      });
    });

    // Delete buttons
    this.bodyEl.querySelectorAll('[data-session-delete]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteSession(btn.dataset.sessionDelete);
      });
    });

    // Add button
    document.getElementById('addSessionBtn')?.addEventListener('click', () => this.createSession());
  }

  async createSession() {
    try {
      const res = await api.createSession('New Session');
      const id = res.session_id || res.id;
      if (id) {
        await this.loadSessions();
        store.emit('conversation:loaded', { id });
        store.emit('toast', { message: 'Session created', type: 'success' });
      }
    } catch (err) {
      console.error('Failed to create session:', err);
      store.emit('toast', { message: 'Failed to create session', type: 'error' });
    }
  }

  startRename(id, btn) {
    const row = btn.closest('[data-session-id]');
    const nameEl = row?.querySelector('.agent-name');
    if (!nameEl) return;
    const convs = store.get('conversations') || [];
    const conv = convs.find(c => c.id === id);
    const current = conv?.title || '';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.className = 'form-input';
    input.style.cssText = 'font-size:11px;padding:2px 6px;margin:0';
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (save && title && title !== current) {
        try {
          await api.updateSession(id, { title });
          conv.title = title;
          store.set('conversations', [...convs]);
          persistence.set('conversations', store.get('conversations'));
          if (store.get('currentConversation')?.id === id) {
            store.set('currentConversation', { ...store.get('currentConversation'), title });
          }
          store.emit('conversations:changed');
          store.emit('toast', { message: 'Session renamed', type: 'success' });
        } catch (err) {
          console.error('Rename failed:', err);
          store.emit('toast', { message: 'Rename failed', type: 'error' });
        }
      }
      this.renderSessions();
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  async deleteSession(id) {    const convs = store.get('conversations') || [];
    const conv = convs.find(c => c.id === id);
    try {
      await api.deleteSession(id);
      store.set('conversations', convs.filter(c => c.id !== id));
      persistence.set('conversations', store.get('conversations'));
      if (store.get('currentConversation')?.id === id) {
        store.set('currentConversation', null);
      }
      store.emit('conversations:changed');
      store.emit('conversation:closed', { id });
      this.renderSessions();
      store.emit('toast', { message: 'Session deleted', type: 'info' });
    } catch (err) {
      console.error('Failed to delete session:', err);
      store.emit('toast', { message: 'Failed to delete session', type: 'error' });
    }
  }

  async selectSession(id) {
    try {
      const session = await api.getSession(id);
      if (session && !session.error) {
        const conv = {
          id: session.id,
          title: session.title,
          createdAt: session.created_at,
          updatedAt: session.last_activity,
          active: session.active,
          messages: this._convertDialogsToMessages(session.dialogs || []),
          agentsUsed: session.models_used || [],
        };
        store.set('currentConversation', conv);
        store.emit('conversation:loaded', conv);
        store.emit('toast', { message: `Session: ${conv.title}`, type: 'success' });
      }
    } catch (err) {
      console.error('Failed to load session:', err);
      store.emit('toast', { message: 'Failed to load session', type: 'error' });
    }
  }

  _convertDialogsToMessages(dialogs) {
    const messages = [];
    dialogs.forEach(dialog => {
      messages.push({
        id: `msg_${dialog.timestamp}_user`,
        role: 'user',
        content: dialog.user_input,
        timestamp: dialog.timestamp * 1000,
      });
      if (dialog.responses) {
        dialog.responses.forEach((resp, i) => {
          messages.push({
            id: `msg_${dialog.timestamp}_${i}`,
            role: 'agent',
            content: resp.response || resp.error || 'No response',
            agentId: resp.model_id,
            reasoning: resp.reasoning || null,
            toolCalls: resp.tool_calls || resp.toolCalls || null,
            timestamp: (dialog.timestamp + (i * 0.001)) * 1000,
          });
        });
      }
    });
    return messages;
  }

  renderAgents() {
    const agents = store.get('agents') || [];
    const activeCount = agents.filter(a => a.active).length;
    // Effective override state: armed only when switched on AND holding text.
    // An active flag with empty text injects nothing, so it shows as off.
    const pre = store.get('settings.globalPrePrompt') || { text: '', active: false };
    const preActive = !!(pre.active && (pre.text || '').trim());

    let html = `<div class="sidebar-section-header">
      <span class="sidebar-section-title">${activeCount} active</span>
      <span class="preprompt-wrap">
        <button class="agent-menu-btn preprompt-btn${preActive ? ' armed' : ''}" id="prePromptBtn" title="Global pre-prompt override${preActive ? ' (ON)' : ' (off)'}">§</button>
        <button class="agent-menu-btn" id="apiLabBtn" title="API Lab — convert a curl to any language, send it, read the answer">⌬</button>
        <button class="agent-menu-btn brainlab-btn" id="brainLabBtn" title="Brain Lab — every agent setting, cards and per-agent locks in one place"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true" width="14" height="14"><path d="M6 2.6A2.3 2.3 0 0 0 3.7 4.9c-1 .5-1.6 1.4-1.6 2.5 0 .7.3 1.4.8 1.9-.3.4-.5.9-.5 1.4 0 1.3 1 2.4 2.3 2.6.2.7.8 1.2 1.5 1.2.5 0 .9-.2 1.2-.6V3.2c-.3-.4-.8-.6-1.4-.6Z"/><path d="M10 2.6a2.3 2.3 0 0 1 2.3 2.3c1 .5 1.6 1.4 1.6 2.5 0 .7-.3 1.4-.8 1.9.3.4.5.9.5 1.4 0 1.3-1 2.4-2.3 2.6-.2.7-.8 1.2-1.5 1.2-.5 0-.9-.2-1.2-.6V3.2c.3-.4.8-.6 1.4-.6Z"/></svg></button>
        <div class="agent-menu" id="prePromptMenu" style="display:none">
          <button class="agent-menu-item" data-pre-action="edit">Edit</button>
          <button class="agent-menu-item ${preActive ? 'danger' : 'go'}" data-pre-action="toggle">${preActive ? 'Deactivate' : 'Activate'}</button>
        </div>
      </span>
      <button class="btn btn-primary btn-sm" id="addAgentBtn">+ ADD</button>
    </div>`;

    agents.forEach(agent => {
      const provider = store.get('providers').find(p => p.id === agent.provider);
      const working = this.workingAgents.has(agent.id);
      const lightClass = working ? 'active' : (agent.active ? 'ready' : 'idle');
      const lightStyle = agent.active || working
        ? `background:${esc(agent.color)};${working ? `box-shadow:0 0 8px ${esc(agent.color)};` : ''}`
        : '';
      html += `<div class="agent-editor" data-agent-id="${esc(agent.id)}">
        <div class="agent-editor-header">
          <div class="agent-grip" title="Drag to reorder" aria-label="Drag to reorder ${esc(agent.name)}">&#8942;&#8942;</div>
          <div class="agent-editor-title" style="color:${esc(agent.color)}">${esc(agent.name)}${agent.label ? ` <span class="agent-label">${esc(agent.label)}</span>` : ''} <span class="agent-code">${esc(agentCode(agent))}</span></div>
          <div class="agent-editor-actions">
            ${agent.alwaysOn ? (() => {
              const held = this._alwaysOnHeld.has(agent.id);
              const running = this._alwaysOnRunning.has(agent.id);
              const cls = `always-on-badge${running ? ' running' : ''}${held ? ' held' : ''}`;
              const tip = held
                ? `Release ${esc(agent.name)} — it will pick its goal up again`
                : `Stop ${esc(agent.name)} now — click again to release`;
              return `<button type="button" class="${cls}" data-always-on-stop="${esc(agent.id)}" title="${tip}" aria-pressed="${held}">${held ? 'HELD' : 'ALWAYS ON'}</button>`;
            })() : ''}
            <button class="agent-ask-btn" data-agent-ask="${esc(agent.id)}" title="Ask ${esc(agent.name)} directly">ASK</button>
            <div class="agent-light ${lightClass}" style="${lightStyle}"></div>
            <button class="agent-menu-btn" data-agent-menu="${esc(agent.id)}">&#8942;</button>
          </div>
        </div>
        <div style="font-size:10px;color:var(--text-secondary)">
          ${esc(agent.role)} &middot; ${esc(agent.model)}
          ${provider ? ' &middot; ' + esc(provider.name) : ''}
        </div>
        <div class="agent-clock" data-clock-agent="${esc(agent.id)}" title=""></div>
        <div class="agent-menu" id="menu-${esc(agent.id)}" style="display:none">
          <button class="agent-menu-item" data-action="edit">Edit</button>
          <button class="agent-menu-item" data-action="toggle">${agent.active ? 'Deactivate' : 'Activate'}</button>
          <button class="agent-menu-item danger" data-action="delete">Delete</button>
        </div>
      </div>`;
    });

    this.bodyEl.innerHTML = html;

    this._attachAgentDragSort();

    // The ALWAYS ON badge stops the current run without switching the agent's
    // always-on setting off: the next tick picks the goal up again.
    this.bodyEl.querySelectorAll('[data-always-on-stop]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        store.emit('alwaysOn:stop', { agentId: btn.dataset.alwaysOnStop });
      });
    });

    // Clicking an agent's name or code copies it. Bound on the row rather than
    // the title so it works regardless of which element the click lands on.
    this.bodyEl.querySelectorAll('.agent-editor').forEach(row => {
      row.addEventListener('click', (e) => {
        if (!e.target.closest('.agent-editor-title')) return;
        const id = row.dataset.agentId;
        const agent = (store.get('agents') || []).find(a => a.id === id);
        if (!agent) return;
        // The code is the permanent handle: names can be duplicated, codes
        // cannot, and the code is what survives a rename.
        const text = agentCode(agent);
        copyToClipboard(text).then(ok => {
          store.emit('toast', {
            message: ok ? `Copied ${text}` : 'Could not reach the clipboard',
            type: ok ? 'success' : 'error',
          });
        });
      });
    });

    // Ask button: one agent, one question, no fan-out to anyone else.
    this.bodyEl.querySelectorAll('[data-agent-ask]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        store.emit('agent:ask', btn.dataset.agentAsk);
      });
    });

    // Add click handlers for menu buttons
    this.bodyEl.querySelectorAll('[data-agent-menu]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const agentId = btn.dataset.agentMenu;
        const menu = document.getElementById('menu-' + agentId);
        if (menu) {
          const isOpen = menu.style.display !== 'none';
          // Close all menus first
          this.bodyEl.querySelectorAll('.agent-menu').forEach(m => m.style.display = 'none');
          menu.style.display = isOpen ? 'none' : 'block';
        }
      });
    });

    // Add click handlers for menu items. Scoped to agent rows: the header's
    // pre-prompt menu reuses the same item classes but belongs to no row, so
    // without the guard every one of its clicks crashed here on a null row.
    this.bodyEl.querySelectorAll('.agent-editor .agent-menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = item.closest('.agent-editor');
        if (!row) return;
        const agentId = row.dataset.agentId;
        const action = item.dataset.action;
        if (action === 'edit') {
          store.emit('agent:edit', agentId);
        } else if (action === 'toggle') {
          store.emit('agent:toggle', agentId);
        } else if (action === 'delete') {
          store.emit('agent:delete', agentId);
        }
        // Close menu
        const menu = document.getElementById('menu-' + agentId);
        if (menu) menu.style.display = 'none';
      });
    });

    // NOTE: no row-click handler — agent settings open only via the ⋮ button
    // (menu button + menu items wired above).

    // Add button
    const addBtn = document.getElementById('addAgentBtn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        store.emit('agent:add');
      });
    }

    // Global pre-prompt button + menu (same open/close behaviour as agent rows)
    document.getElementById('prePromptBtn')?.addEventListener('click', (e) => {      e.stopPropagation();
      const menu = document.getElementById('prePromptMenu');
      if (!menu) return;
      const isOpen = menu.style.display !== 'none';
      this.bodyEl.querySelectorAll('.agent-menu').forEach(m => m.style.display = 'none');
      menu.style.display = isOpen ? 'none' : 'block';
    });
    // The API Lab lives in its own drawer, so this only has to ask for it.
    // Rendered per Agents-tab pass, hence the fresh node each time.
    document.getElementById('apiLabBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.apiLab?.toggle();
    });
    document.getElementById('brainLabBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.brainLab?.toggle();
    });
    document.querySelectorAll('#prePromptMenu [data-pre-action]').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = item.dataset.preAction;
        const menu = document.getElementById('prePromptMenu');
        if (menu) menu.style.display = 'none';
        if (action === 'edit') this._openPrePromptEditor();
        else if (action === 'toggle') this._togglePrePrompt();
      });
    });
    // Paint the token clocks into the rows just built. Metrics and governor
    // events repaint them afterwards; this covers the first render.
    try { refreshAgentClocks(); } catch { /* clocks are decorative */ }
  }

  /**
   * Flip the global pre-prompt override. With no text saved there is nothing
   * to turn on, so Activate opens the editor instead of arming an empty
   * prompt that would inject nothing.
   */
  _togglePrePrompt() {
    const cur = store.get('settings.globalPrePrompt') || { text: '', active: false };
    const text = cur.text || '';
    if (cur.active && text.trim()) {
      store.set('settings.globalPrePrompt', { text, active: false });
      store.emit('toast', { message: 'Global pre-prompt off', type: 'info' });
    } else if (text.trim()) {
      store.set('settings.globalPrePrompt', { text, active: true });
      store.emit('toast', { message: 'Global pre-prompt ON — replaces every agent’s own prompt while active', type: 'success' });
    } else {
      this._openPrePromptEditor();
      return;
    }
    persistence.set('settings', store.get('settings'));
    this.renderAgents();
  }

  /**
   * Popup editor for the override text. Save stores the text and arms the
   * override whenever there is anything to inject; saving empty (or clearing
   * the box) disarms it. Cancel changes nothing.
   */
  _openPrePromptEditor() {
    const cur = store.get('settings.globalPrePrompt') || { text: '', active: false };
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">Global pre-prompt override</span>
          <button class="modal-close" id="prePromptClose">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-hint" style="margin-bottom:8px">Replaces every
            agent's own system prompt while active — main chat, ask-directly and
            routing-chart runs alike. Stored custom prompts are untouched and
            return when this is switched off.</div>
          <textarea class="form-textarea" id="prePromptText" rows="6"
            placeholder="e.g. Always explain your reasoning before answering."></textarea>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="prePromptCancel">Cancel</button>
          <button class="btn btn-primary" id="prePromptSave">Save</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#prePromptClose').addEventListener('click', close);
    overlay.querySelector('#prePromptCancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const ta = overlay.querySelector('#prePromptText');
    ta.value = cur.text || '';
    ta.focus();
    overlay.querySelector('#prePromptSave').addEventListener('click', () => {
      const text = ta.value;
      const active = !!text.trim();
      store.set('settings.globalPrePrompt', { text, active });
      persistence.set('settings', store.get('settings'));
      store.emit('toast', {
        message: active
          ? 'Global pre-prompt saved and ON — replaces every agent’s own prompt while active'
          : 'Global pre-prompt cleared and off',
        type: active ? 'success' : 'info',
      });
      close();
      this.renderAgents();
    });
  }

  /**
   * Proxy tab: fetch elite/anonymous proxies, ping them, save favorites,
   * and route the app's outbound relay traffic through the selected one.
   */
  async renderProxy() {
    this.bodyEl.innerHTML = `
      <div class="proxy-header">
        <button class="btn btn-primary btn-sm" id="proxyRefresh">Refresh List</button>
        <button class="btn btn-secondary btn-sm" id="proxyPingAll">Ping All</button>
        <button class="btn btn-secondary btn-sm" id="proxyClear">Clear Selection</button>
        <label class="proxy-filter">
          <input type="checkbox" id="proxyHideDead">
          <span>Working only</span>
        </label>
      </div>
      <div class="proxy-stats" id="proxyStats"></div>
      <div class="proxy-list" id="proxyList">Loading…</div>
    `;

    document.getElementById('proxyRefresh')?.addEventListener('click', () => this._fetchProxies());
    document.getElementById('proxyPingAll')?.addEventListener('click', () => this._pingAllProxies());
    document.getElementById('proxyClear')?.addEventListener('click', () => this._clearActiveProxy());
    document.getElementById('proxyHideDead')?.addEventListener('change', (e) => {
      this._hideDeadProxies = e.target.checked;
      this._renderProxyList();
    });

    await this._fetchProxies();
  }

  async _fetchProxies() {
    const listEl = document.getElementById('proxyList');
    const statsEl = document.getElementById('proxyStats');
    listEl.innerHTML = '<div class="proxy-loading">Fetching proxy list…</div>';
    statsEl.textContent = '';

    try {
      const res = await api.getProxies();
      if (!res.ok) throw new Error(res.error || 'Failed to fetch proxies');
      this._proxies = res.proxies || [];
      this._renderProxyList();
      const st = res.stats || {};
      // Say what was dropped rather than showing a mysteriously shorter list.
      const dropped = [];
      if (st.not_ipv4) dropped.push(`${st.not_ipv4} non-IPv4`);
      if (st.not_anonymous) dropped.push(`${st.not_anonymous} not anonymous`);
      if (st.not_alive) dropped.push(`${st.not_alive} dead`);
      statsEl.textContent = `${this._proxies.length} IPv4 proxies (elite + anonymous)`
        + (dropped.length ? ` — filtered out ${dropped.join(', ')}` : '');
    } catch (err) {
      listEl.innerHTML = `<div class="proxy-error">Error: ${err.message}</div>`;
    }
  }

  _renderProxyList() {
    const listEl = document.getElementById('proxyList');
    if (!this._proxies?.length) {
      listEl.innerHTML = '<div class="proxy-empty">No proxies found.</div>';
      return;
    }

    const activeId = store.get('settings.proxyActive') || '';
    const favorites = store.get('settings.proxyFavorites') || [];

    // "Working only" hides everything that failed a ping. On a free list
    // that is the great majority, and a dead entry in the list is worse than
    // no entry: it looks selectable, and selecting it breaks every call.
    // Only meaningful once Ping All has run, so it stays a deliberate choice.
    let pool = this._proxies;
    const hideDead = this._hideDeadProxies;
    if (hideDead) {
      pool = pool.filter(p => typeof p.pingMs === 'number' && p.pingMs >= 0);
      // The ACTIVE proxy is never hidden, even when it failed. Filtering it out
      // would leave traffic routed through a dead proxy with no row on screen
      // to notice it or clear it -- the filter would make the problem harder
      // to see, which is the opposite of its purpose.
      const active = this._proxies.find(p => p.proxy === activeId);
      if (active && !pool.includes(active)) pool.push(active);
    }
    if (!pool.length) {
      const pinged = this._proxies.some(p => typeof p.pingMs === 'number');
      listEl.innerHTML = `<div class="proxy-empty">${
        pinged ? 'No proxies answered. Run Ping All again, or untick "Working only".'
               : 'Run Ping All first — nothing has been tested yet.'
      }</div>`;
      return;
    }

    // Sort: active first, then favorites, then by ping (ascending, null last)
    const sorted = [...pool].sort((a, b) => {
      const aActive = a.proxy === activeId;
      const bActive = b.proxy === activeId;
      if (aActive !== bActive) return aActive ? -1 : 1;
      const aFav = favorites.includes(a.proxy);
      const bFav = favorites.includes(b.proxy);
      if (aFav !== bFav) return aFav ? -1 : 1;
      const aPing = a.pingMs ?? Infinity;
      const bPing = b.pingMs ?? Infinity;
      return aPing - bPing;
    });

    listEl.innerHTML = sorted.map(p => this._renderProxyRow(p, activeId, favorites)).join('');

    // Bind events
    listEl.querySelectorAll('.proxy-ping').forEach(btn => {
      btn.addEventListener('click', (e) => this._pingProxy(e.currentTarget.dataset.proxy));
    });
    listEl.querySelectorAll('.proxy-fav').forEach(btn => {
      btn.addEventListener('click', (e) => this._toggleFavorite(e.currentTarget.dataset.proxy));
    });
    listEl.querySelectorAll('.proxy-select').forEach(btn => {
      btn.addEventListener('click', (e) => this._setActiveProxy(e.currentTarget.dataset.proxy));
    });
    listEl.querySelectorAll('.proxy-remove').forEach(btn => {
      btn.addEventListener('click', (e) => this._removeProxy(e.currentTarget.dataset.proxy));
    });
  }

  _renderProxyRow(p, activeId, favorites) {
    const isActive = p.proxy === activeId;
    const isFav = favorites.includes(p.proxy);
    const pingHtml = p.pingMs !== undefined
      ? `<span class="proxy-ping-value ${p.pingMs < 500 ? 'fast' : p.pingMs < 1500 ? 'medium' : 'slow'}">${p.pingMs} ms</span>`
      : `<span class="proxy-ping-value unknown">—</span>`;
    const anonBadge = p.anonymity === 'elite' ? 'elite' : 'anonymous';
    const country = p.country || '—';
    const ssl = p.ssl ? '🔒' : '';
    const uptime = p.uptime !== undefined ? `${p.uptime.toFixed(1)}%` : '—';

    return `
      <div class="proxy-row ${isActive ? 'active' : ''}" data-proxy="${p.proxy}">
        <div class="proxy-main">
          <div class="proxy-addr">
            <strong>${p.ip}:${p.port}</strong>
            <span class="proxy-ssl">${ssl}</span>
          </div>
          <div class="proxy-meta">
            <span class="proxy-anon ${anonBadge}">${anonBadge}</span>
            <span class="proxy-country">${country}</span>
            <span class="proxy-uptime">${uptime} uptime</span>
          </div>
        </div>
        <div class="proxy-actions">
          ${pingHtml}
          <button class="btn-proxy proxy-ping" data-proxy="${p.proxy}" ${p.pinging ? 'disabled' : ''} title="Ping this proxy">
            ${p.pinging ? '⏳' : '🏓'}
          </button>
          <button class="btn-proxy proxy-fav ${isFav ? 'active' : ''}" data-proxy="${p.proxy}" title="Toggle favorite">
            ${isFav ? '★' : '☆'}
          </button>
          <button class="btn-proxy proxy-select ${isActive ? 'active' : ''}" data-proxy="${p.proxy}" ${isActive ? 'disabled' : ''} title="${isActive ? 'Active' : 'Use this proxy'}">
            ${isActive ? '✓ Active' : 'Use'}
          </button>
          <button class="btn-proxy proxy-remove" data-proxy="${p.proxy}" title="Remove from list">
            ✕
          </button>
        </div>
      </div>
    `;
  }

  async _pingProxy(proxyStr) {
    const [ip, port] = proxyStr.split(':');
    const rowEl = document.querySelector(`.proxy-row[data-proxy="${proxyStr}"]`);
    const pingEl = rowEl?.querySelector('.proxy-ping-value');
    const btnEl = rowEl?.querySelector('.proxy-ping');

    if (!rowEl || !pingEl || !btnEl) return;

    btnEl.disabled = true;
    btnEl.textContent = '⏳';
    pingEl.textContent = '…';
    pingEl.className = 'proxy-ping-value';

    try {
      const res = await api.pingProxy(ip, parseInt(port, 10));
      if (res.ok) {
        // Update local array
        const p = this._proxies.find(x => x.proxy === proxyStr);
        if (p) p.pingMs = res.pingMs;
        // Re-render just the ping value with color
        pingEl.textContent = `${res.pingMs} ms`;
        pingEl.className = `proxy-ping-value ${res.pingMs < 500 ? 'fast' : res.pingMs < 1500 ? 'medium' : 'slow'}`;
      } else {
        pingEl.textContent = '✕ failed';
        pingEl.className = 'proxy-ping-value slow';
      }
    } catch (err) {
      pingEl.textContent = '✕ error';
      pingEl.className = 'proxy-ping-value slow';
    } finally {
      btnEl.disabled = false;
      btnEl.textContent = '🏓';
    }
  }

  async _pingAllProxies() {
    const btnEl = document.getElementById('proxyPingAll');
    if (!this._proxies?.length) {
      store.emit('toast', { message: 'No proxies loaded — click Refresh List first', type: 'error' });
      return;
    }
    btnEl.disabled = true;
    btnEl.textContent = 'Pinging…';

    const started = Date.now();
    try {
      // One request. The server pings the whole list concurrently with
      // curl_multi and returns them fastest-first. The old loop issued one
      // request per proxy, in series, each with a 15s timeout -- up to 64
      // minutes for 255 proxies, which is why the button looked dead.
      const res = await api.pingProxiesBatch(
        this._proxies.map(p => ({ ip: p.ip, port: parseInt(p.port, 10) }))
      );
      const byKey = new Map((res.results || []).map(r => [`${r.ip}:${r.port}`, r.pingMs]));
      let alive = 0;
      for (const p of this._proxies) {
        const ms = byKey.get(`${p.ip}:${p.port}`);
        p.pingMs = (ms === null || ms === undefined) ? -1 : ms;
        if (p.pingMs >= 0) alive++;
      }
      this._renderProxyList();
      store.emit('toast', {
        message: `${alive} of ${this._proxies.length} proxies answered in ${Math.round((Date.now() - started) / 1000)}s`,
        type: alive ? 'success' : 'error',
      });
    } catch (err) {
      store.emit('toast', { message: `Ping all failed: ${err.message}`, type: 'error' });
    } finally {
      btnEl.disabled = false;
      btnEl.textContent = 'Ping All';
    }
  }

  _toggleFavorite(proxyStr) {
    const favorites = store.get('settings.proxyFavorites') || [];
    const idx = favorites.indexOf(proxyStr);
    if (idx >= 0) favorites.splice(idx, 1);
    else favorites.push(proxyStr);
    store.set('settings.proxyFavorites', favorites);
    persistence.set('settings', store.get('settings'));
    this._renderProxyList();
  }

  /**
   * Select a proxy, or deselect it by clicking it again.
   *
   * Toggling matters because "route everything through a proxy" is a state you
   * want to LEAVE. With no way back, a stale selection silently keeps sending
   * every agent call through a proxy that may since have died.
   */
  async _setActiveProxy(proxyStr) {
    const p = this._proxies.find(x => x.proxy === proxyStr);
    if (!p) return;

    const wasActive = (store.get('settings.proxyActive') || '') === proxyStr;
    const next = wasActive ? '' : proxyStr;

    store.set('settings.proxyActive', next);
    persistence.set('settings', store.get('settings'));
    try {
      // Server-side too: the relay runs here, so a browser-only setting would
      // change nothing about where traffic actually goes.
      await api.setActiveProxy(next);
    } catch (err) {
      store.emit('toast', { message: `Proxy selection not saved: ${err.message}`, type: 'error' });
    }
    store.emit('toast', {
      message: next ? `Active proxy: ${next}` : 'Proxy cleared — traffic is direct again',
      type: next ? 'success' : 'info',
    });
    this._renderProxyList();
  }

  _clearActiveProxy() {
    store.set('settings.proxyActive', '');
    persistence.set('settings', store.get('settings'));
    store.emit('toast', { message: 'Proxy cleared — using direct connection', type: 'info' });
    this._renderProxyList();
  }

  _removeProxy(proxyStr) {
    this._proxies = this._proxies.filter(x => x.proxy !== proxyStr);
    const favorites = store.get('settings.proxyFavorites') || [];
    store.set('settings.proxyFavorites', favorites.filter(x => x !== proxyStr));
    if (store.get('settings.proxyActive') === proxyStr) {
      store.set('settings.proxyActive', '');
    }
    persistence.set('settings', store.get('settings'));
    this._renderProxyList();
  }

  /**
   * Drag-to-reorder for the agent list.
   *
   * Pointer events rather than HTML5 drag-and-drop, because HTML5 DnD does not
   * fire on touch at all and this list is usable on a phone. The dragged row is
   * moved through the DOM as the pointer crosses each neighbour's midpoint, and
   * translated to stay under the cursor, so the row you grabbed is the row that
   * moves.
   *
   * The grip is the primary handle because `touch-action: none` on it leaves
   * the rest of the row free to scroll normally; dragging by the header also
   * works for the mouse.
   */
  _attachAgentDragSort() {
    const rows = Array.from(this.bodyEl.querySelectorAll('.agent-editor'));
    rows.forEach(row => {
      const grip = row.querySelector('.agent-grip');
      const header = row.querySelector('.agent-editor-header');
      [grip, header].filter(Boolean).forEach(handle => {
        handle.addEventListener('pointerdown', (e) => {
          // Buttons and menus keep their own behaviour.
          if (e.target.closest('button, .agent-menu, input, select, textarea')) return;
          this._startAgentDrag(e, row);
        });
      });
    });
  }

  _startAgentDrag(e, row) {
    if (this._drag) return; // one drag at a time
    const pointerId = e.pointerId;
    const startY = e.clientY;
    const isTouch = e.pointerType === 'touch';
    // A touch needs a moment's hold so a scroll is never mistaken for a drag.
    const threshold = isTouch ? 8 : 5;
    const rect = row.getBoundingClientRect();
    const grabOffset = startY - rect.top;
    // Element references, not ids: restoring a cancelled drag should not depend
    // on CSS.escape or on building an attribute selector from an id.
    const originalOrder = Array.from(
      this.bodyEl.querySelectorAll('.agent-editor')
    );

    const state = { row, pointerId, startY, grabOffset, active: false, originalOrder };
    this._drag = state;

    // Deliberately no setPointerCapture: with capture active the browser
    // retargets the follow-up click to the capturing element, so a click on the
    // agent's name would never reach the copy handler. Tracking on window
    // already keeps working outside the element.
    const move = (ev) => this._onAgentDragMove(ev, state, threshold);
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey, true);
      this._finishAgentDrag(state, ev.type === 'pointercancel');
    };
    const cancel = () => up({ type: 'pointercancel' });
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    };

    state.move = move;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey, true);
    // Keep the browser from scrolling the panel out from under the drag.
    if (isTouch) e.preventDefault();
  }

  _onAgentDragMove(e, state, threshold) {
    if (e.pointerId !== state.pointerId) return;
    const dy = e.clientY - state.startY;
    if (!state.active) {
      if (Math.abs(dy) < threshold) return; // still just a click
      state.active = true;
      state.row.classList.add('agent-dragging');
      document.body.classList.add('agent-reordering');
    }
    e.preventDefault();

    const row = state.row;
    const siblings = Array.from(
      this.bodyEl.querySelectorAll('.agent-editor')
    ).filter(r => r !== row);

    // Drop into whichever neighbour the pointer is above the midpoint of.
    let placed = false;
    for (const sib of siblings) {
      const r = sib.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        this.bodyEl.insertBefore(row, sib);
        placed = true;
        break;
      }
    }
    if (!placed) this.bodyEl.appendChild(row);

    // Re-measure with the transform cleared: reading the rect while it is
    // applied would feed its own offset back in and drift.
    row.style.transform = 'none';
    const base = row.getBoundingClientRect().top;
    row.style.transform = `translateY(${e.clientY - state.grabOffset - base}px)`;
  }

  _finishAgentDrag(state, cancelled) {
    this._drag = null;
    const row = state.row;
    document.body.classList.remove('agent-reordering');
    row.classList.remove('agent-dragging');
    row.style.transform = '';

    const currentOrder = Array.from(
      this.bodyEl.querySelectorAll('.agent-editor')
    ).map(r => r.dataset.agentId);
    const originalIds = state.originalOrder.map(r => r.dataset.agentId);
    const unchanged = currentOrder.every((id, i) => id === originalIds[i]);

    if (cancelled || unchanged) {
      // Put it back where it started rather than leaving a cancelled drag
      // half-applied.
      state.originalOrder.forEach(el => this.bodyEl.appendChild(el));
      // No re-render here: nothing moved, so the DOM is already correct. It
      // would also replace this row's elements, and the click that follows a
      // plain press on the agent's name would land on a detached node.
      return;
    }
    this._commitAgentOrder(currentOrder);
  }

  /** Persist a new agent order and let the rest of the app react. */
  _commitAgentOrder(order) {
    const agents = [...(store.get('agents') || [])];
    const byId = new Map(agents.map(a => [a.id, a]));
    const reordered = order.map(id => byId.get(id)).filter(Boolean);
    // Anything not rendered (shouldn't happen) keeps its place at the end
    // rather than being silently dropped from the roster.
    agents.forEach(a => { if (!order.includes(a.id)) reordered.push(a); });

    persistence.set('agents', reordered);
    store.emit('agents:changed', { reordered: true });
    this.render();
  }

  /** Say what always-on will actually do, so the numbers are never a surprise. */
  _renderAlwaysOnStatus() {
    const el = document.getElementById('sbAlwaysOnStatus');
    if (!el) return;
    const s = store.get('settings') || {};
    const eligible = (store.get('agents') || []).filter(
      a => a && a.alwaysOn && a.active && String(a.alwaysOnGoal || '').trim()
    );
    if (!s.alwaysOn) {
      el.textContent = eligible.length
        ? `${eligible.length} agent(s) have a standing goal. Switch on to let them work.`
        : 'Give an agent a standing goal in its editor, then switch this on.';
      return;
    }
    if (!eligible.length) {
      el.textContent = 'Switched on, but no agent has a standing goal yet.';
      return;
    }
    const every = Math.max(10, parseInt(s.alwaysOnIntervalSec, 10) || 30);
    // ~3500 tokens a turn is a fair average for this app's agent prompts.
    const perHour = (3600 / every) * eligible.length;
    el.textContent = `Running for ${eligible.length} agent(s) every ${every}s — roughly `
      + `${Math.round(perHour)} turns/hour. Each turn is billed by your provider.`;
  }

  renderProviders() {
    const providers = store.get('providers') || [];

    let html = `<div class="sidebar-section-header">
      <span class="sidebar-section-title">${providers.length} providers</span>
      <button class="btn btn-primary btn-sm" id="addProviderBtn">+ ADD</button>
    </div>`;

    providers.forEach(provider => {
      html += `<div class="provider-card" data-provider-id="${esc(provider.id)}">
        <div class="provider-card-header">
          <div class="provider-name">${esc(provider.name)}</div>
          <div class="provider-card-actions">
            <div class="provider-status ${provider.active ? '' : 'inactive'}" style="pointer-events:none">${provider.active ? 'ACTIVE' : 'INACTIVE'}</div>
            <button class="provider-menu-btn" data-provider-menu="${esc(provider.id)}" title="Provider settings">&#8942;</button>
          </div>
        </div>
        <div style="font-size:10px;color:var(--text-secondary);word-break:break-all">${esc(provider.endpoint)}</div>
        <div style="font-size:9px;color:var(--text-dim);margin-top:4px">${provider.models.length} models &middot; ${esc(provider.authType)}</div>
        <div class="agent-menu" id="menu-${esc(provider.id)}" style="display:none">
          <button class="agent-menu-item" data-action="edit">Edit</button>
          <button class="agent-menu-item" data-action="toggle">${provider.active ? 'Deactivate' : 'Activate'}</button>
          <button class="agent-menu-item danger" data-action="delete">Delete</button>
        </div>
      </div>`;
    });

    this.bodyEl.innerHTML = html;

    // Add click handlers for menu buttons
    this.bodyEl.querySelectorAll('[data-provider-menu]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const providerId = btn.dataset.providerMenu;
        const menu = document.getElementById('menu-' + providerId);
        if (menu) {
          const isOpen = menu.style.display !== 'none';
          // Close all menus first
          this.bodyEl.querySelectorAll('.agent-menu').forEach(m => m.style.display = 'none');
          menu.style.display = isOpen ? 'none' : 'block';
        }
      });
    });

    // Add click handlers for menu items
    this.bodyEl.querySelectorAll('.provider-card .agent-menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const providerId = item.closest('.provider-card').dataset.providerId;
        const action = item.dataset.action;
        if (action === 'edit') {
          store.emit('provider:edit', providerId);
        } else if (action === 'toggle') {
          store.emit('provider:toggle', providerId);
        } else if (action === 'delete') {
          store.emit('provider:delete', providerId);
        }
        // Close menu
        const menu = document.getElementById('menu-' + providerId);
        if (menu) menu.style.display = 'none';
      });
    });

    // NOTE: no row-click handler — provider settings open only via the ⋮ button
    // (menu button + menu items wired above).

    // Add button
    const addBtn = document.getElementById('addProviderBtn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        store.emit('provider:add');
      });
    }
  }

  /**
   * One collapsible Config section.
   *
   * Native <details>/<summary> rather than a JS-driven accordion: the open
   * state, the tap behaviour, the keyboard path and the screen-reader
   * semantics are then the platform's, and all this has to do is decide
   * whether it starts open. Bodies stay in the DOM whether open or not, which
   * is what keeps the async status lines (project dir, exec, governor,
   * always-on) populating inside a collapsed section.
   *
   * The whole header is the tap target — 40px tall on a phone, where a 10px
   * label is not something you can hit with a thumb.
   */
  _cfgSection(id, label, badge, body) {
    const b = badge && badge.text
      ? `<span class="cfg-section-badge ${badge.cls || ''}">${esc(badge.text)}</span>`
      : '';
    return `
      <details class="cfg-section" data-cfg-section="${esc(id)}"${this._cfgOpen.has(id) ? ' open' : ''}>
        <summary class="cfg-section-head">
          <span class="cfg-chevron" aria-hidden="true">▸</span>
          <span class="cfg-section-title">${esc(label)}</span>
          ${b}
        </summary>
        <div class="cfg-body">${body}</div>
      </details>`;
  }

  /**
   * Rescue numbers typed but not yet saved, before the DOM is rebuilt.
   *
   * renderConfig() replaces innerHTML every time the tab is opened, and the
   * numbers only land on SAVE -- so switching tabs mid-edit used to discard
   * them silently. They are written into the store here (NOT persisted: SAVE
   * still owns that), which means they survive the rebuild, still show as
   * unsaved, and still need SAVE to become real.
   */
  _commitPendingCfgFields() {
    const num = (id, min, max, fallback) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const n = parseFloat(el.value);
      if (!Number.isFinite(n)) return null;
      return Math.max(min, Math.min(max, n));
    };
    const put = (key, value) => {
      if (value === null) return;
      if (store.get('settings.' + key) !== value) store.set('settings.' + key, value);
    };
    put('temperature', num('sbTemp', 0, 2, 1));
    put('maxTokens', num('sbMaxTokens', 256, 131072, 16384));
    put('alwaysOnIntervalSec', num('sbAlwaysOnInterval', 10, 3600, 30));
    put('alwaysOnGraceSec', num('sbAlwaysOnGrace', 0, 3600, 20));
    put('alwaysOnMaxIterations', num('sbAlwaysOnMaxIter', 0, 10000, 0));
    put('alwaysOnMaxMinutes', num('sbAlwaysOnMaxMin', 0, 100000, 0));
    put('rateLimitRpm', num('sbGovRpm', 0, 600, 0));
    put('rateLimitMaxWaitMs', num('sbGovMaxWait', 5, 600, 65) * 1000);
    put('tokenBudget', num('sbTokenBudget', 0, 1000000000, 0));

    // The project directory lives on the server and is fetched back on every
    // render, so it cannot be rescued the same way: the typed text is held
    // here and _loadProjectDir puts it back into the rebuilt field.
    const dirEl = document.getElementById('sbProjectDir');
    if (dirEl) {
      const typed = dirEl.value.trim();
      if (typed !== (store.get('settings.projectDir') || '').trim()) {
        this._cfgPendingDir = typed;
      } else {
        this._cfgPendingDir = null;
      }
    }
  }

  renderConfig() {
    // Rescue any pending edits FIRST: `settings` is read immediately after
    // this, so committing afterwards would rebuild the fields from the old
    // values and undo the rescue it just performed.
    this._commitPendingCfgFields();
    const settings = store.get('settings');

    // Numbers typed into a field and not yet saved were rescued at the top of
    // this method, before `settings` was read -- see _commitPendingCfgFields().

    const themeLabel = { dark: 'Dark', matrix: 'Matrix', cyberpunk: 'Cyberpunk' }[settings.theme] || 'Dark';
const ghost = { on: true, color: '#a8c0d8', size: 11, opacity: 0.3, ...(settings.chartGhost || {}) };
    const mem = settings.historyTurns ?? DEFAULT_HISTORY_TURNS;
    const rpm = Number(settings.rateLimitRpm) || 0;

    this.bodyEl.innerHTML = `
      ${this._cfgSection('iface', 'Interface', { text: themeLabel }, `
        <div class="form-group">
          <label class="form-label">Theme</label>
          <select class="form-select" id="sbTheme">
            <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>Dark</option>
            <option value="matrix" ${settings.theme === 'matrix' ? 'selected' : ''}>Matrix</option>
            <option value="cyberpunk" ${settings.theme === 'cyberpunk' ? 'selected' : ''}>Cyberpunk</option>
          </select>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Auto Scroll</span>
          <div class="toggle ${settings.autoScroll ? 'active' : ''}" id="sbAutoScroll">
            <div class="toggle-knob"></div>
          </div>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Enter to Send</span>
          <div class="toggle ${settings.enterToSend ? 'active' : ''}" id="sbEnterToSend">
            <div class="toggle-knob"></div>
          </div>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Show Thinking</span>
          <div class="toggle ${settings.showThinking ? 'active' : ''}" id="sbShowThinking">
            <div class="toggle-knob"></div>
          </div>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Show Terminal</span>
          <div class="toggle ${settings.showTerminal ? 'active' : ''}" id="sbShowTerminal">
            <div class="toggle-knob"></div>
          </div>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Loading screen</span>
          <div class="toggle ${Number(settings.loadingScreenMs) > 0 ? 'active' : ''}" id="sbLoadingScreen">
            <div class="toggle-knob"></div>
          </div>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Show Code</span>
          <div class="toggle ${settings.showCode ? 'active' : ''}" id="sbShowCode">
            <div class="toggle-knob"></div>
          </div>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Read replies aloud <span class="form-hint-inline">auto voice</span></span>
          <div class="toggle ${settings.autoSpeak ? 'active' : ''}" id="sbAutoSpeak">
            <div class="toggle-knob"></div>
          </div>
        </div>
        <div class="form-hint" id="sbAutoSpeakHint" style="margin:-6px 0 8px"></div>

        <div class="cfg-sublabel">Chart ghost transcript</div>
        <div class="toggle-row">
          <span class="toggle-label">Show chat behind the chart <span class="form-hint-inline">faint, not clickable</span></span>
          <div class="toggle ${ghost.on ? 'active' : ''}" id="sbGhostOn"><div class="toggle-knob"></div></div>
        </div>
        <div class="form-group" id="sbGhostBody">
          <label class="form-label">Text colour</label>
          <input type="color" class="form-input" id="sbGhostColor" value="${esc(ghost.color)}" style="height:32px;padding:2px">
          <label class="form-label">Text size (px)</label>
          <input type="number" class="form-input" id="sbGhostSize" value="${ghost.size}" min="7" max="22" step="1">
          <label class="form-label">Transparency</label>
          <input type="range" class="form-input" id="sbGhostOpacity" min="0.04" max="0.6" step="0.02" value="${ghost.opacity}">
          <div class="form-hint" id="sbGhostVal"></div>
          <div class="form-hint">The conversation printed faintly behind the routing chart's nodes, so you can see what your agents are saying without leaving the chart. Names and times only — no avatars, no scrollbar, nothing clickable. Nodes draw over it.</div>
        </div>
      `)}

      ${this._cfgSection('limits', 'Limits & Budgets', { text: `TEMP ${settings.temperature ?? 1.0}` }, `
        <div class="cfg-sublabel">Model</div>
        <div class="form-group">
          <label class="form-label">Temperature</label>
          <input type="range" class="form-input" id="sbTemp" min="0" max="2" step="0.1" value="${settings.temperature ?? 1.0}">
          <div class="form-hint" id="sbTempVal">${settings.temperature ?? 1.0}</div>
        </div>
        <div class="form-group">
          <label class="form-label">Max Tokens</label>
          <input type="number" class="form-input" id="sbMaxTokens" value="${settings.maxTokens ?? 16384}" min="256" max="131072">
        </div>

        <div class="cfg-sublabel">Loop cadence</div>
        <div class="form-group">
          <label class="form-label">Every tick (seconds)</label>
          <input type="number" class="form-input" id="sbAlwaysOnInterval" value="${settings.alwaysOnIntervalSec ?? 30}" min="10" max="3600">
        </div>
        <div class="form-group">
          <label class="form-label">Wait after you send (seconds)</label>
          <input type="number" class="form-input" id="sbAlwaysOnGrace" value="${settings.alwaysOnGraceSec ?? 20}" min="0" max="3600">
          <div class="form-hint">Quiet period after one of your messages before an autonomous tick may run. Without it a tick that came due while you were typing fired the moment your reply landed, and the agent looked like it had answered you twice. 0 turns it off.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Stop after (iterations)</label>
          <input type="number" class="form-input" id="sbAlwaysOnMaxIter" value="${settings.alwaysOnMaxIterations ?? 0}" min="0" max="10000">
          <div class="form-hint">0 = no cap; the agent stops itself when it declares the goal met.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Stop after (minutes)</label>
          <input type="number" class="form-input" id="sbAlwaysOnMaxMin" value="${settings.alwaysOnMaxMinutes ?? 0}" min="0" max="100000">
          <div class="form-hint">0 = no cap. Set one if you do not trust a goal to terminate.</div>
        </div>

        <div class="cfg-sublabel">Shell</div>
        <div class="form-group">
          <label class="form-label">Command timeout (seconds)</label>
          <input type="number" class="form-input" id="sbExecTimeout" min="5" max="600" value="60">
        </div>

        <div class="cfg-sublabel">Pacing</div>
        <div class="form-group">
          <label class="form-label">Requests per minute, per key <span class="form-hint-inline">0 = auto</span></label>
          <input type="number" class="form-input" id="sbGovRpm" min="0" max="600" value="${settings.rateLimitRpm ?? 0}">
          <div class="form-hint">0 = auto: each provider paces to its free-tier default from the harness table — NVIDIA NIM 40, Groq 30, OpenRouter 20, local runners unpaced. Any number here overrides every provider with a fixed ceiling.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Longest single wait (seconds)</label>
          <input type="number" class="form-input" id="sbGovMaxWait" min="5" max="600" value="${Math.round((settings.rateLimitMaxWaitMs ?? 65000) / 1000)}">
          <div class="form-hint">Past this the call goes out anyway and the retry path takes over. A wait that long means the key is saturated.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Token budget, per key <span class="form-hint-inline">0 = off</span></label>
          <input type="number" class="form-input" id="sbTokenBudget" min="0" max="1000000000" step="1000" value="${settings.tokenBudget ?? 0}">
          <div class="form-hint">What this key's plan allows (e.g. 8000000). Agent cards then show spent / budget, with a percentage. 0 leaves them at raw totals. A per-agent value can override it in Brain Lab.</div>
        </div>
      `)}

      ${this._cfgSection('perm', 'Permissions', settings.autoDeny
        ? { text: 'AUTO DENY', cls: 'danger' }
        : (mem === 0 ? { text: 'MEMORY OFF', cls: 'warn' } : { text: '' }), `
        <div class="form-group">
          <label class="form-label">Memory (past messages)</label>
          <input type="number" class="form-input" id="sbHistoryTurns" value="${mem}" min="0" max="50">
          <div class="form-hint">How many of your earlier messages each agent is shown before your new one, plus the replies that followed (so 5 = up to 10 messages). 0 = every message treated as the first (no memory).</div>
        </div>
        <div class="form-group">
          <label class="form-label">Working Project Directory</label>
          <input type="text" class="form-input" id="sbProjectDir" placeholder="/var/www/site/myproject" autocomplete="off" spellcheck="false">
          <div class="form-hint">The one folder every agent works in. They may read and write inside it, and nothing outside it. Full path on the server (<code>/var/www/site</code> or <code>C:\site</code>). Empty turns the file tools off; web search is unaffected.</div>
          <div class="form-hint" id="sbProjectStatus"></div>
        </div>

        <div class="cfg-sublabel">Always-On Agents <span class="form-hint-inline">work on their own</span></div>
        <div class="toggle-row">
          <span class="toggle-label">Enable always-on</span>
          <div class="toggle ${settings.alwaysOn ? 'active' : ''}" id="sbAlwaysOn">
            <div class="toggle-knob"></div>
          </div>
        </div>
        <div class="form-hint">Agents you have given a standing goal re-prompt themselves on a timer. Everything they do lands in this chat. Each iteration is billed, so leave the interval generous. Cadence is under Limits &amp; Budgets.</div>
        <div class="toggle-row">
          <span class="toggle-label">Run while tab is hidden</span>
          <div class="toggle ${settings.alwaysOnRunHidden ? 'active' : ''}" id="sbAlwaysOnHidden">
            <div class="toggle-knob"></div>
          </div>
        </div>
        <div class="form-hint" id="sbAlwaysOnStatus"></div>

        <div class="cfg-sublabel">Approvals</div>
        <div class="toggle-row">
          <span class="toggle-label">Auto Approve <span class="form-hint-inline">no prompt before a write</span></span>
          <div class="toggle ${settings.autoApprove ? 'active' : ''}" id="sbAutoApprove">
            <div class="toggle-knob"></div>
          </div>
        </div>
        <div class="form-hint" id="sbAutoApproveHint" style="margin:-6px 0 8px"></div>
        <div class="toggle-row">
          <span class="toggle-label">Auto Deny <span class="form-hint-inline">refuse anything that would ask</span></span>
          <div class="toggle ${settings.autoDeny ? 'active' : ''}" id="sbAutoDeny">
            <div class="toggle-knob"></div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Per-tool approval</label>
          ${[
            ['exec', 'Shell commands'],
            ['write_file', 'File writes'],
            ['write_note', 'Notes'],
            ['remember', 'Private memory'],
          ].map(([t, label]) => `
          <div class="toggle-row">
            <span class="toggle-label">${label}</span>
            <select class="form-select" id="sbToolPolicy-${t}" style="max-width:130px">
              ${['allow', 'ask', 'deny'].map(m =>
                `<option value="${m}"${(settings.toolPolicy?.[t] || 'ask') === m ? ' selected' : ''}>${m[0].toUpperCase() + m.slice(1)}</option>`).join('')}
            </select>
          </div>`).join('')}
          <div class="form-hint">Allow runs it, Ask prompts (skipped while Auto
            Approve is on), Deny refuses. Auto Deny above refuses all four.</div>
        </div>

        <div class="cfg-sublabel">Shell access <span class="form-hint-inline">agents running real commands</span></div>
        <div id="sbExecBlock" style="margin-top:6px">
          <div class="toggle-row">
            <span class="toggle-label">Allow agents to run commands</span>
            <div class="toggle" id="sbExecOn"><div class="toggle-knob"></div></div>
          </div>
          <div class="form-hint">Runs on this server as the web user, jailed to the directories above. Off by default; on your copy only. Its timeout is under Limits &amp; Budgets.</div>
          <div class="toggle-row" id="sbExecApprovalRow" style="margin-top:6px">
            <span class="toggle-label">Ask before running a new command</span>
            <div class="toggle" id="sbExecApproval"><div class="toggle-knob"></div></div>
          </div>
          <div class="form-hint">New commands pop up for approval wherever you are. Anything still waiting is counted below — open it to review.</div>
          <div class="form-hint" id="sbExecStatus"></div>
        </div>

        <div class="cfg-sublabel">Code interpreter <span class="form-hint-inline">run whole snippets</span></div>
        <div class="toggle-row">
          <span class="toggle-label">Allow the run_code tool</span>
          <div class="toggle" id="sbCodeOn"><div class="toggle-knob"></div></div>
        </div>
        <div class="form-hint">Runs a Python/Node/bash snippet in the sandbox working directory as the web user. Stronger than the command allowlist, so it is off by default and separate from shell access. The agent asks before each run.</div>
        <button class="btn btn-ghost btn-block" id="sbPolicyBtn" style="margin-top:12px">ALLOW / DENY LIST</button>
        <div class="form-hint" id="sbPolicyHint" style="margin:4px 0 0"></div>
      `)}

      ${this._cfgSection('throttle', 'Throttle / Limiter', {
        text: settings.rateLimitEnabled !== false ? `ON · ${rpm ? rpm + '/min' : 'AUTO'}` : 'OFF',
        cls: settings.rateLimitEnabled !== false ? 'ok' : '',
      }, `
        <div class="toggle-row">
          <span class="toggle-label">Pace model calls</span>
          <div class="toggle ${settings.rateLimitEnabled !== false ? 'active' : ''}" id="sbGovOn"><div class="toggle-knob"></div></div>
        </div>
        <div class="form-hint">Counts requests per API key over a rolling minute. Over budget, calls queue and wait instead of spending a 429 refusal. Each key is its own bucket — your separate accounts do not share. The two numbers it uses are under Limits &amp; Budgets.</div>
        <div class="toggle-row" style="margin-top:6px">
          <span class="toggle-label">Stealth waits <span class="form-hint-inline">no toast while queuing</span></span>
          <div class="toggle ${settings.rateLimitStealth !== false ? 'active' : ''}" id="sbGovStealth"><div class="toggle-knob"></div></div>
        </div>
        <div class="toggle-row" style="margin-top:6px">
          <span class="toggle-label">Tell agents their budget <span class="form-hint-inline">off by default</span></span>
          <div class="toggle ${settings.budgetInjection === true ? 'active' : ''}" id="sbGovInject"><div class="toggle-knob"></div></div>
        </div>
        <div class="form-hint">Adds a short budget line to the system prompt, but only once a key is half spent. Costs tokens on those turns, and models are unreliable at throttling themselves — the limiter works whether they know or not.</div>
        <div class="form-hint" id="sbGovStatus"></div>
      `)}

      ${this._cfgSection('mcp', 'MCP Client', { text: `${(this._mcpServers || []).length || ''}` }, `
        <div class="form-hint">Connect OUT to other MCP servers. Each gives your agents extra tools (filesystem, git, fetch, a company API…). Agents call them with <code>mcp_list</code> / <code>mcp_call</code>. To let someone else use <b>your</b> tools, see the MCP Server section.</div>
        <div id="sbMcpList"></div>
        <button class="btn btn-ghost btn-block" id="sbMcpAdd" style="margin-top:8px">+ ADD SERVER</button>
        <button class="btn btn-primary btn-block" id="sbMcpSave" style="margin-top:8px">SAVE MCP CLIENT</button>
        <div class="form-hint" id="sbMcpStatus"></div>
      `)}

      ${this._cfgSection('mcpserver', 'MCP Server', { text: this._mcpSrv?.enabled ? 'ON' : '', cls: this._mcpSrv?.enabled ? 'ok' : '' }, `
        <div class="form-hint">Let someone else's MCP client — a friend's local model, Claude Desktop, Cursor — use tools on THIS machine. Each friend gets their own token and scope. Nothing here is permanent; it is all your switch.</div>
        <div class="toggle-row">
          <span class="toggle-label">Enable the MCP server</span>
          <div class="toggle ${this._mcpSrv?.enabled ? 'active' : ''}" id="sbMcpSrvOn"><div class="toggle-knob"></div></div>
        </div>
        <div class="form-group">
          <label class="form-label">Scratch folder friends work in</label>
          <input class="form-input" id="sbMcpSrvRoot" value="${escAttr(this._mcpSrv?.root || '')}" placeholder="e.g. /var/www/site/friends">
          <div class="form-hint">Their file tools and command working directory are jailed here, and a deny-all .htaccess is dropped in so nothing they write is served over the web.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Protected paths <span class="form-hint-inline">refused even inside the root</span></label>
          <textarea class="form-textarea" id="sbMcpSrvProtect" rows="3" placeholder="one rule per line">${esc((this._mcpSrv?.protect || []).join('\n'))}</textarea>
          <div class="form-hint">Secrets the file tools always refuse (default: storage, keys, dotfiles). Clear it entirely to turn protection off.</div>
        </div>
        <div class="form-label">Friend tokens</div>
        <div id="sbMcpSrvTokens"></div>
        <button class="btn btn-ghost btn-block" id="sbMcpSrvAdd" style="margin-top:8px">+ ADD FRIEND</button>
        <button class="btn btn-primary btn-block" id="sbMcpSrvSave" style="margin-top:8px">SAVE MCP SERVER</button>
        <div class="form-hint" id="sbMcpSrvStatus"></div>
      `)}

      <div class="cfg-cluster">
        <div class="form-group" style="margin-top:0">
          <label class="form-label">Access token</label>
          <div style="display:flex;gap:6px">
            <input type="password" class="form-input" id="sbRouterToken" style="flex:1;min-width:0"
              value="${settings.routerToken ? esc(settings.routerToken) : ''}"
              placeholder="paste the token from storage/config.json" autocomplete="off">
            <button class="btn btn-ghost" id="sbTokenShow" title="Show the token to check the paste">Show</button>
            <button class="btn btn-primary" id="sbTokenSave" title="Save the token now">Save</button>
          </div>
          <div class="form-hint" id="sbTokenStatus"></div>
          <div class="form-hint">Required while <code>require_token</code> is on. Every API call sends this in
            the <code>X-Router-Token</code> header, and without it every endpoint answers 401.</div>
        </div>
        <button class="btn btn-ghost btn-block" id="sbUsageBtn" style="margin-top:8px">USAGE</button>
        <button class="btn btn-ghost btn-block" id="sbTraceBtn" style="margin-top:8px">TRACE</button>
        <button class="btn btn-ghost btn-block" id="sbDiagBtn" style="margin-top:8px">DIAGNOSE PROVIDERS</button>
        <div class="form-hint" id="sbDiagHint" style="margin:4px 0 0"></div>
        <div id="sbDiagOut"></div>
        <button class="btn btn-ghost btn-block" id="sbExportBtn" style="margin-top:8px">EXPORT SESSION</button>
        <button class="btn btn-ghost btn-block" id="sbBackupBtn" style="margin-top:8px">FULL BACKUP</button>
        <button class="btn btn-ghost btn-block" id="sbRestoreBtn" style="margin-top:8px">RESTORE BACKUP…</button>
        <div class="form-hint">A full backup holds everything — sessions, agents
          (settings, prompts, memories), providers, config, allow/deny lists,
          workflows — <b>including API keys and the access token</b>. Keep the
          file somewhere safe, never post it.</div>
        <input type="file" id="sbRestoreFile" accept=".json,application/json" hidden>
        <button class="btn btn-ghost btn-block cfg-danger" id="sbResetBtn" style="margin-top:8px">RESET ALL</button>
      </div>

      <div class="cfg-savebar">
        <div class="cfg-savebar-hint" id="cfgSaveHint">Switches apply instantly · numbers save here</div>
        <button class="btn btn-primary btn-block" id="sbSaveBtn">SAVE</button>
      </div>
    `;

    // Open/close bookkeeping, in memory for this session only. The `toggle`
    // event does not bubble, but it is attached per element here, so each
    // <details> reports its own state and it is remembered for the next
    // render within the session (a reload starts from an empty set, so every
    // section is collapsed again).
    this.bodyEl.querySelectorAll('details.cfg-section').forEach(det => {
      det.addEventListener('toggle', () => {
        const id = det.dataset.cfgSection;
        if (det.open) this._cfgOpen.add(id);
        else this._cfgOpen.delete(id);
      });
    });

    // A pending number marks its section so the header can show it. Only the
    // fields that genuinely wait for SAVE are marked: Theme, the per-tool
    // selects, the shell timeout and Memory all persist the moment they
    // change, so a dot on those would appear and never clear. The save itself
    // still happens on SAVE -- this is only the "you changed something" signal.
    [
      'sbTemp', 'sbMaxTokens',
      'sbAlwaysOnInterval', 'sbAlwaysOnGrace', 'sbAlwaysOnMaxIter', 'sbAlwaysOnMaxMin',
      'sbGovRpm', 'sbGovMaxWait', 'sbTokenBudget', 'sbProjectDir',
    ].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const mark = () => el.closest('details.cfg-section')?.classList.add('dirty');
      el.addEventListener('input', mark);
      el.addEventListener('change', mark);
    });

    // Theme change
    document.getElementById('sbTheme').addEventListener('change', (e) => {
      store.emit('theme:change', e.target.value);
    });

    // Temperature
    const tempSlider = document.getElementById('sbTemp');
    const tempVal = document.getElementById('sbTempVal');
    tempSlider.addEventListener('input', (e) => {
      tempVal.textContent = e.target.value;
      store.set('settings.temperature', parseFloat(e.target.value));
      localStorage.setItem(K.TEMP, e.target.value);
    });

    // Max tokens
    document.getElementById('sbMaxTokens').addEventListener('change', (e) => {
      store.set('settings.maxTokens', parseInt(e.target.value, 10));
      localStorage.setItem(K.MAX_TOKENS, e.target.value);
    });

    // Memory depth
    document.getElementById('sbHistoryTurns')?.addEventListener('change', (e) => {
      const n = Math.max(0, Math.min(50, parseInt(e.target.value, 10) || 0));
      store.set('settings.historyTurns', n);
      try { localStorage.setItem(K.HISTORY_TURNS, String(n)); } catch {}
    });

    // Working project directory — fetch the current value so the field shows
    // what the server is actually using, not a stale local copy.
    this._loadProjectDir();

    // MCP servers live server-side (config.json); render the cached list and
    // refresh from the server in the background.
    this._initMcpSection();
    // MCP *server* config (friends connect in) — also server-side.
    this._initMcpServerSection();

    // Shell access lives server-side (config.json), because that is where the
    // gate is enforced — a browser-side flag would be a lie the server ignores.
    this._loadExecSettings();

    // Toggles
    this._initToggle('sbAutoSpeak', (val) => {
      store.set('settings.autoSpeak', val);
      persistence.set('settings', store.get('settings'));
      const hint = document.getElementById('sbAutoSpeakHint');
      if (hint) {
        hint.textContent = val
          ? 'Every agent reply is read. Individual agents can be muted in their own settings.'
          : 'Off. Replies are only read when you click the speaker.';
      }
    });
    {
      const hint = document.getElementById('sbAutoSpeakHint');
      if (hint) {
        hint.textContent = settings.autoSpeak
          ? 'Every agent reply is read. Individual agents can be muted in their own settings.'
          : 'Off. Replies are only read when you click the speaker.';
      }
    }

    // Allow / deny editor
    // Saved on input rather than on SAVE. If the token is wrong the app cannot
    // reach the API, and the SAVE button is an API call -- so requiring a save
    // first would lock you out with no way to correct it.
    // Read the field ON DEMAND rather than trusting blur/change alone: on
    // mobile the change event is unreliable (re-renders and keyboard
    // behaviour can swallow the blur), which silently dropped pastes.
    const saveTokenFromField = () => {
      const field = document.getElementById('sbRouterToken');
      if (!field) return;
      const v = field.value.trim();
      store.set('settings.routerToken', v);
      persistence.set('settings', store.get('settings'));
      const status = document.getElementById('sbTokenStatus');
      if (!v) {
        if (status) status.textContent = '';
        store.emit('toast', { message: 'Access token cleared', type: 'info' });
        return;
      }
      // Verify live, right here: a masked field gives no way to eyeball the
      // paste, so the app says immediately whether the server accepts it.
      // api.getState is a side-effect-free read; a 401 rejects the promise.
      if (status) status.textContent = 'Checking token…';
      api.getState().then(
        () => {
          const s = document.getElementById('sbTokenStatus');
          if (s) s.textContent = 'Token works ✓';
        },
        () => {
          const s = document.getElementById('sbTokenStatus');
          if (s) s.textContent = 'Token rejected ✗ — re-copy it carefully and paste again.';
        }
      );
      store.emit('toast', { message: 'Access token saved', type: 'success' });
    };
    const tokenInput = document.getElementById('sbRouterToken');
    tokenInput?.addEventListener('change', saveTokenFromField);
    document.getElementById('sbTokenSave')?.addEventListener('click', saveTokenFromField);
    // Let the paste be eyeballed: masked dots hide a truncated copy, which is
    // the usual way a 64-char token fails on a phone.
    document.getElementById('sbTokenShow')?.addEventListener('click', () => {
      const inp = document.getElementById('sbRouterToken');
      const btn = document.getElementById('sbTokenShow');
      if (!inp) return;
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      if (btn) btn.textContent = show ? 'Hide' : 'Show';
    });

    document.getElementById('sbPolicyBtn')?.addEventListener('click', () => this.openPolicyEditor());
    this._loadPolicyHint();

    this._initToggle('sbAutoScroll', (val) => store.set('settings.autoScroll', val));
    this._initToggle('sbEnterToSend', (val) => store.set('settings.enterToSend', val));
    // Applied to the panels immediately, not just saved: without this the
    // switch visibly did nothing until the next reload, which reads as broken.
    this._initToggle('sbShowThinking', (val) => {
      store.set('settings.showThinking', val);
      document.getElementById('thinkingPanel')?.classList.toggle('hidden', !val);
    });
    this._initToggle('sbShowTerminal', (val) => {
      store.set('settings.showTerminal', val);
      document.getElementById('terminalPanel')?.classList.toggle('hidden', !val);
    });
    // Off means zero milliseconds, not "some shorter time" -- the splash either
    // exists or it does not. Default (absent) is off.
    this._initToggle('sbLoadingScreen', (val) => {
      store.set('settings.loadingScreenMs', val ? 12200 : 0);
      store.emit('toast', {
        message: val
          ? 'Loading screen on — it applies on your next reload.'
          : 'Loading screen off — it applies on your next reload.',
        type: 'info',
      });
    });
    this._initToggle('sbShowCode', (val) => store.set('settings.showCode', val));

// Ghost transcript: applies the moment it is changed, like every other
// display switch here. There is no SAVE to wait for and nothing to persist
// beyond the settings blob, which _initToggle already does.
    const ghostBody = document.getElementById('sbGhostBody');
    const ghostVal = document.getElementById('sbGhostVal');
    const paintGhostBody = () => { if (ghostBody) ghostBody.style.opacity = ghost.on ? '1' : '0.45'; };
    const ghostLabel = () => {
      if (!ghostVal) return;
      ghostVal.textContent = ghost.on
        ? `on · ${ghost.color} · ${ghost.size}px · ${Math.round(ghost.opacity * 100)}% visible`
        : 'off — the chart canvas is clear';
    };
    const setGhost = (patch) => {
      store.set('settings.chartGhost', { ...(store.get('settings.chartGhost') || ghost), ...patch });
      Object.assign(ghost, store.get('settings.chartGhost'));
      paintGhostBody();
      ghostLabel();
    };
    this._initToggle('sbGhostOn', (val) => setGhost({ on: val }));
    document.getElementById('sbGhostColor')?.addEventListener('input', (e) => setGhost({ color: e.target.value }));
    document.getElementById('sbGhostSize')?.addEventListener('change', (e) => {
      const n = Math.max(7, Math.min(22, parseInt(e.target.value, 10) || 11));
      e.target.value = String(n);
      setGhost({ size: n });
    });
    document.getElementById('sbGhostOpacity')?.addEventListener('input', (e) => {
      setGhost({ opacity: Math.max(0.04, Math.min(0.6, parseFloat(e.target.value) || 0.3)) });
    });
    paintGhostBody();
    ghostLabel();

    // Auto Deny is the panic button: anything that would ask is refused.
    this._initToggle('sbAutoDeny', (val) => store.set('settings.autoDeny', val));
    // Per-tool allow/ask/deny. Persisted like every other setting, so it
    // syncs; the running loop reads it live on each call.
    for (const t of ['exec', 'write_file', 'write_note', 'remember']) {
      document.getElementById('sbToolPolicy-' + t)?.addEventListener('change', (e) => {
        const settings = store.get('settings') || {};
        const policy = { ...(settings.toolPolicy || {}) };
        policy[t] = e.target.value;
        store.set('settings.toolPolicy', policy);
        persistence.set('settings', store.get('settings'));
      });
    }
    // Auto Approve changes what a click means, so say what it turned off.
    this._initToggle('sbAutoApprove', (val) => {
      store.set('settings.autoApprove', val);
      const hint = document.getElementById('sbAutoApproveHint');
      if (hint) {
        hint.textContent = val
          ? 'Agents can write files and notes without asking you first.'
          : '';
      }
      if (val) {
        store.emit('toast', {
          message: 'Auto approve on — writes will not ask', type: 'info',
        });
      }
    });
    if (settings.autoApprove) {
      const hint = document.getElementById('sbAutoApproveHint');
      if (hint) hint.textContent = 'Agents can write files and notes without asking you first.';
    }

    // Always-on: the master switch starts and stops the scheduler immediately,
    // so flipping it takes effect without waiting for the SAVE button.
    this._initToggle('sbAlwaysOn', (val) => {
      store.set('settings.alwaysOn', val);
      persistence.set('settings', store.get('settings'));
      store.emit('settings:changed');
      this._renderAlwaysOnStatus();
    });
    this._initToggle('sbAlwaysOnHidden', (val) => {
      store.set('settings.alwaysOnRunHidden', val);
      persistence.set('settings', store.get('settings'));
    });
    this._renderAlwaysOnStatus();

    // Rate governor: master switch + stealth + injection apply immediately,
    // the numbers land on SAVE like every other field in this tab.
    this._initToggle('sbGovOn', (val) => {
      store.set('settings.rateLimitEnabled', val);
      store.emit('settings:changed');
      this._renderGovStatus();
    });
    this._initToggle('sbGovStealth', (val) => {
      store.set('settings.rateLimitStealth', val);
    });
    this._initToggle('sbGovInject', (val) => {
      store.set('settings.budgetInjection', val);
      if (val) {
        store.emit('toast', {
          message: 'Budget injection on — agents see a budget line once a key is half spent',
          type: 'info',
        });
      }
    });
    this._renderGovStatus();

    // Save (writes current field values through, confirms to user)
    document.getElementById('sbSaveBtn').addEventListener('click', async () => {
      const theme = document.getElementById('sbTheme')?.value;
      const temp = parseFloat(document.getElementById('sbTemp')?.value);
      const maxTokens = parseInt(document.getElementById('sbMaxTokens')?.value, 10);
      if (theme) {
        store.set('settings.theme', theme);
        store.emit('theme:change', theme);
      }
      if (isFinite(temp)) {
        store.set('settings.temperature', temp);
        try { localStorage.setItem(K.TEMP, String(temp)); } catch {}
      }
      if (isFinite(maxTokens)) {
        store.set('settings.maxTokens', maxTokens);
        try { localStorage.setItem(K.MAX_TOKENS, String(maxTokens)); } catch {}
      }
      // If the field is missing for any reason, KEEP the current value rather
      // than defaulting to 0: `parseInt(undefined) || 0` would silently turn
      // every agent's conversation memory off on a SAVE.
      const historyTurns = (() => {
        const el = document.getElementById('sbHistoryTurns');
        if (!el) return store.get('settings.historyTurns') ?? DEFAULT_HISTORY_TURNS;
        const n = parseInt(el.value, 10);
        return Number.isFinite(n) ? Math.max(0, Math.min(50, n))
          : (store.get('settings.historyTurns') ?? DEFAULT_HISTORY_TURNS);
      })();
      store.set('settings.historyTurns', historyTurns);
      try { localStorage.setItem(K.HISTORY_TURNS, String(historyTurns)); } catch {}

      // Always-on fields are live-toggled but the numbers land on SAVE, the
      // same as every other field in this tab.
      const clamp = (id, min, max, fallback) => {
        const el = document.getElementById(id);
        const n = parseInt(el?.value, 10);
        return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
      };
      store.set('settings.alwaysOnIntervalSec', clamp('sbAlwaysOnInterval', 10, 3600, 30));
      store.set('settings.alwaysOnGraceSec', clamp('sbAlwaysOnGrace', 0, 3600, 20));
      store.set('settings.alwaysOnMaxIterations', clamp('sbAlwaysOnMaxIter', 0, 10000, 0));
      store.set('settings.alwaysOnMaxMinutes', clamp('sbAlwaysOnMaxMin', 0, 100000, 0));
      // Rate governor numbers land on SAVE; the toggles above are already live.
      store.set('settings.rateLimitRpm', clamp('sbGovRpm', 0, 600, 0));
      store.set('settings.rateLimitMaxWaitMs', clamp('sbGovMaxWait', 5, 600, 65) * 1000);
      store.set('settings.tokenBudget', clamp('sbTokenBudget', 0, 1000000000, 0));

      persistence.set('settings', store.get('settings'));
      store.emit('settings:changed');
      this._renderAlwaysOnStatus();
      // Nothing is pending any more: drop the dots and say so in the bar.
      this.bodyEl.querySelectorAll('details.cfg-section.dirty').forEach(d => d.classList.remove('dirty'));
      this._cfgPendingDir = null;
      const hint = document.getElementById('cfgSaveHint');
      if (hint) hint.textContent = 'Saved ✓';
      store.emit('toast', { message: 'Configuration saved', type: 'success' });

      // The working directory lives on the server, so it saves separately from
      // the browser-side settings above. A failure here must not look like the
      // whole save worked, hence its own toast.
      const dirInput = document.getElementById('sbProjectDir');
      if (dirInput) {
        try {
          const dir = await this._saveProjectDir(dirInput.value);
          // Agents need to know where they are; keep it in the store so the
          // tool instructions can tell them without another round trip.
          store.set('settings.projectDir', dir);
          persistence.set('settings', store.get('settings'));
          store.emit('sandbox:dirChanged', dir);
          store.emit('toast', {
            message: dir ? `Working directory: ${dir}` : 'File tools disabled',
            type: 'success',
          });
        } catch (err) {
          // Say so here too: the field still holds the rejected text, and the
          // old success message would otherwise still be sitting underneath it.
          const status = document.getElementById('sbProjectStatus');
          if (status) status.textContent = `Not saved: ${err.message}`;
          store.emit('toast', {
            message: `Working directory not saved: ${err.message}`, type: 'error',
          });
        }
      }
    });

    // Usage modal: this app's totals + per-agent breakdown
    document.getElementById('sbUsageBtn').addEventListener('click', () => {
      store.emit('metrics:showUsage');
    });

    // Run trace: a sequenced timeline of model turns and tool calls.
    document.getElementById('sbTraceBtn')?.addEventListener('click', () => {
      store.emit('trace:show');
    });

    // Diagnose: one click, every provider, the failing layer named.
    // "NetworkError when attempting to fetch resource" tells the operator
    // nothing about WHICH of four things is broken; this tells them.
    document.getElementById('sbDiagBtn')?.addEventListener('click', async () => {
      const out = document.getElementById('sbDiagOut');
      const hint = document.getElementById('sbDiagHint');
      const providers = store.get('providers') || [];
      if (!providers.length) {
        store.emit('toast', { message: 'No providers configured yet.', type: 'error' });
        return;
      }
      if (String(store.get('settings.routerToken') || '').trim() === '') {
        store.emit('toast', {
          message: 'Paste your access token into the Access token box above first — a diagnosis cannot reach the server without it.',
          type: 'error',
        });
        return;
      }
      out.innerHTML = '<div class="form-hint">Testing…</div>';
      // One probe per provider: its endpoint, its key, and a model any of
      // its agents uses (the model only affects the message the provider
      // returns; reaching it at all is what is being tested).
      const probes = providers.map(p => ({
        name: p.name,
        endpoint: p.endpoint || '',
        api_key: p.apiKey || '',
        model: ((store.get('agents') || []).find(a => a.provider === p.id) || {}).model || '',
      }));
      try {
        const res = await api.diagnoseProviders(probes);
        const rows = (res && res.results) || [];
        // An empty result set used to render as "All 0 provider(s) reachable",
        // which reads like a pass. It is not a pass: it means the server
        // answered nothing to test, which is what a refused (401) request
        // looks like from here. Say THAT instead of claiming success.
        if (!rows.length) {
          // Say which half is at fault. `sent` is what this browser handed
          // over; `received` is what the server says it got. Equal-and-zero
          // means the request never reached a server that knows about /diag
          // (an old copy still loaded), so it is not a network or key fault.
          const received = res && typeof res.received === 'number' ? res.received : 'unknown';
          out.innerHTML = '<div class="form-hint" style="color:var(--accent-red)">'
            + `Nothing was tested. This browser sent ${probes.length} provider(s); `
            + `the server reports it received ${received}. `
            + (received === 0
              ? 'A server that answered but received nothing is an older copy '
                + 'still loaded — hard-refresh, and check the version badge.'
              : 'Check the Access token above.')
            + '</div>';
          if (hint) hint.textContent = 'Nothing was tested.';
          store.emit('toast', { message: `Nothing tested (sent ${probes.length}, received ${received})`, type: 'error' });
          return;
        }
        // Which copy answered, printed before the results. Cheap, and it settles
        // "am I even looking at the folder I think I am?".
        const srv = res && res.server;
        if (srv) {
          const badge = document.createElement('div');
          badge.className = 'form-hint';
          badge.style.cssText = 'font-family:var(--font-mono);font-size:10px;margin:0 0 8px;word-break:break-all';
          badge.textContent = `server: ${srv.software} · PHP ${srv.php} · ${srv.path}`;
          out.appendChild(badge);
        }
        const LABEL = {
          ok: 'reachable', dns: 'DNS failed', tls: 'TLS refused',
          connect: 'no route / refused', auth: 'key rejected',
          http: 'provider refused', config: 'misconfigured', local: 'local server',
        };
        out.innerHTML = '';
        rows.forEach(r => {
          const row = document.createElement('div');
          row.className = 'exec-approval';
          const head = document.createElement('div');
          head.className = 'exec-approval-cmd';
          head.textContent = r.name;
          const why = document.createElement('div');
          why.className = 'exec-approval-who';
          why.textContent = `${(LABEL[r.stage] || r.stage).toUpperCase()} · ${r.ms != null ? r.ms + 'ms' : ''} `
            + `${r.code ? '· HTTP ' + r.code : ''} — ${r.message || ''}`;
          const fix = {
            dns: 'This machine cannot resolve that hostname. Check DNS, a VPN, or an offline connection.',
            tls: 'The certificate was refused. Often a middlebox or an old trust store — check your clock too.',
            connect: 'Nothing answered at that address. Check the endpoint URL, firewall, or whether you are behind a network that blocks it.',
            auth: 'The key was rejected by the provider. Re-copy it; check it is the right kind of key and that it has credit.',
            http: 'The provider answered but refused the call. The message above carries the reason — a wrong model id is the usual one.',
            config: 'The endpoint is missing or is not a URL.',
            local: 'This app did not answer — is the server window still running?',
          }[r.stage];
          if (fix) {
            const advice = document.createElement('div');
            advice.className = 'form-hint';
            advice.style.marginTop = '4px';
            advice.textContent = fix;
            row.appendChild(head); row.appendChild(why); row.appendChild(advice);
          } else {
            row.appendChild(head); row.appendChild(why);
          }
          out.appendChild(row);
        });
        const bad = rows.filter(r => !r.ok).length;
        if (hint) {
          hint.textContent = bad
            ? `${bad} of ${rows.length} provider(s) cannot be reached from this machine. The first line above is where it stops.`
            : `All ${rows.length} provider(s) reachable — the network is fine; if models still fail, the cause is inside the app or the key.`;
        }
        store.emit('toast', {
          message: bad ? `${bad}/${rows.length} provider(s) unreachable` : 'All providers reachable',
          type: bad ? 'error' : 'success',
        });
      } catch (err) {
        out.innerHTML = `<div class="form-hint" style="color:var(--accent-red)">Diagnosis failed: ${(err && err.message) || err}</div>`;
      }
    });

    // Export
    document.getElementById('sbExportBtn').addEventListener('click', () => {
      store.emit('export:open');
    });

    // Every API call is behind the access-token gate, and a backup/restore is
    // an API call. Without this check the POST simply came back 401 and the
    // app looked broken: "I pressed restore and nothing happened". Checked up
    // front so the reason is said out loud.
    const needToken = what => {
      if (String(store.get('settings.routerToken') || '').trim()) return false;
      store.emit('toast', {
        message: `Paste your access token into Config → Access token first — ${what} cannot reach the server without it.`,
        type: 'error',
      });
      return true;
    };

    // Full backup: the whole copy as one JSON file (state bundle, every
    // session, config incl. allow/deny lists and token, approval grants).
    document.getElementById('sbBackupBtn')?.addEventListener('click', async () => {
      if (needToken('a backup')) return;
      try {
        const data = await api.downloadBackup();
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
        downloadFile(JSON.stringify(data, null, 2), `router-backup-${stamp}.json`, 'application/json');
        store.emit('toast', {
          message: 'Full backup downloaded — it holds keys and the token, keep it somewhere safe',
          type: 'success',
        });
      } catch (err) {
        store.emit('toast', { message: 'Backup failed: ' + (err?.message || err), type: 'error' });
      }
    });

    // Restore: replaces everything with the backup's contents, then reloads
    // so every panel re-reads the restored state from scratch.
    document.getElementById('sbRestoreBtn')?.addEventListener('click', () => {
      document.getElementById('sbRestoreFile')?.click();
    });
    document.getElementById('sbRestoreFile')?.addEventListener('change', async (e) => {
      const file = e.target.files ? e.target.files[0] : null;
      e.target.value = '';
      if (!file) return;
      // Same gate as the backup above: read the file first so the token
      // complaint is not wasted on a file that wasn't even chosen, then say
      // why nothing is about to happen.
      if (needToken('a restore')) return;
      let backup = null;
      try {
        backup = JSON.parse(await file.text());
      } catch {
        store.emit('toast', { message: 'That file is not valid JSON', type: 'error' });
        return;
      }
      if (!backup || backup.app !== 'router-studio') {
        store.emit('toast', { message: 'Not an Autonomous Loop Studio backup file', type: 'error' });
        return;
      }
      const n = Array.isArray(backup.sessions) ? backup.sessions.length : 0;
      const when = backup.exportedAt
        ? new Date(backup.exportedAt * 1000).toLocaleString() : 'unknown date';
      if (!confirm(`Restore this backup (exported ${when}, ${n} session(s))? It REPLACES all current sessions, agents, providers, settings and workflows. Export first if unsure.`)) return;
      try {
        const res = await api.importBackup(backup);
        if (res && res.success) {
          store.emit('toast', {
            message: `Restored ${res.sessions} session(s) — reloading`,
            type: 'success',
          });
          setTimeout(() => location.reload(), 900);
        } else {
          store.emit('toast', { message: 'Restore failed: ' + (res?.error || 'unknown error'), type: 'error' });
        }
      } catch (err) {
        store.emit('toast', { message: 'Restore failed: ' + (err?.message || err), type: 'error' });
      }
    });

    // Reset
    document.getElementById('sbResetBtn').addEventListener('click', () => {
      if (confirm('Reset all data? This will clear all agents, providers, and settings.')) {
        persistence.resetAll();
        store.emit('toast', { message: 'All data reset', type: 'info' });
        store.emit('app:reload');
      }
    });
  }

  /**
   * MCP *server* section: this app AS a server friends connect to. Config lives
   * in config.json (server-side). Tokens never expire and are revoked with ×.
   */
  _initMcpServerSection() {
    document.getElementById('sbMcpSrvOn')?.addEventListener('click', (e) => {
      e.currentTarget.classList.toggle('active');
    });
    document.getElementById('sbMcpSrvAdd')?.addEventListener('click', () => {
      if (!this._mcpSrv) this._mcpSrv = { enabled: false, root: '', protect: [], tokens: [] };
      this._mcpSrv.tokens = [...(this._mcpSrv.tokens || []), { label: '', token: '', scope: ['read'], ips: [] }];
      this._renderMcpSrvTokens();
    });
    document.getElementById('sbMcpSrvSave')?.addEventListener('click', () => this._saveMcpServer());

    if (!this._mcpSrv) {
      api.mcpServerConfig().then(res => {
        if (!document.getElementById('sbMcpSrvTokens')) return; // tab changed
        this._mcpSrv = {
          enabled: !!res.enabled, root: res.root || '',
          protect: res.protect || res.defaultProtect || [], tokens: res.tokens || [],
        };
        const on = document.getElementById('sbMcpSrvOn');
        if (on) on.classList.toggle('active', this._mcpSrv.enabled);
        const rootEl = document.getElementById('sbMcpSrvRoot');
        if (rootEl && !rootEl.value) rootEl.value = this._mcpSrv.root;
        const pEl = document.getElementById('sbMcpSrvProtect');
        if (pEl && !pEl.value.trim()) pEl.value = (this._mcpSrv.protect || []).join('\n');
        this._renderMcpSrvTokens();
      }).catch(() => {
        this._mcpSrv = { enabled: false, root: '', protect: [], tokens: [] };
        this._renderMcpSrvTokens();
      });
    } else {
      this._renderMcpSrvTokens();
    }
  }

  _renderMcpSrvTokens() {
    const el = document.getElementById('sbMcpSrvTokens');
    if (!el) return;
    const toks = this._mcpSrv?.tokens || [];
    if (!toks.length) { el.innerHTML = '<div class="form-hint">No friends yet.</div>'; return; }
    const sc = (t, s) => ((t.scope || []).includes(s) ? ' checked' : '');
    el.innerHTML = toks.map((t, i) => `
      <div data-mcpsrv-row="${i}" style="border:1px solid var(--border);border-radius:6px;padding:8px;margin-top:8px">
        <div style="display:flex;gap:6px;align-items:center">
          <input class="form-input" data-mcpsrv="label" value="${escAttr(t.label || '')}" placeholder="friend name" style="flex:1">
          <button class="btn btn-ghost" data-mcpsrv-del="${i}" title="Revoke this token">&times;</button>
        </div>
        <div class="toggle-row" style="gap:14px;margin-top:8px;justify-content:flex-start">
          <label class="form-hint-inline"><input type="checkbox" data-mcpsrv-scope="read" data-i="${i}"${sc(t, 'read')}> read</label>
          <label class="form-hint-inline"><input type="checkbox" data-mcpsrv-scope="write" data-i="${i}"${sc(t, 'write')}> write</label>
          <label class="form-hint-inline"><input type="checkbox" data-mcpsrv-scope="exec" data-i="${i}"${sc(t, 'exec')}> exec</label>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <input class="form-input" data-mcpsrv="token" value="${escAttr(t.token || '')}" readonly style="flex:1;font-family:var(--font-mono);font-size:11px" title="Share this token with the friend">
          <button class="btn btn-ghost" data-mcpsrv-copy="${i}">COPY</button>
        </div>
        <input class="form-input" data-mcpsrv="ips" value="${escAttr((t.ips || []).join(', '))}" placeholder="optional IP allowlist, comma-separated" style="margin-top:6px">
      </div>`).join('');

    el.querySelectorAll('[data-mcpsrv]').forEach(inp => {
      const set = () => {
        const row = inp.closest('[data-mcpsrv-row]');
        const i = Number(row?.dataset.mcpsrvRow);
        const t = this._mcpSrv?.tokens?.[i];
        if (!t) return;
        const f = inp.dataset.mcpsrv;
        if (f === 'ips') t.ips = inp.value.split(',').map(s => s.trim()).filter(Boolean);
        else t[f] = inp.value;
      };
      inp.addEventListener('input', set);
      inp.addEventListener('change', set);
    });
    el.querySelectorAll('[data-mcpsrv-scope]').forEach(cb => {
      cb.addEventListener('change', () => {
        const i = Number(cb.dataset.i);
        const t = this._mcpSrv?.tokens?.[i];
        if (!t) return;
        const s = cb.dataset.mcpsrvScope;
        const set = new Set(t.scope || []);
        if (cb.checked) set.add(s); else set.delete(s);
        // Checking write/exec implies read, so the tool list is not half-blind.
        if (cb.checked && (set.has('write') || set.has('exec'))) set.add('read');
        t.scope = ['read', 'write', 'exec'].filter(x => set.has(x));
        this._renderMcpSrvTokens();
      });
    });
    el.querySelectorAll('[data-mcpsrv-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._mcpSrv.tokens.splice(Number(btn.dataset.mcpsrvDel), 1);
        this._renderMcpSrvTokens();
      });
    });
    el.querySelectorAll('[data-mcpsrv-copy]').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = this._mcpSrv.tokens[Number(btn.dataset.mcpsrvCopy)];
        if (!t?.token) return;
        copyToClipboard(t.token).then(ok => store.emit('toast', {
          message: ok ? 'Token copied' : 'Could not reach the clipboard',
          type: ok ? 'success' : 'error',
        }));
      });
    });
  }

  async _saveMcpServer() {
    const status = document.getElementById('sbMcpSrvStatus');
    try {
      const protect = (document.getElementById('sbMcpSrvProtect')?.value || '')
        .split('\n').map(s => s.trim()).filter(Boolean);
      const payload = {
        enabled: !!document.getElementById('sbMcpSrvOn')?.classList.contains('active'),
        root: (document.getElementById('sbMcpSrvRoot')?.value || '').trim(),
        protect,
        tokens: (this._mcpSrv?.tokens || []).map(t => ({
          id: t.id, label: t.label, token: t.token, scope: t.scope || [], ips: t.ips || [],
        })),
      };
      const res = await api.mcpServerSave(payload);
      this._mcpSrv = {
        enabled: !!res.enabled, root: res.root || '',
        protect: res.protect || [], tokens: res.tokens || [],
      };
      const pEl = document.getElementById('sbMcpSrvProtect');
      if (pEl) pEl.value = (this._mcpSrv.protect || []).join('\n');
      this._renderMcpSrvTokens();
      if (status) {
        status.textContent = `Saved. ${this._mcpSrv.tokens.length} token(s). Endpoint: /api/mcp-server. `
          + 'Tokens never expire — revoke one with ×, then save.';
      }
      store.emit('toast', { message: 'MCP server saved', type: 'success' });
    } catch (err) {
      if (status) status.textContent = `Not saved: ${err.message}`;
      store.emit('toast', { message: `MCP server not saved: ${err.message}`, type: 'error' });
    }
  }

  _normaliseMcpServers(list) {
    return (list || []).map(s => ({
      ...s,
      args: Array.isArray(s.args) ? s.args.join(' ') : (s.args || ''),
      headersText: Object.entries(s.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
      envText: Object.entries(s.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    }));
  }

  _parseHeadersText(text) {
    const out = {};
    String(text || '').split('\n').forEach(line => {
      const i = line.indexOf(':');
      if (i <= 0) return;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k) out[k] = v;
    });
    return out;
  }

  _parseEnvText(text) {
    const out = {};
    String(text || '').split('\n').forEach(line => {
      const i = line.indexOf('=');
      if (i <= 0) return;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k) out[k] = v;
    });
    return out;
  }

  /**
   * MCP servers: operator-configured, stored server-side in config.json.
   * Rendered from a local cache; the server stays the source of truth.
   */
  _initMcpSection() {
    document.getElementById('sbMcpAdd')?.addEventListener('click', () => {
      this._mcpServers = [...(this._mcpServers || []), { id: '', transport: 'stdio', command: '', args: '', url: '', envText: '' }];
      this._renderMcp();
    });
    document.getElementById('sbMcpSave')?.addEventListener('click', () => this._saveMcpServers());

    if (this._mcpServers == null) {
      api.mcpServers().then(res => {
        if (!document.getElementById('sbMcpList')) return;   // tab changed
        this._mcpServers = this._normaliseMcpServers(res.servers);
        this._renderMcp();
      }).catch(() => { this._mcpServers = []; this._renderMcp(); });
    } else {
      this._renderMcp();
    }
  }

  _renderMcp() {
    const el = document.getElementById('sbMcpList');
    if (!el) return;
    const list = this._mcpServers || [];
    if (!list.length) { el.innerHTML = '<div class="form-hint">No servers yet.</div>'; return; }
    el.innerHTML = list.map((s, i) => `
      <div class="form-group" data-mcp-row="${i}" style="border:1px solid var(--border);border-radius:6px;padding:8px;margin-top:8px">
        <div style="display:flex;gap:6px">
          <input class="form-input" data-mcp="id" value="${escAttr(s.id || '')}" placeholder="name" style="flex:1">
          <select class="form-select" data-mcp="transport" style="max-width:110px">
            <option value="stdio"${s.transport === 'http' ? '' : ' selected'}>stdio</option>
            <option value="http"${s.transport === 'http' ? ' selected' : ''}>http</option>
          </select>
          <button class="btn btn-ghost" data-mcp-del="${i}" title="Remove">&times;</button>
        </div>
        <input class="form-input" data-mcp="command" value="${escAttr(s.command || '')}" placeholder="command (stdio), e.g. npx" style="margin-top:6px">
        <input class="form-input" data-mcp="args" value="${escAttr(s.args || '')}" placeholder="args, space-separated (stdio)" style="margin-top:6px">
        <textarea class="form-textarea" data-mcp="envText" rows="2" placeholder="env (stdio), one per line:&#10;GITHUB_TOKEN=…" style="margin-top:6px">${esc(s.envText || '')}</textarea>
        <input class="form-input" data-mcp="url" value="${escAttr(s.url || '')}" placeholder="https://… (http)" style="margin-top:6px">
        <textarea class="form-textarea" data-mcp="headersText" rows="2" placeholder="headers (http), one per line:&#10;Authorization: Bearer TOKEN" style="margin-top:6px">${esc(s.headersText || '')}</textarea>
      </div>`).join('');
    el.querySelectorAll('[data-mcp]').forEach(inp => {
      const mark = () => {
        const row = inp.closest('[data-mcp-row]');
        if (!row) return;
        const i = Number(row.dataset.mcpRow);
        if (this._mcpServers[i]) this._mcpServers[i][inp.dataset.mcp] = inp.value;
      };
      inp.addEventListener('input', mark);
      inp.addEventListener('change', mark);
    });
    el.querySelectorAll('[data-mcp-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._mcpServers.splice(Number(btn.dataset.mcpDel), 1);
        this._renderMcp();
      });
    });
  }

  async _saveMcpServers() {
    const status = document.getElementById('sbMcpStatus');
    try {
      const servers = (this._mcpServers || [])
        .filter(s => String(s.id || '').trim())
        .map(s => ({
          id: String(s.id).trim(),
          transport: s.transport === 'http' ? 'http' : 'stdio',
          command: String(s.command || '').trim(),
          args: String(s.args || '').trim() ? String(s.args).trim().split(/\s+/) : [],
          env: this._parseEnvText(s.envText),
          url: String(s.url || '').trim(),
          headers: this._parseHeadersText(s.headersText),
        }));
      await api.mcpSaveServers(servers);
      const res = await api.mcpServers();                 // server drops invalid rows
      this._mcpServers = this._normaliseMcpServers(res.servers);
      this._renderMcp();
      if (status) status.textContent = `Saved ${this._mcpServers.length} server(s).`;
      store.emit('toast', { message: 'MCP client saved', type: 'success' });
      try {
        const st = await api.mcpStatus();
        const bad = (st.status || []).filter(x => !x.ok);
        if (status) {
          status.textContent += bad.length
            ? ` Not reachable: ` + bad.map(b => `${b.id} (${b.error})`).join('; ')
            : ' All reachable.';
        }
      } catch { /* status is best-effort */ }
    } catch (err) {
      if (status) status.textContent = `Not saved: ${err.message}`;
      store.emit('toast', { message: `MCP client not saved: ${err.message}`, type: 'error' });
    }
  }

  /**
   * Show the directory the sandbox is really configured with.
   *
   * Read from the server rather than kept locally, because the server is what
   * enforces it — a value cached in this browser could drift from the jail and
   * the field would then lie about what agents can reach.
   */
  async _loadProjectDir() {
    const input = document.getElementById('sbProjectDir');
    const status = document.getElementById('sbProjectStatus');
    if (!input) return;
    try {
      const s = await api.getSandboxStatus();
      if (!document.getElementById('sbProjectDir')) return; // tab changed
      // A path the user typed but has not saved wins over what the server
      // reports: re-rendering the Config tab must not wipe their typing.
      if (this._cfgPendingDir !== null) {
        input.value = this._cfgPendingDir;
        if (status) status.textContent = 'Typed but not saved yet — press SAVE.';
        return;
      }
      input.value = (s.read_roots || [])[0] || '';
      if (status) {
        status.textContent = s.enabled
          ? 'Active — agents can read and write there.'
          : 'Not set — the file tools are off.';
      }
    } catch (err) {
      if (status) status.textContent = `Could not read the current setting: ${err.message}`;
    }
  }

  /**
   * Point the sandbox at one directory, for reading and writing alike.
   *
   * /config replaces the whole config file server-side, so the existing config
   * is fetched and merged rather than posted as just the sandbox key — posting
   * only the sandbox would silently drop every other stored setting.
   */
  async _saveProjectDir(raw) {
    // Accept an absolute path on either platform: POSIX ("/var/www/site") or
    // Windows ("C:\site" / "C:/site"). The old check demanded a leading "/",
    // which no Windows path has, so on Windows the sandbox could never be
    // pointed anywhere but its default (the app's own folder). Backslashes are
    // normalised because the server's jail compares forward-slash paths.
    const dir = String(raw || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (dir && !/^(?:[a-zA-Z]:\/?$|[a-zA-Z]:\/|\/)/.test(dir)) {
      throw new Error('Use a full path, e.g. /var/www/site or C:\\projects\\site');
    }
    const status = document.getElementById('sbProjectStatus');
    const cfg = await api.getConfig();
    const next = {
      ...(cfg.sandbox || {}),
      read_roots: dir ? [dir] : [],
      write_roots: dir ? [dir] : [],
    };
    await api.saveConfig({ ...cfg, sandbox: next });
    if (status) {
      status.textContent = dir
        ? `Saved — agents now work in ${dir}`
        : 'Cleared — the file tools are off.';
    }
    return dir;
  }

  /**
   * A checkbox-style switch.
   *
   * The new value is persisted here, not only on SAVE. These toggles take
   * effect the moment you flip them (auto-scroll changes the very next
   * message), so requiring a second click on SAVE to keep them was a trap:
   * the setting looked applied, then silently reverted on reload.
   */
  /** Read the real shell-access settings and reflect them in the toggles. */
  async _loadExecSettings() {
    // Listeners are attached FIRST, synchronously, outside any try/catch.
    //
    // They used to be attached at the bottom of the try block, after two awaits.
    // Any failure -- a 401 from a missing token, a dropped connection, the tab
    // being opened before the token was pasted -- jumped to the catch, so the
    // listeners were never attached at all and the two toggles became completely
    // inert. The click did nothing visible and nothing was logged, which reads
    // as "the switch is broken" rather than "a fetch failed".
    //
    // Attaching up front means the control works whether or not the load
    // succeeds, and the load can only ever overwrite the displayed state.
    //
    // Bound per ELEMENT, marked with a data attribute rather than a single
    // instance flag: renderConfig rewrites innerHTML, so every render produces
    // brand-new nodes. A one-shot flag would bind the first render and silently
    // skip every render after it -- trading one dead control for another.
    const onToggle = document.getElementById('sbExecOn');
    if (onToggle && !onToggle.dataset.bound) {
      onToggle.dataset.bound = '1';
      onToggle.addEventListener('click', () => {
        const v = onToggle.classList.toggle('active');
        const r = document.getElementById('sbExecApprovalRow');
        if (r) r.style.display = v ? '' : 'none';
        this._saveExecSettings();
      });
    }
    const askToggle = document.getElementById('sbExecApproval');
    if (askToggle && !askToggle.dataset.bound) {
      askToggle.dataset.bound = '1';
      askToggle.addEventListener('click', () => {
        askToggle.classList.toggle('active');
        this._saveExecSettings();
      });
    }
    const timeoutInput = document.getElementById('sbExecTimeout');
    if (timeoutInput && !timeoutInput.dataset.bound) {
      timeoutInput.dataset.bound = '1';
      // `change` (blur / Enter), not `input`: saving on every keystroke would
      // push "1" then "12" then "123", and a half-typed value clamped to the
      // 5..600 range would fight the user mid-edit.
      timeoutInput.addEventListener('change', () => this._saveExecSettings({ quiet: true }));
      timeoutInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); timeoutInput.blur(); }
      });
    }

    const codeToggle = document.getElementById('sbCodeOn');
    if (codeToggle && !codeToggle.dataset.bound) {
      codeToggle.dataset.bound = '1';
      codeToggle.addEventListener('click', () => {
        codeToggle.classList.toggle('active');
        this._saveExecSettings({ quiet: true });
      });
    }

    try {
      const info = await api.execAllowlist();
      const cfg = await api.getConfig();
      const sb = cfg.sandbox || {};
      const on = !!info.enabled;
      const ask = !!sb.exec_approval;
      const set = (id, v) => document.getElementById(id)?.classList.toggle('active', v);
      set('sbExecOn', on);
      set('sbExecApproval', ask);
      set('sbCodeOn', !!sb.code_enabled);
      const row = document.getElementById('sbExecApprovalRow');
      if (row) row.style.display = on ? '' : 'none';
      const t = document.getElementById('sbExecTimeout');
      if (t) t.value = sb.exec_timeout ?? 60;
      const st = document.getElementById('sbExecStatus');
      if (st) {
        st.textContent = on
          ? `On — ${(info.allow || []).length} commands allowed.`
          : 'Off. Agents cannot run any command.';
      }

    } catch (err) {
      // Say what happened. The toggles still work -- their listeners are
      // already attached -- but the displayed state is unverified, so make that
      // obvious rather than leaving stale switches looking authoritative.
      const st = document.getElementById('sbExecStatus');
      if (st) st.textContent = `Could not read the current setting: ${err.message}. `
        + 'Toggles still work; the shown state may be out of date.';
      console.warn('[config] could not load exec settings', err);
    }
  }

  /**
   * Read-modify-write the server config without losing a concurrent edit.
   *
   * PUT /config replaces the entire file rather than merging, so two overlapping
   * savers (the shell settings and the allow/deny editor both touch `sandbox`)
   * each read a snapshot, change one key, and PUT the lot -- the second write
   * silently reverts the first. Chaining them through one promise makes the
   * writes take effect in order instead.
   */
  _patchServerConfig(mutator) {
    this._cfgChain = (this._cfgChain || Promise.resolve()).then(async () => {
      const cfg = await api.getConfig();
      mutator(cfg);
      await api.saveConfig(cfg);
      return cfg;
    });
    return this._cfgChain;
  }

  async _saveExecSettings(opts = {}) {
    const quiet = !!opts.quiet;
    const el = id => document.getElementById(id);
    const on = el('sbExecOn')?.classList.contains('active');
    const ask = el('sbExecApproval')?.classList.contains('active');
    const timeout = Math.max(5, Math.min(600, parseInt(el('sbExecTimeout')?.value, 10) || 60));
    const st = el('sbExecStatus');
    let info = { allow: [] };
    try { info = (await api.execAllowlist()) || { allow: [] }; } catch { /* count unknown */ }
    // (info is read before the patch so the status line can show the count.)
    // Write the clamped value back, otherwise 9999 stays on screen looking
    // saved while the server is holding 600.
    const tEl = el('sbExecTimeout');
    if (tEl && String(tEl.value) !== String(timeout)) tEl.value = timeout;
    try {
      await this._patchServerConfig((cfg) => {
        cfg.sandbox = cfg.sandbox || {};
        cfg.sandbox.exec_enabled = !!on;
        cfg.sandbox.exec_approval = !!ask;
        cfg.sandbox.exec_timeout = timeout;
        cfg.sandbox.code_enabled = !!el('sbCodeOn')?.classList.contains('active');
      });
      if (st) st.textContent = on
        ? `${ask ? 'On' : 'On, no approval'} — ${timeout}s timeout, ${(info.allow || []).length} commands allowed.`
        : 'Off. Agents cannot run any command.';
      store.emit('toast', {
        message: quiet ? `Command timeout set to ${timeout}s` : (on ? 'Shell access enabled' : 'Shell access disabled'),
        type: quiet ? 'info' : (on ? 'success' : 'info'),
      });
      this._pollApprovals();
    } catch (err) {
      if (st) st.textContent = `Not saved: ${err.message}`;
      store.emit('toast', { message: `Shell access not saved: ${err.message}`, type: 'error' });
    }
  }

  /** Surface any command that is waiting on the operator. */
  async _pollApprovals() {
    if (this._approvalTimer) clearInterval(this._approvalTimer);
    this._approvalTimer = setInterval(async () => {
      if (this.activeTab !== 'config') return;
      try {
        const res = await api.execPending();
        const list = res.pending || [];
        this._lastApprovals = list;
        if (list.length === this._shownApprovals) return;
        this._shownApprovals = list.length;
        this._renderApprovals(list);
      } catch { /* the tab may be gone */ }
    }, 4000);
    this._pollApprovalsOnce = () => this._pollApprovals();
  }

  _renderApprovals(list) {
    const host = document.getElementById('sbExecStatus');
    if (!host) return;
    host.innerHTML = '';
    if (!list.length) {
      host.textContent = document.getElementById('sbExecOn')
        ?.classList.contains('active') ? 'No commands waiting for approval.' : '';
      return;
    }
    // Collapsed by default: a count, not a wall of commands. Approvals pop up
    // wherever the operator is looking now, so this list is the review trail,
    // not something that has to be stared at.
    const n = list.length;
    const toggle = document.createElement('button');
    toggle.className = 'btn btn-ghost btn-block';
    toggle.textContent = this._approvalsExpanded
      ? `Hide ${n} waiting command${n === 1 ? '' : 's'}`
      : `${n} command${n === 1 ? '' : 's'} waiting for approval — review`;
    toggle.addEventListener('click', () => {
      this._approvalsExpanded = !this._approvalsExpanded;
      this._renderApprovals(this._lastApprovals || []);
    });
    host.appendChild(toggle);
    if (!this._approvalsExpanded) return;
    list.forEach(p => {
      const row = document.createElement('div');
      row.className = 'exec-approval';
      const cmd = (p.argv || []).join(' ');
      row.innerHTML = `<div class="exec-approval-cmd"></div><div class="exec-approval-who"></div>`;
      row.querySelector('.exec-approval-cmd').textContent = cmd;
      row.querySelector('.exec-approval-who').textContent =
        (p.agent ? p.agent + ' wants to run' : 'A command is waiting') + (p.cwd ? ' in ' + p.cwd : '');
      const bar = document.createElement('div');
      bar.className = 'exec-approval-btns';
      [['Allow once', 'once'], ['Always allow', 'always'], ['Deny + block', 'deny']].forEach(([label, decision]) => {
        const b = document.createElement('button');
        b.className = 'btn btn-sm ' + (decision === 'deny' ? 'btn-ghost' : 'btn-primary');
        b.textContent = label;
        b.addEventListener('click', async () => {
          try {
            const res = await api.execDecide(p.id, decision);
            if (decision === 'deny') {
              const name = (res && res.denied) || String((p.argv || [])[0] || cmd).split(' ')[0];
              store.emit('toast', { message: `Denied and blocked "${name}" — remove it under Config → Allow/Deny list to undo.`, type: 'info' });
            } else {
              store.emit('toast', { message: `Command allowed: ${cmd.slice(0, 60)}`, type: 'info' });
            }
            this._lastApprovals = (this._lastApprovals || []).filter(x => x.id !== p.id);
            this._shownApprovals = this._lastApprovals.length;
            this._renderApprovals(this._lastApprovals);
          } catch (err) {
            store.emit('toast', { message: err.message, type: 'error' });
          }
        });
        bar.appendChild(b);
      });
      row.appendChild(bar);
      host.appendChild(row);
    });
  }

  /**
   * Open the allow/deny editor.
   *
   * Two lists, because they are enforced in two different places and confusing
   * them would be a security hole:
   *   TOOLS   - a client-side gate. Hiding a tool stops the model being told it
   *             exists, but the code is still in the page, so this is policy,
   *             not a boundary.
   *   COMMANDS - the server-side exec allowlist. This one IS enforced, because
   *             a command outside it is refused before the process starts.
   */
  /**
   * Open the allow/deny editor.
   *
   * THREE lists, because they are enforced in three different places and
   * blurring them is what made this unusable:
   *
   *   1. TOOLS        client-side. A hidden tool is simply not offered to the
   *                   model. The code is still in the page, so this is policy,
   *                   not a boundary.
   *   2. COMMANDS OK  server-side allowlist, checked against argv[0]. A miss
   *                   can still be approved one command at a time.
   *   3. COMMANDS NO  server-side denylist, checked FIRST and absolute. A hit
   *                   can never be approved and no stale grant can revive it.
   *
   * The bug this replaces: the tool checkboxes were seeded from the COMMAND
   * allowlist, comparing tool names ("exec", "grep_code") against program
   * names ("grep", "curl"). Nothing matched, so every tool rendered unticked,
   * and saving wrote every tool into denied_tools. It also meant typing a tool
   * name into the command box looked like it granted the tool when it could
   * never match anything.
   */
  async openPolicyEditor() {
    document.getElementById('policyModal')?.remove();

    const toolIds = Object.keys(TOOL_REGISTRY);
    const modal = document.createElement('div');
    modal.id = 'policyModal';
    modal.className = 'modal-bg';
    modal.innerHTML = `
      <div class="modal" style="max-width:700px;width:94vw;max-height:92vh">
        <div class="modal-head">
          <span class="modal-title">Allow / Deny</span>
          <button class="modal-x" id="policyClose">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">1. Harness tools</label>
            <div class="policy-hint warn">Enforced in the BROWSER. Un-ticking stops the model being
              offered the tool and hides it from every agent's picker. It does not remove the code
              from the page &mdash; someone with devtools can still call it directly. This is policy,
              not a boundary.</div>
            <div class="policy-tools" id="policyTools"><div class="form-hint">Loading&hellip;</div></div>
          </div>

          <div class="form-group">
            <label class="form-label">2. Shell commands allowed</label>
            <div class="policy-hint">Enforced SERVER-SIDE against the program name (argv[0]).
              Anything not listed is refused, or queued for your approval if
              &ldquo;ask before running new commands&rdquo; is on. These are OS programs
              (<code>grep</code>, <code>curl</code>) &mdash; <b>not</b> harness tool names.</div>
            <textarea class="form-textarea" id="policyCommands" rows="5"
              placeholder="one command per line, e.g.&#10;grep&#10;curl&#10;nmap"></textarea>
            <div class="form-hint" id="policyAllowHint"></div>
          </div>

          <div class="form-group">
            <label class="form-label">3. Interpreters</label>
            <div class="policy-hint">Pick a level per interpreter. All three are yours to change at
              any time &mdash; nothing here is permanent, and clearing a row puts it straight back on
              the denylist in section 4.</div>
            <div class="policy-interpreters" id="policyInterps"></div>
            <div class="policy-hint warn" id="policyInterpWarn"></div>
          </div>

          <div class="form-group">
            <label class="form-label">4. Shell commands denied</label>
            <div class="policy-hint ok">Enforced SERVER-SIDE and absolute: checked before the
              allowlist and before approvals, so these can never run and no past approval can bring
              them back. Use it for interpreters and destructive verbs.</div>
            <textarea class="form-textarea" id="policyDeny" rows="5"
              placeholder="one command per line, e.g.&#10;sh&#10;python3&#10;rm"></textarea>
            <div class="form-hint" id="policyDenyHint"></div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="policyCancel">Cancel</button>
          <button class="btn btn-primary" id="policySave">Save</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    // .modal-bg is opacity:0 / pointer-events:none until it gets `open`.
    modal.classList.add('open');

    const close = () => modal.remove();
    modal.querySelector('#policyClose').addEventListener('click', close);
    modal.querySelector('#policyCancel').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    const toolsBox = modal.querySelector('#policyTools');
    const allowTa = modal.querySelector('#policyCommands');
    const denyTa = modal.querySelector('#policyDeny');
    const interpBox = modal.querySelector('#policyInterps');

    // Interpreters known to this app. Each is opt-in individually; anything
    // not ticked keeps the absolute denylist. Painted after the fetch below,
    // because the current set is only known once it returns.
    // Shells are here too. They were missing, which meant the only way to run
    // a .sh script was to hand-edit config.json -- the server already handled
    // them correctly (refusing -c and stdin), the UI just never offered them.
    const KNOWN_INTERPRETERS = [
      'bash', 'sh', 'zsh',
      'python3', 'python',
      'node', 'perl', 'php', 'ruby', 'lua',
    ];
    interpBox.innerHTML = '<div class="form-hint">Loading&hellip;</div>';
    const allowHint = modal.querySelector('#policyAllowHint');
    const denyHint = modal.querySelector('#policyDenyHint');

    let info = { allow: [], deny: [], custom_allow: false, custom_deny: false };
    try {
      info = (await api.execAllowlist()) || info;
    } catch {
      toolsBox.innerHTML = '<div class="form-hint" style="color:var(--accent-red)">'
        + 'Could not read the current policy. Close and try again &mdash; saving now would '
        + 'mistakenly hide every tool.</div>';
      return;
    }

    const optedScripts = Array.isArray(info.interpreters) ? info.interpreters : [];
    const optedFull = Array.isArray(info.interpreters_full) ? info.interpreters_full : [];
    const levelOf = n => optedFull.includes(n) ? 'full' : (optedScripts.includes(n) ? 'scripts' : 'off');
    interpBox.innerHTML = KNOWN_INTERPRETERS.map(n => `
      <div class="interp-row">
        <span class="tool-name">${esc(n)}</span>
        <select class="form-select interp-level" data-interp="${esc(n)}">
          <option value="off"      ${levelOf(n) === 'off'      ? 'selected' : ''}>Blocked</option>
          <option value="scripts" ${levelOf(n) === 'scripts' ? 'selected' : ''}>Scripts only</option>
          <option value="full"    ${levelOf(n) === 'full'    ? 'selected' : ''}>Full access</option>
        </select>
        <span class="tool-desc" data-desc="${esc(n)}"></span>
      </div>`).join('');

    // Each level says plainly what it grants, so the choice is informed.
    const LEVEL_TEXT = {
      off: 'Refused. Cannot be approved.',
      scripts: 'May run script files inside your allowed directories. Inline code (-c, -e, -r, stdin) is refused.',
      full: 'May run anything, including -c inline code. This is equivalent to giving it a shell.',
    };
    const paintDescs = () => {
      interpBox.querySelectorAll('[data-interp]').forEach(sel => {
        const d = interpBox.querySelector(`[data-desc="${sel.dataset.interp}"]`);
        if (d) d.textContent = LEVEL_TEXT[sel.value];
      });
      const warn = modal.querySelector('#policyInterpWarn');
      const full = [...interpBox.querySelectorAll('[data-interp]')]
        .filter(s => s.value === 'full').map(s => s.dataset.interp);
      if (warn) {
        warn.textContent = full.length
          ? `${full.join(', ')} can execute arbitrary code as the web server user. `
            + 'That includes reading any file that user can read. Fine if that is your call - '
            + 'just know it is the same power as a shell.'
          : '';
        warn.style.display = full.length ? '' : 'none';
      }
    };
    paintDescs();
    interpBox.addEventListener('change', paintDescs);

    // --- tools: seeded from the saved DENY list, not the command allowlist ---
    let denied = [];
    try {
      const saved = store.get('settings.deniedTools');
      if (Array.isArray(saved)) denied = saved;
      else {
        const cfg = await api.getConfig();
        const d = cfg?.sandbox?.denied_tools;
        if (Array.isArray(d)) denied = d;
      }
    } catch { /* fall back to nothing denied */ }

    toolsBox.innerHTML = toolIds.map(id => {
      const def = TOOL_REGISTRY[id] || {};
      return `<label class="tool-option">
        <input type="checkbox" value="${esc(id)}" ${denied.includes(id) ? '' : 'checked'}>
        <span class="tool-name">${esc(id)}</span>
        <span class="tool-desc">${esc(def.describe || '')}</span>
      </label>`;
    }).join('');

    // --- commands ---
    if (info.custom_allow && Array.isArray(info.allow)) {
      allowTa.value = info.allow.join('\n');
      allowHint.textContent = `Custom list active (${info.allow.length} commands). The built-in defaults are REPLACED, not extended.`;
    } else {
      allowHint.textContent = `Using the built-in default list (${(info.allow || []).length} commands). Anything you type here replaces it entirely.`;
    }

    if (info.custom_deny && Array.isArray(info.deny)) {
      denyTa.value = info.deny.join('\n');
      denyHint.textContent = `Custom denylist active (${info.deny.length} commands).`;
    } else {
      denyTa.value = (info.deny || []).join('\n');
      denyHint.textContent = `Showing the built-in denylist (${(info.deny || []).length} commands). Saving replaces it with whatever is in the box.`;
    }

    // --- save ---
    modal.querySelector('#policySave').addEventListener('click', async () => {
      try {
        const newDenied = [...toolsBox.querySelectorAll('input')]
          .filter(i => !i.checked).map(i => i.value);
        const parse = ta => ta.value.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
        const allow = parse(allowTa);
        const deny = parse(denyTa);
        const level = n => (interpBox.querySelector(`[data-interp="${n}"]`) || {}).value || 'off';
        const interps = KNOWN_INTERPRETERS.filter(n => level(n) === 'scripts');
        const interpsFull = KNOWN_INTERPRETERS.filter(n => level(n) === 'full');

        // Refuse a list that contradicts itself rather than silently letting the
        // denylist win: the operator almost certainly did not mean it.
        const clash = allow.filter(c => deny.includes(c) && !interps.includes(c));
        if (clash.length) {
          store.emit('toast', {
            message: `${clash.join(', ')} ${clash.length > 1 ? 'are' : 'is'} on both lists. The denylist wins, so allowlisting it does nothing.`,
            type: 'error',
          });
        }
        // Flag entries that can never match, so an inert line does not sit
        // there looking like it granted something.
        const inert = allow.filter(c => TOOL_REGISTRY[c]);
        if (inert.length) {
          store.emit('toast', {
            message: `${inert.join(', ')} ${inert.length > 1 ? 'are harness tools' : 'is a harness tool'}, not a program. It will never match a command - use section 1 for that.`,
            type: 'error',
          });
        }

        await this._patchServerConfig((cfg) => {
          cfg.sandbox = cfg.sandbox || {};
          cfg.sandbox.denied_tools = newDenied;
          if (allow.length) cfg.sandbox.exec_allow = allow; else delete cfg.sandbox.exec_allow;
          if (deny.length) cfg.sandbox.exec_deny = deny; else delete cfg.sandbox.exec_deny;
          if (interps.length) cfg.sandbox.exec_interpreters = interps;
          else delete cfg.sandbox.exec_interpreters;
          if (interpsFull.length) cfg.sandbox.exec_interpreters_full = interpsFull;
          else delete cfg.sandbox.exec_interpreters_full;
        });

        store.set('settings.deniedTools', newDenied);
        persistence.set('settings', store.get('settings'));
        store.emit('tools:policy', newDenied);
        store.emit('toast', {
          message: `Saved - ${newDenied.length} tool(s) hidden, ${allow.length} commands allowed, `
            + `${deny.length} denied, ${interps.length + interpsFull.length} interpreter(s) enabled`,
          type: 'success',
        });
        close();
        this._loadPolicyHint();
      } catch (err) {
        store.emit('toast', { message: `Not saved: ${err.message}`, type: 'error' });
      }
    });
  }

  async _loadPolicyHint() {
    const el = document.getElementById('sbPolicyHint');
    if (!el) return;
    try {
      const info = await api.execAllowlist();
      const saved = store.get('settings.deniedTools');
      const hidden = Array.isArray(saved) ? saved.length : 0;
      const nInt = (info.interpreters || []).length + (info.interpreters_full || []).length;
      el.textContent = `Tools: ${hidden} hidden. Commands: ${(info.allow || []).length} allowed, `
        + `${(info.deny || []).length} denied`
        + (nInt ? `, ${nInt} interpreter(s) script-only` : '')
        + `. Shell access is ${info.enabled ? 'ON' : 'off'}.`;
    } catch {
      el.textContent = '';
    }
  }

  _initToggle(id, callback) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', () => {
      el.classList.toggle('active');
      const on = el.classList.contains('active');
      callback(on);
      persistence.set('settings', store.get('settings'));
    });
  }

  /** Live per-key usage for the governor block. Repainted on governor events
   * while Config is open, so a saturated key is visible without polling. */
  _renderGovStatus() {
    const el = document.getElementById('sbGovStatus');
    if (!el) return;
    const on = (store.get('settings') || {}).rateLimitEnabled !== false;
    if (!on) {
      el.textContent = 'Limiter off. Calls go out unpaced.';
      return;
    }
    let rows = [];
    try {
      rows = snapshot();
    } catch {
      rows = [];
    }
    if (!rows.length) {
      el.textContent = 'No keys active in the last minute.';
      return;
    }
    el.textContent = rows
      .map(r => `${r.key}: ${r.used}/${r.rpm} this minute${r.waiting ? ` · ${r.waiting} waiting` : ''}`)
      .join(' · ');
  }

  async loadSessions() {
    try {
      const sessions = await api.listSessions();
      if (Array.isArray(sessions)) {
        const convs = sessions.map(s => ({
          id: s.id,
          title: s.title,
          createdAt: s.created_at,
          updatedAt: s.last_activity,
          active: s.active,
          messages: this._convertDialogsToMessages(s.dialogs || []),
          agentsUsed: s.models_used || [],
        }));
        store.set('conversations', convs);
        persistence.set('conversations', convs);
        if (this.activeTab === 'sessions') this.renderSessions();
      }
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
  }
}

export default Sidebar;
