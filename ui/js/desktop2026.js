/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// DESKTOP2026.JS — the Desktop 2026 glass shell (opt-in)
// ============================================
//
// Pairs with ui/css/desktop2026.css. This is a SHELL, not the app: it wears only
// when BOTH are true --
//   1. the operator picked "Desktop 2026" in Config → Interface (classic is the
//      default, and anything unrecognised counts as classic: see ifaceMode.js), and
//   2. the window is at least 1025px wide.
// Below that width, and whenever classic is chosen, nothing here runs and the
// app is exactly the layout it has always had; the slide-over drawer layout on
// narrow windows is layout.css alone and is identical in both shells. Nothing
// in the app depends on this module: it only decorates the DOM the existing
// components already render.
//
// The Config "Desktop" card is the one exception. Most of it is map settings
// (detail, frame cap, fog, bloom, floor pinning, the performance preset), so it
// is kept in BOTH shells; only the rows that address the glass itself are
// switched off in classic, never removed.
//
//  - left stack: glass cards, edge rail, half-swirl tab change
//  - config: drawers fly out to the right of the label, then drop down;
//    a click anywhere outside an open drawer closes it
//  - map: fixed polar floor; its button group sits centred in the header,
//    above the apps drop-down; panels tuck away while a node card is open
//  - chat: drag-to-widen, expand-to-screen, adjustable background alpha

import { store } from './store.js?v=337';
import { persistence } from './persistence.js?v=337';
import { planDrawer } from './drawerState.js?v=337';
import { resolveIface, normalizeIface, IFACE_EVENT } from './ifaceMode.js?v=337';

const MQ = window.matchMedia('(min-width: 1025px)');
const root = document.documentElement;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const CHAT_W_KEY = 'd26.chatWidth';
const CHAT_W_DEFAULT = 440;
const STACK_RIGHT = 76 + 324;           // --d26-stack-l + --d26-stack-w
const CARD_SEL = '.agent-row, .agent-editor, .provider-card, .provider-row, .provider-editor, .proxy-row, .cfg-section, .cfg-cluster';

let on = false;
let swirling = false;
let fly = null;                         // { section, body, head }
let closing = null;                     // section whose drawer is retracting
let passThrough = false;
let enterTimer = 0;
let decorateQueued = false;

const $body = () => document.getElementById('sidebarBody');
const $tabs = () => [...document.querySelectorAll('.sidebar-nav .nav-btn')];
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- interface
/** The shell the operator picked in Config → Interface ('classic' by default). */
function ifaceMode() { return normalizeIface(store.get('settings.interfaceMode')); }

/**
 * Wear the glass only when it was asked for AND the window can hold it. The
 * width half of this is what keeps every phone and narrow window on the same
 * drawer layout it has always had, in either mode.
 */
function wantsSkin() { return resolveIface({ mode: ifaceMode(), wide: MQ.matches }) === 'desktop'; }

// ---------------------------------------------------------------- settings
function setting(key, dflt) {
  const v = store.get('settings.' + key);
  return v === undefined || v === null ? dflt : v;
}
function saveSetting(key, value) {
  store.set('settings.' + key, value);
  try { persistence.set('settings', store.get('settings')); } catch { /* view pref only */ }
}

