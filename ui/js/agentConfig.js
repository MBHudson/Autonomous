/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// AGENT-CONFIG.JS — per-agent locks, reusable profiles, Brain Lab notes
// ============================================
//
// A LOCK IS AN OVERRIDE, NOT A COPY.
//
// The user's model: a global knob keeps moving, but an agent that was locked
// keeps the value it was locked to. So "locked" means the agent carries its own
// value and the global one is never consulted again for it; "unlocked" means
// the global value is read live on every call.
//
// Temperature and max tokens already had per-agent fields before Brain Lab, so
// those stay where they are (agent.temperature / agent.maxTokens) rather than
// being duplicated into `overrides`. Everything else lives in `agent.overrides`.
// Keeping one source per setting is what stops the UI, the resolver and the
// call paths from disagreeing about what an agent is actually using.

import { store } from './store.js?v=360';
import { DEFAULT_HISTORY_TURNS } from './utils.js?v=360';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

/** The override bag, never the live object (callers must not mutate it in place). */
export const overridesOf = agent => (agent && agent.overrides) || {};

/** The settings Brain Lab may lock per agent. Order is the rail's order. */
export const LOCKABLE = [
  'temperature',
  'maxTokens',
  'historyTurns',
  'rateEnabled',
  'rateRpm',
  'rateMaxWaitMs',
  'rateStealth',
  'tokenBudget',
  'autoApprove',
  'autoDeny',
  'toolPolicy',
];

/** True when this agent owns the value and ignores the global setting. */
export function isLocked(agent, key) {
  if (!agent) return false;
  if (key === 'temperature') return agent.temperature !== undefined && agent.temperature !== null;
  if (key === 'maxTokens') return agent.maxTokens !== undefined && agent.maxTokens !== null;
  return has(agent.overrides, key);
}

function globalSettings() {
  return store.get('settings') || {};
}

function clampInt(n, min, max, fallback) {
  const v = parseInt(n, 10);
  return Number.isFinite(v) && v >= 0 ? Math.min(Math.max(v, min), max) : fallback;
}

/**
 * The effective value for one agent right now.
 *
 * Unlocked settings are read from the global settings on every call, so a
 * change made in Config reaches every unlocked agent immediately.
 */
export function settingFor(agent, key) {
  const s = globalSettings();
  const o = overridesOf(agent);

  switch (key) {
    case 'temperature':
      return agent?.temperature ?? s.temperature ?? 1;
    case 'maxTokens':
      return agent?.maxTokens ?? s.maxTokens ?? 16384;
    case 'historyTurns':
      return has(o, 'historyTurns') ? o.historyTurns : (s.historyTurns ?? DEFAULT_HISTORY_TURNS);
    case 'rateEnabled':
      return has(o, 'rateEnabled') ? o.rateEnabled : (s.rateLimitEnabled !== false);
    case 'rateRpm':
      return has(o, 'rateRpm') ? o.rateRpm : clampInt(s.rateLimitRpm, 0, 600, 0);
    case 'rateMaxWaitMs':
      return has(o, 'rateMaxWaitMs') ? o.rateMaxWaitMs : clampInt(s.rateLimitMaxWaitMs, 1000, 600000, 65000);
    case 'rateStealth':
      return has(o, 'rateStealth') ? o.rateStealth : (s.rateLimitStealth !== false);
    case 'tokenBudget':
      return has(o, 'tokenBudget') ? o.tokenBudget : (s.tokenBudget ?? 0);
    case 'autoApprove':
      return has(o, 'autoApprove') ? o.autoApprove : (s.autoApprove === true);
    case 'autoDeny':
      return has(o, 'autoDeny') ? o.autoDeny : (s.autoDeny === true);
    case 'toolPolicy':
      return has(o, 'toolPolicy') ? o.toolPolicy : (s.toolPolicy || {});
    default:
      return undefined;
  }
}

