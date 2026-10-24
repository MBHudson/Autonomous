/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// CONFIGPANEL.JS — Settings modal
// ============================================

import { store } from '../store.js?v=319';
import { persistence } from '../persistence.js?v=319';
import { themeManager } from '../themes.js?v=319';
import { DEFAULT_HISTORY_TURNS } from '../utils.js?v=319';
import { api } from '../api.js?v=319';
import { audio } from '../audio.js?v=319';

export class ConfigPanel {
  constructor() {
    this.modal = null;
  }

  init() {
    // Wire up config modal buttons
    document.getElementById('configBtn')?.addEventListener('click', () => this.open());
    document.getElementById('configModalClose')?.addEventListener('click', () => this.close());
    document.getElementById('cfgCancel')?.addEventListener('click', () => this.close());
    document.getElementById('cfgSave')?.addEventListener('click', () => this.save());
  }

  /** Repopulate the voice picker for whichever engine is selected. */
  _fillVoices() {
    const sel = document.getElementById('cfgAudioVoice');
    if (!sel) return;
    const browser = document.getElementById('cfgAudioEngine')?.value === 'browser';
    const current = browser
      ? (store.get('settings.audioBrowserVoice') || '')
      : (store.get('settings.audioVoice') || '');
    sel.innerHTML = '';
    for (const v of audio.voiceList()) {
      const opt = document.createElement('option');
      opt.value = v.value;
      opt.textContent = v.label;
      if (v.value === current) opt.selected = true;
      sel.appendChild(opt);
    }
    if (sel.selectedIndex < 0 && sel.options.length) sel.selectedIndex = 0;
  }

  _audioStatus() {
    const el = document.getElementById('cfgAudioStatus');
    const hint = document.getElementById('cfgAudioEngineHint');
    const engine = document.getElementById('cfgAudioEngine')?.value || 'auto';
    const usingBrowser = engine === 'browser' || !audio.isCloudReady();

    if (hint) {
      if (usingBrowser) {
        const n = audio.browserVoices().length;
        hint.textContent = n
          ? `Replies will be read by this computer's built-in voices. No API key, no cost, works offline. ${n} voice(s) available.`
          : 'This browser reports no built-in voices. On Linux that is common — install a speech-dispatcher voice package, or switch the engine back to Auto and add an API key.';
      } else {
        hint.textContent = 'Uses the API key saved for the provider above. Requests go through this server.';
      }
    }
    if (!el) return;
    const caps = (audio.capabilities || {})[audio.providerId()];
    const p = audio.provider();
    if (!usingBrowser && caps && caps.speech === false) {
      el.textContent = caps.speech_error || `${p ? p.name : 'That provider'} cannot synthesize speech.`;
      return;
    }
    if (!usingBrowser && p && !p.apiKey) {
      el.textContent = `${p.name} has no API key saved, so replies fall back to this computer's voices.`;
      return;
    }
    el.textContent = '';
  }

  open() {
    const settings = store.get('settings');
    document.getElementById('cfgTheme').value = settings.theme || 'dark';
    document.getElementById('cfgTemp').value = settings.temperature ?? 0.7;
    document.getElementById('cfgMaxTokens').value = settings.maxTokens ?? 4096;
    const hist = document.getElementById('cfgHistoryTurns');
    if (hist) hist.value = settings.historyTurns ?? DEFAULT_HISTORY_TURNS;

    // --- Speech ---
    const audioProvider = document.getElementById('cfgAudioProvider');
    if (audioProvider) audioProvider.value = settings.audioProvider || 'openai';
    const pitch = document.getElementById('cfgAudioPitch');
    const pitchVal = document.getElementById('cfgAudioPitchVal');
    if (pitch) {
      pitch.value = String(store.get('settings.audioPitch') ?? 1);
      const show = () => {
        if (pitchVal) pitchVal.textContent = Number(pitch.value).toFixed(2);
      };
      pitch.addEventListener('input', show);
      show();
    }
    const speed = document.getElementById('cfgAudioSpeed');
    if (speed) {
      speed.value = settings.audioSpeed ?? 1;
      const val = document.getElementById('cfgAudioSpeedVal');
      if (val) val.textContent = Number(settings.audioSpeed ?? 1).toFixed(2);
      speed.oninput = () => {
        const v = document.getElementById('cfgAudioSpeedVal');
        if (v) v.textContent = Number(speed.value).toFixed(2);
      };
    }
    const autoSpeak = document.getElementById('cfgAutoSpeak');
    if (autoSpeak) autoSpeak.checked = !!settings.autoSpeak;

    // The voice list comes from the server, so fetch it before filling the
    // picker; the rest of the modal opens regardless.
    const engineEl = document.getElementById('cfgAudioEngine');
    if (engineEl) engineEl.value = settings.audioEngine || 'browser';
    audio.loadCapabilities().then(() => {
      this._fillVoices();
      this._audioStatus();
    });
    // Assigned, not addEventListener: this modal is opened repeatedly and
    // stacking a listener per open would repopulate the picker N times.
    if (engineEl) {
      engineEl.onchange = () => { this._fillVoices(); this._audioStatus(); };
    }
    const providerEl = document.getElementById('cfgAudioProvider');
    if (providerEl) {
      providerEl.onchange = () => { this._fillVoices(); this._audioStatus(); };
    }
    // Chrome hands over its voice list late; redraw the picker when it lands.
    store.on('audio:voices', () => {
      if (document.getElementById('configModal')?.classList.contains('open')) {
        this._fillVoices();
        this._audioStatus();
      }
    });
    this._fillVoices();
    this._audioStatus();

    // Sandbox allowlist lives server-side (storage/config.json) because that is
    // where the path jail reads it from. Load it async so a slow or missing
    // backend never blocks the modal opening.
    const read = document.getElementById('cfgSandboxRead');
    const write = document.getElementById('cfgSandboxWrite');
    const token = document.getElementById('cfgSandboxToken');
    if (read) read.value = '…';
    if (write) write.value = '';
    // The token lives in this browser only; the server keeps its own copy.
    if (token) token.value = store.get('settings.sandboxToken') || '';
    api.getSandboxStatus()
      .then(s => {
        if (read) read.value = (s.read_roots || []).join('\n');
        if (write) write.value = (s.write_roots || []).join('\n');
        const status = document.getElementById('cfgSandboxStatus');
        if (status) {
          const engine = s.search_engine === 'searxng' ? 'SearXNG' : 'DuckDuckGo (no key)';
          const bits = [s.enabled
            ? `Filesystem tools are live. Web search: ${engine}.`
            : 'No directories are allowed yet, so the filesystem tools report themselves as disabled. Web search works regardless.'];
          if (s.require_token) {
            bits.push('A token is required — your browser must send a matching one or every sandbox call is refused.');
          }
          status.textContent = bits.join(' ');
        }
      })
      .catch(err => {
        const status = document.getElementById('cfgSandboxStatus');
        if (status) status.textContent = `Could not load sandbox settings: ${err.message}`;
        if (read) read.value = '';
      });

    document.getElementById('configModal').classList.add('open');
  }

