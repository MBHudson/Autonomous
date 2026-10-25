/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// APP.JS — Bootstrap & wiring only
// ============================================

import { store, APP_VERSION } from './store.js?v=330';
import { K } from './storage.js?v=330';
import { persistence, DEFAULT_AGENTS, DEFAULT_PROVIDERS } from './persistence.js?v=330';
import { startStateSync } from './stateSync.js?v=330';
import { api } from './api.js?v=330';
import { themeManager } from './themes.js?v=330';
import { Sidebar } from './components/sidebar.js?v=330';
import { Chat } from './components/chat.js?v=330';
import { TopologyGraph } from './components/topology.js?v=330';
import { initTopoPanel } from './components/topoPanel.js?v=330';

/**
 * The 3D topology pulls in three.js (~700KB) through the import map. Loaded
 * dynamically so a missing vendor file, an old browser without import maps,
 * or the legacy page (no import map at all) degrades to the 2D chart instead
 * of taking the whole app down with a failed static import.
 */
function loadTopology3D() {
  return import('./components/topology3d/index.js?v=330')
    .then(m => m.Topology3D)
    .catch(err => {
      console.warn('[topology] 3D view unavailable, using the 2D chart:', err);
      return null;
    });
}
import { RoutingChart } from './components/routingChart.js?v=330';
import { AgentEditor } from './components/agentEditor.js?v=330';
import { ProviderEditor } from './components/providerEditor.js?v=330';
import { Microphone } from './components/microphone.js?v=330';
import { ConfigPanel } from './components/configPanel.js?v=330';
import { ExportPanel } from './components/export.js?v=330';
import { ThinkingPanel } from './components/thinkingPanel.js?v=330';
import { TerminalPanel } from './components/terminalPanel.js?v=330';
import { MetricsPanel } from './components/metricsPanel.js?v=330';
import { TracePanel } from './components/tracePanel.js?v=330';
import { preloadAvatars, wireAvatarThinking } from './components/avatar.js?v=330';
import { bindMemoryTools, bindSandboxTools, initCustomTools } from './tools.js?v=330';
import { initApprovals } from './approvals.js?v=330';
import * as memory from './memory.js?v=330';
import { audio } from './audio.js?v=330';
import { AlwaysOn } from './alwaysOn.js?v=330';
import { ApiLab } from './apiLab.js?v=330';
import { BrainLab } from './brainlab.js?v=330';
import { BrowserView } from './components/browserView.js?v=330';


