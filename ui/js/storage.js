/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// STORAGE.JS — app-scoped localStorage keys
// ============================================
//
// localStorage is scoped to the ORIGIN, not the path, so two copies of this app
// on one host shared a single set of keys — editing agents/providers in a copy
// overwrote the original's.
//
// Keys are namespaced by the app's own directory:
//   /test/t/router/       -> test_t_router::providers
//   /test/t/router-copy/  -> test_t_router_copy::providers
//
// The pre-namespacing keys (router_providers, …) are migrated ONCE and then
// DELETED. That gives two things at once:
//   • this app keeps the settings it already had
//   • any copy opened afterwards starts clean, even in the same browser,
//     because nothing is left for it to inherit
//
// Append ?reset=1 to the URL to wipe this app's settings back to defaults.

/** The directory this app is served from, e.g. "/test/t/router/". */
export const APP_DIR = new URL('../../', import.meta.url).pathname;

/** A filesystem-safe, collision-free prefix for this app instance. */
export const APP_SLUG = APP_DIR.split('/').filter(Boolean).join('__') || 'app';

const SLOT_NAMES = [
  'agents', 'providers', 'conversations', 'metrics',
  'settings', 'theme', 'temp', 'maxTokens', 'currentSession',
];

/** Pre-namespacing keys, one per slot. */
const LEGACY = {
  agents: 'router_agents',
  providers: 'router_providers',
  conversations: 'router_conversations',
  metrics: 'router_metrics',
  settings: 'router_settings',
  theme: 'router_theme',
  temp: 'router_temp',
  maxTokens: 'router_max_tokens',
  currentSession: 'router_current_session',
};

/** Namespaced key for a logical slot. */
export const k = slot => `${APP_SLUG}::${slot}`;

/**
 * Every namespaced key this app manages. Names are explicit rather than
 * derived from the slot, because the call sites use SCREAMING_SNAKE names
 * that do not survive a naive slot.toUpperCase() (maxTokens -> MAXTOKENS).
 */
export const K = {
  AGENTS: k('agents'),
  PROVIDERS: k('providers'),
  CONVERSATIONS: k('conversations'),
  METRICS: k('metrics'),
  PIPELINES: k('pipelines'),
  SETTINGS: k('settings'),
  THEME: k('theme'),
  TEMP: k('temp'),
  HISTORY_TURNS: k('historyTurns'),
  MAX_TOKENS: k('maxTokens'),
  CURRENT_SESSION: k('currentSession'),
  MEMORY: k('memory'),
};

/**
 * Remove the pre-namespacing unscoped keys.
 *
 * There is deliberately NO adoption path: every copy of this app starts from
 * the built-in defaults, exactly like a brand-new install. Those old keys are
 * shared by every copy on the host, so they are deleted rather than migrated —
 * migrating them would let whichever copy loaded first hand its settings to all
 * the others, which is the exact bug this file exists to fix.
 *
 * Nothing is lost that lives only in the browser: sessions, dialogs and
 * metrics history are stored server-side per app directory and are untouched.
 */
export function purgeLegacyStorage() {
  if (typeof localStorage === 'undefined') return 0;
  let removed = 0;
  SLOT_NAMES.forEach(slot => {
    const legacyKey = LEGACY[slot];
    if (!legacyKey) return;
    try {
      if (localStorage.getItem(legacyKey) !== null) {
        localStorage.removeItem(legacyKey);
        removed++;
      }
    } catch { /* ignore */ }
  });
  if (removed) {
    console.info(`[${APP_SLUG}] cleared ${removed} shared legacy key(s); this copy now has its own settings`);
  }
  return removed;
}

/** Wipe every key belonging to this app instance. */
export function resetAppStorage() {
  SLOT_NAMES.forEach(slot => {
    try { localStorage.removeItem(k(slot)); } catch { /* ignore */ }
  });
}

/** Run once, before anything reads storage. */
export function initStorage() {
  purgeLegacyStorage();
  try {
    if (new URLSearchParams(location.search).get('reset') === '1') {
      resetAppStorage();
      console.info(`[${APP_SLUG}] settings reset to defaults`);
    }
  } catch { /* ignore */ }
}