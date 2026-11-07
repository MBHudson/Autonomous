/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// KEYBOARD.JS — keep the focused field above the on-screen keyboard
// ============================================
//
// On a phone the on-screen keyboard opens OVER the page instead of resizing
// it — and in fullscreen (documentElement.requestFullscreen) it always
// overlays, because there is no browser chrome left to shrink. The chat
// composer then sits behind the keyboard and you type blind.
//
// This module watches window.visualViewport (the part of the page the
// keyboard is not covering) and, while the keyboard is open:
//   1. shrinks .app to the visible height, so the fixed composer row rides
//      above the keyboard instead of under it;
//   2. exposes the covered height as --kb-height, which the CSS adds to the
//      composer and dialog padding;
//   3. keeps the focused field scrolled into view (and the chat pinned to
//      the newest message while you type).
//
// Harmless on desktop: without a touch keyboard the viewport never shrinks
// by a keyboard-sized amount, so --kb-height stays 0 and nothing changes.

/**
 * A keyboard covers far more than this; the URL bar showing/hiding covers
 * far less. Below it, do nothing so ordinary browser-chrome movement never
 * resizes the app.
 */
const KB_THRESHOLD_PX = 120;

const EDITABLE = 'textarea,'
  + ' input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]),'
  + ' select, [contenteditable="true"]';

let installed = false;

function isEditable(el) {
  return !!(el && el.matches && el.matches(EDITABLE));
}

export function initKeyboardAvoid() {
  if (installed) return;
  installed = true;
  const root = document.documentElement;
  const vv = window.visualViewport;

  const scrollFocusedIntoView = () => {
    try {
      const el = document.activeElement;
      if (!isEditable(el)) return;
      // The composer: keep the newest messages visible above the input row.
      if (el.id === 'inputField') {
        const box = document.getElementById('chatMessages');
        if (box) box.scrollTop = box.scrollHeight;
      }
      if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    } catch { /* never break typing for a nicety */ }
  };

  const update = () => {
    try {
      if (!vv) {
        root.style.setProperty('--kb-height', '0px');
        root.classList.remove('kb-open');
        return;
      }
      const layoutH = window.innerHeight || 0;
      const visibleH = vv.height || 0;
      const top = vv.offsetTop || 0;
      // What the keyboard covers: layout height minus what is still visible.
      // offsetTop is subtracted because a panned/zoomed page hides part of
      // the layout above the fold, not behind the keyboard.
      let kb = Math.round(layoutH - visibleH - top);
      if (kb < KB_THRESHOLD_PX) kb = 0;
      root.style.setProperty('--kb-height', kb + 'px');
      // Pinch-zoom on a fine-pointer device also shrinks the visual viewport
      // without any keyboard; only shrink the app where a touch keyboard can
      // exist (coarse pointer) or while an editable actually has focus.
      const coarse = !!(window.matchMedia
        && window.matchMedia('(pointer: coarse)').matches);
      const allowShrink = coarse || isEditable(document.activeElement);
      root.classList.toggle('kb-open', kb > 0 && allowShrink);
      const app = document.querySelector('.app');
      if (app) {
        if (kb > 0 && allowShrink && visibleH > 0) {
          // Shrink the fixed grid to the visible strip so its bottom row
          // (the composer) sits above the keyboard. Cleared on close.
          app.style.height = visibleH + 'px';
          app.style.maxHeight = visibleH + 'px';
          app.style.top = top > 0 ? top + 'px' : '';
        } else {
          app.style.height = '';
          app.style.maxHeight = '';
          app.style.top = '';
        }
      }
      if (kb > 0) scrollFocusedIntoView();
    } catch { /* never break the page for a nicety */ }
  };

  if (vv) {
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
  }
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  document.addEventListener('fullscreenchange', () => {
    // Entering/exiting fullscreen changes what "visible" means; re-measure
    // after the transition settles.
    setTimeout(update, 100);
    setTimeout(update, 500);
  });

  // The keyboard animates in over ~200-300ms and visualViewport fires
  // throughout, but the focused field also needs a nudge after the animation
  // lands — otherwise it can end up half-covered on the first tap.
  document.addEventListener('focusin', (e) => {
    if (!isEditable(e.target)) return;
    setTimeout(scrollFocusedIntoView, 60);
    setTimeout(scrollFocusedIntoView, 350);
    setTimeout(update, 350);
  });
  document.addEventListener('focusout', () => {
    // Keyboard closing restores the viewport; the resize handler clears the
    // shrink. This is the fallback for browsers that never fire it.
    setTimeout(update, 350);
  });

  update();
}
