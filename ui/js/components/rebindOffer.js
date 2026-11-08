/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// REBINDOFFER.JS — the button inside the file-tool warning
// ============================================
//
// The warning bubble is the one place the operator is already reading when the
// page turns out to be half-bound. A sentence there can name the fix; only a
// control can perform it. This keeps that control in a module small enough to
// exercise with a fake element, so the click path is tested rather than trusted
// -- chat.js keeps the toasts, the trace and the message bookkeeping.

/**
 * Append a rebind button to a warning bubble's body and wire it up.
 *
 * @param {Element} bubble    the rendered message element (has .message-body)
 * @param {object}  opts
 * @param {Function} opts.bind      returns { unbound: string[] }; may throw
 * @param {string}  opts.doneText   what the bubble says once everything binds
 * @param {Function} [opts.onBound] called after the bubble has been rewritten
 * @param {Function} [opts.onFail]  called with the names still unbound
 * @returns {Element|null} the button, or null when there is no body to hold it
 */
export function offerRebind(bubble, { bind, doneText, onBound, onFail } = {}) {
  const body = bubble && typeof bubble.querySelector === 'function'
    ? bubble.querySelector('.message-body')
    : null;
  if (!body) return null;
  const doc = body.ownerDocument
    || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;

  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-secondary btn-sm';
  btn.textContent = 'BIND FILE TOOLS';
  if (btn.style) btn.style.marginTop = '8px';

  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    btn.disabled = true;
    // Disabled with the old label reads as a dead control. Binding is a
    // synchronous walk over the registry, but the button still says what it
    // is doing, because the half that follows is not synchronous at all.
    btn.textContent = 'BINDING…';

    let unbound = [];
    try {
      const verdict = bind ? bind() : { unbound: [] };
      unbound = Array.isArray(verdict && verdict.unbound) ? verdict.unbound : [];
    } catch (err) {
      // A thrown attempt is a failed attempt. Say so in the same place the
      // names would have gone, rather than leaving the button spinning.
      unbound = [`the attempt threw: ${(err && err.message) || err}`];
    }

    if (unbound.length) {
      btn.disabled = false;
      btn.textContent = 'TRY AGAIN';
      if (onFail) onFail(unbound);
      return;
    }

    // Do not claim the outcome before it is known. Binding is only the page
    // half; whether the server has a directory is a second fact, and the
    // answer takes a round trip. So the warning stays readable, the button
    // carries the progress, and the bubble is written once -- from the
    // verdict rather than in front of it.
    const settle = (text) => {
      body.textContent = text || doneText || '✓ File tools are bound.';
      if (typeof btn.remove === 'function') btn.remove();
    };
    if (!onBound) { settle(doneText); return; }

    btn.textContent = 'CHECKING…';
    try {
      const verdict = onBound();
      if (verdict && typeof verdict.then === 'function') {
        verdict.then(text => settle(text)).catch(() => settle(doneText));
      } else {
        settle(verdict);
      }
    } catch {
      // A follow-up that throws cannot undo a binding that happened.
      settle(doneText);
    }
  });

  body.appendChild(btn);
  return btn;
}
