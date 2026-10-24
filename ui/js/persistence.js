/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// PERSISTENCE.JS — localStorage abstraction layer
// ============================================

import { store } from './store.js?v=321';
import { deepClone, makeAgentCode } from './utils.js?v=321';
import { K, initStorage } from './storage.js?v=321';

// Storage keys are namespaced per app directory so several copies served from
// one host cannot overwrite each other's settings. See ui/js/storage.js.
const STORAGE_KEYS = {
  AGENTS: K.AGENTS,
  PROVIDERS: K.PROVIDERS,
  CONVERSATIONS: K.CONVERSATIONS,
  METRICS: K.METRICS,
  SETTINGS: K.SETTINGS,
  PIPELINES: K.PIPELINES,
  THEME: K.THEME,
  TEMP: K.TEMP,
  MAX_TOKENS: K.MAX_TOKENS,
};

// API keys are intentionally EMPTY. Every provider ships with no key so that a
// fresh copy of this app can be handed to someone without leaking the owner's
// credentials. The user adds a key per provider in the Providers panel.
// Agents are pre-configured with roles but start INACTIVE for the same reason:
// nothing should call out anywhere until the user supplies their own keys.
// In production, use environment variables or a secure backend proxy.
// To override, set localStorage keys before app loads or modify this file.
const DEFAULT_PROVIDERS = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: '',
    models: [
      // Verified against GET https://openrouter.ai/api/v1/models (464 models,
      // 17 of them genuinely free — the ":free" tier below).
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'google/gemma-4-31b-it:free',
      'qwen/qwen3.8-27b:free',
      'liquid/lfm-2.5-2.6b:free',
      'thinkingmachines/inkling:free',
      'openai/gpt-4o-mini',
      'google/gemini-2.5-flash',
      'qwen/qwen-2.5-coder-32b-instruct',
      'meta-llama/llama-3.1-70b-instruct',
      'anthropic/claude-3.5-sonnet',
    ],
    authType: 'bearer',
    active: true,
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    apiKey: '',
    models: [
      // Verified against GET https://integrate.api.nvidia.com/v1/models
      // (81 models). The previous entries here — nemotron-3-ultra-free,
      // big-pickle-free, space-bunny-free — were invented and do NOT exist;
      // NVIDIA has no "*-free" tier, which is what the 404s were about.
      'nvidia/nemotron-3-ultra-550b-a55b',
      'z-ai/glm-5.3',
      'z-ai/glm-5.3-flash',
      'moonshotai/kimi-k3',
      'nvidia/nemotron-4-340b-instruct',
      'nvidia/llama-3.1-nemotron-ultra-253b-v1',
      'openai/gpt-oss-20b',
      'meta/llama-3.2-90b-vision-instruct',
    ],
    authType: 'bearer',
    active: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiKey: '',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-haiku-20240307'],
    authType: 'x-api-key',
    active: false,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-preview'],
    authType: 'bearer',
    active: false,
  },
  {
    id: 'google',
    name: 'Google',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    apiKey: '',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    authType: 'none',
    active: false,
  },
  {
    id: 'groq',
    name: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: '',
    models: ['llama-3.1-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    authType: 'bearer',
    active: false,
  },
  {
    id: 'together',
    name: 'Together',
    endpoint: 'https://api.together.xyz/v1/chat/completions',
    apiKey: '',
    models: ['meta-llama/Llama-3.1-70B-Instruct-Turbo', 'mistralai/Mixtral-8x7B-Instruct-v0.1'],
    authType: 'bearer',
    active: false,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    endpoint: 'http://localhost:11434/api/chat',
    apiKey: '',
    models: ['llama3.1', 'mistral', 'codellama', 'qwen2.5-coder'],
    authType: 'none',
    active: false,
  },
];

