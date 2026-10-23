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
export const APP_VERSION = 300;

class Store {
  constructor() {
    this.state = {
      agents: [],
      providers: [],
      conversations: [],
      currentConversation: null,
      settings: this._defaultSettings(),
      ui: {
        activeTab: 'sessions',
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
      // Global pre-prompt override (Agents tab header). Prepended to every
      // agent's system prompt while active.
      globalPrePrompt: { text: '', active: false },
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
