/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// API-POOL.JS — rotate several API keys for one provider
// ============================================
//
// Some operators hold more than one key for the same provider (separate free
// accounts, team keys, a spare). Instead of picking one by hand, a provider
// can carry a POOL and this module hands out the next key, rotating after a
// number of requests the operator sets.
//
// Feature-gated: Config → Labs → "API pool" (settings.apiPool, default OFF).
// Off = nothing here is consulted and the single provider key is used exactly
// as before.
//
// Counters and cooldowns are SESSION-ONLY on purpose. Persisting "this key has
// served 7 of 10" buys little, and a stale counter only ever rotates away from
// a good key; a fresh session starting a clean round is the safe direction.
// A 429 puts a key on cooldown so the next call tries a different one instead
// of spending the same refusal again.

import { store } from './store.js?v=326';
import { agentCode } from './utils.js?v=326';

const counts = new Map();      // keyId -> requests used this round
const cooldown = new Map();    // keyId -> epoch ms a key is refused until
const cursor = new Map();      // providerId -> last key index handed out

const DEFAULT_COOLDOWN_MS = 60 * 1000;

export function poolEnabled() {
  return (store.get('settings') || {}).apiPool === true;   // default OFF
}

/** How many requests one key serves before rotating. 0/blank => every call. */
function rotateAfter(provider) {
  const n = parseInt(provider?.rotateAfter, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : 1;
}

/** The pool in force for this call: an agent override wins over the provider. */
export function keysFor(provider, agent) {
  const list = (agent && Array.isArray(agent.apiKeys) && agent.apiKeys.length)
    ? agent.apiKeys
    : (provider && Array.isArray(provider.apiKeys) ? provider.apiKeys : []);
  return list.filter(k => k && typeof k.key === 'string' && k.key.trim());
}

const norm = s => String(s || '').trim().toLowerCase().replace(/^#/, '');

/**
 * Does this key apply to the model being called?
 *
 * A key is universal unless the operator turned on "only this model" AND gave
 * a model # (the agent's code, like #63BET7) or a model id. Then it is used
 * only for that model — so a provider can hold keys dedicated to one model and
 * rotate around it, while everything else keeps the single key.
 */
export function scopeMatches(keyObj, agent) {
  if (!keyObj || !keyObj.only) return true;
  const want = norm(keyObj.model);
  if (!want) return true;                 // toggled on but blank => universal
  const code = norm(agent ? (agent.code || agentCode(agent)) : '');
  const model = norm(agent && agent.model);
  return want === code || want === model || (model && model.includes(want));
}

/** Reset rotation bookkeeping (e.g. when the pool is edited). */
export function resetPool(providerId) {
  if (providerId) {
    cursor.delete(providerId);
    return;
  }
  counts.clear(); cooldown.clear(); cursor.clear();
}

/**
 * The key to use for this call, or null when the pool is empty/disabled.
 * Skips keys on cooldown and keys that have hit their request cap; when every
 * usable key has hit the cap, a new round starts.
 */
export function pickKey(provider, agent) {
  const keys = keysFor(provider, agent).filter(k => scopeMatches(k, agent));
  if (!keys.length) return null;
  const now = Date.now();
  const cap = rotateAfter(provider);
  const pid = provider?.id || 'provider';
  const start = cursor.get(pid) || 0;

  const usable = keys
    .map((k, i) => ({ k, i }))
    .filter(({ k }) => (cooldown.get(k.id) || 0) <= now);
  if (!usable.length) return keys[start % keys.length];   // all cooling; best effort

  let chosen = usable.find(({ k }) => (counts.get(k.id) || 0) < cap);
  if (!chosen) {
    // Everyone hit the cap: new round.
    usable.forEach(({ k }) => counts.set(k.id, 0));
    chosen = usable[0];
  }
  cursor.set(pid, chosen.i);
  return chosen.k;
}

/**
 * Report the outcome of a call made with `keyObj`.
 * A rate-limit refusal puts the key on cooldown (the Retry-After, or a minute).
 */
export function noteResult(provider, keyObj, { ok = true, rateLimited = false } = {}) {
  if (!keyObj || !keyObj.id) return;
  counts.set(keyObj.id, (counts.get(keyObj.id) || 0) + 1);
  if (rateLimited) {
    cooldown.set(keyObj.id, Date.now() + DEFAULT_COOLDOWN_MS);
  }
}

/** A snapshot for the provider editor: per-key usage + cooldown state. */
export function poolSnapshot(provider) {
  const now = Date.now();
  return keysFor(provider, null).map(k => ({
    id: k.id,
    used: counts.get(k.id) || 0,
    cooling: (cooldown.get(k.id) || 0) > now,
    cooldownMs: Math.max(0, (cooldown.get(k.id) || 0) - now),
  }));
}
