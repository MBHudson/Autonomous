/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// THINKINGPANEL.JS — Thinking overlay panel
// ============================================

import { store } from '../store.js?v=358';
import { esc } from '../utils.js?v=358';

export class ThinkingPanel {
  constructor() {
    this.panel = null;
    this.content = null;
    this.log = [];
  }

  init() {
    this.panel = document.getElementById('thinkingPanel');
    this.content = document.getElementById('thinkingContent');

    document.getElementById('thinkingClose')?.addEventListener('click', () => this.hide());

    // Listen for thinking events
    store.on('thinking:add', (entry) => this.addEntry(entry));
  }

  toggle() { this.panel.classList.toggle('hidden'); }
  show() { this.panel.classList.remove('hidden'); }
  hide() { this.panel.classList.add('hidden'); }

  addEntry(entry) {
    this.log.unshift(entry);
    if (this.log.length > 50) this.log.pop();
    this._render();
  }

  _render() {
    if (!this.content) return;
    this.content.innerHTML = this.log.map(e => `
      <div class="thinking-entry">
        <div class="thinking-agent" style="color:${e.color}">${esc(e.agentName)} <span class="thinking-time">${e.time}</span></div>
        <div>${esc(e.text)}</div>
      </div>
    `).join('');
  }
}

export default ThinkingPanel;