// --------------------------------------------------------------------- css
function ensureCss() {
  if (document.querySelector('link[data-d26]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'ui/css/desktop2026.css?v=337';
  l.dataset.d26 = '1';
  document.head.appendChild(l);
}

// -------------------------------------------------------------- the rail
function wrapRail(wrap) {
  $tabs().forEach(btn => {
    const span = btn.querySelector('.d26-rail-label');
    if (wrap && !span) {
      const label = document.createElement('span');
      label.className = 'd26-rail-label';
      label.textContent = btn.textContent.trim();
      btn.textContent = '';
      btn.appendChild(label);
    } else if (!wrap && span) {
      btn.textContent = span.textContent;
    }
  });
}

function activeTab() {
  return document.querySelector('.sidebar-nav .nav-btn.active')?.dataset.tab || 'sessions';
}

function setTabAttr() { root.dataset.d26Tab = activeTab(); }

// ------------------------------------------------------------ card decor
function decorate() {
  decorateQueued = false;
  if (!on) return;
  const body = $body();
  if (!body) return;
  setTabAttr();
  const tab = root.dataset.d26Tab;
  const cards = [...body.querySelectorAll(CARD_SEL)];
  // Providers render their own row markup; treat each top-level block that is
  // not a header/list wrapper as a card so that stack floats like the rest.
  if (tab === 'providers') {
    [...body.children].forEach(el => {
      if (cards.includes(el) || /^(SCRIPT|STYLE)$/.test(el.tagName)) return;
      if (el.matches('.sidebar-section-header, .proxy-header, .proxy-stats, .proxy-list, .empty, .cfg-savebar, .agent-menu')) return;
      if (el.querySelector(CARD_SEL)) return;
      cards.push(el);
    });
  }
  cards.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  cards.forEach((el, i) => {
    el.classList.add('d26-card');
    el.style.setProperty('--d26-i', String(Math.min(i, 14)));
    // Agent cards run their animated border in the colour the operator chose
    // for that agent, not the tab accent, so the stack reads per-agent.
    if (el.classList.contains('agent-editor')) {
      const agent = (store.get('agents') || []).find(a => a.id === el.dataset.agentId);
      if (agent && agent.color) el.style.setProperty('--d26-c', agent.color);
    }
  });
  if (tab === 'config') {
    injectDesktopConfig(body);
    if (fly && !fly.section.isConnected) dropFlyState();
    requestAnimationFrame(() => syncFly(null));
  } else if (fly) {
    closeFly(false);
  }
}

function queueDecorate() {
  if (decorateQueued) return;
  decorateQueued = true;
  requestAnimationFrame(decorate);
}

// --------------------------------------------------- config: own section
function injectDesktopConfig(body) {
  if (body.querySelector('[data-d26-own]')) return;
  const el = document.createElement('details');
  el.className = 'cfg-section d26-card';
  el.dataset.d26Own = '1';
  el.innerHTML = `
    <summary class="cfg-section-head" style="list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:12px 14px">
      <span class="cfg-section-title">Desktop</span>
      <span class="cfg-chevron">&#8250;</span>
    </summary>
    <div class="cfg-body">
      <div class="form-hint" id="d26SkinNote" hidden>Rows about glass, glow, motion, chat transparency and the floating floor belong to the <b>Desktop 2026</b> interface. In Classic they keep their saved values but cannot be operated here &mdash; nothing is removed. Everything else on this card &mdash; performance mode, map detail, frames per second, fog, bloom and floor pinning &mdash; applies to Classic as well.</div>
      <div class="form-group">
        <label class="form-label"><input type="checkbox" id="d26Perf"> Performance mode <span class="form-hint-inline">for a low-powered machine</span></label>
        <div class="form-hint">One click: no frosted glass, no border glow, no ambient motion, no fog, no bloom, no floating floor and no auto-rotate, at half the frame rate, with the map drawn at 70% detail and resting when nothing is happening. These are the <b>same settings as the controls below</b> —  nothing is removed and every one can be changed back on its own. Anything you had already set cheaper is left alone. Switch this off and the values you had before return (anything you moved by hand in the meantime stays where you put it).</div>
      </div>
      <div class="form-group">
        <label class="form-label"><input type="checkbox" id="d26AutoHide"> Tuck panels away while a node card is open</label>
        <div class="form-hint">Clicking a node on the map slides the left stack and the chat to the screen edges until its card is closed. Not used while the map is in its own full-window mode. Dragging or zooming the map never moves the panels.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Chat background <span class="form-hint-inline" id="d26AlphaVal"></span></label>
        <input type="range" class="form-input" id="d26ChatAlpha" min="0" max="100" step="1">
        <div class="form-hint">0% lets the map show straight through the chat, 100% is solid.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Glass blur <span class="form-hint-inline" id="d26BlurVal"></span></label>
        <input type="range" class="form-input" id="d26BlurRange" min="0" max="24" step="1">
        <div class="form-hint">Frosted-glass blur behind the cards and panels. This is the single biggest GPU cost of the desktop skin — drag it to 0 for a flat, fastest look.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Glow &amp; border animation <span class="form-hint-inline" id="d26GlowVal"></span></label>
        <input type="range" class="form-input" id="d26GlowRange" min="0" max="100" step="5">
        <div class="form-hint">The colour that runs around the card borders. 0 turns it off (flat borders), 100% is the full glow.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Ambient motion <span class="form-hint-inline" id="d26MotionVal"></span></label>
        <input type="range" class="form-input" id="d26MotionRange" min="0" max="100" step="5">
        <div class="form-hint">Background sweep, floor scan and the slow breathing. 0 stops them completely (calmest / cheapest), 100% is full speed.</div>
      </div>
      <div class="form-group">
        <label class="form-label"><input type="checkbox" id="d26FogToggle"> Background fog <span class="form-hint-inline" id="d26FogVal"></span></label>
        <div class="form-hint">A haze that starts past the grid, under the map, and fades into the distance. Uncheck to remove it entirely.</div>
      </div>
      <div class="form-group">
        <label class="form-label"><input type="checkbox" id="d26Bloom"> Bloom glow <span class="form-hint-inline">post-process halos</span></label>
        <div class="form-hint">The soft light bleeding out of nodes and beams. Off keeps every emissive colour and drops the multi-pass blur, which is the most expensive fill-rate item on the map.</div>
      </div>
      <div class="form-group">
        <label class="form-label"><input type="checkbox" id="d26FloorToggle"> Floating floor <span class="form-hint-inline">grid under the whole window</span></label>
        <div class="form-hint">The fixed polar grid drawn under everything. Off falls back to the inexpensive grid that lives inside the 3D scene itself, so the depth cue stays.</div>
      </div>
      <div class="form-group">
        <label class="form-label"><input type="checkbox" id="d26FloorFix"> Fix the floor in place <span class="form-hint-inline" id="d26FloorFixVal"></span></label>
        <div class="form-hint">Used while the floating floor is off. The fallback grid is part of the 3D scene, so orbiting the map carries it around and a low angle squashes it into a line. This holds it still in the window instead &mdash; the same spot at every angle &mdash; and orbiting, dragging and zooming the map all keep working normally.</div>
      </div>
      <div class="form-group">
        <label class="form-label"><input type="checkbox" id="d26AutoRotate"> Slow auto-rotate <span class="form-hint-inline">idle camera drift</span></label>
        <div class="form-hint">The drift that resumes 12s after you stop touching the map. Off parks the view until you orbit it yourself — and lets the scene, and everything composited over it, go genuinely idle.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Topography frames per second</label>
        <input type="number" class="form-input" id="d26Fps" min="1" max="60" step="1" style="max-width:84px">
        <div class="form-hint">Hard cap on how often the map redraws. Lower it to cut GPU use on a warm machine; 60 is the browser default.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Map detail <span class="form-hint-inline" id="d26QualityVal"></span></label>
        <input type="range" class="form-input" id="d26QualityRange" min="0" max="4" step="1">
        <div class="form-hint">How many pixels the topography itself is drawn at. Full is the sharpest; each step down draws fewer of them, which softens the lines and labels and relieves a weak GPU. Unlike the old automatic shrink, this stays exactly where you put it &mdash; the map never lowers its own detail while you use it.</div>
      </div>
    </div>`;
  const sections = [...body.querySelectorAll('.cfg-section')]
    .filter(s => s !== el && !s.parentElement.closest('.cfg-section'));
  const last = sections.pop();
  if (last) last.after(el);
  else {
    const save = body.querySelector('.cfg-savebar');
    if (save) save.before(el); else body.appendChild(el);
  }

  const auto = el.querySelector('#d26AutoHide');
  auto.checked = setting('d26AutoHide', true) !== false;
  auto.addEventListener('change', () => {
    saveSetting('d26AutoHide', auto.checked);
    store.emit('toast', { message: `Panels ${auto.checked ? 'tuck away' : 'stay put'} when a node card opens`, type: 'info' });
    syncMin();
  });
  const slider = el.querySelector('#d26ChatAlpha');
  const val = el.querySelector('#d26AlphaVal');
  const pct = Math.round(chatAlpha() * 100);
  slider.value = String(pct);
  val.textContent = pct + '%';
  slider.addEventListener('input', () => {
    val.textContent = slider.value + '%';
    applyAlpha(Number(slider.value) / 100);
  });
  slider.addEventListener('change', () => saveSetting('d26ChatAlpha', Number(slider.value) / 100));

  const blur = el.querySelector('#d26BlurRange');
  const blurOut = el.querySelector('#d26BlurVal');
  blur.value = String(blurPx());
  blurOut.textContent = blurPx() + 'px';
  blur.addEventListener('input', () => { blurOut.textContent = blur.value + 'px'; applyBlur(Number(blur.value)); });
  blur.addEventListener('change', () => saveSetting('d26Blur', Number(blur.value)));

  const glow = el.querySelector('#d26GlowRange');
  const glowOut = el.querySelector('#d26GlowVal');
  glow.value = String(glowPct());
  glowOut.textContent = glowPct() + '%';
  glow.addEventListener('input', () => { glowOut.textContent = glow.value + '%'; applyGlow(Number(glow.value)); });
  glow.addEventListener('change', () => saveSetting('d26Glow', Number(glow.value)));

  const motion = el.querySelector('#d26MotionRange');
  const motionOut = el.querySelector('#d26MotionVal');
  motion.value = String(motionPct());
  motionOut.textContent = motionPct() + '%';
  motion.addEventListener('input', () => { motionOut.textContent = motion.value + '%'; applyMotion(Number(motion.value)); });
  motion.addEventListener('change', () => saveSetting('d26Motion', Number(motion.value)));

  const fogT = el.querySelector('#d26FogToggle');
  const fogOut = el.querySelector('#d26FogVal');
  fogT.checked = topoFogMode() !== 2;   // on unless explicitly Off
  fogOut.textContent = fogT.checked ? 'on' : 'off';
  fogT.addEventListener('change', () => {
    const val = fogT.checked ? 1 : 2;   // 1 = background fog, 2 = off
    fogOut.textContent = fogT.checked ? 'on' : 'off';
    store.set('settings.topoFog', val);
    saveSetting('topoFog', val);
    applyTopoSettings();
  });

  const fps = el.querySelector('#d26Fps');
  fps.value = String(topoFps());
  fps.addEventListener('input', () => {
    const n = Math.max(1, Math.min(60, parseInt(fps.value, 10) || 60));
    store.set('settings.topoFps', n);
    applyTopoSettings();
  });
  fps.addEventListener('change', () => {
    const n = Math.max(1, Math.min(60, parseInt(fps.value, 10) || 60));
    fps.value = String(n);
    saveSetting('topoFps', n);
  });

  // Map quality: each one a normal setting with its own control, so the
  // performance preset above is only a convenient set of values.
  const bloom = el.querySelector('#d26Bloom');
  bloom.checked = setting('topoBloom', true) !== false;
  bloom.addEventListener('change', () => {
    saveSetting('topoBloom', bloom.checked);
    applyTopoSettings();
  });

  const floorT = el.querySelector('#d26FloorToggle');
  floorT.checked = floorOn();
  floorT.addEventListener('change', () => {
    saveSetting('topoFloor', floorT.checked);
    applyFloor();
  });

  const fixT = el.querySelector('#d26FloorFix');
  fixT.checked = floorFixed();
  fixT.addEventListener('change', () => {
    saveSetting('topoFloorFixed', fixT.checked);
    applyTopoSettings();
    syncFloorControls();
  });

  const quality = el.querySelector('#d26QualityRange');
  const qualityOut = el.querySelector('#d26QualityVal');
  quality.value = String(topoQualityIndex());
  qualityOut.textContent = qualityLabel();
  quality.addEventListener('input', () => {
    qualityOut.textContent = TOPO_QUALITY_LABELS[Number(quality.value)] || '';
    store.set('settings.topoQuality', TOPO_QUALITY[Number(quality.value)]);
    applyTopoSettings();
  });
  quality.addEventListener('change', () => saveSetting('topoQuality', TOPO_QUALITY[Number(quality.value)]));

  const rot = el.querySelector('#d26AutoRotate');
  rot.checked = setting('topoAutoRotate', true) !== false;
  rot.addEventListener('change', () => {
    saveSetting('topoAutoRotate', rot.checked);
    applyTopoSettings();
  });

  const perf = el.querySelector('#d26Perf');
  perf.checked = perfMode();
  perf.addEventListener('change', () => {
    setPerf(perf.checked);
    store.emit('toast', {
      message: perf.checked
        ? 'Performance mode on — glass, glow, bloom, floor, drift and full map detail are off; every knob below still works'
        : 'Performance mode off — your previous Desktop values are back',
      type: 'info',
    });
  });

  syncPerfControls();
}

// Rows that address the glass itself rather than the map. They stay in the card
// in both interfaces -- with their values -- but only the shell can operate them.
const SKIN_ONLY = ['d26AutoHide', 'd26ChatAlpha', 'd26BlurRange', 'd26GlowRange', 'd26MotionRange', 'd26FloorToggle'];

function syncSkinOnly() {
  SKIN_ONLY.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
  const note = document.getElementById('d26SkinNote');
  if (note) note.hidden = !!on;
  syncFloorControls();
}

/** The Config tab body, or null when that is not the tab on screen. */
function configBody() {
  if (activeTab() !== 'config') return null;
  return $body();
}

/**
 * Put the Desktop card back when a sidebar render has taken it away.
 *
 * It began as part of the skin, but an operator on Classic still needs the map
 * settings it carries. Only the glass rows are disabled there, and their values
 * survive so switching the shell back on changes nothing they had chosen.
 *
 * This is called from a childList observer, so it has to do NOTHING once the
 * card exists. Injecting builds text nodes (labels, values), and every one of
 * those writes is itself a childList mutation: doing the work unconditionally
 * re-entered the observer forever and the page had to be killed.
 */
function syncDesktopConfig() {
  const body = configBody();
  if (!body) return;
  if (body.querySelector('[data-d26-own]')) return;
  injectDesktopConfig(body);
  syncSkinOnly();
}

// -------------------------------------------------- config: side drawers
function sectionIsOpen(s) {
  return !!(s && (s.open === true || s.classList.contains('open') || s.classList.contains('is-open')));
}

function toggleSection(s) {
  if (!s || !s.isConnected) return;
  if (s.tagName === 'DETAILS') { s.open = !s.open; return; }
  const head = s.querySelector('.cfg-section-head');
  if (!head) return;
  passThrough = true;
  try { head.click(); } finally { passThrough = false; }
}

function topSections() {
  const body = $body();
  if (!body) return [];
  return [...body.querySelectorAll('.cfg-section')].filter(s => !s.parentElement.closest('.cfg-body'));
}

/**
 * Where the section's label sits inside the drawer's own box.
 *
 * placeFly() raises a drawer for a section low enough that it would not fit, so
 * the label's row is not always level with the drawer's top. Both animations
 * measure it here and fold the panel into -- or out of -- that row, so opening
 * and closing always read as the label's line rather than the drawer's corner.
 */
function labelBand(head, body) {
  const box = body.getBoundingClientRect();
  const row = head.getBoundingClientRect();
  const hh = Math.round(row.height) || 44;
  const bh = Math.round(box.height) || hh;
  return {
    hh,
    bh,
    top: Math.max(0, Math.min(Math.max(0, bh - hh), Math.round(row.top - box.top))),
  };
}

/** Unfold out of the label: a sliver on its row, then full width, then full height. */
function flyFrames(hh, top = 0) {
  const r = ' round 14px';
  const bar = `calc(100% - ${hh + top}px)`;
  return [
    { clipPath: `inset(${top}px 100% ${bar} 0${r})`, opacity: 0.4 },
    { clipPath: `inset(${top}px 0 ${bar} 0${r})`, opacity: 1, offset: 0.42 },
    { clipPath: `inset(0 0 0 0${r})`, opacity: 1 },
  ];
}

/**
 * Retract into the label, in one motion.
 *
 * The close used to be flyFrames() played backwards: the panel folded up into a
 * full-width bar first and only then wiped away leftwards, so it read as two
 * moves -- and for a section low in the stack that bar sat on the drawer's top,
 * not on the label's row. This collapses on both axes at once, straight back to
 * the row that opened it, so the last thing on screen is the panel narrowing
 * into its label instead of a curtain running across the map.
 */
function closeFrames(head, body) {
  const r = ' round 14px';
  const { hh, bh, top } = labelBand(head, body);
  const w = Math.round(body.getBoundingClientRect().width) || 1;
  return [
    { clipPath: `inset(0 0 0 0${r})`, opacity: 1 },
    { clipPath: `inset(${top}px ${w}px ${Math.max(0, bh - top - hh)}px 0${r})`, opacity: 0.35 },
  ];
}

function placeFly() {
  if (!fly) return;
  const stack = $body()?.getBoundingClientRect();
  const head = fly.head.getBoundingClientRect();
  if (!stack) return;
  const chatW = parseFloat(getComputedStyle(root).getPropertyValue('--d26-chat-w')) || CHAT_W_DEFAULT;
  const x = Math.round(stack.right + 2);
  const room = window.innerWidth - x - chatW - 36;
  const w = Math.round(Math.max(300, Math.min(420, room)));
  let y = Math.round(head.top);
  const minH = 260;
  if (window.innerHeight - y - 18 < minH) y = Math.max(72, window.innerHeight - 18 - minH);
  const h = Math.round(window.innerHeight - y - 18);
  const st = fly.body.style;
  st.setProperty('--fx', x + 'px');
  st.setProperty('--fy', y + 'px');
  st.setProperty('--fw', w + 'px');
  st.setProperty('--fh', h + 'px');
  // Label scrolled out of the stack: the drawer has nothing to hang off.
  if (head.bottom < stack.top + 4 || head.top > stack.bottom - 4) closeFly(true);
}

/**
 * Drop any clip animation still on the body before starting the next one.
 *
 * Open and close animate the same element, so a close started while the open
 * was still playing left two animations fighting over clip-path -- the newer
 * one fills forwards, the older keeps running underneath, and whichever ends
 * last decides what is on screen. One animation at a time, always.
 */
function stopAnimating(el) {
  el.getAnimations().forEach(a => { try { a.cancel(); } catch { /* already gone */ } });
}

function openFly(section) {
  // Opening the section that was retracting cancels the retract: this drawer
  // owns the body again, so a pending close must not tidy up after it.
  if (closing === section) closing = null;
  const body = section.querySelector(':scope > .cfg-body') || section.querySelector('.cfg-body');
  const head = section.querySelector(':scope > .cfg-section-head') || section.firstElementChild;
  if (!body || !head) return;
  body.classList.add('d26-fly');
  if (getComputedStyle(body).display === 'none') body.style.display = 'block';
  section.classList.add('d26-fly-open');
  root.classList.add('d26-flyout');
  fly = { section, body, head };
  placeFly();
  stopAnimating(body);
  if (!reduced()) {
    const band = labelBand(head, body);
    body.animate(flyFrames(band.hh, band.top), { duration: 640, easing: EASE });
  }
}

function dropFlyState() {
  fly = null;
  closing = null;
  root.classList.remove('d26-flyout');
}

function closeFly(animated = true) {
  const f = fly;
  if (!f) return Promise.resolve();
  fly = null;
  // Remember what is retracting. `fly` is cleared immediately so a click
  // during the animation is not read as "this drawer is out", but the section
  // is still open for another 440ms -- syncFly must not mistake that for a
  // request to open it (see below).
  closing = f.section;
  const done = () => {
    if (closing === f.section) closing = null;
    // A drawer was opened on this section again while it retracted: leave the
    // element to that one instead of stripping its classes and closing it.
    if (fly && fly.section === f.section) return;
    f.body.classList.remove('d26-fly');
    f.body.style.removeProperty('display');
    ['--fx', '--fy', '--fw', '--fh'].forEach(p => f.body.style.removeProperty(p));
    f.section.classList.remove('d26-fly-open');
    if (!fly) root.classList.remove('d26-flyout');
    if (sectionIsOpen(f.section)) toggleSection(f.section);
  };
  if (!animated || reduced() || !f.body.isConnected) { done(); return Promise.resolve(); }
  stopAnimating(f.body);
  const a = f.body.animate(closeFrames(f.head, f.body),
    { duration: 440, easing: 'cubic-bezier(0.5, 0, 0.75, 0.3)', fill: 'forwards' });
  return a.finished.then(() => { done(); a.cancel(); }, done);
}

/**
 * Follow the app's own open/closed state and keep exactly one drawer out.
 *
 * The decision itself is planDrawer() in drawerState.js, which is DOM-free so
 * the race below can be tested: a section that is still retracting is skipped,
 * because its <details> stays open for the whole close animation and the Config
 * tab repaints its live status lines throughout. Picking that section up again
 * replayed the OPEN animation on an element the CLOSE animation was still
 * filling, so the drawer popped back in on the last fifth of the close and
 * vanished a second time.
 */
function syncFly(clicked) {
  if (!on || root.dataset.d26Tab !== 'config') return;
  if (fly && !fly.section.isConnected) dropFlyState();
  if (closing && !closing.isConnected) closing = null;
  const plan = planDrawer({
    open: topSections().filter(sectionIsOpen),
    current: fly ? fly.section : null,
    closing,
    clicked: clicked && clicked.isConnected && sectionIsOpen(clicked) ? clicked : null,
  });
  if (!plan) return;
  if (plan.closePrev) closeFly(true);
  plan.close.forEach(toggleSection);
  openFly(plan.target);
}

function onConfigClick(e) {
  if (!on || passThrough || root.dataset.d26Tab !== 'config') return;
  const head = e.target.closest('.cfg-section-head');
  if (!head) return;
  const section = head.closest('.cfg-section');
  if (!section || section.parentElement.closest('.cfg-body')) return;
  // Closing the drawer that is out: play the drop-up / retract first, then
  // let the section close itself.
  if (fly && fly.section === section) {
    e.preventDefault();
    e.stopPropagation();
    closeFly(true);
    return;
  }
  requestAnimationFrame(() => syncFly(section));
}

/** A press anywhere outside the open drawer closes it (animated). */
function onOutsidePress(e) {
  if (!on || !fly) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (fly.section.contains(t)) return;                 // its label or its drawer
  if (t.closest('.cfg-section-head')) return;          // another label: normal swap
  if (t.closest('.modal-bg, .modal, .approve-box, .toast-container')) return;
  const body = $body();
  if (t === body && e.offsetX >= body.clientWidth) return;   // the stack's own scrollbar
  closeFly(true);
}

// ------------------------------------------------------ half-swirl tabs
function onNavClick(e) {
  if (!on) return;
  const btn = e.target.closest('.nav-btn');
  if (!btn) return;
  if (btn.classList.contains('active')) return;
  if (swirling) { e.stopImmediatePropagation(); e.preventDefault(); return; }
  const tabs = $tabs();
  const from = tabs.findIndex(t => t.classList.contains('active'));
  const to = tabs.indexOf(btn);
  const dir = to >= from ? 1 : -1;
  closeFly(false);
  swirl(dir);
}

function swirl(dir) {
  const body = $body();
  if (!body) return;
  if (reduced()) {
    requestAnimationFrame(() => { setTabAttr(); queueDecorate(); });
    return;
  }
  swirling = true;

  // Snapshot the outgoing stack so it can spin away while the real body
  // already holds the next tab's cards.
  const ghost = body.cloneNode(true);
  ghost.removeAttribute('id');
  ghost.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
  ghost.classList.add('d26-ghost');
  ghost.classList.remove('d26-enter');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.pointerEvents = 'none';
  ghost.style.zIndex = '19';
  ghost.style.transformOrigin = 'left center';
  document.body.appendChild(ghost);
  ghost.scrollTop = body.scrollTop;

  const out = ghost.animate([
    { transform: 'none', opacity: 1, filter: 'blur(0px)' },
    { transform: `translate(-30%, ${dir * 4}%) perspective(1000px) rotateY(48deg) rotateZ(${-4 * dir}deg) scale(0.8)`, opacity: 0.7, offset: 0.45 },
    { transform: `translate(-62%, ${dir * 8}%) perspective(1000px) rotateY(84deg) rotateZ(${-9 * dir}deg) scale(0.5)`, opacity: 0, filter: 'blur(3px)' },
  ], { duration: 640, easing: 'cubic-bezier(0.5, 0, 0.7, 0.4)', fill: 'forwards' });

  // The sidebar's own click handler renders the new tab right after this
  // capture listener returns; pick it up on the next frame.
  requestAnimationFrame(() => {
    setTabAttr();
    decorate();
    body.scrollTop = 0;
    body.style.transformOrigin = 'left center';
    restartEnter(body);
    const inn = body.animate([
      { transform: `translate(-55%, ${-dir * 8}%) perspective(1000px) rotateY(-80deg) rotateZ(${9 * dir}deg) scale(0.55)`, opacity: 0, filter: 'blur(3px)' },
      { transform: `translate(-18%, ${-dir * 3}%) perspective(1000px) rotateY(-34deg) rotateZ(${3 * dir}deg) scale(0.86)`, opacity: 0.85, offset: 0.55 },
      { transform: 'none', opacity: 1, filter: 'blur(0px)' },
    ], { duration: 820, delay: 120, easing: EASE, fill: 'backwards' });

    Promise.allSettled([out.finished, inn.finished]).then(() => {
      ghost.remove();
      body.style.removeProperty('transform-origin');
      swirling = false;
    });
  });
}

function restartEnter(body) {
  clearTimeout(enterTimer);
  body.classList.remove('d26-enter');
  void body.offsetWidth;
  body.classList.add('d26-enter');
  // Only the arrival deals the cards in; later re-renders (status lights,
  // clocks) must not replay it.
  enterTimer = setTimeout(() => body.classList.remove('d26-enter'), 2600);
}

// --------------------------------------------- panels tuck to the edges
function popupOpen() {
  const p = document.querySelector('#topologyContainer .t3d-popup');
  return !!(p && !p.hidden);
}

function syncMin() {
  const expanded = document.getElementById('rightPanel')?.classList.contains('topo-expanded');
  const want = on
    && setting('d26AutoHide', true) !== false
    && !expanded
    && !root.classList.contains('d26-chat-full')
    && popupOpen();
  if (want && !root.classList.contains('d26-min')) closeFly(false);
  root.classList.toggle('d26-min', !!want);
}

// ------------------------------------------- topology buttons in header
/**
 * The Center / 2D / full-window / bell group lives in the header, centred
 * above the apps drop-down. The #rightPanel layer is a fixed z-index:0
 * stacking context under the header, so CSS alone cannot lift the group
 * above the header's fade (it would be dimmed and unclickable). The element
 * is therefore moved, not copied: same nodes, same ids, same listeners.
 * It goes back into the map panel while the map is full-window (so the exit
 * button stays reachable) and whenever the desktop skin is off.
 */
function syncPill() {
  const pill = document.querySelector('.right-panel-header');
  const panel = document.getElementById('rightPanel');
  const header = document.querySelector('.app > .header');
  if (!pill || !panel || !header) return;
  const expanded = panel.classList.contains('topo-expanded');
  const wantHeader = on && !expanded;
  if (wantHeader && pill.parentElement !== header) {
    header.appendChild(pill);
    pill.classList.add('d26-in-header');
  } else if (!wantHeader && pill.parentElement !== panel) {
    panel.insertBefore(pill, panel.querySelector('.right-panel-body'));
    pill.classList.remove('d26-in-header');
  } else if (!wantHeader) {
    pill.classList.remove('d26-in-header');
  }
}

// ------------------------------------------------------------------ chat
// Default 4%: the chat is mostly the map showing through, which is both the
// look the operator asked for and by far the cheapest thing to composite over
// a live canvas.
const CHAT_ALPHA_DEFAULT = 0.04;
function chatAlpha() {
  const a = Number(setting('d26ChatAlpha', CHAT_ALPHA_DEFAULT));
  return Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : CHAT_ALPHA_DEFAULT;
}

function applyAlpha(a = chatAlpha()) {
  root.style.setProperty('--d26-chat-alpha', String(a));
}

// Desktop "how much of this stuff" knobs. Each is applied as a CSS custom
// property on <html> so the stylesheet (and every card/panel) picks it up at
// once; 0 is the cheap end.
// Default 1px: 2% of the 0-24px range, rounded up to the slider's whole-pixel
// step so the glass is still glass -- just barely frosted. Every backdrop-filter
// layer is re-composited over the canvas each frame, so this is the cheapest
// setting that keeps the look.
const BLUR_PX_DEFAULT = 1;
function blurPx() {
  const v = Number(setting('d26Blur', BLUR_PX_DEFAULT));
  return Number.isFinite(v) ? Math.min(24, Math.max(0, v)) : BLUR_PX_DEFAULT;
}
function glowPct() {
  const v = Number(setting('d26Glow', 100));
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100;
}
function motionPct() {
  const v = Number(setting('d26Motion', 100));
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100;
}
function applyBlur(px = blurPx()) {
  root.style.setProperty('--d26-blur', px + 'px');
  // blur(0px) is NOT free: it still creates a backdrop-filter layer, and a
  // backdrop layer over a live canvas is re-composited every frame. Zero has to
  // mean no layer at all, otherwise dragging the slider to 0 buys nothing.
  root.classList.toggle('d26-flat', px <= 0);
}
function applyGlow(pct = glowPct()) {
  root.style.setProperty('--d26-glow', String(pct / 100));
  root.classList.toggle('d26-no-glow', pct <= 0);
}
function applyMotion(pct = motionPct()) {
  // 1 keeps every `calc(11s / var(--d26-motion))` valid while .d26-still stops
  // the loops outright. The old clamp to 0.05 left them running at 1/20 speed,
  // which still repaints every frame -- "calmest" cost exactly the same.
  root.style.setProperty('--d26-motion', String(pct <= 0 ? 1 : pct / 100));
  root.classList.toggle('d26-still', pct <= 0);
}

// Desktop → Topography: fog mode + frame-rate cap. These live in the scene, so
// we push them through a store event the 3D layer listens for.
function topoFogMode() {
  const v = Number(setting('topoFog', 1));
  return Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1;
}
function topoFps() {
  const v = Number(setting('topoFps', 60));
  return Number.isFinite(v) ? Math.max(1, Math.min(60, v)) : 60;
}
// Desktop → Map detail. Per cent of the pixel-ratio cap, same steps the scene
// owns; the control shows the nearest one so the two can never disagree.
const TOPO_QUALITY = [100, 85, 70, 55, 42];
const TOPO_QUALITY_LABELS = ['100% · full detail', '85%', '70%', '55%', '42% · softest'];
function topoQualityIndex() {
  const v = Number(setting('topoQuality', 100));
  const pct = Number.isFinite(v) && v > 0 ? v : 100;
  let best = 0;
  for (let i = 1; i < TOPO_QUALITY.length; i++) {
    if (Math.abs(TOPO_QUALITY[i] - pct) < Math.abs(TOPO_QUALITY[best] - pct)) best = i;
  }
  return best;
}
function topoQuality() { return TOPO_QUALITY[topoQualityIndex()]; }
function qualityLabel() { return TOPO_QUALITY_LABELS[topoQualityIndex()] || ''; }
function applyTopoSettings() {
  store.emit('topo:settings', { fog: topoFogMode(), fps: topoFps(), quality: topoQuality() });
}

// ------------------------------------------------------------ map floor
function floorOn() { return setting('topoFloor', true) !== false; }
// Desktop → Fix the floor in place: hold the in-scene grid in the window rather
// than letting an orbit carry it around the graph. On by default -- a grid that
// slides out from under the chart reads as a bug, and the pin costs nothing.
function floorFixed() { return setting('topoFloorFixed', true) !== false; }

/**
 * The fixed DOM floor is the most expensive layer over the canvas (a 150vmax
 * screen-blended element). Off swaps in the polar grid that already lives inside
 * the 3D scene -- one draw call -- so the depth cue survives even though nothing
 * is drawn in the DOM.
 */
function applyFloor() {
  // The floating floor is a DOM layer that only the glass shell injects. In
  // Classic the in-scene polar grid IS the floor, so it is never hidden in
  // favour of a layer that is not there.
  const want = on && floorOn();
  const floor = document.querySelector('.d26-floor');
  if (floor) floor.hidden = !want;
  if (on) setSceneGridVisible(!want);
  syncFloorControls();
}

/**
 * The fix only means anything for the fallback grid, so it is disabled -- not
 * hidden, and keeping its value -- while the floating floor is the one showing.
 */
function syncFloorControls() {
  const fixT = document.getElementById('d26FloorFix');
  // "Floating floor" is a layer of the glass shell. Classic has no such layer,
  // so the pin is always available there -- it holds the map's own grid.
  const floating = on && floorOn();
  if (fixT) {
    fixT.checked = floorFixed();
    fixT.disabled = floating;
  }
  // Write only on a real change: assigning textContent replaces a text node
  // even when the string is identical, and that counts as a mutation for any
  // observer watching this subtree.
  const out = document.getElementById('d26FloorFixVal');
  const text = floating ? 'floating floor is on' : (floorFixed() ? 'pinned' : 'moves with the map');
  if (out && out.textContent !== text) out.textContent = text;
}

// --------------------------------------------------- performance preset
//
// This is NOT a second set of visual state. It writes the same settings the
// Desktop controls above already own, then writes them back when switched off,
// so every value stays visible and adjustable in its own control and nothing is
// removed -- only switched off.
const PERF_CHEAP = {
  d26Blur: 0,
  d26Glow: 0,
  d26Motion: 0,
  topoFog: 2,          // 2 = fog off (matches the Desktop control)
  topoFps: 30,
  topoQuality: 70,      // fewer pixels for the map; softens lines, not layout
  topoBloom: false,
  topoFloor: false,
  topoAutoRotate: false,
};
const PERF_KEYS = Object.keys(PERF_CHEAP);
// The Resource Manager switches are part of the same preset (they are what makes
// the map rest), but they live under dedicated settings keys.
const PERF_RM = { rmIdleThrottle: 'idleThrottle', rmPauseCovered: 'pauseCovered', rmIdleFps: 'idleFps' };

const perfMode = () => setting('perfMode', false) === true;

/**
 * Read one preset-owned value, wherever its real setting lives. Every branch
 * returns a concrete value (the same default its own control shows), so
 * switching the preset off can always put a real number or boolean back -- an
 * unset key must never be "restored" to `undefined` and left cheap.
 */
function readPresetKey(k) {
  const rmKey = PERF_RM[k];
  if (rmKey) {
    const rm = setting('resourceManager', {}) || {};
    return k === 'rmIdleFps' ? (Number(rm.idleFps) || 10) : !!rm[rmKey];
  }
  switch (k) {
    case 'd26Blur': return blurPx();
    case 'd26Glow': return glowPct();
    case 'd26Motion': return motionPct();
    case 'topoFog': return topoFogMode();
    case 'topoFps': return topoFps();
    case 'topoQuality': return topoQuality();
    case 'topoBloom': return setting('topoBloom', true) !== false;
    case 'topoFloor': return floorOn();
    case 'topoAutoRotate': return setting('topoAutoRotate', true) !== false;
    default: return store.get('settings.' + k);
  }
}

/** Write one preset-owned value to the setting that really owns it. */
function writePresetKey(k, v) {
  const rmKey = PERF_RM[k];
  if (rmKey) store.set('settings.resourceManager.' + rmKey, v);
  else store.set('settings.' + k, v);
}

function perfSnapshot() {
  const snap = {};
  PERF_KEYS.forEach(k => { snap[k] = readPresetKey(k); });
  Object.keys(PERF_RM).forEach(k => { snap[k] = readPresetKey(k); });
  return snap;
}

/**
 * The cheap set, decided from the live values so it can only ever tighten. A
 * preset that raised something you had already made cheaper would be a bug.
 */
function perfCheapValues() {
  return {
    ...PERF_CHEAP,
    // Already slower than the preset? Keep the operator's number.
    topoFps: Math.min(Number(readPresetKey('topoFps')) || 60, PERF_CHEAP.topoFps),
    rmIdleThrottle: true,
    rmPauseCovered: true,
    rmIdleFps: Math.min(Number(readPresetKey('rmIdleFps')) || 10, 12),
  };
}

/** Write one set of values through the real settings keys, then re-apply. */
function applyPerfValues(vals) {
  Object.keys(vals).forEach(k => { if (vals[k] !== undefined) writePresetKey(k, vals[k]); });
  persistence.set('settings', store.get('settings'));
  applyBlur();
  applyGlow();
  applyMotion();
  applyFloor();
  applyTopoSettings();
  syncPerfControls();
}

/**
 * Values to restore when the preset is switched off. `applied` is what the
 * preset actually wrote, so a key that no longer holds it was moved by hand in
 * the meantime and keeps its new value instead of being silently reverted.
 */
function perfRestore() {
  const rec = setting('perfRestore', {}) || {};
  const prev = rec.prev || {};
  const applied = rec.applied || {};
  const out = {};
  Object.keys(applied).forEach(k => {
    const now = readPresetKey(k);
    out[k] = now === applied[k] ? prev[k] : now;
  });
  return out;
}

function setPerf(want) {
  const next = !!want;
  if (next === perfMode()) { syncPerfControls(); return; }
  if (next) {
    const applied = perfCheapValues();
    saveSetting('perfRestore', { prev: perfSnapshot(), applied });
    applyPerfValues(applied);
  } else {
    applyPerfValues(perfRestore());
  }
  saveSetting('perfMode', next);
  syncPerfControls();
}

/** Reflect the real settings in every control that shows them. */
function syncPerfControls() {
  const q = id => document.getElementById(id);
  const perf = q('d26Perf');
  if (perf) perf.checked = perfMode();
  const blur = q('d26BlurRange'), blurOut = q('d26BlurVal');
  if (blur) blur.value = String(blurPx());
  if (blurOut) blurOut.textContent = blurPx() + 'px';
  const glow = q('d26GlowRange'), glowOut = q('d26GlowVal');
  if (glow) glow.value = String(glowPct());
  if (glowOut) glowOut.textContent = glowPct() + '%';
  const motion = q('d26MotionRange'), motionOut = q('d26MotionVal');
  if (motion) motion.value = String(motionPct());
  if (motionOut) motionOut.textContent = motionPct() + '%';
  const fog = q('d26FogToggle'), fogOut = q('d26FogVal');
  if (fog) {
    fog.checked = topoFogMode() !== 2;
    if (fogOut) fogOut.textContent = fog.checked ? 'on' : 'off';
  }
  const fps = q('d26Fps');
  if (fps) fps.value = String(topoFps());
  const quality = q('d26QualityRange'), qualityOut = q('d26QualityVal');
  if (quality) quality.value = String(topoQualityIndex());
  if (qualityOut) qualityOut.textContent = qualityLabel();
  const bloom = q('d26Bloom'), floorT = q('d26FloorToggle'), rot = q('d26AutoRotate');
  if (bloom) bloom.checked = setting('topoBloom', true) !== false;
  if (floorT) floorT.checked = floorOn();
  syncFloorControls();
  if (rot) rot.checked = setting('topoAutoRotate', true) !== false;
  // Resource Manager switches sit in the same Config tab and read the same
  // settings, so the preset has to leave them telling the truth.
  const rm = setting('resourceManager', {}) || {};
  q('sbRmIdle')?.classList.toggle('active', !!rm.idleThrottle);
  q('sbRmCovered')?.classList.toggle('active', !!rm.pauseCovered);
  const rmFps = q('sbRmIdleFps');
  if (rmFps) rmFps.value = String(rm.idleFps ?? 10);
}

function clampChat(w) {
  const max = Math.max(340, window.innerWidth - STACK_RIGHT - 60);
  return Math.round(Math.min(max, Math.max(340, w)));
}

function applyChatWidth(w) {
  let width = w;
  if (width === undefined) {
    try { width = Number(localStorage.getItem(CHAT_W_KEY)) || CHAT_W_DEFAULT; } catch { width = CHAT_W_DEFAULT; }
  }
  root.style.setProperty('--d26-chat-w', clampChat(width) + 'px');
}

function setChatFull(full) {
  root.classList.toggle('d26-chat-full', full);
  const btn = document.querySelector('.d26-chat-expand');
  if (btn) {
    btn.classList.toggle('on', full);
    btn.title = full ? 'Restore chat (Esc)' : 'Expand chat to the screen';
    btn.innerHTML = full ? ICON_SHRINK : ICON_EXPAND;
  }
  syncMin();
}

const ICON_EXPAND = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9"/></svg>';
const ICON_SHRINK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M13.5 6.5h-4v-4M9.5 6.5L14 2M2.5 9.5h4v4M6.5 9.5L2 14"/></svg>';

function injectChatControls() {
  const main = document.querySelector('.main-panel');
  if (!main || main.querySelector('.d26-chat-expand')) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'd26-chat-expand';
  btn.hidden = true;                    // shown only by the desktop CSS
  btn.title = 'Expand chat to the screen';
  btn.innerHTML = ICON_EXPAND;
  btn.addEventListener('click', () => setChatFull(!root.classList.contains('d26-chat-full')));
  main.appendChild(btn);

  const handle = document.createElement('div');
  handle.className = 'd26-chat-resize';
  handle.hidden = true;
  handle.title = 'Drag to widen the chat · double-click to reset';
  main.prepend(handle);

  let dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if (!on || root.classList.contains('d26-chat-full')) return;
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('d26-resizing');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    applyChatWidth(window.innerWidth - 18 - e.clientX);
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    document.body.classList.remove('d26-resizing');
    const w = parseFloat(getComputedStyle(root).getPropertyValue('--d26-chat-w')) || CHAT_W_DEFAULT;
    try { localStorage.setItem(CHAT_W_KEY, String(Math.round(w))); } catch { /* ignore */ }
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => {
    applyChatWidth(CHAT_W_DEFAULT);
    try { localStorage.setItem(CHAT_W_KEY, String(CHAT_W_DEFAULT)); } catch { /* ignore */ }
  });
}

// ------------------------------------------------------- the map floor
function injectFloor() {
  const host = document.querySelector('#rightPanel .right-panel-body');
  if (!host || host.querySelector('.d26-floor')) return;
  const C = 500;
  let rings = '';
  for (let i = 1; i <= 10; i++) {
    rings += `<circle cx="${C}" cy="${C}" r="${i * 50}" fill="none" stroke="#00e5ff" stroke-width="${i % 5 === 0 ? 2 : 1}" stroke-opacity="${i % 5 === 0 ? 0.9 : 0.5}"/>`;
  }
  let spokes = '';
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const x = (C + Math.cos(a) * 500).toFixed(1);
    const y = (C + Math.sin(a) * 500).toFixed(1);
    spokes += `<line x1="${C}" y1="${C}" x2="${x}" y2="${y}" stroke="#00e5ff" stroke-width="1" stroke-opacity="${i % 6 === 0 ? 0.8 : 0.35}"/>`;
  }
  const floor = document.createElement('div');
  floor.className = 'd26-floor';
  floor.hidden = true;
  floor.setAttribute('aria-hidden', 'true');
  floor.innerHTML = `<svg viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet">
    ${rings}${spokes}
    <circle cx="${C}" cy="${C}" r="498" fill="none" stroke="#00e5ff" stroke-width="6" stroke-dasharray="2 14" stroke-opacity="0.9"/>
    <circle cx="${C}" cy="${C}" r="6" fill="#00e5ff"/>
    <circle class="d26-floor-scan" cx="${C}" cy="${C}" r="500" fill="none" stroke="#00e5ff" stroke-width="4"/>
  </svg>`;
  host.appendChild(floor);
}

