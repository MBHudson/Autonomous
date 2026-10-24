/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// METRICSPANEL.JS — Per-session usage metrics modal
// ============================================

import { store } from '../store.js?v=319';
import { api } from '../api.js?v=319';
import { esc, agentCode } from '../utils.js?v=319';

function fmt(n) {
  n = Math.round(n || 0);
  return n.toLocaleString('en-US');
}

export class MetricsPanel {
  constructor() {
    this.modal = null;
  }

  init() {
    store.on('metrics:showAgent', (id) => this.openAgent(id));
    store.on('metrics:showProvider', (id) => this.openProvider(id));
    store.on('metrics:showModel', (payload) => {
      const p = Array.isArray(payload)
        ? { provider: payload[0], model: payload[1] }
        : (payload || {});
      this.openModel(p.provider, p.model);
    });
    store.on('metrics:showUsage', () => this.openUsage());
  }

  _sessionTitle(sessionId) {
    const convs = store.get('conversations') || [];
    const conv = convs.find(c => c.id === sessionId);
    return conv?.title || (sessionId?.slice(0, 18) + '…');
  }

  /**
   * Usage for ONE model, across every session.
   *
   * Sessions recorded before per-model tracking existed have no models bucket.
   * Rather than showing them as zero, fall back to attributing each agent's
   * usage to that agent's currently-selected model. That is approximate if an
   * agent changed model since, so `approximate` is surfaced to the caller.
   */
  _modelEntry(providerId, modelId) {
    const metrics = store.get('metrics') || { sessions: {} };
    const sessions = metrics.sessions || {};
    const key = `${providerId || '?'}::${modelId || '?'}`;
    const rows = [];
    let tIn = 0, tOut = 0, tCalls = 0;
    let approximate = false;

    Object.entries(sessions).forEach(([sid, sess]) => {
      const e = sess?.models?.[key];
      if (e) {
        tIn += e.prompt || 0;
        tOut += e.completion || 0;
        tCalls += e.calls || 0;
        rows.push({ sessionId: sid, title: this._sessionTitle(sid), ...e });
      }
    });

    if (!rows.length) {
      const agents = store.get('agents') || [];
      Object.entries(sessions).forEach(([sid, sess]) => {
        Object.entries(sess?.agents || {}).forEach(([agentId, e]) => {
          const a = agents.find(x => x.id === agentId);
          if (!a || a.model !== modelId || (providerId && a.provider !== providerId)) return;
          approximate = true;
          tIn += e.prompt || 0;
          tOut += e.completion || 0;
          tCalls += e.calls || 0;
          rows.push({ sessionId: sid, title: this._sessionTitle(sid), ...e });
        });
      });
    }

    return {
      rows,
      totals: { prompt: tIn, completion: tOut, calls: tCalls },
      approximate,
    };
  }

  /** Every model seen in the metrics, keyed provider::model, with totals. */
  _modelTotals() {
    const metrics = store.get('metrics') || { sessions: {} };
    const sessions = metrics.sessions || {};
    const map = new Map();
    Object.values(sessions).forEach(sess => {
      Object.values(sess?.models || {}).forEach(e => {
        const key = `${e.provider || '?'}::${e.model || '?'}`;
        const cur = map.get(key) || { provider: e.provider || '', model: e.model || '', prompt: 0, completion: 0, calls: 0 };
        cur.prompt += e.prompt || 0;
        cur.completion += e.completion || 0;
        cur.calls += e.calls || 0;
        map.set(key, cur);
      });
    });
    // Agents that predate model buckets still deserve a row, attributed to the
    // model they point at now.
    if (!map.size) {
      const agents = store.get('agents') || [];
      Object.values(sessions).forEach(sess => {
        Object.entries(sess?.agents || {}).forEach(([agentId, e]) => {
          const a = agents.find(x => x.id === agentId);
          if (!a || !a.model) return;
          const key = `${a.provider || '?'}::${a.model}`;
          const cur = map.get(key) || { provider: a.provider || '', model: a.model, prompt: 0, completion: 0, calls: 0, approximate: true };
          cur.prompt += e.prompt || 0;
          cur.completion += e.completion || 0;
          cur.calls += e.calls || 0;
          map.set(key, cur);
        });
      });
    }
    return map;
  }

  _agentEntry(agentId) {
    const metrics = store.get('metrics') || { sessions: {} };
    const sessions = metrics.sessions || {};
    const rows = [];
    let tIn = 0, tOut = 0, tCalls = 0;
    Object.entries(sessions).forEach(([sid, sess]) => {
      const e = sess?.agents?.[agentId];
      if (!e) return;
      tIn += e.prompt || 0;
      tOut += e.completion || 0;
      tCalls += e.calls || 0;
      rows.push({ sessionId: sid, title: this._sessionTitle(sid), ...e });
    });
    return { rows, totals: { prompt: tIn, completion: tOut, calls: tCalls } };
  }

