// ============================================
// TOPOPANEL.JS — resizable / expandable topology panel
// ============================================
//
// Renderer-agnostic: works the same for the 3D scene and the 2D SVG chart.
// The width lives in a CSS variable (--topo-w) that the app grid reads, and is
// remembered per app copy.

import { k } from '../storage.js?v=318';

const WIDTH_KEY = k('topoWidth');
const MIN_W = 300;
const DEFAULT_W = 420;
/** Chat column never gets squeezed below this. */
const MIN_CHAT = 380;
const SIDEBAR_W = 260;

function clampWidth(w) {
  const vw = window.innerWidth;
  const max = Math.max(MIN_W, Math.min(vw * 0.65, vw - SIDEBAR_W - MIN_CHAT));
  return Math.round(Math.min(max, Math.max(MIN_W, w)));
}

function nudgeResize() {
  // The 2D chart listens to window resize; the 3D scene has its own observer.
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

export function initTopoPanel() {
  const panel = document.getElementById('rightPanel');
  if (!panel) return;
  const root = document.documentElement;

  let width = DEFAULT_W;
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) width = saved;
  } catch { /* ignore */ }
  const apply = (w) => {
    width = clampWidth(w);
    root.style.setProperty('--topo-w', `${width}px`);
  };
  apply(width);
  window.addEventListener('resize', () => {
    const before = width;
    apply(width);
    if (before !== width) nudgeResize();
  });

  // ---- drag handle on the panel's left edge ----
  const handle = document.createElement('div');
  handle.className = 'topo-resize';
  handle.title = 'Drag to resize · double-click to reset';
  panel.prepend(handle);

  let dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if (panel.classList.contains('topo-expanded')) return;
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('topo-resizing');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    apply(window.innerWidth - e.clientX);
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    document.body.classList.remove('topo-resizing');
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* ignore */ }
    nudgeResize();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => {
    apply(DEFAULT_W);
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* ignore */ }
    nudgeResize();
  });

  // ---- expand to a full-window overlay ----
  const btn = document.getElementById('topoExpandBtn');
  const setExpanded = (on) => {
    panel.classList.toggle('topo-expanded', on);
    document.body.classList.toggle('topo-expanded-open', on);
    if (btn) {
      btn.classList.toggle('on', on);
      btn.title = on ? 'Collapse (Esc)' : 'Expand the topology to the full window';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    nudgeResize();
  };
  btn?.addEventListener('click', () => setExpanded(!panel.classList.contains('topo-expanded')));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.__topoHandled) return;
    if (!panel.classList.contains('topo-expanded')) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    setExpanded(false);
  });
}
