/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================���
// AUDIO.JS — Speech out and speech in
// ============================================
//
// Speech synthesis runs through the server proxy (providers are CORS-blocked),
// with the browser's own speechSynthesis as a fallback when no API key is
// configured, so the feature is never simply missing.
//
// Transcripts come from MediaRecorder + the proxy. The older Web Speech path in
// microphone.js still exists as a fallback for browsers without a key.

import { store } from './store.js?v=319';
import { api, errText } from './api.js?v=319';

/** OpenAI's per-request character ceiling. Matches MAX_CHARS in src/Audio.php. */
const MAX_CHARS = 4000;

/**
 * Break text into utterances short enough that the browser will finish them.
 *
 * Splitting on sentence marks alone was not enough. An agent reply often has a
 * long run with no full stop -- a URL, a log line, a code fragment -- which
 * becomes one enormous utterance, and Chrome abandons those after roughly 15
 * seconds. The result read as "it stops after a few words" with no error
 * anywhere. So sentences are further broken at commas and, failing that, on
 * whitespace, and any residue is hard-cut.
 */
const SPEECH_UTTERANCE_MAX = 220;

function splitForSpeech(text) {
  const src = String(text || '').trim();
  if (!src) return [];

  // Greedy packer. Every candidate piece is appended unless it would overflow,
  // which keeps sentences whole where they fit and never emits a piece larger
  // than the cap -- including for input with no spaces at all, where the only
  // way to bound the size is to cut mid-token.
  const out = [];
  let buf = '';
  const flush = () => { if (buf.trim()) { out.push(buf.trim()); buf = ''; } };
  const push = (piece) => {
    const p = String(piece || '');
    if (!p.trim()) return;
    if (p.length > SPEECH_UTTERANCE_MAX) {
      // A single token longer than the cap -- a very long URL, a hash, a blob.
      // There is nowhere natural to break it, so cut it hard.
      flush();
      for (let i = 0; i < p.length; i += SPEECH_UTTERANCE_MAX) {
        out.push(p.slice(i, i + SPEECH_UTTERANCE_MAX));
      }
      return;
    }
    if (buf.length + p.length > SPEECH_UTTERANCE_MAX) flush();
    buf += p;
  };

  // Split on newlines FIRST. A single sentence regex cannot cross a newline, so
  // running it over multi-line output matched only the final line and silently
  // discarded everything before it.
  for (const line of src.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    const sentences = trimmedLine.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [trimmedLine];
    for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if (s.length <= SPEECH_UTTERANCE_MAX) { flush(); out.push(s); continue; }

    // Prefer clause breaks, then words. split('') keeps the separators so
    // punctuation is spoken rather than swallowed.
    const clauses = s.split(/(?<=[,;:])\s*/);
    for (const clause of clauses) {
      if (clause.trim().length <= SPEECH_UTTERANCE_MAX) { push(clause); continue; }
      for (const word of clause.split(/(\s+)/)) push(word);
    }
    }
  }
  flush();
  return out.length ? out : [src];
}

/** Keeps recently spoken clips around so a re-read costs nothing. */
const CACHE_LIMIT = 16;

export class AudioController {
  constructor() {
    this.current = null;        // HTMLAudioElement being played
    this.currentUrl = null;     // object URL to revoke when it stops
    this.queue = Promise.resolve();
    this.stopped = false;
    this.cache = new Map();     // cacheKey -> object URL
    this.speaking = false;
    this.onStateChange = null;  // set by voice mode to mirror the UI
    this._browserUtterance = null;
    this.capabilities = null;
    /**
     * Replies that arrived while something else was being read.
     *
     * This used to be a hard `if (audio.speaking) return`, which discarded
     * every reply after the first. With a fan-out of five agents that meant one
     * reply was ever spoken and four were thrown away silently. speak() already
     * serialises through this.queue, so the fix is to enqueue rather than
     * refuse.
     */
    this._pendingSpeech = [];
  }

  /** Cap the backlog. An agent ticking every 30s must not build an unbounded pile. */
  static MAX_PENDING_SPEECH = 6;

