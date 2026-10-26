/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// IFACEMODE.JS — which desktop shell the app wears
// ============================================
//
// Two shells, one rule:
//
//   classic  the left setup panel, the chat and the right network/map panel
//            side by side -- the layout the app has always had, and what the
//            archive in the-copy-before-the-huge-ui-change looked like.
//   desktop  the Desktop 2026 glass shell (ui/js/desktop2026.js): a floating
//            left rail with drawers, chat widened, floor and bloom on the map.
//
// Classic is the DEFAULT: an absent, empty or unrecognised value is classic, so
// a fresh install and every existing profile start there without a migration.
//
// Window width is NOT part of this choice. Below 1025px both shells give way to
// the same slide-over drawer layout, which layout.css owns alone; the switch can
// only decide whether the glass wears at a width where it fits. That keeps the
// phone view exactly as it is, whichever shell is selected.
//
// Kept DOM-free and dependency-free so tests/js/ifaceMode.test.mjs can pin the
// default without a browser.

export const IFACE_CLASSIC = 'classic';
export const IFACE_DESKTOP = 'desktop';

/** Store event the Config select emits when the choice changes. */
export const IFACE_EVENT = 'iface:change';

/** Anything that is not an explicit "desktop" is the classic layout. */
export function normalizeIface(mode) {
  return String(mode ?? '').trim().toLowerCase() === IFACE_DESKTOP ? IFACE_DESKTOP : IFACE_CLASSIC;
}

/**
 * Which shell to wear right now.
 *
 * @param {{mode?: string, wide?: boolean}} state  the saved choice and whether
 *        the window is wide enough for the shell (min-width: 1025px).
 * @returns {'classic'|'desktop'}
 */
export function resolveIface({ mode, wide } = {}) {
  return normalizeIface(mode) === IFACE_DESKTOP && !!wide ? IFACE_DESKTOP : IFACE_CLASSIC;
}

/** Human name for the choice, for toasts and the Config badge. */
export function ifaceLabel(mode) {
  return normalizeIface(mode) === IFACE_DESKTOP ? 'Desktop 2026' : 'Classic';
}
