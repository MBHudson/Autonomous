/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
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