  _allTimeTotals() {
    const metrics = store.get('metrics') || { sessions: {} };
    const sessions = metrics.sessions || {};
    let tIn = 0, tOut = 0, tCalls = 0;
    Object.values(sessions).forEach(sess => {
      Object.values(sess?.agents || {}).forEach(e => {
        tIn += e.prompt || 0;
        tOut += e.completion || 0;
        tCalls += e.calls || 0;
      });
    });
    return { prompt: tIn, completion: tOut, calls: tCalls };
  }

  _allTimeHtml() {
    const t = this._allTimeTotals();
    return `<div class="form-label" style="margin:0 0 6px">All-time total (this app)</div>`
      + this._totalsHtml(t, 'calls');
  }

  _rowsHtml(rows) {
    if (rows.length === 0) {
      return '<div class="empty"><div class="empty-text">No usage recorded yet.<br>Send a message to start tracking.</div></div>';
    }
    let html = '<table class="metrics-table"><thead><tr>'
      + '<th>Session</th><th>In</th><th>Out</th><th>Calls</th>'
      + '</tr></thead><tbody>';
    rows.forEach(r => {
      html += `<tr><td>${esc(r.title)}</td><td class="num">${fmt(r.prompt)}</td>`
        + `<td class="num">${fmt(r.completion)}</td><td class="num">${fmt(r.calls)}</td></tr>`;
    });
    return html + '</tbody></table>';
  }

  _totalsHtml(t, label) {
    return `<div class="metrics-totals">`
      + `<div class="metrics-total"><span>${fmt(t.prompt)}</span><label>tokens in</label></div>`
      + `<div class="metrics-total"><span>${fmt(t.completion)}</span><label>tokens out</label></div>`
      + `<div class="metrics-total"><span>${fmt(t.calls)}</span><label>${label || 'calls'}</label></div>`
      + `</div>`;
  }

  openAgent(agentId) {
    const agents = store.get('agents') || [];
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;
    const { rows, totals } = this._agentEntry(agentId);
    this._open(`${esc(agentCode(agent))} ${esc(agent.name)} — Usage`, agent.color,
      this._allTimeHtml()
      + `<div class="form-label" style="margin:12px 0 6px">This agent</div>`
      + this._totalsHtml(totals) + this._rowsHtml(rows));
  }

  /**
   * One model's own usage. Clicking a model on the topology used to route to
   * the provider panel, so every model on that provider showed the identical
   * provider-wide totals. Each model now reports only what it spent.
   */
  openModel(providerId, modelId) {
    if (!modelId) return;
    const providers = store.get('providers') || [];
    const provider = providers.find(p => p.id === providerId);
    const { rows, totals, approximate } = this._modelEntry(providerId, modelId);
    const title = `${modelId} — Usage`;
    // No app-wide total here on purpose. It was prepended to every panel, which
    // is why two different models appeared to show "the same usage" — the first
    // block was identical in all of them. The app total lives in the Usage
    // button, where it belongs.
    this._open(esc(title), '#00e5ff',
      `<div class="form-label" style="margin:0 0 6px">This model`
      + (provider ? ` (${esc(provider.name)})` : '') + '</div>'
      + this._totalsHtml(totals, 'calls')
      + (approximate
        ? '<div class="form-hint" style="margin-top:6px">Older sessions predate per-model '
          + 'tracking, so they are attributed to the model each agent is set to now.</div>'
        : '')
      + `<div class="form-label" style="margin:12px 0 6px">By session</div>`
      + this._rowsHtml(rows));
  }

  openProvider(providerId) {
    const providers = store.get('providers') || [];
    const agents = store.get('agents') || [];
    // Resolve backend model nodes (provider field) and local provider_ ids
    const pid = String(providerId).replace(/^provider_/, '');
    const provider = providers.find(p => p.id === pid);
    const owned = agents.filter(a => a.provider === pid);
    const name = provider?.name || pid;

    let tIn = 0, tOut = 0, tCalls = 0;
    let perAgent = '';
    owned.forEach(agent => {
      const { rows, totals } = this._agentEntry(agent.id);
      tIn += totals.prompt;
      tOut += totals.completion;
      tCalls += totals.calls;
      perAgent += `<div class="metrics-agent-block">`
        + `<div class="metrics-agent-name" style="color:${esc(agent.color)}">${esc(agentCode(agent))} ${esc(agent.name)}</div>`
        + this._rowsHtml(rows) + `</div>`;
    });
    // Per-model breakdown, each with ITS OWN totals. Without this the panel only
    // had a provider-wide number, which looked identical for every model.
    const modelTotals = this._modelTotals();
    let byModel = '';
    [...modelTotals.entries()]
      .filter(([, m]) => !pid || m.provider === pid)
      .sort((a, b) => (b[1].prompt + b[1].completion) - (a[1].prompt + a[1].completion))
      .forEach(([, m]) => {
        byModel += `<div class="metrics-agent-block">`
          + `<div class="metrics-agent-name">${esc(m.model)}</div>`
          + this._totalsHtml(m, 'calls')
          + `</div>`;
      });
    const modelCount = modelTotals.size;
    if (!byModel) {
      byModel = '<div class="empty"><div class="empty-text">No model usage recorded yet.</div></div>';
    }

    if (owned.length === 0) {
      perAgent = '<div class="empty"><div class="empty-text">No agents use this provider.</div></div>';
    }
    this._open(`${esc(name)} — Usage`, '#00e5ff',
      `<div class="form-label" style="margin:0 0 6px">This provider</div>`
      + this._totalsHtml({ prompt: tIn, completion: tOut, calls: tCalls })
      + `<div class="form-label" style="margin:12px 0 6px">By model (${modelCount})</div>`
      + byModel
      + `<div class="form-label" style="margin:12px 0 6px">By agent (${owned.length})</div>`
      + perAgent);
  }

