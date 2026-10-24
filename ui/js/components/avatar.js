/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// AVATAR.JS — user + agent avatars
// ============================================
//
// The SVGs live in ui/img/ and are fetched once, then inlined into the DOM.
// Paths are resolved off this module's own URL so the app stays portable.
// Inlining matters: the robot's pupils are inner elements, so CSS can only
// animate them if the markup is in the document rather than inside an <img>.
//
// The robot's eyes scan side to side ONLY while that agent is working
// (.avatar-agent.thinking) — at rest the pupils sit centered.

import { store } from '../store.js?v=322';

const SRC_USER = new URL('../../img/avatar-user.svg', import.meta.url).href;
const SRC_AGENT = new URL('../../img/avatar-agent.svg', import.meta.url).href;

const cache = { user: null, agent: null };
const inflight = {};

/** Fetch an SVG once and keep the markup for reuse. */
async function loadSvg(kind, url) {
  if (cache[kind]) return cache[kind];
  if (!inflight[kind]) {
    inflight[kind] = fetch(url)
      .then(r => (r.ok ? r.text() : ''))
      .then(txt => (cache[kind] = txt || null))
      .catch(() => (cache[kind] = null));
  }
  return inflight[kind];
}

/** Warm the cache; call during boot so the first message paints instantly. */
export function preloadAvatars() {
  loadSvg('user', SRC_USER);
  loadSvg('agent', SRC_AGENT);
}

/**
 * Build an avatar element synchronously; the SVG fills in when it arrives.
 * Message rendering is synchronous, so callers get the element immediately
 * and layout never jumps.
 */
export function createAvatar(role, agentId = null) {
  const el = document.createElement('div');
  el.className = `message-avatar ${role === 'user' ? 'avatar-user' : 'avatar-agent'}`;
  el.classList.add('avatar-loading');

  if (agentId) {
    const agent = (store.get('agents') || []).find(a => a.id === agentId);
    if (agent) {
      el.style.setProperty('--agent-color', agent.color);
      el.dataset.agentId = agentId;
    }
  }

  const isUser = role === 'user';
  const src = isUser ? SRC_USER : SRC_AGENT;
  fill(el, isUser, src);
  return el;
}

/** Inline the SVG (or fall back to <img>) once it has loaded. */
function fill(el, isUser, src) {
  loadSvg(isUser ? 'user' : 'agent', src).then(markup => {
    if (!el.isConnected) return;
    el.classList.remove('avatar-loading');
    if (markup) {
      const holder = document.createElement('span');
      holder.className = 'avatar-svg';
      holder.innerHTML = markup;
      const svg = holder.querySelector('svg');
      if (svg) {
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
      }
      el.appendChild(holder);
    } else {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.width = 20;
      img.height = 20;
      img.draggable = false;
      el.appendChild(img);
    }
  });
}

/**
 * Watch agent status and toggle the eye-scan class on every rendered avatar
 * for that agent. Called once at boot.
 */
export function wireAvatarThinking() {
  const setThinking = (agentId, thinking) => {
    document.querySelectorAll(`.avatar-agent[data-agent-id="${cssEscape(agentId)}"]`)
      .forEach(el => el.classList.toggle('thinking', !!thinking));
  };

  store.on('agent:status', ({ agentId, status }) => {
    if (!agentId) return;
    const busy = status === 'thinking' || status === 'active';
    setThinking(agentId, busy);
    // When an agent goes idle, make sure the typing-dots robot also stops.
    if (status === 'idle') setThinking(agentId, false);
  });

  store.on('agents:changed', () => {
    document.querySelectorAll('.avatar-agent[data-agent-id]').forEach(el => {
      const agent = (store.get('agents') || []).find(a => a.id === el.dataset.agentId);
      if (agent) el.style.setProperty('--agent-color', agent.color);
    });
  });
}

/** Minimal attribute-selector escaping for agent ids. */
function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}