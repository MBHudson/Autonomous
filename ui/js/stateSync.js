/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// STATE SYNC — make a copy portable across devices
// ============================================
//
// The problem this solves: agents, providers, settings, conversations, metrics
// and memory all lived in localStorage, which is private to one browser on one
// device. Open the same install on a phone and you get a different set of
// agents — not a synced one, a *default* one.
//
// The fix: the server keeps the whole bundle in storage/state.json, beside the
// code, so each directory is self-contained. This module keeps the two in step:
//
//   on load   server wins  (it is the source of truth; localStorage is a cache)
//   on write  localStorage first (instant), server debounced (batched)
//
// localStorage is deliberately kept. If the backend is unreachable the app
// still works exactly as it did before, and the next successful push carries
// the change up. That is also why the first load can seed the server from local
// data: otherwise adopting this would appear to wipe every existing agent.
//
// Conflicts are last-write-wins. Two devices editing agents in the same second
// will clobber each other; merging them would need a real CRDT and is not
// worth it here.

// Every import here carries the same ?v as the rest of the app. Without it the
// browser loads a second copy of persistence.js (one module per distinct URL)
// and the singleton this file hooks would not be the one the UI edits -- so
// edits would never reach the server.
import { persistence } from './persistence.js?v=320';
import { store } from './store.js?v=320';
import { api } from './api.js?v=320';
import { K } from './storage.js?v=320';

/** Slots mirrored to the server. Order is irrelevant; keys must match. */
const SLOTS = ['agents', 'providers', 'conversations', 'metrics', 'settings', 'pipelines'];

/** Individually-keyed slots that are not inside `settings`. */
const EXTRA_KEYS = {
  theme: K.THEME,
  temp: K.TEMP,
  maxTokens: K.MAX_TOKENS,
  currentSession: K.CURRENT_SESSION,
};

const SAVE_DEBOUNCE_MS = 1200;
/**
 * Settings (every Config switch, select and box) go up almost at once: a
 * toggle followed by a quick reload used to lose the change, because the
 * boot sync adopted the server's older copy. Short enough that no reload
 * beats it, long enough that typing into a box is one request, not ten.
 */
const SETTINGS_SAVE_MS = 150;
let timerDue = 0;
const BUNDLE_VERSION = 1;

/**
 * How often to ask "has anything changed?".
 *
 * Polling, deliberately, instead of Server-Sent Events. This host runs mod_php,
 * where every in-flight request occupies an Apache worker: one SSE connection
 * would pin a worker for as long as the tab stayed open, and a couple of open
 * devices could starve the whole box. A poll is a request that finishes
 * immediately, and the unchanged answer is a few bytes.
 */
const POLL_MS = 5000;

let timer = null;
let dirty = false;
let started = false;
let lastRev = 0;
let pollTimer = null;
let polling = false;
// Gates uploads until this browser has a definitive picture of the server.
// Without it, a fresh/reset browser (defaults in cache) that saves anything
// -- even just pasting its token -- uploads those defaults and overwrites
// every real list on the server. Local writes always land in localStorage;
// only the server mirror waits.
let syncedOnce = false;
/** Saves in flight; polls stand down while ours is still landing. */
let saving = 0;
let inflight = Promise.resolve();