  /** Remember a reply to be read once the current one finishes. */
  _enqueueSpeech(text, label, voice, pitch) {
    if (this._pendingSpeech.length >= AudioController.MAX_PENDING_SPEECH) {
      // Drop the OLDEST: the newest reply is the one you are waiting on.
      const dropped = this._pendingSpeech.shift();
      this.onStateChange?.({ queued: this._pendingSpeech.length, dropped: dropped?.label });
    }
    this._pendingSpeech.push({ text, label, voice, pitch });
  }

  /** Read the next queued reply, if any. Safe to call when idle. */
  _drainSpeech() {
    if (this.stopped || this.speaking || !this._pendingSpeech.length) return;
    const next = this._pendingSpeech.shift();
    this._speakNow(next.text, next.voice, next.pitch);
  }

  _speakNow(text, voice, pitch) {
    // Clear the speaking flag on BOTH paths before draining. _drainSpeech
    // refuses to start anything while `speaking` is true, so if any engine
    // failure path ever leaves that flag stuck, every queued reply behind it
    // would be stranded forever with no error shown. That is the same shape as
    // the "speech stops after a few words" bug, so it is defended against here
    // rather than trusted.
    const release = () => {
      this.speaking = false;
      this.onStateChange?.({ speaking: false });
    };
    this.speak(text, { voice, pitch })
      .then(() => { release(); this._drainSpeech(); })
      .catch((err) => {
        release();
        store.emit('toast', { message: `Speech failed: ${errText(err.message) || errText(err) || err}`, type: 'error' });
        // A failed reply must not strand the ones behind it.
        this._drainSpeech();
      });
  }

  /**
   * Wire the controller to the app.
   *
   * Auto-speak lives here rather than in the chat so playback, voice choice
   * and the failure messages all stay in one place; chat only announces that
   * a reply landed.
   */
  init() {
    if (this._wired) return;
    this._wired = true;

    store.on('chat:reply', (msg) => {
      if (!this.settings.autoSpeak) return;
      // chat.js only announces agent messages, but check the role here too:
      // this handler must never read your own question back at you, whoever
      // ends up emitting the event.
      if (!msg || msg.role === 'user') return;
      // Autonomous ticks post into the same transcript. Reading every one aloud
      // would talk over you continuously, so autonomous output is never spoken.
      if (msg.autonomous) return;
      const text = msg.content;
      if (!AudioController.isSpeakable(text)) return;

      // Per-agent overrides: an agent can pick its own voice, or opt out of
      // being read aloud entirely with voice === 'off'.
      const agent = (msg.agentId && (store.get('agents') || []).find(a => a.id === msg.agentId)) || null;
      const agentVoice = agent ? agent.voice : null;
      const agentPitch = agent ? agent.pitch : undefined;
      if (agent && (agentVoice === 'off' || agent.muteVoice === true)) return;

      // Queue rather than drop. Five agents replying at once used to leave
      // exactly one of them audible.
      if (this.speaking) {
        const label = (msg.agentName || '').trim() || null;
        this._enqueueSpeech(text, label, agentVoice || '', agentPitch);
        this.onStateChange?.({ queued: this._pendingSpeech.length });
        return;
      }
      this._speakNow(text, agentVoice || '', agentPitch);
    });

    // Escape stops playback, which matters most in voice mode.
    document.addEventListener?.('keydown', (e) => {
      if (e.key === 'Escape' && this.speaking) this.stop();
    });
  }

  // --- configuration ---

  get settings() {
    return store.get('settings') || {};
  }

  providerId() {
    return this.settings.audioProvider || 'openai';
  }

  /** The configured provider record, or null if it isn't there any more. */
  provider() {
    const id = this.providerId();
    const list = store.get('providers') || [];
    return list.find(p => p && p.id === id) || null;
  }

  /**
   * Whether cloud speech is actually usable: a provider that exists, has a
   * key, and is one the server knows how to route.
   */
  isCloudReady() {
    const p = this.provider();
    return !!(p && p.apiKey);
  }

  /** Base URL for the audio call, derived from the chat endpoint. */
  endpointFor(provider) {
    if (!provider || !provider.endpoint) return '';
    return String(provider.endpoint)
      .replace(/\/(chat\/completions|messages)$/, '');
  }