  save() {
    const theme = document.getElementById('cfgTheme').value;
    const temp = parseFloat(document.getElementById('cfgTemp').value);
    const maxTokens = parseInt(document.getElementById('cfgMaxTokens').value);
    const histEl = document.getElementById('cfgHistoryTurns');
    const historyTurns = histEl
      ? Math.max(0, Math.min(50, parseInt(histEl.value, 10) || 0))
      : DEFAULT_HISTORY_TURNS;

    store.set('settings.theme', theme);
    store.set('settings.temperature', temp);
    store.set('settings.maxTokens', maxTokens);
    store.set('settings.historyTurns', historyTurns);

    // --- Speech ---
    const aEngine = document.getElementById('cfgAudioEngine');
    if (aEngine) store.set('settings.audioEngine', aEngine.value);
    const aProvider = document.getElementById('cfgAudioProvider');
    if (aProvider) store.set('settings.audioProvider', aProvider.value);
    const aVoice = document.getElementById('cfgAudioVoice');
    if (aVoice && aVoice.value) {
      // Kept apart: the two engines name voices completely differently, and a
      // stale value from the other one would select nothing.
      if (aEngine && aEngine.value === 'browser') store.set('settings.audioBrowserVoice', aVoice.value);
      else store.set('settings.audioVoice', aVoice.value);
    }
    const aSpeed = document.getElementById('cfgAudioSpeed');
    if (aSpeed) {
      const v = parseFloat(aSpeed.value);
      store.set('settings.audioSpeed', Number.isFinite(v) ? v : 1);
    }
    const aPitch = document.getElementById('cfgAudioPitch');
    if (aPitch) {
      const pv = parseFloat(aPitch.value);
      store.set('settings.audioPitch', Number.isFinite(pv) ? pv : 1);
    }
    const aAuto = document.getElementById('cfgAutoSpeak');
    if (aAuto) store.set('settings.autoSpeak', aAuto.checked);

    persistence.set('settings', store.get('settings'));
    themeManager.apply(theme);

    const readEl = document.getElementById('cfgSandboxRead');
    if (!readEl) { this.close(); return; }
    const paths = el => el.value.split('\n').map(s => s.trim()).filter(Boolean);
    const readRoots = paths(readEl);
    const writeRoots = paths(document.getElementById('cfgSandboxWrite'));
    const tokenEl = document.getElementById('cfgSandboxToken');
    const sandboxToken = tokenEl ? tokenEl.value.trim() : '';

    // Browser-side copy of the token, sent as X-Sandbox-Token on every
    // sandbox call. Persisted here rather than server-side on purpose: the
    // server keeps the authoritative copy in config.json.
    if (sandboxToken) {
      store.set('settings.sandboxToken', sandboxToken);
      persistence.set('settings', store.get('settings'));
    } else if (store.get('settings.sandboxToken')) {
      store.set('settings.sandboxToken', '');
      persistence.set('settings', store.get('settings'));
    }

    this.close();
    store.emit('toast', {
      message: historyTurns === 0
        ? 'Saved — memory off, each message is independent'
        : `Saved — agents remember the last ${historyTurns} turn${historyTurns === 1 ? '' : 's'}`,
      type: 'success',
    });

    // Saved after closing so the sandbox write is not on the modal's critical
    // path. /config replaces the whole file server-side, so re-read it first
    // and merge the sandbox key in — otherwise saving here would silently
    // discard every other setting the backend stores.
    api.getConfig()
      .then(cfg => {
        const next = { ...(cfg.sandbox || {}), read_roots: readRoots, write_roots: writeRoots };
        if (sandboxToken) next.token = sandboxToken;
        return api.saveConfig({ ...cfg, sandbox: next });
      })
      .then(() => store.emit('toast', { message: 'Sandbox saved', type: 'success' }))
      .catch(err => store.emit('toast', {
        message: `Sandbox not saved: ${err.message}`, type: 'error',
      }));
  }

  close() {
    document.getElementById('configModal').classList.remove('open');
  }
}

export default ConfigPanel;