  /**
 * USAGE (CONFIG tab): this web app's usage only — all-time totals plus a
 * per-agent breakdown aggregated across every session.
 *
 * An earlier version appended an "opencode-studio" block bridged from a
 * separate local server, which made an unrelated session show up as if it
 * were one of this app's agents. Removed at the user's request, along with
 * the GET /studio-usage backend route.
 */
async openUsage() {
    this._open('Usage', '#00e5ff',
      '<div class="empty"><div class="empty-text">Loading usage…</div></div>');

    const agents = store.get('agents') || [];
    const providers = store.get('providers') || [];

    // Accumulate every agent across every session for this app.
    const metrics = store.get('metrics') || { sessions: {} };
    const sessions = metrics.sessions || {};
    const perAgent = new Map();
    Object.values(sessions).forEach(sess => {
      Object.entries(sess?.agents || {}).forEach(([agentId, e]) => {
        const cur = perAgent.get(agentId) || { prompt: 0, completion: 0, calls: 0 };
        cur.prompt += e.prompt || 0;
        cur.completion += e.completion || 0;
        cur.calls += e.calls || 0;
        perAgent.set(agentId, cur);
      });
    });

    let rowsHtml;
    if (perAgent.size === 0) {
      rowsHtml = '<div class="empty"><div class="empty-text">No usage recorded yet.<br>'
        + 'Send a message to start tracking.</div></div>';
    } else {
      rowsHtml = '<table class="metrics-table"><thead><tr>'
        + '<th>Agent</th><th>In</th><th>Out</th><th>Calls</th>'
        + '</tr></thead><tbody>';
      // Busiest first.
      [...perAgent.entries()]
        .sort((a, b) => (b[1].prompt + b[1].completion) - (a[1].prompt + a[1].completion))
        .forEach(([agentId, t]) => {
          const agent = agents.find(a => a.id === agentId);
          const provider = providers.find(p => p.id === agent?.provider);
          const label = agent ? `${agentCode(agent)} ${agent.name}` : agentId;
          const sub = [agent?.role, provider?.name].filter(Boolean).join(' · ');
          rowsHtml += `<tr><td>${esc(label)}`
            + (sub ? `<div class="metrics-sub">${esc(sub)}</div>` : '')
            + `<div class="metrics-sub">${esc(agent?.model || '')}</div></td>`
            + `<td class="num">${fmt(t.prompt)}</td>`
            + `<td class="num">${fmt(t.completion)}</td>`
            + `<td class="num">${fmt(t.calls)}</td></tr>`;
        });
      rowsHtml += '</tbody></table>';
    }

    this._open('Usage', '#00e5ff',
      '<div class="form-label" style="margin:0 0 6px">Router — all-time total (this web app only)</div>'
      + this._totalsHtml(this._allTimeTotals(), 'calls')
      + '<div class="form-label" style="margin:12px 0 6px">By agent (this web app only)</div>'
      + rowsHtml);
  }

  _open(title, color, bodyHtml) {
    this.close();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal metrics-modal">`
      + `<div class="modal-header"><span class="modal-title" style="color:${color}">${title}</span>`
      + `<button class="modal-close" id="metricsClose">&times;</button></div>`
      + `<div class="modal-body">${bodyHtml}</div>`
      + `<div class="modal-footer"><button class="btn btn-ghost" id="metricsOk">Close</button></div>`
      + `</div>`;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close(); });
    document.body.appendChild(overlay);
    this.modal = overlay;
    document.getElementById('metricsClose').addEventListener('click', () => this.close());
    document.getElementById('metricsOk').addEventListener('click', () => this.close());
  }

  close() {
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }
  }
}

export default MetricsPanel;