/** Read one raw value straight out of localStorage. */
function readRaw(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Snapshot everything that should travel between devices. */
function collect() {
  const slots = {};
  for (const slot of SLOTS) {
    const v = persistence.get(slot);
    if (v !== undefined) slots[slot] = v;
  }
  // Access tokens are device-local credentials, not shared state. Syncing
  // them let one browser's empty (or stale) token field overwrite the
  // server's copy, which every other browser then adopted -- wiping working
  // pastes everywhere at once. Strip on a CLONE (slots.settings may alias
  // the live cached object; deleting on it would log this browser out too).
  if (slots.settings && typeof slots.settings === 'object') {
    slots.settings = { ...slots.settings };
    delete slots.settings.routerToken;
    delete slots.settings.sandboxToken;
  }
  for (const [name, storageKey] of Object.entries(EXTRA_KEYS)) {
    const v = readRaw(storageKey);
    if (v !== null) slots[name] = v;
  }
  // Memory keeps its own file-shaped record under K.MEMORY.
  const mem = readRaw(K.MEMORY);
  if (mem) slots.memory = mem;
  return { version: BUNDLE_VERSION, updated: Date.now(), slots };
}

/** Write a bundle down into this browser's cache. */
function applyLocally(slots) {
  for (const slot of SLOTS) {
    if (slots[slot] === undefined) continue;
    persistence.cache.set(slot, slots[slot]);
    const key = persistence._getStorageKey(slot);
    if (key) {
      try { localStorage.setItem(key, JSON.stringify(slots[slot])); } catch { /* quota */ }
    }
  }
  for (const [name, storageKey] of Object.entries(EXTRA_KEYS)) {
    if (slots[name] === undefined) continue;
    try {
      localStorage.setItem(storageKey,
        typeof slots[name] === 'object' ? JSON.stringify(slots[name]) : String(slots[name]));
    } catch { /* ignore */ }
  }
  if (slots.memory && Array.isArray(slots.memory.entries)) {
    // UNION by id, never a straight replace. The server's copy wins on a
    // conflict, but a note that exists ONLY in this browser is never silently
    // dropped by an incoming sync — which is how "everyone lost their memory"
    // happened: a sparse/older server slot overwrote the local notes wholesale.
    try {
      const localRaw = localStorage.getItem(K.MEMORY);
      const local = localRaw ? JSON.parse(localRaw) : null;
      const localEntries = (local && Array.isArray(local.entries)) ? local.entries : [];
      const seen = new Set(slots.memory.entries.map(e => e && e.id));
      const extra = localEntries.filter(e => e && e.id && !seen.has(e.id));
      const out = extra.length
        ? { ...slots.memory, entries: [...slots.memory.entries, ...extra] }
        : slots.memory;
      localStorage.setItem(K.MEMORY, JSON.stringify(out));
    } catch { /* ignore */ }
  }
  // Push the freshest values into the live store so open panels re-render.
  // Settings MERGE rather than replace: a sparse server object (a copy that
  // never set a value, or an older writer) must never wipe keys it doesn't
  // know about -- that failure mode silently reset toggles like the loading
  // screen and terminal visibility every few seconds via the poll loop.
  // Lists re-render through their :changed events, but only when the adopted
  // value actually differs, so a no-op sync never disturbs open panels.
  const changed = [];
  for (const slot of SLOTS) {
    if (slots[slot] === undefined) continue;
    let value = slots[slot];
    if (slot === 'settings' && value && typeof value === 'object') {
      // Merge, then persist the MERGED object to cache, localStorage AND
      // store. Persisting the raw server copy would drop device-local keys
      // the server never holds (access tokens): the token survived in memory
      // but died on disk, so the first reload worked and the second came up
      // logged out. Incoming token keys are refused even if an old client
      // still sends them: only this browser's own pasted value is valid here.
      const incoming = { ...value };
      delete incoming.routerToken;
      delete incoming.sandboxToken;
      // A copy saved before loading screen / thinking / terminal went
      // default-off must not switch them back on; keep this browser's values.
      if (!incoming.uiPanelsDefaultOff) {
        delete incoming.showThinking;
        delete incoming.showTerminal;
        delete incoming.loadingScreenMs;
      }
      value = { ...(store.get(slot) || {}), ...incoming };
    } else {
      const before = JSON.stringify(store.get(slot) ?? null);
      if (JSON.stringify(value) === before) continue;
      changed.push(slot);
    }
    persistence.cache.set(slot, value);
    const key = persistence._getStorageKey(slot);
    if (key) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
    }
    store.set(slot, value);
  }
  for (const slot of changed) {
    if (slot === 'agents' || slot === 'providers' || slot === 'conversations') {
      store.emit(`${slot}:changed`);
    }
  }
}

/** Push the bundle up, coalescing bursts of edits into one request. */
function scheduleSave({ immediate = false, delay = SAVE_DEBOUNCE_MS } = {}) {
  dirty = true;
  // Not yet synced: keep it local. Flushing now would upload whatever this
  // browser happens to hold (possibly fresh defaults) over the real server
  // copy. The flag flushes automatically once the first sync lands.
  if (!syncedOnce) return;
  if (immediate) { pushNow(); return; }
  // A shorter request wins over a pending longer one (settings vs. chat).
  if (timer && timerDue <= Date.now() + delay) return;
  if (timer) clearTimeout(timer);
  timerDue = Date.now() + delay;
  timer = setTimeout(() => { timer = null; pushNow(); }, delay);
}

/**
 * Upload now. Saves are chained so two quick edits can never land out of
 * order (the older bundle overwriting the newer one on the server), and the
 * bundle is collected when the request actually goes, so it is the freshest.
 */
function pushNow() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!syncedOnce || !dirty) return inflight;
  dirty = false;
  saving++;
  inflight = inflight.then(async () => {
    try {
      const res = await api.saveState(collect());
      // Remember the revision we just produced, so the next poll recognises
      // our own write instead of treating it as someone else's change.
      if (res && typeof res.rev === 'number') lastRev = res.rev;
    } catch (err) {
      // Keep the flag set so the next edit, or the next load, retries.
      dirty = true;
      console.warn('State sync: could not save to the server, will retry later.', err);
    } finally {
      saving--;
    }
  });
  return inflight;
}

