// ============================================
// TOPOLOGY3D / POPUP.JS — click-a-node metrics card
// ============================================

import { store } from '../../store.js?v=304';
import { esc } from '../../utils.js?v=304';
import { latency, fmtMs, latencyTier } from '../../latency.js?v=304';

const KIND_LABEL = {
  message: 'prompt', response: 'reply', delegate: 'delegate',
  agent: 'ask', tell: 'tell', fail: 'failed',
};

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

function sparkline(series, color) {
  if (!series || series.length < 2) {
    return `<div class="t3d-spark-empty">${series && series.length === 1 ? 'one call so far' : 'no calls measured yet'}</div>`;
  }
  const W = 220, H = 34, P = 2;
  const max = Math.max(...series), min = Math.min(...series);
  const span = Math.max(1, max - min);
  const pts = series.map((v, i) => {
    const x = P + (i / (series.length - 1)) * (W - P * 2);
    const y = H - P - ((v - min) / span) * (H - P * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(',');
  return `<svg class="t3d-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polyline points="${P},${H - P} ${pts.join(' ')} ${W - P},${H - P}" fill="${esc(color)}" fill-opacity="0.12" stroke="none"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${esc(color)}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.5" fill="${esc(color)}"/>
  </svg>
  <div class="t3d-spark-axis"><span>${fmtMs(min)}</span><span>last ${series.length} calls</span><span>${fmtMs(max)}</span></div>`;
}

/** Token and tool totals for one agent, this session and across all sessions. */
export function agentUsage(agentId, sessionId) {
  const sessions = (store.get('metrics') || {}).sessions || {};
  const zero = () => ({ prompt: 0, completion: 0, requests: 0, approx: false });
  const sess = zero();
  const all = zero();
  const tools = { calls: 0, byTool: {} };
  const sessTools = { calls: 0 };
  Object.entries(sessions).forEach(([sid, s]) => {
    const e = s && s.agents && s.agents[agentId];
    if (e) {
      [all, ...(sid === sessionId ? [sess] : [])].forEach(t => {
        t.prompt += e.prompt || 0;
        t.completion += e.completion || 0;
        t.requests += e.requests || e.calls || 0;
        t.approx = t.approx || !!e.approx;
      });
    }
    const tl = s && s.tools && s.tools[agentId];
    if (tl) {
      tools.calls += tl.calls || 0;
      Object.entries(tl.byTool || {}).forEach(([k, v]) => { tools.byTool[k] = (tools.byTool[k] || 0) + v; });
      if (sid === sessionId) sessTools.calls += tl.calls || 0;
    }
  });
  return { sess, all, tools, sessTools };
}

export class PopupCard {
  /**
   * @param {HTMLElement} host positioned container
   * @param {object} ctx { nodeById(id), nodes(), history(), sessionId(), onClose() }
   */
  constructor(host, ctx) {
    this.ctx = ctx;
    this.el = document.createElement('div');
    this.el.className = 't3d-popup';
    this.el.hidden = true;
    host.appendChild(this.el);
    this.nodeId = null;
    this._timer = null;

    this.el.addEventListener('pointerdown', e => e.stopPropagation());
    this.el.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
    this.el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'close') this.close();
      else if (act === 'report') {
        const n = this.ctx.nodeById(this.nodeId);
        if (n?.type === 'agent') store.emit('metrics:showAgent', n.id);
        else if (n?.type === 'provider') store.emit('metrics:showProvider', n.id);
      }
    });
  }

  get isOpen() { return !this.el.hidden && !!this.nodeId; }

  open(nodeId) {
    this.nodeId = nodeId;
    this.el.hidden = false;
    this.render();
    clearInterval(this._timer);
    // "12s ago" and live status keep moving while the card is up.
    this._timer = setInterval(() => this.render(), 2000);
    this.el.classList.remove('t3d-pop-in');
    void this.el.offsetWidth;
    this.el.classList.add('t3d-pop-in');
  }

  close() {
    if (!this.nodeId) return;
    this.nodeId = null;
    this.el.hidden = true;
    clearInterval(this._timer);
    this.ctx.onClose?.();
  }

  /** Re-render if open (called on metric/latency/status changes). */
  refresh() { if (this.isOpen) this.render(); }

  render() {
    const n = this.ctx.nodeById(this.nodeId);
    if (!n) { this.close(); return; }
    const color = n.color || '#00e5ff';
    this.el.style.setProperty('--c', color);
    let body = '';
    if (n.type === 'agent') body = this._agent(n, color);
    else if (n.type === 'provider') body = this._provider(n, color);
    else if (n.type === 'user') body = this._user(n);
    else body = this._session(n);
    const statusPill = n.type === 'agent' || n.type === 'user'
      ? `<span class="t3d-pill ${esc(n.status || 'idle')}">${esc(n.status === 'online' ? 'online' : (n.status || 'idle'))}</span>` : '';
    const scroll = this.el.querySelector('.t3d-pop-body')?.scrollTop || 0;
    this.el.innerHTML = `
      <div class="t3d-pop-head">
        <span class="t3d-dot"></span>
        <div class="t3d-pop-title">
          <div class="t3d-pop-name">${esc(n.label || n.id)}</div>
          <div class="t3d-pop-sub">${esc(this._subtitle(n))}</div>
        </div>
        ${statusPill}
        <button class="t3d-x" data-act="close" title="Close (Esc)">&times;</button>
      </div>
      <div class="t3d-pop-body">${body}</div>`;
    const b = this.el.querySelector('.t3d-pop-body');
    if (b) b.scrollTop = scroll;
  }

  _subtitle(n) {
    if (n.type === 'agent') return [n.code, n.role].filter(Boolean).join(' · ');
    if (n.type === 'provider') return 'provider';
    if (n.type === 'user') return 'operator';
    return 'session';
  }

  _latencyBlock(s, color) {
    const tier = latencyTier(s.avg);
    return `
      <div class="t3d-sec">
        <div class="t3d-sec-h">Latency <span class="t3d-hint">model calls, after queueing</span></div>
        <div class="t3d-big ${tier}">${fmtMs(s.avg)}<small>avg</small></div>
        <div class="t3d-grid">
          <div><label>Last</label><b>${fmtMs(s.last)}</b></div>
          <div><label>p95</label><b>${fmtMs(s.p95)}</b></div>
          <div><label>First token</label><b>${fmtMs(s.ttftAvg)}</b></div>
          <div><label>Min / max</label><b>${fmtMs(s.min)} / ${fmtMs(s.max)}</b></div>
          <div><label>Queue wait</label><b>${fmtMs(s.queueAvg)}</b></div>
          <div><label>Errors</label><b class="${s.errors ? 'bad' : ''}">${s.errors}${s.count ? ` <small>(${Math.round(s.errorRate * 100)}%)</small>` : ''}</b></div>
        </div>
        ${sparkline(s.series, color)}
        ${s.lastError ? `<div class="t3d-err" title="${esc(s.lastError)}">Last error ${esc(ago(s.lastErrorAt))}: ${esc(s.lastError.slice(0, 120))}</div>` : ''}
      </div>`;
  }

  _recentBlock(id) {
    const items = this.ctx.history()
      .filter(h => h.from === id || h.to === id)
      .slice(-8)
      .reverse();
    if (!items.length) return `<div class="t3d-sec"><div class="t3d-sec-h">Recent messages</div><div class="t3d-empty">Nothing yet this session</div></div>`;
    const rows = items.map(h => {
      const outbound = h.from === id;
      const otherId = outbound ? h.to : h.from;
      const other = otherId ? this.ctx.nodeById(otherId) : null;
      const otherName = otherId === 'user' ? 'You' : (other?.label || otherId || '—');
      const otherColor = otherId === 'user' ? '#ff4757' : (other?.color || '#64748b');
      const arrow = h.kind === 'fail' ? '✕' : (outbound ? '→' : '←');
      return `<div class="t3d-msg ${h.kind === 'fail' ? 'fail' : ''}">
        <span class="t3d-msg-dir ${outbound ? 'out' : 'in'}">${arrow}</span>
        <span class="t3d-msg-who" style="color:${esc(otherColor)}">${esc(h.kind === 'fail' ? 'call failed' : otherName)}</span>
        <span class="t3d-msg-kind">${esc(KIND_LABEL[h.kind] || h.kind)}</span>
        <span class="t3d-msg-t">${esc(ago(h.at))}</span>
      </div>`;
    }).join('');
    return `<div class="t3d-sec"><div class="t3d-sec-h">Recent messages</div>${rows}</div>`;
  }

  _agent(n, color) {
    const agent = (store.get('agents') || []).find(a => a.id === n.id) || {};
    const provider = (store.get('providers') || []).find(p => p.id === n.providerId);
    const s = latency.stats(n.id);
    const u = agentUsage(n.id, this.ctx.sessionId());
    const approx = (u.sess.approx || u.all.approx) ? '≈' : '';
    const topTools = Object.entries(u.tools.byTool).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const toolMax = topTools.length ? topTools[0][1] : 1;
    return `
      <div class="t3d-sec">
        <div class="t3d-kv"><label>Model</label><span title="${esc(n.model || '')}">${esc(n.model || '—')}</span></div>
        <div class="t3d-kv"><label>Provider</label><span>${esc(provider?.name || n.providerId || '—')}</span></div>
        ${agent.temperature != null ? `<div class="t3d-kv"><label>Temp</label><span>${esc(agent.temperature)}</span></div>` : ''}
      </div>
      ${this._latencyBlock(s, color)}
      <div class="t3d-sec">
        <div class="t3d-sec-h">Tokens ${approx ? '<span class="t3d-hint">≈ estimated where the provider sent no usage</span>' : ''}</div>
        <div class="t3d-tok">
          <div></div><label>Prompt</label><label>Completion</label><label>Requests</label>
          <div class="t3d-tok-row">Session</div><b>${approx}${fmtNum(u.sess.prompt)}</b><b>${approx}${fmtNum(u.sess.completion)}</b><b>${fmtNum(u.sess.requests)}</b>
          <div class="t3d-tok-row">All time</div><b>${approx}${fmtNum(u.all.prompt)}</b><b>${approx}${fmtNum(u.all.completion)}</b><b>${fmtNum(u.all.requests)}</b>
        </div>
      </div>
      <div class="t3d-sec">
        <div class="t3d-sec-h">Tool calls <span class="t3d-count">${fmtNum(u.tools.calls)}</span><span class="t3d-hint">${fmtNum(u.sessTools.calls)} this session</span></div>
        ${topTools.length ? topTools.map(([k, v]) => `
          <div class="t3d-bar"><span>${esc(k)}</span><i style="width:${Math.max(6, (v / toolMax) * 100).toFixed(0)}%"></i><b>${v}</b></div>`).join('')
          : '<div class="t3d-empty">No tool calls yet</div>'}
      </div>
      ${this._recentBlock(n.id)}
      <div class="t3d-pop-foot"><button class="t3d-link" data-act="report">Full token report →</button></div>`;
  }

  _provider(n, color) {
    const pid = String(n.id).replace(/^provider_/, '');
    const provider = (store.get('providers') || []).find(p => p.id === pid) || {};
    const members = this.ctx.nodes().filter(x => x.type === 'agent' && x.providerId === pid);
    const s = latency.statsFor(members.map(m => m.id));
    let host = '';
    try { host = new URL(provider.endpoint).host; } catch { host = provider.endpoint || ''; }
    let tokens = 0, requests = 0;
    members.forEach(m => {
      const u = agentUsage(m.id, this.ctx.sessionId());
      tokens += u.all.prompt + u.all.completion;
      requests += u.all.requests;
    });
    return `
      <div class="t3d-sec">
        <div class="t3d-kv"><label>Host</label><span>${esc(host || '—')}</span></div>
        <div class="t3d-kv"><label>Models</label><span>${esc((provider.models || []).length || '—')}</span></div>
        <div class="t3d-kv"><label>Tokens</label><span>${fmtNum(tokens)} over ${fmtNum(requests)} requests</span></div>
      </div>
      <div class="t3d-sec">
        <div class="t3d-sec-h">Agents <span class="t3d-count">${members.length}</span></div>
        ${members.map(m => {
          const ms = latency.stats(m.id);
          const shown = ms.avg ?? ms.last;
          return `<div class="t3d-agent-row"><span class="t3d-dot sm" style="--c:${esc(m.color)}"></span>
            <span class="t3d-agent-name" style="color:${esc(m.color)}">${esc(m.label)}</span>
            <span class="t3d-ping ${latencyTier(shown)}">${fmtMs(shown)}</span></div>`;
        }).join('') || '<div class="t3d-empty">No active agents</div>'}
      </div>
      ${this._latencyBlock(s, color)}
      <div class="t3d-pop-foot"><button class="t3d-link" data-act="report">Provider token report →</button></div>`;
  }

  _user() {
    const hist = this.ctx.history();
    const sent = hist.filter(h => h.from === 'user').length;
    const got = hist.filter(h => h.to === 'user').length;
    const agents = this.ctx.nodes().filter(x => x.type === 'agent');
    const working = agents.filter(a => a.status === 'thinking' || a.status === 'active');
    const sid = this.ctx.sessionId();
    const sess = ((store.get('metrics') || {}).sessions || {})[sid] || {};
    let tokens = 0;
    Object.values(sess.agents || {}).forEach(e => { tokens += (e.prompt || 0) + (e.completion || 0); });
    const ids = agents.map(a => a.id);
    const s = latency.statsFor(ids);
    return `
      <div class="t3d-sec">
        <div class="t3d-grid">
          <div><label>Prompts sent</label><b>${sent}</b></div>
          <div><label>Replies</label><b>${got}</b></div>
          <div><label>Agents online</label><b>${agents.length}</b></div>
          <div><label>Working now</label><b>${working.length}</b></div>
          <div><label>Session tokens</label><b>${fmtNum(tokens)}</b></div>
          <div><label>Fleet avg ping</label><b class="${latencyTier(s.avg)}">${fmtMs(s.avg)}</b></div>
        </div>
      </div>
      ${working.length ? `<div class="t3d-sec"><div class="t3d-sec-h">Working</div>${working.map(a =>
        `<div class="t3d-agent-row"><span class="t3d-dot sm" style="--c:${esc(a.color)}"></span><span class="t3d-agent-name" style="color:${esc(a.color)}">${esc(a.label)}</span><span class="t3d-msg-kind">${esc(a.status)}</span></div>`).join('')}</div>` : ''}
      ${this._recentBlock('user')}`;
  }

  _session(n) {
    const conv = (store.get('conversations') || []).find(c => c.id === n.id) || {};
    const msgs = (conv.messages || []).length;
    const linked = (n.agents || []).map(id => this.ctx.nodeById(id)).filter(Boolean);
    return `
      <div class="t3d-sec">
        <div class="t3d-kv"><label>Messages</label><span>${msgs}</span></div>
        <div class="t3d-kv"><label>Updated</label><span>${esc(ago(conv.updatedAt || conv.createdAt) || '—')}</span></div>
        <div class="t3d-kv"><label>State</label><span>${n.status === 'closed' ? 'closed' : 'open'}</span></div>
      </div>
      <div class="t3d-sec"><div class="t3d-sec-h">Agents</div>${linked.map(a =>
        `<div class="t3d-agent-row"><span class="t3d-dot sm" style="--c:${esc(a.color)}"></span><span class="t3d-agent-name" style="color:${esc(a.color)}">${esc(a.label)}</span></div>`).join('') || '<div class="t3d-empty">—</div>'}</div>`;
  }

  /** Keep the card beside its node, inside the container. */
  place(x, y, w, h, nodeRadius = 0) {
    if (!this.isOpen) return;
    const cw = this.el.offsetWidth || 280;
    const ch = this.el.offsetHeight || 300;
    const pad = 10;
    const gap = 18 + Math.min(nodeRadius, 120);
    let left = x + gap;
    if (left + cw > w - pad) left = x - cw - gap;
    if (left < pad) left = Math.max(pad, Math.min(w - cw - pad, x - cw / 2));
    let top = y - ch * 0.3;
    top = Math.max(pad, Math.min(h - ch - pad, top));
    this.el.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  dispose() { clearInterval(this._timer); this.el.remove(); }
}