/** The in-scene polar grid moves with the camera; the fixed floor replaces it. */
function setSceneGridVisible(visible, tries = 0) {
  const t = window.__topology;
  const core = t && t.core;
  if (core && typeof core.setGridVisible === 'function') { core.setGridVisible(visible); return; }
  let grid = null;
  if (t && typeof t === 'object') {
    for (const v of Object.values(t)) {
      if (v && typeof v === 'object' && v.grid && v.grid.isObject3D) { grid = v.grid; break; }
    }
  }
  if (grid) { grid.visible = visible; return; }
  // The 3D view loads after this module; keep looking for a little while.
  if (tries < 30) setTimeout(() => { if (on === !visible) setSceneGridVisible(visible, tries + 1); }, 500);
}

// --------------------------------------------------------- on / off
function activate() {
  if (on) return;
  on = true;
  ensureCss();
  root.classList.add('d26');
  wrapRail(true);
  injectChatControls();
  injectFloor();
  applyChatWidth();
  applyAlpha();
  applyBlur();
  applyGlow();
  applyMotion();
  applyTopoSettings();
  syncPill();
  decorate();
  const body = $body();
  if (body && !reduced()) restartEnter(body);
  applyFloor();
  syncSkinOnly();
  syncMin();
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function deactivate() {
  if (!on) return;
  closeFly(false);
  on = false;
  syncPill();
  clearTimeout(enterTimer);
  $body()?.classList.remove('d26-enter');
  root.classList.remove('d26', 'd26-min', 'd26-chat-full', 'd26-flyout');
  delete root.dataset.d26Tab;
  root.style.removeProperty('--d26-chat-w');
  root.style.removeProperty('--d26-chat-alpha');
  root.style.removeProperty('--d26-blur');
  root.style.removeProperty('--d26-glow');
  root.style.removeProperty('--d26-motion');
  root.classList.remove('d26-still', 'd26-no-glow', 'd26-flat');
  wrapRail(false);
  // The Config card is NOT removed: classic needs the map settings it holds.
  // Only its glass rows switch off (their values stay where they are).
  syncSkinOnly();
  document.querySelectorAll('.d26-ghost').forEach(g => g.remove());
  swirling = false;
  setSceneGridVisible(true);
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

/**
 * Put the app into the shell the operator asked for, now.
 *
 * Runs on load, when the window crosses 1025px, and when Config → Interface
 * changes -- so picking a shell never needs a reload.
 */
function sync() {
  if (wantsSkin()) activate(); else deactivate();
  // Map settings are not skin settings: push them in either shell, so the
  // Desktop card can never show a value the map is not actually using.
  applyTopoSettings();
  applyFloor();
  syncDesktopConfig();
  // Not left to syncDesktopConfig(): it returns early when the card is already
  // in place, and a shell switch still has to flip the glass rows.
  syncSkinOnly();
}

// ------------------------------------------------------------- wiring
function init() {
  const body = $body();
  if (body) {
    // Only the decoration is skin-gated. The Config card has to reappear after
    // every sidebar render in classic too, so it is checked in both shells --
    // and only when it is missing, because this callback is itself triggered by
    // childList changes and the card's own labels are text nodes.
    new MutationObserver(() => {
      if (on) queueDecorate();
      if (configBody()?.querySelector('[data-d26-own]')) return;
      syncDesktopConfig();
    }).observe(body, { childList: true, subtree: true });
    body.addEventListener('click', onConfigClick, true);
    body.addEventListener('scroll', () => { if (fly) placeFly(); }, { passive: true });
  }
  document.querySelector('.sidebar-nav')?.addEventListener('click', onNavClick, true);
  document.addEventListener('pointerdown', onOutsidePress, true);

  const panel = document.getElementById('rightPanel');
  if (panel) {
    // Only the card's hidden flag and the map's own expand class matter;
    // labels restyle every frame, so style/class churn below is ignored.
    new MutationObserver(syncMin).observe(panel, { attributes: true, attributeFilter: ['hidden'], subtree: true });
    new MutationObserver(() => { syncPill(); syncMin(); }).observe(panel, { attributes: true, attributeFilter: ['class'] });
  }

  window.addEventListener('resize', () => {
    if (!on) return;
    applyChatWidth(parseFloat(getComputedStyle(root).getPropertyValue('--d26-chat-w')) || undefined);
    placeFly();
  });

  document.addEventListener('keydown', (e) => {
    if (!on || e.key !== 'Escape') return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if (fly) { closeFly(true); return; }
    if (root.classList.contains('d26-chat-full')) setChatFull(false);
  });

  const onChange = () => sync();
  if (MQ.addEventListener) MQ.addEventListener('change', onChange);
  else MQ.addListener(onChange);
  // Config → Interface switches the shell live.
  store.on(IFACE_EVENT, sync);
  // Saved settings can land after this module runs (localStorage at import,
  // then the server copy), so re-check when the settings object is replaced --
  // but only act on an actual change, or every unrelated settings write would
  // re-sync the shell mid-gesture.
  let lastMode = ifaceMode();
  store.subscribe('settings', () => {
    const mode = ifaceMode();
    if (mode === lastMode) return;
    lastMode = mode;
    sync();
  });
  sync();
}

try { init(); } catch (err) { console.warn('[desktop2026] skin disabled:', err); }
