/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// TOPOLOGY.JS — SVG network graph
// ============================================

import { store } from '../store.js?v=337';
import { api } from '../api.js?v=337';
import { esc, agentCode } from '../utils.js?v=337';

// How long a hop stays bright while in flight, and how long it then lingers as
// a faint record of the exchange before it fades out and is dropped.
const TRAFFIC_HOLD_MS = 6000;
const RESPONSE_HOLD_MS = 9000;
// Inbound traffic (You → a model) stays lit for as long as the model is
// actually generating. A fixed short window meant the line went quiet while a
// slow model was still working, so the animation "stopped too soon". The
// response/failure event normally demotes it long before this safety cap.
const INBOUND_HOLD_MS = 120000;

/** Past sessions charted around their agent. Beyond this they only add clutter. */
const MAX_CHARTED_SESSIONS = 6;

/** Sum of a "d d" dasharray, so the marching animation starts at a seam. */
function dashTotal(dash) {
  return dash.split(' ').reduce((a, b) => a + (parseFloat(b) || 0), 0);
}

export class TopologyGraph {
  constructor() {
    this.svgEl = null;
    this.containerEl = null;
    this.nodes = [];
    this.edges = [];
    this.positions = new Map();
    this.animationId = null;
    this.particles = [];
    this.flows = [];
    this._flowSeq = 0;
    // MCP: servers we call (out) and friends' clients connected to us (in).
    this._mcpServers = [];
    this._mcpFriends = [];
    this._mcpStatus = [];
    this._mcpEnabled = false;
    this._mcpLog = [];
    this._mcpSeq = -1;
    this._mcpTimer = null;
    this._mcpCfgTimer = null;
  }

