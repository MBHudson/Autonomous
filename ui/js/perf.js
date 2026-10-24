/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// PERF.JS — a tiny CPU/GPU/FPS meter for the Resource Manager gauges
// ============================================
//
// A web page cannot read the OS's real CPU or GPU utilisation, so these are
// honest proxies measured inside the tab:
//   * FPS      — how often the 3D render loop actually drew a frame.
//   * CPU      — the share of each frame this app spends running JavaScript
//                (our own onFrame + draw submission), as a % of the frame.
//   * GPU      — real GPU time per frame via EXT_disjoint_timer_query_webgl2
//                when the browser exposes it; otherwise the frame time is shown
//                and the gauge is labelled an estimate.
//
// Nothing here allocates per frame beyond a couple of numbers.

export const perf = {
  fps: 0,
  frameMs: 0,
  cpu: 0,        // % of frame spent in our JS
  gpu: null,     // ms of GPU time (timer query) or null
  gpuOk: false,  // whether the timer query is available
};

let _lastNow = 0;
let _acc = 0;
let _frames = 0;
let _cpu = 0;
let _jsMs = 0;

/** Call once per rendered frame. jsMs = time spent in our own JS that frame. */
export function perfFrame(nowMs, jsMs) {
  if (_lastNow) {
    const dt = nowMs - _lastNow;
    if (dt > 0 && dt < 2000) {          // ignore absurd gaps after a pause
      _acc += dt;
      _frames++;
      _cpu += (jsMs / dt) * 100;
      _jsMs += jsMs;
      if (_acc >= 500) {
        perf.fps = Math.round((_frames * 1000) / _acc);
        perf.frameMs = +(_jsMs / _frames).toFixed(1);
        perf.cpu = Math.max(0, Math.min(100, Math.round(_cpu / _frames)));
        _acc = 0; _frames = 0; _cpu = 0; _jsMs = 0;
      }
    }
  }
  _lastNow = nowMs;
}

/** Reset the frame anchor after a pause, so the next dt isn't a huge spike. */
export function perfResume() { _lastNow = 0; }

// ---- GPU timer query (optional) -------------------------------------------

let _gl = null;
let _ext = null;
let _q = null;
let _qBusy = false;
let _pending = null;

export function perfAttachGL(gl) {
  try {
    _gl = gl;
    _ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
      || gl.getExtension('EXT_disjoint_timer_query');
    perf.gpuOk = !!_ext;
  } catch { perf.gpuOk = false; }
}

export function gpuBegin() {
  if (!_ext || _qBusy || !_gl) return;
  try { _q = _gl.createQuery(); _gl.beginQuery(_ext.TIME_ELAPSED_EXT, _q); _qBusy = true; }
  catch { _qBusy = false; }
}

export function gpuEnd() {
  if (!_qBusy || !_gl) return;
  try {
    _gl.endQuery(_ext.TIME_ELAPSED_EXT);
    _pending = _q;
    _q = null;
    _qBusy = false;
  } catch { _qBusy = false; }
}

/** Poll a finished query (once per frame, cheap). */
export function gpuPoll() {
  if (!_pending || !_gl) return;
  try {
    const done = _gl.getQueryParameter(_pending, _gl.QUERY_RESULT_AVAILABLE);
    if (done) {
      const ns = _gl.getQueryParameter(_pending, _gl.QUERY_RESULT);
      perf.gpu = Math.round(ns / 1e4) / 100;   // ns -> ms, 2dp
      _gl.deleteQuery(_pending);
      _pending = null;
    }
  } catch { _pending = null; }
}