const DEFAULT_AGENTS = [
  { id: 'commander', name: 'Commander', role: 'coordinator', provider: 'openrouter', model: 'openai/gpt-4o-mini', color: '#00e5ff', active: false, memory: true },
  { id: 'planner', name: 'Planner', role: 'strategist', provider: 'openrouter', model: 'google/gemini-2.5-flash', color: '#a855f7', active: false, memory: true },
  { id: 'worker', name: 'Worker', role: 'executor', provider: 'openrouter', model: 'qwen/qwen-2.5-coder-32b-instruct', color: '#00ff88', active: false, memory: true },
  { id: 'reviewer', name: 'Reviewer', role: 'verifier', provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', color: '#ff9f43', active: false, memory: true },
];

class Persistence {
  constructor() {
    this.cache = new Map();
    initStorage();
    this.loadAll();
  }

  loadAll() {
    // Load providers: merge saved over defaults so new/changed defaults
    // appear while user edits (keys, endpoints, models) are preserved.
    const savedProviders = this._get(STORAGE_KEYS.PROVIDERS) || [];
    const savedById = new Map(savedProviders.map(p => [p.id, p]));
    const providers = this._migrateModels(
      deepClone(DEFAULT_PROVIDERS).map(d => {
        const saved = savedById.get(d.id);
        if (!saved) return d;
        // Merge the model lists instead of letting the saved array replace
        // them, so models added to the defaults still show up.
        const merged = { ...d, ...saved };
        if (Array.isArray(d.models)) merged.models = this._mergeModels(d.models, saved.models);
        return merged;
      })
        .concat(savedProviders.filter(p => !DEFAULT_PROVIDERS.some(d => d.id === p.id)))
    );
    this.cache.set('providers', providers);
    this._persist(STORAGE_KEYS.PROVIDERS, providers);

    // Load agents (migrate stale model IDs from older defaults). An empty
    // saved array falls back to defaults: [] is what a wiped or never-seeded
    // copy holds, and unlike providers (which merge) agents have no union
    // step, so a bare `||` would let an empty array win because [] is truthy.
    // A store with zero agents breaks every picker and fan-out in the UI, so
    // an explicit empty list is treated as "nothing saved yet", not as a
    // deliberate choice to run agentless.
    const savedAgents = this._get(STORAGE_KEYS.AGENTS);
    const agents = this._migrateModels(
      (Array.isArray(savedAgents) && savedAgents.length)
        ? savedAgents : deepClone(DEFAULT_AGENTS));
    // Mint a code for any agent that predates the code feature, so every
    // agent has a permanent handle for logs and exports.
    agents.forEach(a => { if (a && !a.code) a.code = makeAgentCode(); });

    this.cache.set('agents', agents);
    if (savedAgents) this._persist(STORAGE_KEYS.AGENTS, agents);

    // Load conversations
    const savedConversations = this._get(STORAGE_KEYS.CONVERSATIONS);
    this.cache.set('conversations', savedConversations || []);

    // Load workflows (routing-chart pipelines). Absent on first run or on a
    // copy that never opened the chart -- an empty list, never undefined, so
    // a save can never mistake "not loaded" for "deleted everything".
    this.cache.set('pipelines', this._get(STORAGE_KEYS.PIPELINES) || []);

    // Load metrics (per-session token usage)
    const savedMetrics = this._get(STORAGE_KEYS.METRICS);
    this.cache.set('metrics', savedMetrics || { sessions: {} });

    // Load settings
    const savedSettings = this._get(STORAGE_KEYS.SETTINGS) || {};
    // One-time default migration. Old shipped defaults were temperature 0.7 and
    // maxTokens 4096; 4096 silently truncates reasoning models, so raise it.
    // Only rewrite values that are STILL the old default — anything the user
    // chose is left alone.
    let settingsMigrated = false;
    // 0.7 was the original shipped default; 0.2 was briefly shipped by mistake
    // (taken from a Moonshot kimi-k2 harness, wrong model). Both fold into 1.0.
    if (savedSettings.temperature === 0.7 || savedSettings.temperature === 0.2) {
      savedSettings.temperature = 1.0;
      settingsMigrated = true;
    }
    if (savedSettings.maxTokens === 4096) {
      savedSettings.maxTokens = 16384;
      settingsMigrated = true;
    }
    // One-time: loading screen, thinking panel and terminal now default OFF.
    // Applied once to existing installs (which had them saved as on); after
    // the flag is set, whatever the user toggles in Config is kept.
    if (!savedSettings.uiPanelsDefaultOff) {
      savedSettings.showThinking = false;
      savedSettings.showTerminal = false;
      savedSettings.loadingScreenMs = 0;
      savedSettings.uiPanelsDefaultOff = true;
      settingsMigrated = true;
    }
    this.cache.set('settings', savedSettings);
    if (settingsMigrated) this._persist(STORAGE_KEYS.SETTINGS, savedSettings);

    // Speech defaults, applied without marking the blob migrated: absent keys
    // are simply "not configured yet", and writing them on first load would
    // dirty every install's saved settings for no reason. autoSpeak stays off
    // deliberately — a fan-out of five agents would read all five aloud, and
    // speech is billed per character.
    const audioDefaults = {
      audioProvider: 'openai',
      audioVoice: '',
      // 'browser' forces built-in OS voices (no API, no credits, works offline).
      // 'auto' would try cloud providers first, which requires API credits.
      audioEngine: 'browser',
      audioBrowserVoice: '',
      audioPitch: 1,
      // Sent as X-Router-Token on every API call.
      routerToken: '',
      audioSpeed: 1,
      autoSpeak: false,
    };
    // Always-on defaults. Off by default and uncapped by default: switching
    // this on bills real money per iteration, so it has to be a deliberate act.
    const alwaysOnDefaults = {
      alwaysOn: false,
      alwaysOnIntervalSec: 30,
      // Seconds to hold off on an autonomous tick after the user sends a turn.
      // Stops the agent appearing to answer the same message twice.
      // 3 seconds is enough to let the user turn settle before the scheduler
      // takes over again; the chat layer also deduplicates responses per turn.
      alwaysOnGraceSec: 3,
      alwaysOnMaxIterations: 0,
      alwaysOnMaxMinutes: 0,
      alwaysOnRunHidden: false,
    };
    let audioAdded = false;
    for (const [key, value] of Object.entries(audioDefaults)) {
      if (savedSettings[key] === undefined) {
        savedSettings[key] = value;
        audioAdded = true;
      }
    }
    for (const [key, value] of Object.entries(alwaysOnDefaults)) {
      if (savedSettings[key] === undefined) {
        savedSettings[key] = value;
        audioAdded = true;
      }
    }
    if (audioAdded) this._persist(STORAGE_KEYS.SETTINGS, savedSettings);

    // Load theme
    const savedTheme = this._get(STORAGE_KEYS.THEME);
    if (savedTheme) this.cache.set('theme', savedTheme);

    // Load temp
    const savedTemp = this._get(STORAGE_KEYS.TEMP);
    if (savedTemp) this.cache.set('temperature', parseFloat(savedTemp));

    // Load max tokens
    const savedMaxTokens = this._get(STORAGE_KEYS.MAX_TOKENS);
    if (savedMaxTokens) this.cache.set('maxTokens', parseInt(savedMaxTokens, 10));

    // Push to store
    store.set('providers', providers);
    store.set('agents', agents);
    store.set('conversations', this.cache.get('conversations'));
    store.set('metrics', this.cache.get('metrics'));
    store.set('settings', { ...store.get('settings'), ...this.cache.get('settings') });
    if (savedTheme) store.set('settings.theme', savedTheme);
    if (savedTemp) store.set('settings.temperature', parseFloat(savedTemp));
    if (savedMaxTokens) store.set('settings.maxTokens', parseInt(savedMaxTokens, 10));
  }

  /** Fix stale/invalid model IDs (verified against OpenRouter catalog) */
  _migrateModels(items) {
    const renames = {
      'google/gemini-2.0-flash': 'google/gemini-2.5-flash',
      'google/gemini-2.0-flash-001': 'google/gemini-2.5-flash',
      'qwen/qwen2.5-coder-32b': 'qwen/qwen-2.5-coder-32b-instruct',
      'meta-llama/llama-3.1-70b': 'meta-llama/llama-3.1-70b-instruct',
      // These NVIDIA ids never existed (verified against the live catalog —
      // NVIDIA has no free tier). Map them onto real, working models so an
      // agent saved against one stops 404ing.
      'nvidia/nemotron-3-ultra-free': 'nvidia/nemotron-3-ultra-550b-a55b',
      'nvidia/big-pickle-free': 'nvidia/nemotron-3-super-120b-a12b',
      'nvidia/space-bunny-free': 'nvidia/nemotron-3-ultra-550b-a55b',
      'nvidia/llama-3.1-nemotron-70b': 'nvidia/llama-3.1-nemotron-70b-instruct',
    };
    const fix = (m) => {
      if (typeof m !== 'string') return m;
      if (m.startsWith('openrouter/')) m = m.slice('openrouter/'.length);
      return renames[m] || m;
    };
    items.forEach((item) => {
      if (Array.isArray(item.models)) item.models = item.models.map(fix);
      if (typeof item.model === 'string') item.model = fix(item.model);
    });
    return items;
  }

  /**
   * Union a default model list with the saved one: keep everything the user
   * added, and add anything new from the defaults. A plain `{...d, ...saved}`
   * spread lets the saved `models` array wipe the defaults, which meant newly
   * shipped models (e.g. the OpenRouter ":free" tier) never reached anyone who
   * already had the provider saved.
   */
  _mergeModels(defaultModels = [], savedModels = []) {
    const out = [];
    [...defaultModels, ...savedModels].forEach(m => {
      if (typeof m === 'string' && m && !out.includes(m)) out.push(m);
    });
    return out;
  }

  _persist(storageKey, value) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (err) {
      console.error('Persistence migrate-save failed:', err);
    }
  }

  get(key) {
    return this.cache.get(key);
  }

  set(key, value) {
    this.cache.set(key, value);
    const storageKey = this._getStorageKey(key);
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(value));
      } catch (err) {
        console.error('Persistence set failed:', err);
      }
    }
    // Also update store
    if (key === 'providers' || key === 'agents' || key === 'conversations' || key === 'settings' || key === 'metrics' || key === 'pipelines') {
      store.set(key, value);
    }
  }

  remove(key) {
    this.cache.delete(key);
    const storageKey = this._getStorageKey(key);
    if (storageKey) {
      localStorage.removeItem(storageKey);
    }
  }

  _get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  _getStorageKey(key) {
    const map = {
      agents: STORAGE_KEYS.AGENTS,
      providers: STORAGE_KEYS.PROVIDERS,
      conversations: STORAGE_KEYS.CONVERSATIONS,
      metrics: STORAGE_KEYS.METRICS,
      settings: STORAGE_KEYS.SETTINGS,
      // Workflows. Without this line _getStorageKey returned null for
      // 'pipelines', so persistence.set() quietly did nothing at all -- no
      // localStorage write, no server mirror -- and every workflow appeared to
      // save while vanishing on reload. Same failure shape as a config toggle
      // that flips the UI but nothing reads.
      pipelines: STORAGE_KEYS.PIPELINES,
      theme: STORAGE_KEYS.THEME,
      temperature: STORAGE_KEYS.TEMP,
      maxTokens: STORAGE_KEYS.MAX_TOKENS,
    };
    return map[key] || null;
  }

  /** Export all data as JSON string */
  exportAll() {
    const data = {};
    this.cache.forEach((value, key) => {
      data[key] = value;
    });
    return JSON.stringify(data, null, 2);
  }

  /** Import all data from JSON string */
  importAll(json) {
    try {
      const data = JSON.parse(json);
      Object.entries(data).forEach(([key, value]) => {
        this.set(key, value);
      });
      return true;
    } catch (err) {
      console.error('Import failed:', err);
      return false;
    }
  }

  /** Reset all data to defaults */
  resetAll() {
    Object.values(STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
    this.cache.clear();
    this.loadAll();
  }

  /** Get default providers (for reset) */
  getDefaultProviders() {
    return deepClone(DEFAULT_PROVIDERS);
  }

  /** Get default agents (for reset) */
  getDefaultAgents() {
    return deepClone(DEFAULT_AGENTS);
  }
}

// Singleton instance
export const persistence = new Persistence();
export default persistence;
export { DEFAULT_PROVIDERS, DEFAULT_AGENTS };