document.addEventListener('DOMContentLoaded', async () => {
  // Tell the inline watchdog in index.html that boot actually got going. A
  // half-copied folder otherwise looks exactly like a working one: the shell
  // renders, the tabs are inert, the console is empty, and nothing says why.
  window.__appBooted = true;
  // Start fetching three.js now; it is awaited just before the topology is
  // built, so the download overlaps the state sync below.
  const topology3dReady = loadTopology3D();
  // On-screen boot errors: if anything throws during startup, show it
  // instead of leaving a dead page.
  const bootErrors = [];
  window.addEventListener('error', (e) => {
    bootErrors.push(e.message);
    showBootError();
  });
  window.addEventListener('unhandledrejection', (e) => {
    bootErrors.push('Async: ' + (e.reason?.message || e.reason));
    showBootError();
  });
  function showBootError() {
    let box = document.getElementById('bootError');
    if (!box) {
      box = document.createElement('div');
      box.id = 'bootError';
      box.style.cssText = 'position:fixed;bottom:10px;left:10px;right:10px;z-index:99999;background:#300;color:#fdd;padding:10px;font-size:11px;border:1px solid red;border-radius:6px;white-space:pre-wrap';
      document.body.appendChild(box);
    }
    box.textContent = 'BOOT ERROR:\n' + bootErrors.join('\n');
  }

  function safeInit(name, fn) {
    try {
      fn();
    } catch (err) {
      console.error(`Init failed [${name}]:`, err);
      bootErrors.push(`[${name}] ${err.message}`);
      showBootError();
    }
  }

  // Keep the header badge in step with store.APP_VERSION, which is the single
  // source of truth for the version number.
  const badge = document.getElementById('appVersion');
  if (badge) badge.textContent = 'v' + APP_VERSION;

  // ?debug=1: on-screen diagnostics for phones, which have no console. Shows
  // the path (which copy is actually open), versions, store counts, whether a
  // token is stored (never the value), and the last toast. Read it out when
  // reporting a bug -- it ends "it works on desktop" mysteries in one glance.
  try {
    if (new URLSearchParams(location.search).get('debug') === '1') initDebugOverlay();
  } catch { /* diagnostics must never break boot */ }
  function initDebugOverlay() {
    const box = document.createElement('div');
    box.id = 'debugOverlay';
    box.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:70000;'
      + 'background:rgba(0,0,0,0.92);color:#7dff9a;border-top:1px solid #0f0;'
      + 'font:10px/1.5 monospace;padding:6px 8px;white-space:pre-wrap;'
      + 'max-height:38vh;overflow-y:auto;';
    let lastNote = 'none yet';
    try {
      store.on('toast', (m) => {
        lastNote = `${m?.type || 'info'}: ${String(m?.message || '').slice(0, 110)}`;
      });
    } catch { /* ignore */ }
    const render = () => {
      let lsKeys = '?';
      try {
        lsKeys = String(Object.keys(localStorage).filter(k => k.includes('::')).length);
      } catch { /* ignore */ }
      const counts = ['agents', 'providers', 'conversations', 'pipelines']
        .map(k => `${k}:${((store.get(k) || []).length)}`).join(' ');
      // Cache-vs-store-vs-builtins: tells whether the loader produced empties
      // (cache matches store at 0) or something wiped the store afterwards
      // (cache full, store empty) or the built-ins themselves are gone.
      let cacheCounts = '?', defCounts = '?';
      try {
        cacheCounts = `${(persistence.get('agents') || []).length}/${(persistence.get('providers') || []).length}`;
        defCounts = `${DEFAULT_AGENTS.length}/${DEFAULT_PROVIDERS.length}`;
      } catch { /* ignore */ }
      const tok = store.get('settings.routerToken') ? 'token=yes' : 'token=EMPTY';
      box.textContent = `path:${location.pathname} v${APP_VERSION} | store ${counts} | cache ${cacheCounts} | def ${defCounts} | ${tok} | ls:${lsKeys} | last: ${lastNote}`;
    };
    setInterval(render, 2000);
    render();
    document.body.appendChild(box);
  }

  // Honor "no splash" BEFORE anything network-bound runs. The awaited state
  // sync below can take seconds on a phone, during which the static loader
  // HTML sits visible no matter what the setting says -- so "loading screen
  // off" visibly did nothing on exactly the device that needs it most. The
  // store is already hydrated from localStorage at import time, so this read
  // costs nothing and waits for nothing.
  try {
    // Off unless explicitly set to a positive duration (default is off).
    if (!(Number(store.get('settings.loadingScreenMs')) > 0)) {
      document.body.classList.add('app-loaded');
    }
  } catch { /* loader stays; the timed hide at the end still runs */ }

  // Memory tools need memory.js; bind before any agent can be called, or an
  // agent that asks to `remember` would get a silent no-op.
  bindMemoryTools(memory);

  // Same for the server-backed tools (search, fetch, filesystem). Bound up
  // front so an agent never sees "not bound yet" for a tool you enabled.
  safeInit('sandboxTools', () => bindSandboxTools(api));

  // Adopt this copy's saved agents/providers/settings from the server BEFORE
  // anything renders, so the sidebar, header and agent editor all read the
  // shared values instead of this browser's own copy. Deliberately awaited:
  // without the wait the panels paint from localStorage first and then visibly
  // change, which looks like the app resetting itself. Never rejects -- a
  // failed sync just leaves the browser running on its local copy.
  try {
    await startStateSync();
  } catch (err) {
    console.warn('State sync unavailable; using this browser\'s saved copy.', err);
  }

  safeInit('customTools', () => initCustomTools());

  // Initialize components
  const sidebar = new Sidebar();
  // The API Lab: one drawer for both converter directions plus a real request
  // runner. Created before the sidebar renders so the button in the Agents-tab
  // header has something to open on the very first paint.
  const apiLab = new ApiLab();
  sidebar.apiLab = apiLab;
  const brainLab = new BrainLab();
  sidebar.brainLab = brainLab;
  brainLab.apiLab = apiLab;
  window.__bl = brainLab;
  window.__apiLab = apiLab;
  const chat = new Chat();
  const Topology3D = await topology3dReady;
  let topology;
  try {
    topology = Topology3D ? new Topology3D() : new TopologyGraph();
  } catch (err) {
    console.warn('[topology] 3D constructor failed, using the 2D chart:', err);
    topology = new TopologyGraph();
  }
  if (!(Topology3D && topology instanceof Topology3D)) {
    // 2D only: the view switch has nothing to switch to.
    const modeBtn = document.getElementById('topoModeBtn');
    if (modeBtn) { modeBtn.disabled = true; modeBtn.textContent = '2D'; modeBtn.title = '3D view unavailable in this browser'; }
  }
  window.__topology = topology;
  const agentEditor = new AgentEditor();
  const providerEditor = new ProviderEditor();
  const microphone = new Microphone();
  const configPanel = new ConfigPanel();
  const exportPanel = new ExportPanel();
  const thinkingPanel = new ThinkingPanel();
  const terminalPanel = new TerminalPanel();
  const browserView = new BrowserView();
  const metricsPanel = new MetricsPanel();
  const tracePanel = new TracePanel();


  // Init all (each isolated so one failure can't kill the rest)
  safeInit('sidebar', () => sidebar.init());
  safeInit('apiLab', () => apiLab.init());
  safeInit('brainLab', () => brainLab.init());
  safeInit('chat', () => chat.init());
  // Server-side command approvals, surfaced wherever the operator is looking.
  // Isolated like the rest: if the watcher fails, approvals still work from
  // the Config tab's own buttons.
  safeInit('approvals', () => initApprovals());

  // Once, loudly, when the token is missing or wrong.
  let tokenWarned = false;
  store.on('token:required', () => {
    // Un-hide on EVERY 401, not just the first: the banner is the only
    // symptom a phone user can see, and it must never lie about the present.
    document.getElementById('apiLockedBanner')?.removeAttribute('hidden');
    if (tokenWarned) return;
    tokenWarned = true;
    store.emit('toast', {
      message: 'Access token missing or wrong - paste it into Config to continue',
      type: 'error',
    });
    // Leave the toast up rather than let it vanish unread.
    setTimeout(() => { tokenWarned = false; }, 30000);
  });
  // The banner taps through to where the token lives.
  document.getElementById('apiLockedBanner')?.addEventListener('click', () => {
    document.getElementById('rightPanel')?.classList.remove('open');
    document.getElementById('sidebar')?.classList.add('open');
    document.querySelector('.sidebar-nav [data-tab="config"]')?.click();
  });
  safeInit('audio', () => audio.init());
  safeInit('alwaysOn', () => {
    const alwaysOn = new AlwaysOn(chat);
    alwaysOn.init();
    window.__alwaysOn = alwaysOn;   // reachable from the console for stopping it
    // Back-reference so the chat can tell the scheduler that a user turn just
    // ended. The scheduler already holds `chat`; without this link the grace
    // window after a user turn had nothing to measure against.
    chat.alwaysOn = alwaysOn;

    // --- Ask an agent directly (feature B) ---
    let askingAgentId = null;
    const modal = document.getElementById('askModal');
    const input = document.getElementById('askModalInput');
    const title = document.getElementById('askModalTitle');
    const closeModal = () => {
      modal?.classList.remove('open');
      askingAgentId = null;
    };
    store.on('agent:ask', (agentId) => {
      const agent = (store.get('agents') || []).find(a => a.id === agentId);
      if (!agent || !modal) return;
      askingAgentId = agentId;
      if (title) title.textContent = `Ask ${agent.name}`;
      if (input) { input.value = ''; input.focus(); }
      modal.classList.add('open');
    });
    document.getElementById('askModalClose')?.addEventListener('click', closeModal);
    document.getElementById('askModalCancel')?.addEventListener('click', closeModal);
    modal?.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    document.getElementById('askModalSend')?.addEventListener('click', async () => {
      const q = input ? input.value : '';
      const id = askingAgentId;
      closeModal();
      if (id && q.trim()) {
        // Asked from a routing-chart node: the drawer stays open, and the
        // question is mirrored into its run log now; the answer follows via
        // the drawer's chat:reply mirror when it lands in the transcript.
        if (window.__rc?.open) { try { window.__rc.logAsk(id, q.trim()); } catch { /* log-only */ } }
        await chat.askAgentDirectly(id, q);
      }
    });
    // Enter sends, Shift+Enter is a newline — same as the main input.
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        document.getElementById('askModalSend')?.click();
      }
    });
  });
  // --- Inline ASK from the topology's node card (feature C) ---
  // Wired in its own block so it still works if always-on failed to start. The
  // topology asks through the store rather than holding a chat reference; the
  // answer comes back the same way and is painted in the graph's floating box.
  // askAgentInline keeps it out of the transcript while still emitting the flow
  // events that animate the map.
  safeInit('askInline', () => {
    store.on('agent:ask-inline', async ({ agentId, question } = {}) => {
      if (!agentId) return;
      const res = await chat.askAgentInline(agentId, question);
      store.emit('agent:ask-inline:reply', { agentId, ...(res || {}) });
    });
  });
  safeInit('topoPanel', () => initTopoPanel());
  safeInit('topology', () => topology.init());
  // The routing chart is the editable counterpart to the topology graph, and it
  // needs the Chat instance because every node runs through chat._callAgent --
  // that is deliberate, so per-agent endpoint and key overrides are inherited
  // rather than reimplemented here.
  const routingChart = new RoutingChart(chat);
  safeInit('routingChart', () => routingChart.init());
  // Exposed for the probe harness in chart-probe.mjs, which drives the real UI
  // to check the canvas actually works rather than inferring it from the code.
  window.__rc = routingChart;
  // The apps notch under the header is the one home for Brain Lab, API Lab and
  // the Routing Chart. Bound here because app.js owns all three instances. The
  // menu closes on an outside click, on Esc, and when any item is chosen.
  const appsTab = document.getElementById('appsTab');
  const appsMenu = document.getElementById('appsMenu');
  const closeApps = () => {
    if (appsMenu) appsMenu.hidden = true;
    appsTab?.setAttribute('aria-expanded', 'false');
  };
  appsTab?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!appsMenu) return;
    const willShow = appsMenu.hidden;
    appsMenu.hidden = !willShow;
    appsTab.setAttribute('aria-expanded', String(willShow));
  });
  document.addEventListener('click', (e) => {
    if (!appsMenu || appsMenu.hidden) return;
    if (appsMenu.contains(e.target) || appsTab?.contains(e.target)) return;
    closeApps();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeApps(); });
  const openApp = (id, fn) => document.getElementById(id)?.addEventListener('click', () => { closeApps(); fn(); });
  openApp('appsBrainLab', () => brainLab.toggle());
  // Main-screen API Lab: apiLab.show() opens it full-window (see show()).
  openApp('appsApiLab', () => apiLab.toggle());
  openApp('appsRouting', () => routingChart.toggle());
  openApp('appsBrowser', () => browserView.toggle());
  safeInit('agentEditor', () => agentEditor.init());
  safeInit('providerEditor', () => providerEditor.init());
  safeInit('microphone', () => microphone.init());
  safeInit('configPanel', () => configPanel.init());
  safeInit('exportPanel', () => exportPanel.init());
  safeInit('thinkingPanel', () => thinkingPanel.init());
  safeInit('browserView', () => browserView.init());
  safeInit('terminalPanel', () => terminalPanel.init());
  safeInit('metricsPanel', () => metricsPanel.init());
  safeInit('tracePanel', () => tracePanel.init());

  // Robot eyes animate only while their agent is working
  safeInit('avatars', () => { preloadAvatars(); wireAvatarThinking(); });


  // Wire up header buttons
  // These two panels have persisted show/hide preferences that nothing read.
  // Honour them on load, then let the header buttons still work.
  const showThinking = store.get('settings.showThinking');
  const showTerminal = store.get('settings.showTerminal');
  if (showThinking) thinkingPanel.show();
  if (showTerminal) terminalPanel.show();

  document.getElementById('thinkingToggle')?.addEventListener('click', () => {
    thinkingPanel.toggle();
    store.set('settings.showThinking',
      !document.getElementById('thinkingPanel')?.classList.contains('hidden'));
    persistence.set('settings', store.get('settings'));
  });
  document.getElementById('terminalToggle')?.addEventListener('click', () => {
    terminalPanel.toggle();
    store.set('settings.showTerminal',
      !document.getElementById('terminalPanel')?.classList.contains('hidden'));
    persistence.set('settings', store.get('settings'));
  });
  document.getElementById('themeToggle')?.addEventListener('click', () => themeManager.toggle());
  document.getElementById('exportBtn')?.addEventListener('click', () => exportPanel.open());
  document.getElementById('dialogExportBtn')?.addEventListener('click', () => exportPanel.open());
  document.getElementById('configBtn')?.addEventListener('click', () => configPanel.open());

  // Fullscreen toggle (top-right of header). Icon stays the same in/out.
  const fsBtn = document.getElementById('fullscreenBtn');
  fsBtn?.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (err) {
      console.error('Fullscreen failed:', err);
    }
  });
  document.getElementById('sidebarToggle')?.addEventListener('click', () => {
    document.getElementById('rightPanel')?.classList.remove('open');
    document.getElementById('sidebar')?.classList.toggle('open');
  });
  document.getElementById('panelToggle')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('rightPanel')?.classList.toggle('open');
  });


  // Load initial data, then restore the open (or most recent) dialog
  sidebar.loadSessions().then(() => {
    try {
      const convs = store.get('conversations') || [];
      if (convs.length === 0) return;
      const storedId = localStorage.getItem(K.CURRENT_SESSION);
      const pick = convs.find(c => c.id === storedId) || convs[0];
      if (pick && (pick.messages || []).length > 0) {
        chat.loadConversation(pick);
      }
    } catch (err) {
      console.error('Failed to restore dialog:', err);
    }
  });

  // Update header stats when data changes
  function updateHeaderStats() {
    const agents = store.get('agents') || [];
    const providers = store.get('providers') || [];
    const conversations = store.get('conversations') || [];

    const statAgents = document.getElementById('statAgents');
    const statProviders = document.getElementById('statProviders');
    const statSessions = document.getElementById('statSessions');

    if (statAgents) statAgents.textContent = agents.length;
    if (statProviders) statProviders.textContent = providers.length;
    if (statSessions) statSessions.textContent = conversations.length;
  }

  // Listen for data changes
  store.on('agents:changed', updateHeaderStats);
  store.on('providers:changed', updateHeaderStats);
  store.on('conversations:changed', updateHeaderStats);

  // Another device edited this copy while we were open. Refresh the header
  // counts and the sidebar list; an open editor is left alone so it cannot
  // throw away what someone is halfway through typing in it.
  store.on('state:remote', () => {
    updateHeaderStats();
    safeInit('sidebar', () => sidebar.render());
    store.emit('toast', { message: 'Updated from another device', type: 'info' });
  });

  // Agent toggle / delete (from sidebar settings menus)
  store.on('agent:toggle', (id) => {
    const agents = store.get('agents') || [];
    const agent = agents.find(a => a.id === id);
    if (agent) {
      agent.active = !agent.active;
      persistence.set('agents', agents);
      store.emit('agents:changed');
      store.emit('toast', { message: `${agent.name} ${agent.active ? 'activated' : 'deactivated'}`, type: 'success' });
    }
  });
  // Always-on switch (from the routing chart's node inspector). Same flag the
  // agent editor owns, so every screen agrees. Guarded like the editor: a
  // switch with no standing goal is refused rather than armed empty.
  store.on('agent:alwaysOn', ({ id, on } = {}) => {
    const agents = store.get('agents') || [];
    const agent = agents.find(a => a.id === id);
    if (!agent) return;
    if (on && !String(agent.alwaysOnGoal || '').trim()) {
      store.emit('toast', { message: `Give ${agent.name} a standing goal in its editor first — without one, always-on does nothing.`, type: 'error' });
      return;
    }
    agent.alwaysOn = !!on;
    persistence.set('agents', agents);
    store.emit('agents:changed');
    store.emit('toast', { message: `${agent.name} always-on ${agent.alwaysOn ? 'on — it works its goal on the timer' : 'off'}`, type: 'success' });
  });
  store.on('agent:delete', (id) => {
    const agents = store.get('agents') || [];
    const agent = agents.find(a => a.id === id);
    if (!agent) return;
    persistence.set('agents', agents.filter(a => a.id !== id));
    store.emit('agents:changed');
    store.emit('toast', { message: 'Agent deleted', type: 'info' });
  });

  // Provider toggle / delete / bulk actions (from sidebar settings menus)
  store.on('provider:toggle', (id) => {
    const providers = store.get('providers') || [];
    const provider = providers.find(p => p.id === id);
    if (provider) {
      provider.active = !provider.active;
      persistence.set('providers', providers);
      store.emit('providers:changed');
      store.emit('toast', { message: `${provider.name} ${provider.active ? 'activated' : 'deactivated'}`, type: 'success' });
    }
  });
  store.on('provider:delete', (id) => {
    const providers = store.get('providers') || [];
    const provider = providers.find(p => p.id === id);
    if (provider && confirm(`Delete provider "${provider.name}"?`)) {
      persistence.set('providers', providers.filter(p => p.id !== id));
      store.emit('providers:changed');
      store.emit('toast', { message: 'Provider deleted', type: 'info' });
    }
  });
  store.on('provider:activateAll', () => {
    const providers = store.get('providers') || [];
    providers.forEach(p => { p.active = true; });
    persistence.set('providers', providers);
    store.emit('providers:changed');
  });
  store.on('provider:deactivateAll', () => {
    const providers = store.get('providers') || [];
    providers.forEach(p => { p.active = false; });
    persistence.set('providers', providers);
    store.emit('providers:changed');
  });
  store.on('provider:refresh', () => {
    store.emit('providers:changed');
    store.emit('toast', { message: 'Provider list refreshed', type: 'success' });
  });
  store.on('provider:export', () => {
    const providers = store.get('providers') || [];
    const blob = new Blob([JSON.stringify(providers, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'providers.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  store.on('provider:import', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (Array.isArray(data)) {
            persistence.set('providers', data);
            store.emit('providers:changed');
            store.emit('toast', { message: 'Providers imported', type: 'success' });
          } else {
            store.emit('toast', { message: 'Invalid file format', type: 'error' });
          }
        } catch {
          store.emit('toast', { message: 'Import failed', type: 'error' });
        }
      };
      reader.readAsText(file);
    };
    input.click();
  });

  // Re-render sidebar when data changes
  store.on('agents:changed', () => sidebar.render());
  store.on('providers:changed', () => sidebar.render());

  // Toast notifications — forward to topology notification dropdown instead of popups
  store.on('toast', ({ message, type } = {}) => {
    store.emit('topology:notify', {
      agentId: null,
      agentName: 'System',
      agentColor: '#00e5ff',
      type: type || 'info',
      message: message,
    });
  });

  // Initial stats update
  updateHeaderStats();

  // Start uptime counter
  const startTime = Date.now();
  setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    const el = document.getElementById('statUptime');
    if (el) el.textContent = `${h}:${m}:${s}`;
  }, 1000);

  // Hide the loading screen.
  //
  // 12200ms was hardcoded, so the splash always cost twelve and a half seconds
  // on every single load whether the boot took half a second or twenty. It is
  // now: 0 = no splash at all, otherwise a minimum floor for the animation to
  // be worth watching, whichever is longer. The floor is what stops an instant
  // boot flashing a splash for 40ms, which reads as a glitch rather than polish.
  const LOADING_MS = Number(store.get('settings.loadingScreenMs'));
  const splashMs = Number.isFinite(LOADING_MS) ? Math.max(0, LOADING_MS) : 0;
  const hide = () => document.body.classList.add('app-loaded');
  if (splashMs <= 0) {
    hide();
  } else {
    const startedAt = Date.now();
    setTimeout(hide, Math.max(splashMs - (Date.now() - startedAt), 0));
  }
});
