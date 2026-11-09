/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// STREAM SHAPE — the two conversions a provider stream needs
// ============================================
//
// Kept out of api.js so they can be tested without a browser: api.js pulls in
// the store, the rate governor and the tool protocol, none of which a pure
// "add up these two token counts" deserves.

/**
 * Merge one frame's usage into what the stream has already seen.
 *
 * Providers split the picture across frames. Anthropic puts input tokens on
 * message_start and output tokens on the closing message_delta, so a rule of
 * `total = max(prev, prompt + completion)` read the second frame as `0 + C`
 * and reported max(input, output) instead of input + output. Prompt and
 * completion are merged separately here, and the total is the largest of what
 * was already known, what the provider stated, and their sum — so a frame that
 * repeats a running total cannot double it, and a frame carrying half of it
 * cannot shrink it.
 *
 * @param {{prompt:number,completion:number,total:number}|null} prev
 * @param {number} prompt     input tokens on this frame (0 when absent)
 * @param {number} completion output tokens on this frame (0 when absent)
 * @param {number} explicitTotal provider's own total, when it sent one
 * @returns {{prompt:number,completion:number,total:number}}
 */
export function mergeUsage(prev, prompt, completion, explicitTotal) {
  const p = Math.max(Number(prev && prev.prompt) || 0, Number(prompt) || 0);
  const c = Math.max(Number(prev && prev.completion) || 0, Number(completion) || 0);
  return {
    prompt: p,
    completion: c,
    total: Math.max(Number(prev && prev.total) || 0, Number(explicitTotal) || 0, p + c),
  };
}

/**
 * Google's finishReason in the vocabulary the rest of the app already reads.
 *
 * Gemini says MAX_TOKENS where OpenAI says length, and reports a refused
 * answer as SAFETY / RECITATION / PROHIBITED_CONTENT rather than as an empty
 * completion. None of it was read at all, so a reply cut off at the ceiling
 * or emptied by a safety block looked like an ordinary short answer and the
 * truncation path never fired.
 *
 * @param {string} reason candidates[0].finishReason
 * @returns {string|null} 'length', 'stop', 'content_filter', or the reason lowercased
 */
export function googleFinishReason(reason) {
  const r = String(reason == null ? '' : reason).trim().toLowerCase();
  if (!r) return null;
  if (r === 'max_tokens') return 'length';
  if (r === 'stop' || r === 'unspecified' || r === 'finish_reason_unspecified') return 'stop';
  if (['safety', 'recitation', 'blocklist', 'prohibited_content', 'spii',
    'image_safety', 'language'].includes(r)) {
    return 'content_filter';
  }
  return r;
}
