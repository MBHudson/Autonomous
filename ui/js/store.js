/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// STORE.JS — Central state store (pub/sub)
// ============================================

/**
 * The app version.
 *
 * BUMP THIS ON EVERY CHANGE. It drives the version badge in the header, and it
 * is deliberately the only place the number lives: the cache-buster query on
 * the asset tags in index.html and on every module import has to be changed to
 * the same value, or browsers mix a new module with an old one. That drift is
 * what produced "api.sandbox is not a function" once already.
 *
 * Current value and where the others go:
 *   * ui/index.html + index.html : <span id="appVersion"> and every ?v=
 *   * every `from './x.js?v='`   : this number
 */
export const APP_VERSION = 360;

class Store {
  constructor() {
    this.state = {
      agents: [],
      providers: [],
      conversations: [],
      currentConversation: null,
      settings: this._defaultSettings(),
      ui: {
        activeTab: 'agents',
        thinkingOpen: false,
        terminalOpen: false,
        editingAgentId: null,
        editingProviderId: null,
        activeAgentIds: new Set(),
        sidebarOpen: true,
      },
    };
    this.listeners = new Map();
    this.eventListeners = new Map();
  }

  _defaultSettings() {
    return {
      theme: 'dark',
      // Which desktop shell to wear: 'classic' (the left setup panel, the chat
      // and the right map/network panel side by side -- the layout from before
      // the desktop refresh) or 'desktop' (the Desktop 2026 glass shell).
      // Absent or unrecognised counts as classic; the rule lives in ifaceMode.js.
      interfaceMode: 'classic',
      temperature: 1.0,
      maxTokens: 16384,
      autoScroll: true,
      soundEnabled: false,
      enterToSend: true,
      showThinking: false,
      showTerminal: false,
      // Milliseconds of splash. 0 (the default) disables it; absent also
      // means off. Turning it on in Config sets the 12.2s splash.
      loadingScreenMs: 0,
      showCode: true,
      // Tool approval: global kill-switch plus per-tool allow/ask/deny.
      // Absent everywhere means today's behaviour (ask gated tools, run rest).
      autoDeny: false,
      toolPolicy: {},
      // Global pre-prompt override (Agents tab header). PREPENDED to every
      // agent's system prompt while active by default; mode 'replace' swaps the
      // agent's own prompt out instead.
      globalPrePrompt: { text: '', active: false, mode: 'prepend' },
      // The routing chart's ghost transcript: the chat printed faintly behind
      // the canvas. On by default at a low opacity because the whole point is
      // knowing that work is happening without switching screens; the four
      // controls live in Config > Interface.
      chartGhost: { on: true, color: '#a8c0d8', size: 11, opacity: 0.3 },
      // Brain Lab: a user-owned scratchpad (never injected into a prompt) and
      // reusable direction bundles that can be appended or locked per agent.
      brainNotes: '',
      brainProfiles: [],
      customTools: [],
      // Config → Labs. "Dynamic tools" adapts the tool instructions to the
      // model's dialect and the SERVER's real environment (OS, cwd, which
      // commands exist); the memo remembers the dialect that last worked for a
      // provider::model. Both default ON — switching either off restores the
      // classic behaviour exactly.
      dynamicTools: true,
      toolDialectMemo: true,
      toolDialectMap: {},
      // API pool: rotate a provider's extra keys after N requests. Default ON,
      // because it only ever engages for a provider that actually carries a
      // pool — with no pool keys it falls straight back to the single provider
      // key, exactly as before.
      apiPool: true,
      // Resource Manager (Config → Resource Manager). Every switch is OFF by
      // default, so the 3D graph keeps rendering continuously exactly as it did
      // before this existed; turning one on lets the app rest when it is not
      // needed. The gauges read live values from ui/js/perf.js.
      resourceManager: {
        pauseCovered: false,    // pause while a full-screen panel is open
        pauseUnfocused: false,  // pause while the window is not focused
        pauseOffscreen: false,  // pause while the graph is off-screen
        idleThrottle: false,    // drop to a low frame rate when nothing happens
        idleFps: 10,
      },
      // Browser screen: keep the Live auto-refresh polling while the screen is
      // hidden (default) or pause it and resume on return. The Live on/off
      // choice itself is a separate, persisted preference.
      browserLiveBackground: true,
      // Config → Updates: ask the server, once per page load, whether a newer
      // release is published, and put the answer in the notification bell.
      // ON by default because it is the whole point of the feature, and cheap
      // -- the server caches the probe for six hours and the comparison is a
      // version number. Turning it off leaves the manual CHECK NOW and
      // DOWNLOAD UPDATE in Config working exactly the same.
      checkUpdatesOnStartup: true,
      // The published version already announced in the bell, so the same news
      // is not repeated on every reload. Set by the boot check; a newer
      // release re-notifies. Not a user setting.
      updateNotifiedVersion: '',
    };
  }

  /** Get value by dot-notation path */
  get(path) {
    const keys = path.split('.');
    let current = this.state;
    for (const key of keys) {
      if (current == null || typeof current !== 'object') return undefined;
      current = current[key];
    }
    return current;
  }

  /** Set value by dot-notation path (immutable update + notify) */
  set(path, value) {
    const keys = path.split('.');
    const newState = { ...this.state };
    let current = newState;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current)) {
        current[key] = {};
      } else {
        current[key] = { ...current[key] };
      }
      current = current[key];
    }

    const lastKey = keys[keys.length - 1];
    const oldValue = current[lastKey];
    current[lastKey] = value;

    this.state = newState;

    // Notify path-specific listeners
    this._notify(path, value, oldValue);

    // Notify wildcard listeners
    this._notify('*', value, oldValue);

    return value;
  }

  /** Subscribe to changes on a path (or '*' for all) */
  subscribe(path, callback) {
    if (!this.listeners.has(path)) {
      this.listeners.set(path, new Set());
    }
    this.listeners.get(path).add(callback);

    // Return unsubscribe function
    return () => {
      const set = this.listeners.get(path);
      if (set) {
        set.delete(callback);
        if (set.size === 0) this.listeners.delete(path);
      }
    };
  }

  /** Emit a global event */
  emit(event, data) {
    const set = this.eventListeners.get(event);
    if (set) {
      set.forEach(cb => {
        try {
          cb(data);
        } catch (err) {
          console.error(`Store event listener error for "${event}":`, err);
        }
      });
    }
  }

  /** Subscribe to a global event */
  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event).add(callback);

    return () => {
      const set = this.eventListeners.get(event);
      if (set) {
        set.delete(callback);
        if (set.size === 0) this.eventListeners.delete(event);
      }
    };
  }

  _notify(path, value, oldValue) {
    const set = this.listeners.get(path);
    if (set) {
      set.forEach(cb => {
        try {
          cb(value, oldValue, path);
        } catch (err) {
          console.error(`Store listener error for "${path}":`, err);
        }
      });
    }
  }

  /** Get a snapshot of the entire state */
  snapshot() {
    return JSON.parse(JSON.stringify(this.state, (key, value) => {
      if (value instanceof Set) return Array.from(value);
      return value;
    }));
  }

  /** Replace entire state (e.g., after loading from storage) */
  replaceState(newState) {
    this.state = {
      ...newState,
      ui: { ...this.state.ui, ...(newState.ui || {}) },
    };
    this._notify('*', this.state, null);
  }
}

// Singleton instance
export const store = new Store();
export default store;
