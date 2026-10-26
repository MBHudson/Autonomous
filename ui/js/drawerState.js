/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// DRAWERSTATE.JS — which Config drawer should be out
// ============================================
//
// The desktop skin (desktop2026.js) shows one Config section at a time as a
// drawer beside the left stack. Deciding WHICH section wins is the only part of
// that worth testing on its own, so it lives here, with no DOM and no imports.
//
// Sections are opaque: the caller passes whatever identifies them (the
// skin passes the elements themselves) and gets those same values back in the
// plan. Nothing in this file reads a node, so tests/js/drawerState.test.mjs can
// import it straight into Node.
//
// The rule that matters: a section whose drawer is RETRACTING is not a
// candidate. Its <details> stays open for the length of the close animation, so
// anything that asks "which section is open?" during those 440ms -- and the
// Config tab repaints its live status lines constantly -- would otherwise pick
// it up and re-open the drawer that is still on its way out.

/**
 * @param {object} [input]
 * @param {Array}    [input.open]     sections whose <details> is open
 * @param {*}        [input.current]  section whose drawer is out, if any
 * @param {*}        [input.closing]  section whose drawer is retracting, if any
 * @param {*}        [input.clicked]  section the operator just clicked, if any
 * @returns {{ target: *, closePrev: boolean, close: Array } | null}
 *   The section to open, whether the current drawer must be closed first, and
 *   the other open sections to fold up. `null` means nothing should change:
 *   there is no target, or the target is already the one that is out.
 */
export function planDrawer({ open = [], current = null, closing = null, clicked = null } = {}) {
  // Retracting sections are not open, even though their <details> still is.
  const candidates = open.filter(el => el !== closing);

  // An explicit click wins, but only if it genuinely ended up open.
  let target = clicked && candidates.includes(clicked) ? clicked : null;
  // Otherwise keep exactly one drawer out: whatever is open and is not the one
  // already showing (which also covers a repaint arriving mid-close, where
  // `current` is already null and the only open section is the retracting one).
  if (!target) target = candidates.find(el => el !== current) || null;

  if (!target || target === current) return null;

  return {
    target,
    // The old drawer has to retract before the new one comes out.
    closePrev: current !== null,
    // Any other section left open folds up. `current` is skipped because its own
    // retract closes it, and `target` is about to be shown.
    close: candidates.filter(el => el !== target && el !== current),
  };
}
