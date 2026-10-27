/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// TRACEPANEL.JS — the record of what happened
// ============================================
//
// Three tabs over one modal, because these are three views of the same
// question ("what did the agents actually do?") and splitting them across
// separate panels would mean hunting in three places for one run:
//
//   RUNS  — model turns and tool calls, with timing, tokens and success.
//   COMMS — what the agents SAID to each other, not just that they spoke.
//   EXEC  — storage/exec.log, paired into runs, newest first.
//
// RUNS and COMMS are page-load only (memory). EXEC is read from the server on
// open, so it survives a reload and shows commands from earlier sessions —
// including runs that started and never reported back.
//
// The two renderers are exported so the per-agent drawer on the map can show
// the same rows filtered to one agent instead of re-implementing them.

import { store } from '../store.js?v=358';
import { esc } from '../utils.js?v=358';
import { recent, clear, stats } from '../trace.js?v=358';
import { api } from '../api.js?v=358';
import * as comms from '../commsLog.js?v=358';

function fmtTime(t) {
  try { return new Date(t).toLocaleTimeString([], { hour12: false }); } catch { return ''; }
}

function fmtTokens(n) {
  n = Math.round(n || 0);
  if (n >= 1000000) return `${(n / 1000000).toFixed(2).replace(/\.?0+$/, '')}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtMs(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Epoch SECONDS (the audit log's unit) to a local clock time. */
function fmtAuditTime(sec) {
  if (!sec) return '—';
  return fmtTime(sec * 1000);
}

const KIND_LABEL = { ask: 'ask', tell: 'tell', ping: 'ping' };

/**
 * The COMMS list: one block per exchange, both halves together.
 *
 * Everything is escaped — these are model-written strings arriving over the
 * wire, and a reply containing markup must read as text, not render.
 */
export function commsHtml(entries, emptyText = 'No agent-to-agent messages yet.') {
  if (!entries || !entries.length) {
    return `<div class="trace-empty">${esc(emptyText)}</div>`;
  }
  return entries.map(e => {
    const failed = e.ok === false;
    const reply = e.reply
      ? `<div class="comms-reply${failed ? ' fail' : ''}">${esc(e.reply)}</div>`
      : (e.kind === 'ask'
        ? '<div class="comms-reply pending">…still waiting for a reply</div>'
        : '');
    const meta = [
      fmtTime(e.t),
      KIND_LABEL[e.kind] || e.kind,
      e.ms != null ? fmtMs(e.ms) : '',
    ].filter(Boolean).join(' · ');
    return `<div class="comms-item${failed ? ' fail' : ''}">
      <div class="comms-head">
        <span class="comms-name">${esc(e.fromName || e.fromId || 'agent')}</span>
        <span class="comms-arrow">→</span>
        <span class="comms-name">${esc(e.toName || e.toId || 'agent')}</span>
        <span class="comms-meta">${esc(meta)}</span>
      </div>
      <div class="comms-text">${esc(e.text || '(empty)')}</div>
      ${reply}
    </div>`;
  }).join('');
}

/**
 * The EXEC table, from api.execLog()'s parsed runs.
 *
 * `finished: false` is the important row: a start line with no end means the
 * process never reported back (killed mid-command, server restarted, or a GUI
 * app still open), which is exactly what the old one-line audit could not show.
 */
export function execHtml(data) {
  const entries = (data && data.entries) || [];
  if (!entries.length) {
    return '<div class="trace-empty">Nothing in storage/exec.log yet.</div>';
  }
  const rows = entries.map(e => {
    const state = !e.finished
      ? '<span class="trace-fail">no end</span>'
      : (e.timeout
        ? '<span class="trace-fail">timeout</span>'
        : (e.exit === 0 ? 'ok' : `<span class="trace-fail">exit ${e.exit}</span>`));
    return `<tr class="${e.finished ? '' : 'trace-row-open'}">
      <td>${esc(fmtAuditTime(e.endedAt || e.startedAt))}</td>
      <td>${esc(e.agent && e.agent !== '-' ? e.agent : '—')}</td>
      <td class="trace-cmd">${esc(e.command || '')}${e.cwd ? `<span class="metrics-sub"> ${esc(e.cwd)}</span>` : ''}</td>
      <td class="num">${esc(e.ms != null ? String(e.ms) + 'ms' : '')}</td>
      <td>${state}</td>
    </tr>`;
  }).join('');
  return `<table class="metrics-table">
      <thead><tr><th>time</th><th>agent</th><th>command</th><th class="num">took</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export class TracePanel {
  constructor() {
    this.el = null;
    this.tab = 'runs';
    this.execData = null;
    this.execError = '';
    this.execLoading = false;
  }

  init() {
    store.on('trace:show', (opts) => this.open(opts && opts.tab));
    store.on('comms:changed', () => { if (this.el && this.tab === 'comms') this.render(); });
  }

  open(tab) {
    if (tab === 'runs' || tab === 'comms' || tab === 'exec') this.tab = tab;
    this.el?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-bg open';
    overlay.id = 'traceModal';
    overlay.innerHTML = `
      <div class="modal metrics-modal trace-modal">
        <div class="modal-header">
          <span class="modal-title">Run trace</span>
          <button class="modal-close" id="traceClose">&times;</button>
        </div>
        <div class="modal-body" id="traceBody"></div>
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
    byId('traceClear')?.addEventListener('click', () => this.clearTab());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { this.close(); return; }
      const tabBtn = e.target.closest?.('[data-trace-tab]');
      if (tabBtn) {
        const next = tabBtn.dataset.traceTab;
        if (next && next !== this.tab) {
          this.tab = next;
          this.render();
        }
      }
    });

    this.render();
  }

  /** Clear only what the open tab is showing — RUNS does not wipe COMMS. */
  clearTab() {
    if (this.tab === 'runs') clear();
    else if (this.tab === 'comms') comms.clear();
    else return; // The exec log is the audit trail; the UI cannot delete it.
    this.render();
  }

  render() {
    if (!this.el) return;
    const body = this.el.querySelector('#traceBody');
    if (!body) return;
    const clearBtn = this.el.querySelector('#traceClear');
    if (clearBtn) {
      // The audit log is evidence; there is no clear button for it on purpose.
      clearBtn.style.display = this.tab === 'exec' ? 'none' : '';
    }

    body.innerHTML = `
      <div class="trace-tabs"></div>
      <div class="trace-view" id="traceView">${this.tab === 'exec' ? this.execBody() : ''}</div>`;
    this.renderTabs();

    if (this.tab === 'runs') {
      const s = stats();
      body.querySelector('#traceView').innerHTML = `
        <div class="metrics-totals">
          <div class="metrics-total"><span>${fmtTokens(s.tokens)}</span><label>tokens</label></div>
          <div class="metrics-total"><span>${s.calls}</span><label>model calls</label></div>
          <div class="metrics-total"><span>${s.toolCalls}</span><label>tool calls</label></div>
          <div class="metrics-total"><span>${s.errors}</span><label>errors</label></div>
        </div>
        <div class="form-hint">Newest first. This page-load only — reload to reset.</div>
        <div class="trace-scroll">${this.runsTable()}</div>`;
    } else if (this.tab === 'comms') {
      body.querySelector('#traceView').innerHTML = `
        <div class="form-hint">What the agents actually said to each other: the question, and the answer that came back. Kept in memory for this page-load — agent chat is not written to storage.</div>
        <div class="trace-scroll">${commsHtml(comms.recent(300))}</div>`;
    } else {
      this.loadExec();
    }
  }

  /**
   * The tab bar, on its own so a count can be corrected after a fetch without
   * rebuilding the view underneath it.
   */
  renderTabs() {
    const tabs = this.el?.querySelector('.trace-tabs');
    if (!tabs) return;
    const execCount = this.execData ? (this.execData.entries || []).length : '';
    tabs.innerHTML = [
      ['runs', 'Runs', recent(300).length],
      ['comms', 'Comms', comms.count()],
      ['exec', 'Exec', execCount],
    ].map(([id, label, n]) => `<button class="trace-tab${this.tab === id ? ' active' : ''}" data-trace-tab="${id}">
        ${esc(label)}${n !== '' && n != null ? `<span class="trace-count">${esc(String(n))}</span>` : ''}
      </button>`).join('');
  }

  runsTable() {
    const rows = recent(300).map(e => {
      const what = e.kind === 'model'
        ? `${esc(e.model || 'model')}${e.approx ? ' (est)' : ''}`
        : esc(e.tool || e.kind);
      const cost = e.kind === 'model'
        ? `${fmtTokens((e.prompt || 0) + (e.completion || 0))} tok`
        : (e.ms != null ? `${e.ms}ms` : '');
      const ok = e.ok === false
        ? '<span class="trace-fail">fail</span>'
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
    return `<table class="metrics-table">
        <thead><tr><th>time</th><th>kind</th><th>agent</th><th>what</th><th class="num">cost</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6">No events yet.</td></tr>'}</tbody>
      </table>`;
  }

  execBody() {
    if (this.execLoading && !this.execData) return '<div class="trace-empty">Reading storage/exec.log…</div>';
    if (this.execError) return `<div class="trace-empty">Could not read the exec log — ${esc(this.execError)}</div>`;
    const hint = `<div class="form-hint">Every command the sandbox ran, start line first. A run with no end means the process never reported back. Read-only: nothing here can be cleared from the UI.</div>`;
    return hint + `<div class="trace-scroll">${execHtml(this.execData)}</div>`;
  }

  /** One fetch per open (and per refresh), not per keystroke or render. */
  async loadExec() {
    if (this.execLoading) return;
    this.execLoading = true;
    this.execError = '';
    try {
      const data = await api.execLog({ lines: 300 });
      if (!this.el) return; // closed while in flight
      this.execData = data;
    } catch (err) {
      this.execError = err?.message || String(err);
    } finally {
      this.execLoading = false;
    }
    // The count belongs in the tab, so the label is refreshed with the rows.
    this.renderTabs();
    const view = this.el?.querySelector('#traceView');
    if (view && this.tab === 'exec') view.innerHTML = this.execBody();
  }

  close() {
    this.el?.remove();
    this.el = null;
  }
}

export default TracePanel;