  spec(text, extra = {}) {
    // extra.voice overrides the global choice for cloud providers too.
    const p = this.provider();
    return {
      provider: this.providerId(),
      endpoint: this.endpointFor(p),
      api_key: (p && p.apiKey) || '',
      model: this.settings.audioModel || '',
      voice: (extra && extra.voice) || this.settings.audioVoice || '',
      speed: this.settings.audioSpeed ?? 1,
      pitch: this.resolvePitch(extra && extra.pitch),
      text,
      ...extra,
    };
  }

  async loadCapabilities() {
    if (this.capabilities) return this.capabilities;
    try {
      const res = await api.audioCapabilities();
      this.capabilities = (res && res.providers) || {};
    } catch {
      this.capabilities = {};
    }
    return this.capabilities;
  }

  /**
   * Whether this provider can synthesize at all.
   *
   * Groq's text-to-speech models were decommissioned, so it can transcribe but
   * not speak. Checking here means the settings panel can say so before the
   * user clicks something that will fail.
   */
  canSpeak() {
    const caps = this.capabilities || {};
    const entry = caps[this.providerId()];
    // Before capabilities load, assume yes: the server is the real gate and
    // it returns a plain explanation if the provider cannot speak.
    if (!entry) return true;
    return entry.speech !== false;
  }

  /**
   * Which engine to speak with.
   *
   * 'auto' still falls back to the OS voices when the chosen provider has no
   * key, which is what makes this work with no API at all. 'browser' forces
   * them even when a key exists.
   */
  engine() {
    // 'browser' forces built-in voices. 'auto' and anything else also uses
    // built-in voices (no API) unless the user explicitly chose a cloud provider
    // AND that provider has a valid API key.
    if (this.settings.audioEngine === 'browser') return 'browser';
    if (this.settings.audioEngine === 'auto') return 'browser';
    // Only explicit cloud providers (openai, groq, etc.) can use cloud
    return this.isCloudReady() ? 'cloud' : 'browser';
  }

  voiceList() {
    // Browser engine: offer what the OS actually has.
    if (this.engine() === 'browser') {
      return this.browserVoices().map(v => ({
        value: v.voiceURI || v.name,
        label: `${v.name} (${v.lang})${v.localService ? '' : ' — network'}`,
      }));
    }
    const id = this.providerId();
    const caps = this.capabilities || {};
    if (caps[id] && Array.isArray(caps[id].voices)) {
      return caps[id].voices.map(v => ({ value: v, label: v }));
    }
    // Before capabilities load, offer something sensible so the picker isn't
    // empty on first open.
    return [{ value: 'alloy', label: 'alloy' }];
  }

  // --- making text speakable ---

