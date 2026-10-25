/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// TRACEPANEL.JS — the run-trace viewer
// ============================================
//
// A flat, newest-first timeline of model turns and tool calls with timing,
// token cost and success, plus totals. Opened from Config → TRACE.

import { store } from '../store.js?v=330';
import { esc } from '../utils.js?v=330';
import { recent, clear, stats } from '../trace.js?v=330';

function fmtTime(t) {
  try { return new Date(t).toLocaleTimeString([], { hour12: false }); } catch { return ''; }
}

function fmtTokens(n) {
  n = Math.round(n || 0);
  if (n >= 1000000) return `${(n / 1000000).toFixed(2).replace(/\.?0+$/, '')}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export class TracePanel {
  constructor() {
    this.el = null;
  }

  init() {
    store.on('trace:show', () => this.open());
  }

  open() {
    this.close();
    const s = stats();
    const rows = recent(300).map(e => {
      const what = e.kind === 'model'
        ? `${esc(e.model || 'model')}${e.approx ? ' (est)' : ''}`
        : esc(e.tool || e.kind);
      const cost = e.kind === 'model'
        ? `${fmtTokens((e.prompt || 0) + (e.completion || 0))} tok`
        : (e.ms != null ? `${e.ms}ms` : '');
      const ok = e.ok === false
        ? '<span style="color:var(--accent-red)">fail</span>'
        : (e.ok === true ? 'ok' : '');
      const err = e.error ? ` <span class="metrics-sub">${esc(String(e.error).slice(0, 80))}</span>` : '';
      return `<tr>
        <td>${esc(fmtTime(e.t))}</td>
        <td>${esc(e.kind)}</td>
        <td>${esc(e.agentName || '—')}</td>
        <td>${what}${err}</td>
        <td class="num">${cost}</td>
        <td>${ok}</td>
      </tr>`;
    }).join('');

    const overlay = document.createElement('div');
    overlay.className = 'modal-bg open';
    overlay.id = 'traceModal';
    overlay.innerHTML = `
      <div class="modal metrics-modal">
        <div class="modal-header">
          <span class="modal-title">Run trace</span>
          <button class="modal-close" id="traceClose">&times;</button>
        </div>
        <div class="modal-body">
          <div class="metrics-totals">
            <div class="metrics-total"><span>${fmtTokens(s.tokens)}</span><label>tokens</label></div>
            <div class="metrics-total"><span>${s.calls}</span><label>model calls</label></div>
            <div class="metrics-total"><span>${s.toolCalls}</span><label>tool calls</label></div>
            <div class="metrics-total"><span>${s.errors}</span><label>errors</label></div>
          </div>
          <div class="form-hint">Newest first. This page-load only — reload to reset.</div>
          <div style="max-height:60vh;overflow:auto">
            <table class="metrics-table">
              <thead><tr><th>time</th><th>kind</th><th>agent</th><th>what</th><th class="num">cost</th><th></th></tr></thead>
              <tbody>${rows || '<tr><td colspan="6">No events yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="traceClear">Clear</button>
          <button class="btn btn-primary" id="traceOk">Close</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    this.el = overlay;

    const byId = id => overlay.querySelector('#' + id);
    byId('traceClose')?.addEventListener('click', () => this.close());
    byId('traceOk')?.addEventListener('click', () => this.close());
    byId('traceClear')?.addEventListener('click', () => { clear(); this.open(); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close(); });
  }

  close() {
    this.el?.remove();
    this.el = null;
  }
}

export default TracePanel;