/**
 * Save settings to the server right away instead of after the debounce.
 * Used by the Config switches: a toggle followed by a quick reload used to
 * lose the change, because the boot sync adopted the server's older copy.
 */
export function saveNow() {
  scheduleSave({ immediate: true });
  return inflight;
}

/**
 * Ask whether another device has changed anything, and adopt it if so.
 *
 * Guarded against three ways this could misbehave:
 *   - never runs while a local save is in flight, so we cannot overwrite our
 *     own edit with the copy we just uploaded;
 *   - `polling` re-entrancy guard, so a slow response cannot stack up;
 *   - skips when the tab is hidden, so a backgrounded phone tab is not polling
 *     all day.
 */
async function pollOnce() {
  if (polling || dirty || saving || document.hidden) return;
  polling = true;
  try {
    const res = await api.getStateSince(lastRev);
    if (!res || !res.exists || res.changed === false) return;
    const remoteRev = Number(res.rev) || 0;
    if (remoteRev && remoteRev === lastRev) return;
    const slots = res.state && res.state.slots;
    if (!slots || !Object.keys(slots).length) return;

    lastRev = remoteRev;
    applyLocally(slots);
    syncedOnce = true;
    if (dirty) scheduleSave();
    // Tell the UI to re-render: the sidebar agent list, the header counts and
    // any open editor all read from the store.
    store.emit('state:remote', { rev: remoteRev });
    console.info('State sync: adopted a change made on another device.');
  } catch (err) {
    // A failed poll is not worth a console full of noise; the next one retries.
  } finally {
    polling = false;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollOnce, POLL_MS);
  // Catch up straight away when the tab comes back to the foreground.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) pollOnce();
    });
  }
}

/**
 * Adopt whatever the server has, then start mirroring.
 *
 * Called once from app.js. Never throws: a failure here must not stop the app
 * booting, it just leaves the copy running on its localStorage copy alone.
 */
export async function startStateSync() {
  if (started) return;
  started = true;

  // Every normal write goes through persistence.set / remove; hook them rather
  // than trying to catch each call site.
  const prevSet = persistence.set.bind(persistence);
  persistence.set = (key, value) => {
    prevSet(key, value);
    scheduleSave(key === 'settings' ? { delay: SETTINGS_SAVE_MS } : undefined);
  };
  const prevRemove = persistence.remove?.bind(persistence);
  if (prevRemove) {
    persistence.remove = key => { prevRemove(key); scheduleSave(); };
  }
  // Memory writes bypass persistence entirely.
  if (typeof window !== 'undefined') {
    window.addEventListener('router:memory-changed', scheduleSave);
  }

  try {
    const res = await api.getState();
    const server = res && res.state && res.state.slots;

    if (!res || !res.exists || !server || !Object.keys(server).length) {
      // First sync for this copy. If this browser already has data of its own,
      // that data is older and more precious than an empty server file, so it
      // seeds the server instead of being overwritten by nothing.
      const mine = collect();
      if (Object.keys(mine.slots).length) {
        try {
          const put = await api.saveState(mine);
          if (put && typeof put.rev === 'number') {
            lastRev = put.rev;
            syncedOnce = true;
            if (dirty) scheduleSave();
          }
          console.info('State sync: seeded the server from this browser.');
        } catch {
          // Seed failed (offline, or rejected): stay local-only. Flushing
          // now would risk uploading defaults over a server we cannot see.
        }
      } else {
        // Nothing anywhere: an empty server accepts our later edits safely.
        syncedOnce = true;
      }
      startPolling();
      return;
    }

    lastRev = Number(res.rev) || Number(res.state.rev) || 0;
    applyLocally(server);
    syncedOnce = true;
    if (dirty) scheduleSave();
    console.info('State sync: adopted the server copy.');
  } catch (err) {
    console.warn('State sync: server unavailable, running from local storage.', err);
  }

  startPolling();

  // A tab closed shortly after an edit could lose that edit; flush on the way
  // out. A keepalive fetch survives the unload AND carries the access-token
  // headers; sendBeacon cannot set headers, so on a token-protected install
  // its write was always refused (401). Keepalive bodies are capped at 64KB,
  // so a large bundle still falls back to the beacon.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      if (!dirty) return;
      const body = JSON.stringify({ state: collect() });
      const url = `${api.baseUrl}/state`;
      try {
        if (body.length < 60000) {
          fetch(url, { method: 'PUT', headers: api._authHeaders(), body, keepalive: true }).catch(() => {});
        } else {
          navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        }
        dirty = false;
      } catch { /* best effort */ }
    });
  }
}

/** Force an immediate push. Exported for tests and for an explicit save. */
export function flushStateSync() {
  if (timer) { clearTimeout(timer); timer = null; }
  dirty = false;
  return api.saveState(collect()).catch(err => {
    dirty = true;
    throw err;
  });
}