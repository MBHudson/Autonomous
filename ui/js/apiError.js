/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// APIERROR.JS — refusals the UI has to recognise, not just display
// ============================================

/**
 * True when the server refused because the token gate is armed with no token.
 *
 * That state answers 503 on EVERY route — `/sandbox/status` included — so the
 * posture cannot be read from a normal response; a caller only ever sees the
 * failure. Kept in one place so the Config status line and the Permissions
 * hint cannot drift apart on the shape of the body.
 *
 * @param {Error & {status?: number, data?: object}} err
 * @returns {boolean}
 */
export function isNoTokenError(err) {
  return !!err && err.status === 503
    && String((err.data && err.data.error) || '').toLowerCase() === 'no token configured';
}