  /**
   * Strip everything that sounds wrong out loud.
   *
   * Reading raw markdown aloud is the single most obvious way this can feel
   * broken: models emit fenced code, inline backticks and bare URLs constantly,
   * and a voice saying "https colon slash slash" ruins the reply.
   */
  sanitize(text) {
    if (!text) return '';
    let out = String(text);

    out = out.replace(/```[\s\S]*?```/g, ' ');      // fenced code blocks
    out = out.replace(/~~~[\s\S]*?~~~/g, ' ');
    out = out.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'); // links -> link text
    out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');   // headings
    out = out.replace(/^\s{0,3}>\s?/gm, '');       // block quotes
    out = out.replace(/^\s*[-*+]\s+/gm, '');        // bullets
    out = out.replace(/^\s*\d+\.\s+/gm, '');        // numbered lists
    out = out.replace(/^\s*[-*_]{3,}\s*$/gm, ' ');  // horizontal rules
    out = out.replace(/\|\s*[-: ]+\|[-\s|:]*\|/g, ' '); // table rules
    out = out.replace(/\|/g, ' ');                  // table cells

    // Emphasis before backticks, and the underscore forms are anchored to a
    // word boundary on purpose. Tool names are snake_case and they appear in
    // nearly every reply: a loose _italic_ rule turns `read_file` into
    // "readfile" and `grep_code` into "grepcode".
    out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
    out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
    out = out.replace(/(^|[\s(\[])\*([^*\n]+)\*(?=$|[\s.,!?)])/gm, '$1$2');
    out = out.replace(/__([^_]+)__/g, '$1');
    out = out.replace(/(^|[\s(\[])_([^_\n]+)_(?=$|[\s.,!?)])/gm, '$1$2');
    out = out.replace(/~~([^~]+)~~/g, '$1');        // strikethrough

    out = out.replace(/`([^`]*)`/g, '$1');          // inline code, keep the text
    // Bare URLs last, so link text has already been extracted by this point.
    out = out.replace(/\bhttps?:\/\/\S+/gi, ' ');
    out = out.replace(/`+/g, '');

    return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Split on sentence boundaries so a long reply never exceeds the provider
   * limit and never gets cut mid-word.
   */
  chunk(text, max = MAX_CHARS) {
    const clean = String(text || '').trim();
    if (!clean) return [];
    if (clean.length <= max) return [clean];

    const sentences = clean.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g) || [clean];
    const out = [];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > max && buf) {
        out.push(buf.trim());
        buf = '';
      }
      if (s.length > max) {
        // A single enormous "sentence" (minified code, a data blob): fall back
        // to a hard cut rather than dropping the text entirely.
        for (let i = 0; i < s.length; i += max) {
          out.push(s.slice(i, i + max).trim());
        }
        continue;
      }
      buf += s;
    }
    if (buf.trim()) out.push(buf.trim());
    return out.filter(Boolean);
  }

  // --- playing ---

  cacheKey(text) {
    return `${this.providerId()}|${this.settings.audioVoice || ''}|${text}`;
  }

  /** Blobs, not object URLs: a cached URL would have to be fetched back to
   *  rebuild the Blob it was made from, which is pointless and can fail. */
  _cachePut(key, blob) {
    this.cache.set(key, blob);
    // Evict the oldest. Dropping the Blob is enough for the browser to reclaim
    // it; no URL exists yet to revoke.
    while (this.cache.size > CACHE_LIMIT) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  /** Play one blob to completion, resolving when it ends (or is stopped). */
  _play(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const el = new Audio(url);
      this.current = el;
      this.currentUrl = url;
      const cleanup = () => {
        if (this.current === el) { this.current = null; this.currentUrl = null; }
        URL.revokeObjectURL(url);
      };
      el.onended = () => { cleanup(); resolve(); };
      el.onerror = () => {
        cleanup();
        reject(new Error('The browser could not play the generated audio.'));
      };
      el.play().catch((err) => { cleanup(); reject(err); });
    });
  }

  /** Speak with the browser's built-in voices. Used when there is no key. */
  /**
 * The voices the OS provides, cached.
 *
 * Chrome fills this list asynchronously and fires `voiceschanged` when it
 * lands, so reading it once at startup usually gets an empty array. Cache it
 * and refresh on the event, then tell anyone watching the picker to redraw.
 */
  browserVoices() {
    const synth = window.speechSynthesis;
    if (!synth || typeof synth.getVoices !== 'function') return [];
    let voices = synth.getVoices();
    if (voices && voices.length) { this._voices = voices; return voices; }
    if (this._voices && this._voices.length) return this._voices;
    if (!this._voicesBound && typeof synth.addEventListener === 'function') {
      this._voicesBound = true;
      synth.addEventListener('voiceschanged', () => {
        this._voices = synth.getVoices() || [];
        store.emit('audio:voices', { voices: this._voices });
      });
    }
    return this._voices || [];
  }

  /**
   * Which voice to use: the one chosen in Settings if it still exists,
   * otherwise the best-sounding local English voice available.
   *
   * `localService` matters. Chrome ships "Google UK English Female" and
   * friends as *network* voices that can fail silently when offline — the
   * opposite of what you want from a fallback that exists to work offline.
   */
  /**
   * Resolve which voice to speak with.
   *
   * `override` is the per-agent choice. It wins over the global setting, so two
   * agents can be given different voices instead of every reply sounding
   * identical. Falls back to the global pick when the override names a voice
   * this machine does not have.
   */
  pickBrowserVoice(override) {
    const voices = this.browserVoices();
    if (!voices.length) return null;
    const want = String(override || this.settings.audioBrowserVoice || '');
    if (want) {
      const exact = voices.find(v => v.voiceURI === want || v.name === want);
      if (exact) return exact;
      // The saved voice does not exist on THIS machine. That happens whenever a
      // copy made on one OS is opened on another: these URIs are typically
      // urn:moz-tts:sapi:...Microsoft Zira..., which only exist on
      // Firefox-on-Windows. Falling through silently to the first English
      // voice made every agent speak in the same one and read as "the per-agent
      // voices are ignored". Say so once per missing voice instead, and tell
      // the user what they can actually choose from.
      this._warnMissingVoice(want, voices);
    }
    const english = voices.filter(v => /^en(-|_|$)/i.test(v.lang || ''));
    const pool = english.length ? english : voices;
    return pool.find(v => v.localService) || pool[0] || null;
  }

  /**
   * One notice per missing voice, not one per utterance -- otherwise an agent
   * with an unavailable voice nags on every single sentence.
   */
  _warnMissingVoice(want, voices) {
    this._missingVoices = this._missingVoices || new Set();
    if (this._missingVoices.has(want)) return;
    this._missingVoices.add(want);
    const names = voices.slice(0, 8).map(v => v.name).join(', ');
    try {
      store.emit('toast', {
        message: `Voice "${want.split('?')[0].replace(/^urn:moz-tts:sapi:/, '')}" is not installed on this `
          + `machine, so that agent is using a default voice. Available: ${names}`
          + `${voices.length > 8 ? ', ...' : ''}. Re-pick it in the agent's settings.`,
        type: 'error',
      });
    } catch { /* no store */ }
  }

  /**
   * Speak with the OS voices.
   *
   * Two long-standing Chrome bugs are worked around here, because without them
   * this reads as "the built-in voices are broken":
   *
   *  - Speech is cut off after roughly 15 seconds. Poking the synth with a
   *    pause/resume tick keeps it alive for long replies.
   *  - Long text stalls. The text is spoken a sentence at a time instead.
   */
  /**
   * Resolve pitch for a call: per-agent value first, then the global default.
   * Chrome clamps this to 0..2 with 1 as neutral. It is the lever that makes a
   * single installed voice read as distinctly higher or lower, which matters
   * when the machine only exposes a handful of voices.
   */
  resolvePitch(override) {
    const raw = override === undefined || override === null || override === ''
      ? (this.settings.audioPitch ?? 1)
      : override;
    const n = Number(raw);
    return Math.max(0.1, Math.min(2, Number.isFinite(n) ? n : 1));
  }

  speakBrowser(text, voiceOverride, pitchOverride) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth || !text) { resolve(); return; }
      this._browserDone = false;

      const voice = this.pickBrowserVoice(voiceOverride);
      const rate = Math.max(0.5, Math.min(2, Number(this.settings.audioSpeed) || 1));
      const pitch = this.resolvePitch(pitchOverride);
      // Sentence-at-a-time also keeps each utterance short, which is what stops
      // Chrome from hanging on a wall of text.
      const parts = splitForSpeech(text);

      let i = 0;
      let watchdog = null;
      this._keepAlive = setInterval(() => {
        // Touching the synth resets its internal countdown.
        try { synth.pause(); synth.resume(); } catch { /* not fatal */ }
      }, 8000);

      const clearWatchdog = () => {
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      };

      const next = () => {
        clearWatchdog();
        if (this.stopped || i >= parts.length) { finish(); return; }
        const utter = new SpeechSynthesisUtterance(parts[i++].trim());
        utter.rate = rate;
        utter.pitch = pitch;
        if (voice) utter.voice = voice;
        utter.onend = () => next();
        utter.onerror = (ev) => {
          // 'interrupted' and 'canceled' are what Chrome emits when it silently
          // cuts a long utterance off, and 'synthesis-unavailable' is what a
          // missing voice produces. Neither should end the reply: advance and
          // keep going, or the rest of the answer is never spoken.
          if (ev && ev.error === 'canceled' && this.stopped) { finish(); return; }
          next();
        };
        // Watchdog. If neither onend nor onerror ever arrives -- which is what
        // Firefox does when it drops an utterance -- the loop would sit on the
        // same line forever and the reply would simply stop after a few
        // seconds with no error shown anywhere.
        watchdog = setTimeout(() => {
          watchdog = null;
          try { synth.cancel(); } catch { /* ignore */ }
          next();
        }, Math.max(8000, (parts[i - 1] || '').length * 90));
        this._browserUtterance = utter;
        try { synth.speak(utter); } catch { next(); }
      };

      const finish = () => {
        if (this._browserDone) return;
        this._browserDone = true;
        clearWatchdog();
        clearInterval(this._keepAlive);
        this._keepAlive = null;
        this._browserUtterance = null;
        this._browserFinish = null;
        resolve();
      };
      // Kept so stop() can release anyone awaiting this speech directly.
      // Relying on the browser to fire onend after cancel() is fragile — some
      // fire onerror, some fire nothing — and a stuck await would wedge the
      // caller forever.
      this._browserFinish = finish;

      this.stopped = false;
      next();
    });
  }

  /**
   * Speak text aloud.
   *
   * @param {string} raw  markdown is stripped first
   * @param {object} [opts] { onStart, onDone } callbacks for the UI
   * @returns {Promise<{spoken: number, chunks: number, engine: string}>}
   */
  speak(raw, opts = {}) {
    const text = this.sanitize(raw);
    if (!text) {
      return Promise.resolve({ spoken: 0, chunks: 0, engine: 'none' });
    }
    this.stopped = false;
    // Resolved for THIS call only. It used to be stashed on `this` and reused
    // when opts.voice was empty, which meant the first per-agent voice ever
    // used became permanent: changing the global voice in Settings appeared to
    // do nothing until you pressed stop. The queue already carries each item's
    // own voice, so there was never a reason for it to be sticky.
    const voiceForRun = (opts && opts.voice) || '';
    const pitchForRun = opts ? opts.pitch : undefined;
    const chunks = this.chunk(text);
    const engine = this.engine();
    this.speaking = true;
    opts.onStart?.(text, engine);
    this.onStateChange?.({ speaking: true, engine });

    // Serialize: concurrent speaks would overlap, and revoke each other's URLs.
    this.queue = this.queue.then(async () => {
      let spoken = 0;
      try {
        for (const part of chunks) {
          if (this.stopped) break;
          if (engine === 'browser') {
            await this.speakBrowser(part, voiceForRun, pitchForRun);
            spoken += part.length;
            continue;
          }
          const key = this.cacheKey(part);
          let blob = this.cache.get(key);
          if (!blob) {
            blob = await api.audioSpeak(this.spec(part, { voice: voiceForRun, pitch: pitchForRun }));
            this._cachePut(key, blob);
          }
          await this._play(blob);
          spoken += part.length;
        }
      } catch (err) {
        this.speaking = false;
        this.onStateChange?.({ speaking: false });
        opts.onDone?.(err);
        throw err;
      }
      this.speaking = false;
      this.onStateChange?.({ speaking: false });
      opts.onDone?.(null);
      return { spoken, chunks: chunks.length, engine };
    });

    return this.queue;
  }

  /** Stop immediately, whether mid-word or mid-reply. */
  stop() {
    this.stopped = true;
    // Clear the backlog too. Stopping means "I have heard enough"; without this
    // the queued replies kept talking after the button was pressed.
    this._pendingSpeech = [];
    this.onStateChange?.({ queued: 0 });
    if (this._keepAlive) { clearInterval(this._keepAlive); this._keepAlive = null; }
    if (this.current) {
      this.current.pause();
      this.current.currentTime = 0;
      this.current = null;
    }
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    try { window.speechSynthesis?.cancel(); } catch { /* not available */ }
    this._browserUtterance = null;
    // Release the pending speakBrowser() even if the engine never reports back.
    if (this._browserFinish) { const f = this._browserFinish; this._browserFinish = null; f(); }
    this.speaking = false;
    this.onStateChange?.({ speaking: false });
  }

  /** True when the tag is speech worth sending to the provider. */
  static isSpeakable(raw) {
    const plain = String(raw || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[`*_#>|~\[\]()]/g, ' ')
      .trim();
    return plain.length > 1;
  }
}

export const audio = new AudioController();
export default audio;