  init() {
    this.containerEl = document.getElementById('topologyContainer');
    this.svgEl = document.getElementById('topoSvg');

    // Handle window resize
    window.addEventListener('resize', () => this._updateDimensions());

    // Listen for agent status changes
    store.on('agent:status', (data) => {
      this.updateNodeStatus(data.agentId, data.status);
    });

    // Refresh when agents are added/edited/renamed/recolored
    store.on('agents:changed', () => this.refresh());
    // Refresh when providers toggle (activated set changed)
    store.on('providers:changed', () => this.refresh());
    // Refresh when usage lands (session↔agent association may be new)
    store.on('metrics:changed', () => this.refresh());

    // Listen for topology refresh
    store.on('topology:refresh', () => this.refresh());

    // Traffic belongs to the conversation that caused it — a new session starts
    // with a clean chart rather than last chat's ghost lines.
    store.on('session:changed', () => this._flowClear());

    // Notification bell
    this.notifBell = document.getElementById('notifBell');
    this.notifDropdown = document.getElementById('notifDropdown');
    this.notifBadge = document.getElementById('notifBadge');
    this.notifList = document.getElementById('notifList');
    this.notifClear = document.getElementById('notifClear');
    this._notifications = [];

    if (this.notifBell) {
      this.notifBell.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasHidden = this.notifDropdown.hidden;
        this.notifDropdown.hidden = !wasHidden;
        if (!wasHidden) return;
        // Position dropdown: flip left if it would overflow viewport
        requestAnimationFrame(() => this._positionDropdown());
      });
    }
    if (this.notifClear) {
      this.notifClear.addEventListener('click', () => this._clearNotifications());
    }
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (this.notifDropdown && !this.notifDropdown.hidden &&
          !this.notifDropdown.contains(e.target) &&
          !this.notifBell.contains(e.target)) {
        this.notifDropdown.hidden = true;
      }
    });

    // Listen for notifications
    store.on('topology:notify', (data) => this._addNotification(data));

    // Message-flow overlay: directed conversation lines
    store.on('flow:start', (d) => this._flowAdd({ from: d?.from || 'user', to: d?.to }));
    store.on('flow:delegate', (d) => this._flowAdd({ from: d?.from, to: d?.to, kind: 'delegate' }));
    // Agent-to-agent traffic. `kind` distinguishes a question (answered, so a
    // line comes back the other way) from an order, which is one-way.
    store.on('flow:speak', (d) => this._flowAdd({
      from: d?.from, to: d?.to, kind: d?.kind === 'tell' ? 'tell' : 'agent',
    }));
    store.on('flow:respond', (d) => this._flowRespond(d?.from));
    store.on('flow:fail', (d) => this._flowFadeTo(d?.to));

    // MCP traffic. Outgoing calls are announced by the tool layer; incoming
    // (friends connected to us) are polled from the server's audit log —
    // there is no push channel, so a friend's beam animates on the poll tick.
    store.on('mcp:call', (d) => this._mcpRecord(d));
    store.on('mcp:probe', () => this._probeMcp());
    store.on('mcp:config-changed', () => this._loadMcp());
    this._loadMcp();
    this._mcpTimer = setInterval(() => this._pollMcpActivity(), 2500);
    this._mcpCfgTimer = setInterval(() => this._loadMcp({ quiet: true }), 15000);

    // Initial render
    this.refresh();
  }

  async refresh() {
    // Graph is built locally: only ACTIVATED providers/agents appear.
    // (Backend model catalog is stale seed data — never chart it.)
    this._buildLocalTopology();

    this._calculatePositions();
    this._render();
    this._startAnimations();
  }

  _buildLocalTopology() {
    // Source of truth: local config. Only ACTIVATED providers and agents
    // (agent must be activated AND its provider activated) are charted.
    const agents = store.get('agents') || [];
    const providers = store.get('providers') || [];
    const convs = store.get('conversations') || [];
    const activatedProviders = new Set(providers.filter(p => p.active).map(p => p.id));
    // Guard against duplicate agent records: a duplicated id would render two
    // nodes fighting over one position and one status, which is exactly the
    // confusing state reported after an agent was copied or re-created.
    const seenIds = new Set();
    const chartAgents = agents.filter(a => {
      if (!a.active || !activatedProviders.has(a.provider)) return false;
      if (seenIds.has(a.id)) {
        console.warn('[topology] duplicate agent id ignored:', a.id, a.name);
        return false;
      }
      seenIds.add(a.id);
      return true;
    });
    const activatedIds = new Set(chartAgents.map(a => a.id));

    this.nodes = [{
      id: 'user',
      label: 'You',
      type: 'user',
      status: 'online',
      color: '#ff4757',
    }];
    this.edges = [];

    // Agent nodes (+ static user links; motion comes only from flow events)
    chartAgents.forEach(agent => {
      this.nodes.push({
        id: agent.id,
        label: agent.name,
        type: 'agent',
        status: 'idle',
        color: agent.color,
        role: agent.role,
        code: agentCode(agent),
        model: agent.model,
        providerId: agent.provider,
      });
      this.edges.push({ from: 'user', to: agent.id, type: 'agent', animated: false });
    });

    // Provider nodes: every ACTIVATED provider, even without agents
    providers.forEach(provider => {
      if (!provider.active) return;
      this.nodes.push({
        id: `provider_${provider.id}`,
        label: provider.name,
        type: 'provider',
        status: 'available',
        color: '#00ff88',
      });
    });

    // Session nodes: only those associated with an ACTIVATED agent,
    // clustered around their agent (positions computed later).
    //
    // Capped to the most recent MAX_CHARTED_SESSIONS. Before the v98 history fix
    // the client held no conversation records at all, so nothing here ever
    // rendered; once records existed, every session ever started became a node
    // stacked on its agent's 44px ring, which read as a duplicated icon.
    const chartable = convs
      .filter(c => c && c.id)
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
      .slice(0, MAX_CHARTED_SESSIONS);
    chartable.forEach(conv => {
      const used = conv.agentsUsed || [];
      let linked = used.filter(id => activatedIds.has(id));
      if (linked.length === 0 && activatedIds.size > 0) {
        const hasAgentMsg = (conv.messages || []).some(m => m.role === 'agent');
        if (hasAgentMsg) linked = [...activatedIds].slice(0, 1);
      }
      if (linked.length === 0) return; // not associated → not charted
      this.nodes.push({
        id: conv.id,
        label: conv.title || 'Session',
        type: 'session',
        status: conv.active === false ? 'closed' : 'idle',
        color: conv.active === false ? '#ff4757' : '#7f52ff',
        agents: linked,
      });
      // No session edges: tight orbital clustering shows the association.
    });

    // MCP servers we connect OUT to (amber) and friends' clients connected IN to
    // us (sky). Namespaced ids so they can never collide with an agent.
    (this._mcpServers || []).forEach(s => {
      if (!s || !s.id) return;
      const id = `mcp_${s.id}`;
      if (this.nodes.some(n => n.id === id)) return;
      this.nodes.push({
        id, label: s.id, type: 'mcp', status: 'idle', color: '#f59e0b',
        transport: s.transport || 'stdio',
      });
      this.edges.push({ from: 'user', to: id, type: 'mcp', animated: false });
    });
    const seenFriends = new Set();
    (this._mcpFriends || []).forEach(t => {
      const label = String((t && t.label) || '').trim() || 'friend';
      const id = `mcpclient_${label}`;
      if (seenFriends.has(id)) return;
      seenFriends.add(id);
      this.nodes.push({
        id, label, type: 'mcpclient', status: 'idle', color: '#38bdf8',
        scope: (t && t.scope) || [],
      });
      this.edges.push({ from: 'user', to: id, type: 'mcp', animated: false });
    });

    // Preserve live working states across rebuilds. Any agent at either end of a
    // live line counts as working, so an agent that is mid-conversation with
    // another agent keeps its rings instead of only the one doing the calling.
    const live = new Set(this.flows.filter(f => f.phase === 'active').flatMap(f => [f.from, f.to]));
    this.nodes.forEach(n => {
      if (n.type === 'agent' && live.has(n.id)) n.status = 'active';
    });
  }

  _calculatePositions() {
    const width = this.containerEl?.clientWidth || 280;
    const height = this.containerEl?.clientHeight || 200;
    const centerX = width / 2;
    const centerY = height / 2;
    this.positions.clear();

    // User at top center
    this.positions.set('user', { x: centerX, y: 40 });

    // Router at center
    this.positions.set('router', { x: centerX, y: centerY });

    // Providers in outer circle (positioned FIRST — agents ring around them)
    const providerNodes = this.nodes.filter(n => n.type === 'provider');
    const providerRadius = Math.min(width, height) * 0.42;
    providerNodes.forEach((node, i) => {
      const angle = (i / Math.max(providerNodes.length, 1)) * 2 * Math.PI - Math.PI / 2;
      this.positions.set(node.id, {
        x: centerX + providerRadius * Math.cos(angle),
        y: centerY + providerRadius * Math.sin(angle),
      });
    });

    // Agents ring around their own provider node (provider nebulas)
    const agentNodes = this.nodes.filter(n => n.type === 'agent');
    const byProvider = new Map();
    agentNodes.forEach(node => {
      const pid = node.providerId || '__none';
      if (!byProvider.has(pid)) byProvider.set(pid, []);
      byProvider.get(pid).push(node);
    });
    byProvider.forEach((members, pid) => {
      const pPos = this.positions.get(`provider_${pid}`) || { x: centerX, y: centerY };
      const ringR = 56 + Math.max(0, members.length - 1) * 16;
      members.forEach((node, i) => {
        const angle = (i / Math.max(members.length, 1)) * 2 * Math.PI - Math.PI / 2;
        this.positions.set(node.id, {
          x: pPos.x + ringR * Math.cos(angle),
          y: pPos.y + ringR * Math.sin(angle),
        });
      });
    });

    // Sessions cluster tightly around their first associated agent
    const sessionNodes = this.nodes.filter(n => n.type === 'session');
    const perAgentCount = new Map();
    sessionNodes.forEach((node) => {
      const anchorId = (node.agents || [])[0];
      const anchor = anchorId ? this.positions.get(anchorId) : null;
      if (!anchor) {
        this.positions.set(node.id, { x: centerX, y: centerY });
        return;
      }
      const idx = perAgentCount.get(anchorId) || 0;
      perAgentCount.set(anchorId, idx + 1);
      // Even angular spacing, stepping outwards. The old formula reused angles
      // as the count grew, so sessions landed on top of each other.
      const PER_RING = 5;
      const angle = (idx % PER_RING) * (2 * Math.PI / PER_RING) - Math.PI / 2;
      const radius = 50 + Math.floor(idx / PER_RING) * 30;
      this.positions.set(node.id, {
        x: anchor.x + radius * Math.cos(angle),
        y: anchor.y + radius * Math.sin(angle),
      });
    });

    // MCP nodes ring the outside, spread over the lower arc so they clear the
    // provider nebulas above them.
    const mcpNodes = this.nodes.filter(n => n.type === 'mcp' || n.type === 'mcpclient');
    const mcpRadius = Math.min(width, height) * 0.46;
    mcpNodes.forEach((node, i) => {
      const t = mcpNodes.length === 1 ? 0.5 : i / (mcpNodes.length - 1);
      const angle = Math.PI * (0.15 + t * 0.7);   // 27° … 153°, i.e. the bottom
      this.positions.set(node.id, {
        x: centerX + mcpRadius * Math.cos(angle),
        y: centerY + mcpRadius * Math.sin(angle),
      });
    });

    // Keep every node inside the viewBox (labels extend below agents,
    // orbits wobble sessions): clamp with per-type margins.
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    this.nodes.forEach(node => {
      const p = this.positions.get(node.id);
      if (!p) return;
      const bottomMargin = node.type === 'agent' ? 64 : 34;
      p.x = clamp(p.x, 28, width - 28);
      p.y = clamp(p.y, 44, height - bottomMargin);
    });
  }

  _render() {
    if (!this.svgEl) return;

    const width = this.containerEl?.clientWidth || 280;
    const height = this.containerEl?.clientHeight || 200;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;

    // Per-node soft glow used to be an feGaussianBlur filter on every circle.
    // The circles pulse (animate r / fill-opacity) every frame, so the browser
    // re-ran the blur for every node on every frame -- the single biggest GPU
    // cost in the 2D view. A radial-gradient halo is vector art the compositor
    // rasterises once and just scales, for the same soft glow.
    let glowDefs = '';
    const glowId = (id) => 'glow-' + String(id).replace(/[^a-zA-Z0-9_-]/g, '');
    svg += `<defs></defs>`;

    // Deep-space starfield: seeded, stable motes. Static on purpose -- the old
    // per-star <animate> twinkle (and the drifting motes) forced the compositor
    // to repaint the whole map every frame for movement you can barely see.
    svg += `<g class="topo-starfield">`;
    const moteColors = ['#00e5ff', '#ffffff', '#a855f7', '#00ff88'];
    for (let i = 0; i < 42; i++) {
      const mx = ((i * 197.3) % 1000) / 1000 * width;
      const my = ((i * 311.7) % 1000) / 1000 * height;
      const mr = 0.6 + ((i * 13) % 10) / 10 * 0.9;
      const mc = moteColors[i % moteColors.length];
      svg += `<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="${mr.toFixed(1)}" fill="${mc}" opacity="0.14"/>`;
    }
    svg += `</g>`;

    // Provider nebulas: breathing clouds around each provider + its agents
    const nebGroups = new Map();
    this.nodes.forEach(node => {
      if (node.type === 'agent' && node.providerId) {
        const pid = `provider_${node.providerId}`;
        if (!nebGroups.has(pid)) nebGroups.set(pid, []);
        nebGroups.get(pid).push(node.id);
      }
    });
    nebGroups.forEach((memberIds, pid) => {
      const pts = [pid, ...memberIds]
        .map(id => this.positions.get(id))
        .filter(Boolean);
      if (pts.length === 0) return;
      const xs = pts.map(p => p.x);
      const ys = pts.map(p => p.y);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const rx = (Math.max(...xs) - Math.min(...xs)) / 2 + 34;
      const ry = (Math.max(...ys) - Math.min(...ys)) / 2 + 30;
      const pNode = this.nodes.find(n => n.id === pid);
      const pColor = (pNode && pNode.color) || '#00ff88';
      svg += `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" `
        + `fill="${pColor}" fill-opacity="0.025" stroke="${pColor}" stroke-opacity="0.125" stroke-width="1" stroke-dasharray="3 6" class="topo-nebula">`
        + `<animate attributeName="rx" values="${rx.toFixed(1)};${(rx + 5).toFixed(1)};${rx.toFixed(1)}" dur="6s" repeatCount="indefinite"/>`
        + `<animate attributeName="fill-opacity" values="0.025;0.045;0.025" dur="6s" repeatCount="indefinite"/>`
        + `</ellipse>`;
    });

    // Draw edges
    this.edges.forEach(edge => {
      const from = this.positions.get(edge.from);
      const to = this.positions.get(edge.to);
      if (!from || !to) return;

      const isActive = edge.animated || edge.active;
      const fromNode = this.nodes.find(n => n.id === edge.from);
      const toNode = this.nodes.find(n => n.id === edge.to);
      const endpointWorking = [fromNode, toNode].some(
        n => n && (n.status === 'active' || n.status === 'thinking')
      );
      const showFlow = isActive || endpointWorking;
      const edgeClass = `topo-edge ${showFlow ? 'live' : ''}`;
      const strokeWidth = edge.type === 'control' ? 2 : 1;
      const agentEndpoint = [fromNode, toNode].find(n => n && n.type === 'agent');
      const edgeColor = agentEndpoint?.color || '#2a7f8f';

      svg += `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" class="${edgeClass}" stroke="${edgeColor}" stroke-width="${strokeWidth}"/>`;
    });

    // Draw nodes (label stagger restarts each render for stable layout)
    this._agentLabelIdx = 0;
    this.nodes.forEach(node => {
      const pos = this.positions.get(node.id);
      if (!pos) return;

      const size = this._getNodeSize(node.type);
      const color = node.color || '#00e5ff';
      const isActive = node.status === 'active' || node.status === 'online';
      const isThinking = node.status === 'thinking';
      const isWorking = isActive || isThinking;
      const nodeClass = `topo-node ${isActive ? 'active' : ''} ${isThinking ? 'thinking' : ''}`;

      svg += `<g class="${nodeClass}" data-node-id="${esc(node.id)}">`;

      // Sessions drift in slow orbits around their anchor point
      if (node.type === 'session') {
        const orbitR = 9 + (String(node.id).length % 5);
        const orbitDur = 22 + (String(node.id).length % 11);
        svg += `<animateMotion dur="${orbitDur}s" repeatCount="indefinite" `
          + `path="M${pos.x.toFixed(1)},${pos.y.toFixed(1)} a${orbitR},${orbitR} 0 1,1 0.1,0"/>`;
      }

      // Ripple rings (water-drop effect) for working nodes
      if (isWorking && node.type === 'agent') {
        // Three, not two: an agent that is mid-conversation with another agent
        // is "working" only because it appears in a live flow, and two rings
        // read as decoration rather than as activity.
        [0, 0.8, 1.6].forEach(delay => {
          svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${size}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.7">`
            + `<animate attributeName="r" values="${size};${size + 26}" dur="2.4s" begin="${delay}s" repeatCount="indefinite" />`
            + `<animate attributeName="opacity" values="0.7;0" dur="2.4s" begin="${delay}s" repeatCount="indefinite" />`
            + `</circle>`;
        });
      }

      // Soft halo as a cached radial gradient (cheap) instead of a Gaussian
      // blur filter on an animated circle (re-rasterised every frame).
      const gid = glowId(node.id);
      glowDefs += `<radialGradient id="${gid}">`
        + `<stop offset="0" stop-color="${esc(color)}" stop-opacity="0.55"/>`
        + `<stop offset="0.55" stop-color="${esc(color)}" stop-opacity="0.12"/>`
        + `<stop offset="1" stop-color="${esc(color)}" stop-opacity="0"/>`
        + `</radialGradient>`;
      // Static halo + static core. The old <animate r / fill-opacity> on every
      // node repainted each circle every frame; the breathing is now a single
      // compositor-friendly opacity pulse in CSS (see .topo-node-halo).
      svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${(size * 2.8).toFixed(1)}" fill="url(#${gid})" class="topo-node-halo" pointer-events="none"/>`;
      svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${size}" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="2" class="topo-node-circle"/>`;

      if (node.type === 'agent') {
        // Rich agent label: name (agent color) + role + model + working status.
        // Alternating nudge keeps neighboring labels from colliding.
        const nudge = (this._agentLabelIdx = ((this._agentLabelIdx || 0) + 1) % 2) * 9;
        const ly = pos.y + size + 13 + nudge;
        const statusText = isThinking ? 'Thinking…' : (isActive ? 'Working…' : '');
        svg += `<text x="${pos.x}" y="${ly}" class="topo-node-label" style="font-weight:bold;fill:${color}">${esc(node.label || 'Agent')}</text>`;
        if (node.code) svg += `<text x="${pos.x}" y="${ly + 12}" class="topo-node-label topo-node-sub topo-node-code">${esc(node.code)}</text>`;
        if (node.role) svg += `<text x="${pos.x}" y="${ly + (node.code ? 23 : 12)}" class="topo-node-label topo-node-sub">${esc(node.role)}</text>`;
        if (node.model) {
          const shortModel = node.model.length > 26 ? node.model.slice(0, 25) + '…' : node.model;
          svg += `<text x="${pos.x}" y="${ly + 23}" class="topo-node-label topo-node-sub topo-node-model">${esc(shortModel)}<title>${esc(node.model)}</title></text>`;
        }
        if (statusText) svg += `<text x="${pos.x}" y="${ly + 35}" class="topo-node-label topo-node-status" style="fill:${color}">● ${statusText}</text>`;
        // Tool calls and tokens, side by side: what it did, and what it cost.
        // Shown whenever there is anything to show, not only while working --
        // a finished agent still has a tally worth reading.
        const tokTotal = this._agentTokenTotal(node.id);
        const toolStats = this._agentToolTotal(node.id);
        const metrics = [];
        if (toolStats.calls) metrics.push(`⚙ ${toolStats.calls}`);
        if (tokTotal) metrics.push(`⬡ ${this._fmtTokens(tokTotal)}`);
        if (metrics.length) {
          const top = this._agentToolTotal(node.id).top || '';
          svg += `<text x="${pos.x}" y="${ly + (statusText ? 46 : 35)}" `
            + `class="topo-node-label topo-node-tokens" style="fill:${color}">`
            + `${esc(metrics.join('  ·  '))}`
            + (top ? `<title>${esc(toolStats.calls)} tool calls this session${top ? ', most used: ' + esc(top) : ''}</title>` : '')
            + `</text>`;
        }
      } else {
        svg += `<text x="${pos.x}" y="${pos.y + size + 14}" class="topo-node-label">${esc(node.label)}</text>`;
      }
      svg += `</g>`;
    });

    svg += '<g id="flowOverlay"></g>';
    // Gradients collected while drawing the nodes. <defs> may sit anywhere in
    // an SVG, so appending here keeps the node loop free of forward references.
    if (glowDefs) svg += `<defs>${glowDefs}</defs>`;
    svg += '</svg>';
    this.svgEl.innerHTML = svg;

    // Add click handlers: agents + providers open their usage metrics
    this.svgEl.querySelectorAll('.topo-node').forEach(el => {
      el.addEventListener('click', () => {
        const nodeId = el.dataset.nodeId;
        const node = this.nodes.find(n => n.id === nodeId);
        if (!node) return;
        if (node.type === 'agent') {
          store.emit('metrics:showAgent', nodeId);
        } else if (node.type === 'provider') {
          store.emit('metrics:showProvider', nodeId);
        } else if (node.type === 'model') {
          // Its own figures, not the provider's. This used to forward to
          // metrics:showProvider, so every model on a provider displayed the
          // same provider-wide totals.
          store.emit('metrics:showModel', {
            provider: node.provider,
            model: node.model || node.label || node.name || nodeId,
          });
        }
      });
      // Hover focus: dim everything not connected to this node
      el.addEventListener('mouseenter', () => this._focusNode(el.dataset.nodeId, true));
      el.addEventListener('mouseleave', () => this._focusNode(el.dataset.nodeId, false));
    });

    this._renderFlows();
  }

  _focusNode(nodeId, on) {
    if (!this.svgEl) return;
    if (!on) {
      this.svgEl.querySelectorAll('.topo-dim').forEach(el => el.classList.remove('topo-dim'));
      return;
    }
    const keep = new Set([nodeId, 'user']);
    this.edges.forEach(e => {
      if (e.from === nodeId) keep.add(e.to);
      if (e.to === nodeId) keep.add(e.from);
    });
    // Flows count as connections too
    (this.flows || []).forEach(f => {
      if (f.from === nodeId) keep.add(f.to);
      if (f.to === nodeId) keep.add(f.from);
    });
    this.svgEl.querySelectorAll('.topo-node').forEach(el => {
      el.classList.toggle('topo-dim', !keep.has(el.dataset.nodeId));
    });
    this.svgEl.querySelectorAll('.topo-edge').forEach((el, i) => {
      const e = this.edges[i];
      el.classList.toggle('topo-dim', !(e && keep.has(e.from) && keep.has(e.to)));
    });
  }

  _flowColor(id) {
    if (id === 'user') {
      const user = this.nodes.find(n => n.id === 'user');
      return (user && user.color) || '#ff4757';
    }
    const node = this.nodes.find(n => n.id === id);
    return (node && node.color) || '#00e5ff';
  }

  _flowAdd({ from, to, kind, holdMs } = {}) {
    if (!from || !to) return;
    // A repeated hop on a pair we already recorded just refreshes that line
    // instead of stacking a duplicate on top of it.
    const existing = this.flows.find(
      f => f.from === from && f.to === to && f.kind === (kind || 'message'));
    if (existing) {
      existing.phase = 'active';
      existing.stamp = Date.now();
      if (holdMs) existing.holdMs = holdMs;
      clearTimeout(existing._timer);
      this._renderFlows();
      this._scheduleSettle(existing);
      return existing;
    }
    const flow = { id: ++this._flowSeq, from, to, kind: kind || 'message',
      phase: 'active', stamp: Date.now() };
    // A request aimed at a model holds until that model answers (or the safety
    // cap trips), so the dots keep flowing for the whole request rather than
    // only 6s. One-way agent-to-agent messages keep the short default.
    const requestKind = !kind || kind === 'message' || kind === 'delegate';
    if (!holdMs && requestKind && this.nodes.some(n => n.id === to && n.type === 'agent')) {
      holdMs = INBOUND_HOLD_MS;
    }
    if (holdMs) flow.holdMs = holdMs;
    this.flows.push(flow);
    // Traffic lines linger, so the ring buffer has to be roomier than before.
    while (this.flows.length > 24) this.flows.shift();
    this._renderFlows();
    this._scheduleSettle(flow);
    return flow;
  }

  /**
   * Hold a line bright while it is in flight, then demote it to a faint
   * "this happened" record, then drop it. Demoting rather than deleting is the
   * whole point: you can read back who spoke to whom.
   */
  _scheduleSettle(flow) {
    clearTimeout(flow._timer);
    flow._timer = setTimeout(() => {
      if (this.flows.indexOf(flow) === -1 || flow.phase !== 'active') return;
      flow.phase = 'traffic';
      this._renderFlows();
      this._settleRecord(flow);
    }, flow.holdMs || TRAFFIC_HOLD_MS);
  }

  /** From the settled "traffic" phase: linger, fade, drop. */
  _settleRecord(flow) {
    clearTimeout(flow._timer);
    flow._timer = setTimeout(() => {
      // A line refreshed back to 'active' must not be faded by a timer left
      // over from its previous life.
      if (this.flows.indexOf(flow) === -1 || flow.phase !== 'traffic') return;
      flow.phase = 'fading';
      this._renderFlows();
      setTimeout(() => {
        if (flow.phase !== 'fading') return;
        this.flows = this.flows.filter(f => f !== flow);
        this._renderFlows();
      }, 1000);
    }, TRAFFIC_HOLD_MS);
  }

  /** Wipe the traffic record — used when the topology is reset. */
  _flowClear() {
    this.flows.forEach(f => clearTimeout(f._timer));
    this.flows = [];
    this._renderFlows();
  }

  // ==================== MCP (servers out / friends in) ====================

  /** Fetch the MCP server + friend list (cheap) and chart them. */
  async _loadMcp() {
    try {
      const [srv, cfg] = await Promise.all([
        api.mcpServers().catch(() => ({ servers: [] })),
        api.mcpServerConfig().catch(() => ({ tokens: [] })),
      ]);
      this._mcpServers = (srv && srv.servers) || [];
      this._mcpFriends = (cfg && Array.isArray(cfg.tokens)) ? cfg.tokens : [];
      this._mcpEnabled = !!(cfg && cfg.enabled);
      this.refresh();
    } catch { /* keep the last known set */ }
  }

  /** Reachability + tool count per server. Probes them, so call it on demand. */
  async _probeMcp() {
    try {
      const res = await api.mcpStatus();
      this._mcpStatus = (res && res.status) || [];
      this._mcpNotify();
    } catch { /* leave the last known status */ }
    return this._mcpStatus;
  }

  _mcpStatusFor(id) { return (this._mcpStatus || []).find(s => s.id === id) || null; }

  /** Record a call — outgoing (tool layer) or incoming (activity poll). */
  _mcpRecord(entry) {
    if (!entry) return;
    this._mcpLog.push(entry);
    while (this._mcpLog.length > 60) this._mcpLog.shift();
    this._mcpNotify();
  }

  /** Nudge the 3D card to repaint; harmless when it is not showing. */
  _mcpNotify() {
    try { this.popup?.refresh?.(); } catch { /* card is optional */ }
  }

  /**
   * Poll the server's audit log for friend activity and turn any new lines into
   * topology traffic. The FIRST poll only records a baseline, so a reload does
   * not replay old calls as animations.
   */
  async _pollMcpActivity() {
    let res;
    try { res = await api.mcpActivity(); } catch { return; }
    const entries = (res && res.entries) || [];
    if (!entries.length) return;
    const maxSeq = entries[entries.length - 1].seq;
    if (this._mcpSeq < 0) { this._mcpSeq = maxSeq; return; }
    if (maxSeq <= this._mcpSeq) return;
    entries.forEach(e => {
      if (e.seq <= this._mcpSeq) return;
      const id = `mcpclient_${e.mcp || 'friend'}`;
      if (this._mcpEnabled && this.nodes.some(n => n.id === id)) {
        // Ask + answer: a line in from the friend, and one back.
        store.emit('flow:speak', { from: id, to: 'user' });
        store.emit('flow:speak', { from: 'user', to: id });
      }
      this._mcpRecord({ direction: 'in', ...e });
    });
    this._mcpSeq = maxSeq;
  }

  // ==================== NOTIFICATIONS ====================
  /**
   * Add a notification to the bell dropdown.
   * @param {Object} data - { agentId, agentName, agentColor, type, message, timestamp }
   * type: 'error' | 'warning' | 'info' | 'success'
   */
  _addNotification(data) {
    const notif = {
      id: 'n' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
      agentId: data.agentId || null,
      agentName: data.agentName || 'System',
      agentColor: data.agentColor || '#00e5ff',
      type: data.type || 'info',
      message: data.message || '',
      timestamp: data.timestamp || Date.now(),
    };
    this._notifications.unshift(notif);
    if (this._notifications.length > 100) this._notifications = this._notifications.slice(0, 100);
    this._renderNotifications();
  }

  _renderNotifications() {
    if (!this.notifList || !this.notifBadge) return;
    const count = this._notifications.length;
    this.notifBadge.textContent = count > 99 ? '99+' : count;
    this.notifBadge.hidden = count === 0;

    this.notifList.innerHTML = this._notifications.map(n => `
      <div class="notif-item ${n.type}">
        <div class="notif-row">
          <div class="notif-agent">
            <span class="notif-agent-dot" style="background:${n.agentColor}"></span>
            ${esc(n.agentName)}
          </div>
          <span class="notif-time">${new Date(n.timestamp).toLocaleTimeString()}</span>
        </div>
        <div class="notif-message">${esc(n.message)}</div>
      </div>
    `).join('') || '<div class="notif-empty">No notifications</div>';
  }

  _clearNotifications() {
    this._notifications = [];
    this._renderNotifications();
  }

  /**
   * Position the dropdown so it never overflows the viewport.
   * Called after opening the dropdown.
   */
  _positionDropdown() {
    if (!this.notifDropdown || this.notifDropdown.hidden) return;

    // On mobile (≤1024px), CSS handles positioning via fixed layout
    if (window.innerWidth <= 1024) return;

    // On desktop: position dropdown relative to the bell button
    // since dropdown is now a direct child of .app (viewport-fixed parent)
    const bellRect = this.notifBell.getBoundingClientRect();
    const dropdownRect = this.notifDropdown.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Position dropdown below the bell, aligned to its right edge
    const top = bellRect.bottom + 6;
    const right = viewportWidth - bellRect.right;

    this.notifDropdown.style.top = `${top}px`;
    this.notifDropdown.style.right = `${right}px`;
    this.notifDropdown.style.left = 'auto';
    this.notifDropdown.style.bottom = 'auto';

    // Check if dropdown would extend past left edge of viewport
    const dropdownLeft = bellRect.right - dropdownRect.width;
    const needsFlip = dropdownLeft < 8; // 8px margin from viewport edge

    this.notifDropdown.classList.toggle('flip-left', needsFlip);
    if (needsFlip) {
      this.notifDropdown.style.left = `${Math.max(8, bellRect.left - dropdownRect.width + bellRect.width)}px`;
      this.notifDropdown.style.right = 'auto';
    }
  }

  _flowRespond(agentId) {
    if (!agentId) return;
    // Fade the inbound prompt + delegation lines into this agent...
    this._flowFadeTo(agentId);
    // ...while the reply line flows back toward the user. The reply is the
    // payload; let it sit bright a moment longer than an inbound hop so you can
    // actually see the answer travel.
    this._flowAdd({ from: agentId, to: 'user', kind: 'response', holdMs: RESPONSE_HOLD_MS });
  }

  _flowFadeTo(agentId) {
    if (!agentId) return;
    let touched = false;
    this.flows.forEach(f => {
      // Only demote lines that are still in flight — a line that has already
      // become a traffic record should keep its history.
      if (f.to === agentId && f.phase === 'active') {
        f.phase = 'traffic';
        this._settleRecord(f);
        touched = true;
      }
    });
    if (touched) this._renderFlows();
  }

  _renderFlows() {
    const g = this.svgEl?.querySelector('#flowOverlay');
    if (!g) return;
    let defs = '';
    let lines = '';
    this.flows.forEach(f => {
      const a = this.positions.get(f.from);
      const b = this.positions.get(f.to);
      if (!a || !b) return;
      const fromNode = this.nodes.find(n => n.id === f.from);
      const toNode = this.nodes.find(n => n.id === f.to);
      const cFrom = this._flowColor(f.from);
      const cTo = this._flowColor(f.to);
      // Trim ends so the arrow lands outside the node circles
      const sFrom = this._getNodeSize(fromNode?.type) + 6;
      const sTo = this._getNodeSize(toNode?.type) + 8;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const x1 = a.x + (dx / len) * sFrom;
      const y1 = a.y + (dy / len) * sFrom;
      const x2 = b.x - (dx / len) * sTo;
      const y2 = b.y - (dy / len) * sTo;
      const isDelegate = f.kind === 'delegate';
      const isAgent = f.kind === 'agent' || f.kind === 'tell';
      const isTraffic = f.phase === 'traffic';

      // Every line that carries traffic between the user and a model is painted
      // in the model's own color (the one the operator picked), whichever way
      // the traffic flows. Only agent-to-agent hops blend sender into receiver.
      const modelNode = [fromNode, toNode].find(n => n && n.type === 'agent');
      const talksToUser = (fromNode?.type === 'user') !== (toNode?.type === 'user');
      const solidModel = talksToUser && modelNode;
      const useGradient = !solidModel && (isDelegate || isAgent);
      const baseColor = solidModel ? modelNode.color : cFrom;

      // Active hops are solid and animated; the settled record is thin and dim
      // so it reads as history rather than live traffic.
      //
      // Everything live is drawn at the same weight. Coordinator dispatch used
      // to be the odd one out (thinner, dimmer) even though a busy admin
      // fanning work out to eight agents is the single busiest thing on the
      // chart -- it only looked quiet because those lines were styled down.
      // Weight and brightness are now uniform; the dash pattern still
      // distinguishes who is talking to whom.
      const width = isTraffic ? 1 : 2.6;
      const dash = isTraffic ? '1 6' : (isDelegate ? '2 6' : (isAgent ? '9 6' : '6 7'));
      const opacity = isTraffic ? 0.34 : 1;

      if (useGradient) {
        const gid = `fg-${f.id}`;
        defs += `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">`
          + `<stop offset="0" stop-color="${cFrom}"/><stop offset="1" stop-color="${cTo}"/></linearGradient>`;
      }
      const stroke = useGradient ? `url(#fg-${f.id})` : baseColor;
      const mid = `fm-${f.id}`;
      // Settled arrows shrink so the live ones stay legible on top.
      const markerSize = isTraffic ? 5 : 8;
      defs += `<marker id="${mid}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="${markerSize}" markerHeight="${markerSize}" orient="auto-start-reverse">`
        + `<path d="M0,0 L10,5 L0,10 z" fill="${useGradient ? cTo : baseColor}"/></marker>`;

      // Marching dashes travelling FROM the sender TOWARD the receiver are what
      // make the direction readable at a glance -- a plain line with an
      // arrowhead is easy to misread when several cross. They run for the whole
      // life of the line (active AND the settled record); only the final fade
      // stops the motion, and it animates opacity instead.
      let extra = '';
      if (f.phase === 'fading') {
        extra = `<animate attributeName="opacity" values="${opacity};0" dur="1s" fill="freeze"/>`;
      } else {
        const dur = isTraffic ? '1.6s' : (isAgent ? '1.1s' : (isDelegate ? '1.4s' : '0.9s'));
        extra = `<animate attributeName="stroke-dashoffset" from="${dashTotal(dash)}" to="0" `
          + `dur="${dur}" repeatCount="indefinite"/>`;
      }
      lines += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" `
        + `class="flow-line" stroke="${stroke}" stroke-width="${width}" stroke-dasharray="${dash}" `
        + `stroke-linecap="round" opacity="${opacity}" marker-end="url(#${mid})">${extra}</line>`;
    });
    g.innerHTML = (defs ? `<defs>${defs}</defs>` : '') + lines;
  }

  _agentTokenTotal(agentId) {
    const metrics = store.get('metrics');
    const sessions = (metrics && metrics.sessions) || {};
    let total = 0;
    Object.values(sessions).forEach(sess => {
      const e = sess && sess.agents && sess.agents[agentId];
      if (e) total += (e.prompt || 0) + (e.completion || 0);
    });
    return total;
  }

  /** Tool calls this agent has made, and the one it leans on most. */
  _agentToolTotal(agentId) {
    const metrics = store.get('metrics');
    const sessions = (metrics && metrics.sessions) || {};
    let calls = 0;
    const byTool = {};
    Object.values(sessions).forEach(sess => {
      const e = sess && sess.tools && sess.tools[agentId];
      if (!e) return;
      calls += e.calls || 0;
      Object.entries(e.byTool || {}).forEach(([k, v]) => { byTool[k] = (byTool[k] || 0) + v; });
    });
    let top = '';
    let topN = 0;
    Object.entries(byTool).forEach(([k, v]) => { if (v > topN) { top = k; topN = v; } });
    return { calls, top, topN };
  }

  _fmtTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M tok';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k tok';
    return n + ' tok';
  }

  _getNodeSize(type) {
    const sizes = { user: 18, router: 14, agent: 12, provider: 10, session: 8, mcp: 10, mcpclient: 10 };
    return sizes[type] || 10;
  }

  _startAnimations() {
    // CSS animations handle most of the visual effects
    // This method can be extended for JS-based animations
  }

  _updateDimensions() {
    this._calculatePositions();
    this._render();
  }

  updateNodeStatus(agentId, status) {
    const node = this.nodes.find(n => n.id === agentId);
    if (node) {
      node.status = status;
      this._render();
    }
  }

  destroy() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    if (this._mcpTimer) clearInterval(this._mcpTimer);
    if (this._mcpCfgTimer) clearInterval(this._mcpCfgTimer);
  }
}

export default TopologyGraph;