/** The global value for a key, ignoring this agent's override. */
export function globalFor(key) {
  const s = globalSettings();
  switch (key) {
    case 'temperature': return s.temperature ?? 1;
    case 'maxTokens': return s.maxTokens ?? 16384;
    case 'historyTurns': return s.historyTurns ?? DEFAULT_HISTORY_TURNS;
    case 'rateEnabled': return s.rateLimitEnabled !== false;
    case 'rateRpm': return clampInt(s.rateLimitRpm, 0, 600, 0);
    case 'rateMaxWaitMs': return clampInt(s.rateLimitMaxWaitMs, 1000, 600000, 65000);
    case 'rateStealth': return s.rateLimitStealth !== false;
    case 'tokenBudget': return s.tokenBudget ?? 0;
    case 'autoApprove': return s.autoApprove === true;
    case 'autoDeny': return s.autoDeny === true;
    case 'toolPolicy': return s.toolPolicy || {};
    default: return undefined;
  }
}

/**
 * Pin the CURRENT GLOBAL value onto the agent.
 *
 * Uses the global value, not the agent's effective one, because locking an
 * unlocked setting means "keep what the global is doing right now"; copying an
 * effective value would be the same thing today and diverge the moment an
 * override existed, which is exactly the state the lock button must avoid.
 */
export function lockSetting(agent, key) {
  if (!agent) return;
  if (key === 'temperature') { agent.temperature = globalFor('temperature'); return; }
  if (key === 'maxTokens') { agent.maxTokens = globalFor('maxTokens'); return; }
  agent.overrides = { ...(agent.overrides || {}), [key]: globalFor(key) };
}

/** Drop the override; the agent follows the global setting again. */
export function unlockSetting(agent, key) {
  if (!agent) return;
  if (key === 'temperature') { delete agent.temperature; return; }
  if (key === 'maxTokens') { delete agent.maxTokens; return; }
  if (!agent.overrides) return;
  const next = { ...agent.overrides };
  delete next[key];
  agent.overrides = next;
}

/** Write a locked value. Unlocked settings must be locked first by the UI. */
export function setSetting(agent, key, value) {
  if (!agent) return;
  if (key === 'temperature') { agent.temperature = value; return; }
  if (key === 'maxTokens') { agent.maxTokens = value; return; }
  agent.overrides = { ...(agent.overrides || {}), [key]: value };
}

/** Any rate lock means this agent gets its own pacing bucket. */
export function hasRateLock(agent) {
  return ['rateEnabled', 'rateRpm', 'rateMaxWaitMs', 'rateStealth'].some(k => isLocked(agent, k));
}

/**
 * The filesystem jail this agent works in.
 *
 * A per-agent choice wins; otherwise every agent follows the global working
 * directory. The server still checks the result against the allowlist, so this
 * is a scope, not a permission grant.
 */
export function sandboxRootFor(agent) {
  const own = String(agent?.sandboxRoot || '').trim();
  if (own) return own;
  return String(store.get('settings.projectDir') || '').trim();
}

// ---------------------------------------------------------------- profiles

const newProfileId = () =>
  'prof_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

export function profiles() {
  const list = store.get('settings.brainProfiles');
  return Array.isArray(list) ? list : [];
}

/** Profiles attached (locked) to an agent, resolved in attachment order. */
export function profileTextsFor(agent) {
  const ids = Array.isArray(agent?.profileIds) ? agent.profileIds : [];
  if (!ids.length) return [];
  const all = profiles();
  return ids
    .map(id => all.find(p => p.id === id))
    .filter(Boolean)
    .map(p => String(p.text || '').trim())
    .filter(Boolean);
}

/**
 * The always-append block: the agent's own "custom" box plus every locked
 * profile. Unlike systemPrompt, this is never replaced by the global override —
 * that is the whole point of the box existing.
 */
export function alwaysAppendFor(agent) {
  const parts = [];
  const custom = String(agent?.customPrompt || '').trim();
  if (custom) parts.push(custom);
  parts.push(...profileTextsFor(agent));
  return parts.join('\n\n');
}

export { newProfileId };

// ---------------------------------------------------------------- notes

/** Brain Lab's own scratchpad. User-owned, not injected into any prompt. */
export const NOTES_KEY = 'settings.brainNotes';
export const getNotes = () => String(store.get('settings.brainNotes') || '');
