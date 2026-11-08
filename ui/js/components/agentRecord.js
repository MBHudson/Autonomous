/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// AGENTRECORD.JS — one agent's own traffic, opened from the map
// ============================================
//
// The same two records Config → TRACE shows for everyone, scoped to the agent
// whose card you clicked: what it SAID (both halves of each exchange, with the
// text) and what it RAN (its lines in storage/exec.log).
//
// Talk now holds the agent's whole side of the conversation, not only the part
// that went to another agent: your prompt, the task a coordinator handed it,
// what it told a team-mate, and the reply it produced. That is why the scope
// filter exists -- All communication by default, Agent to agent for the narrower
// question the drawer used to answer on its own.
//
// Opened by `comms:showAgent` — emitted by the Messages button on a 3D agent
// card and by the same button on the 2D metrics modal. The renderers are the
// trace panel's, so there is one implementation of each row and three doors.

import { store } from '../store.js?v=409';
import { esc } from '../utils.js?v=409';
import { api } from '../api.js?v=409';
import * as comms from '../commsLog.js?v=409';
import { commsHtml, execHtml } from './tracePanel.js?v=409';

export class AgentRecord {
  constructor() {
    this.el = null;
    this.agentId = null;
    this.tab = 'talk';
    this.scope = 'all';
    this.execData = null;
    this.execError = '';
    this.execLoading = false;
  }

  init() {
    store.on('comms:showAgent', (d) => this.open(d && d.agentId));
    store.on('comms:changed', () => { if (this.el && this.tab === 'talk') this.render(); });
  }

  agent() {
    return (store.get('agents') || []).find(a => a.id === this.agentId) || {};
  }

  open(agentId) {
    if (!agentId) return;
    // Same agent already open: do not reset the tab the operator is reading.
    if (this.el && this.agentId === agentId) { this.render(); return; }
    this.agentId = agentId;
    this.tab = 'talk';
    this.scope = 'all';
    this.execData = null;
    this.execError = '';
    this.el?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-bg open agent-record-bg';
    overlay.id = 'agentRecord';
    overlay.innerHTML = `
      <div class="agent-record" role="dialog" aria-label="Agent record">
        <div class="agent-record-head">
          <span class="agent-record-title" id="arTitle"></span>
          <button class="modal-close" id="arClose">&times;</button>
        </div>
        <div class="agent-record-tabs" id="arTabs"></div>
        <div class="agent-record-body" id="arBody"></div>
      </div>`;
    document.body.appendChild(overlay);
    this.el = overlay;

    overlay.querySelector('#arClose')?.addEventListener('click', () => this.close());
    overlay.addEventListener('click', (e) => {
      // Clicking the dimmed area behind the drawer closes it, like every modal.
      if (e.target === overlay) { this.close(); return; }
      const tab = e.target.closest?.('[data-ar-tab]');
      if (tab && tab.dataset.arTab !== this.tab) {
        this.tab = tab.dataset.arTab;
        this.render();
        return;
      }
      const scopeBtn = e.target.closest?.('[data-ar-scope]');
      if (scopeBtn && scopeBtn.dataset.arScope !== this.scope) {
        this.scope = scopeBtn.dataset.arScope;
        this.render();
      }
    });
    this.render();
  }

  render() {
    if (!this.el) return;
    const a = this.agent();
    const name = a.name || this.agentId;
    const head = this.el.querySelector('#arTitle');
    if (head) {
      head.innerHTML = `${esc(name)}${a.code ? `<span class="agent-code">${esc(a.code)}</span>` : ''}`
        + `<span class="agent-record-sub">${esc(a.role || a.model || '')}</span>`;
    }

    const all = comms.forAgent(this.agentId, comms.MAX);
    const entries = this.scope === 'agent'
      ? all.filter(e => e.kind === 'ask' || e.kind === 'tell' || e.kind === 'ping')
      : all;
    const counts = {
      talk: all.length,
      runs: this.tab === 'runs' ? (this.execData?.entries?.length ?? '') : '',
    };
    const tabs = this.el.querySelector('#arTabs');
    if (tabs) {
      tabs.innerHTML = [['talk', 'Talk', counts.talk], ['runs', 'Runs', counts.runs]]
        .map(([id, label, n]) => `<button class="trace-tab${this.tab === id ? ' active' : ''}" data-ar-tab="${id}">
            ${esc(label)}${n !== '' ? `<span class="trace-count">${esc(String(n))}</span>` : ''}
          </button>`).join('');
    }

    const body = this.el.querySelector('#arBody');
    if (!body) return;
    if (this.tab === 'talk') {
      const scopeBtn = (id, label) => `<button class="trace-tab${this.scope === id ? ' active' : ''}" data-ar-scope="${id}">${esc(label)}</button>`;
      body.innerHTML = `<div class="form-hint">Everything ${esc(name)} sent or received this page-load — your prompt, the task it was handed, what it said to another agent, and every reply. Nothing here is written to storage.</div>`
        + `<div class="agent-scope" id="arScope">${scopeBtn('all', 'All communication')}${scopeBtn('agent', 'Agent to agent')}</div>`
        + `<div class="trace-scroll">${commsHtml(entries, this.scope === 'agent'
          ? `${name} has not spoken to another agent yet.`
          : `${name} has not said anything yet this page-load.`)}</div>`;
      return;
    }
    // First look at RUNS: fetch once, then render from what came back. A
    // reopened drawer for the same agent re-fetches, so a command that ran in
    // the meantime shows up.
    if (!this.execData && !this.execLoading && !this.execError) {
      this.loadRuns();
    }
    if (this.execLoading && !this.execData) {
      body.innerHTML = '<div class="trace-empty">Reading storage/exec.log…</div>';
      return;
    }
    if (this.execError) {
      body.innerHTML = `<div class="trace-empty">Could not read the exec log — ${esc(this.execError)}</div>`;
      return;
    }
    body.innerHTML = `<div class="form-hint">Commands this agent ran. A run with no end means the process never reported back.</div>`
      + `<div class="trace-scroll">${execHtml(this.execData)}</div>`;
  }

  async loadRuns() {
    if (this.execLoading) return;
    this.execLoading = true;
    this.execError = '';
    const want = this.agentId;
    try {
      const data = await api.execLog({ lines: 300, agent: this.agentId });
      if (!this.el || this.agentId !== want) return; // closed or switched agent
      this.execData = data;
    } catch (err) {
      this.execError = err?.message || String(err);
    } finally {
      this.execLoading = false;
    }
    if (this.el && this.tab === 'runs') this.render();
  }

  close() {
    this.el?.remove();
    this.el = null;
    this.agentId = null;
  }
}

export default AgentRecord;
