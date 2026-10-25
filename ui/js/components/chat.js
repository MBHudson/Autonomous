/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// CHAT.JS — Chat panel controller
// ============================================

import { store } from '../store.js?v=327';
import { K as STORAGE_K } from '../storage.js?v=327';

const CURRENT_SESSION_KEY = STORAGE_K.CURRENT_SESSION;

/**
 * How many extra steps a burst of steering messages may buy. Bounded on
 * purpose: steering is a human override, not a licence to run unbounded.
 */
const MAX_STEER_STEPS = 8;
import { api, errText } from '../api.js?v=327';
import { persistence } from '../persistence.js?v=327';
import { DEFAULT_HISTORY_TURNS, agentCode, asText, historyCharBudget, compactMessages, contextInputBudget, compactText } from '../utils.js?v=327';
import { settingFor, alwaysAppendFor, sandboxRootFor } from '../agentConfig.js?v=327';
import { toolProtocolFor, contextLimitFor, detectFamily, rememberDialect } from '../toolProtocol.js?v=327';
import { toolInstructions, parseToolCall, runTool, MAX_TOOL_STEPS, bindAgentComms, defaultTools, ALWAYS_ON_TOOLS, BROWSER_TOOLS, TOOL_REGISTRY } from '../tools.js?v=327';
import { nativeToolDefs, nativeToolChoice, nativeToolArgs, NATIVE_FAMILIES } from '../nativeTools.js?v=327';
import { buildToolInstructions, getEnvFacts, nextDialect, browserEnabled } from '../toolManifest.js?v=327';
import { poolEnabled, pickKey, noteResult } from '../apiPool.js?v=327';
import { usageFor } from '../rateGovernor.js?v=327';
import { trace } from '../trace.js?v=327';
import { latency } from '../latency.js?v=327';
import { buildContent, mergeContent, stripImages, acceptAttr } from '../attachments.js?v=327';
import { blockFor as memoryBlockFor, MEMORY_TOOLS } from '../memory.js?v=327';
import { SlashCommands } from '../slashCommands.js?v=327';
import { parseRoute, routingHelp } from '../routing.js?v=327';
import { substituteCurlTemplate, parseCurl, bearerFromHeaders, bodyHasSystemMessage, findLeftoverVars, parseJsonLenient, hasTemplateVars } from '../curlParser.js?v=327';
import { parseSnippet, snippetKind } from '../snippetParser.js?v=327';
import { MessageRenderer, renderToolCalls } from './message.js?v=327';
import { createAvatar } from './avatar.js?v=327';

/**
 * How long an agent may keep working on a single task.
 *
 * An agent that is still asking for tools has not finished, and cutting it
 * off mid-task is what produced "stops without completing". So the loop keeps
 * going -- but only to a ceiling. Without one, a model that keeps calling a
 * failing tool would spend tokens until the tab died.
 */
const PERSISTENCE_MAX_STEPS = 12;          // tool calls per turn, all rounds
const PERSISTENCE_WALL_CLOCK_MS = 20 * 60 * 1000;
const FINAL_SUMMARY_MS = 90 * 1000;         // grace period for the closing summary
const AGENT_FILES_BUDGET = 260000;          // absolute character ceiling for attached files
const TOOL_RECORD_CHARS = 8000;             // per-call UI copy, not the model transcript

function toolArgForUi(arg) {
  if (arg === undefined) return null;
  let text;
  try {
    text = typeof arg === 'string' ? arg : JSON.stringify(arg);
  } catch {
    text = String(arg);
  }
  if (String(text || '').length <= 4000) return arg;
  return { _truncated: true, preview: String(text).slice(0, 4000) };
}

function toolResultForUi(result) {
  const text = asText(result);
  if (text.length <= TOOL_RECORD_CHARS) return text;
  return `${text.slice(0, TOOL_RECORD_CHARS)}\n\u2026 (${text.length - TOOL_RECORD_CHARS} more characters)`;
}

function toolResultStatus(text) {
  const t = String(text || '').trim();
  if (/^waiting for your approval|^pending approval/i.test(t)) return 'pending';
  if (/^(error|denied|refused)\b|^could not |^timed out/i.test(t)) return 'error';
  const exit = /\[exit (-?\d+)/i.exec(t);
  if (exit && Number(exit[1]) !== 0) return 'error';
  return 'ok';
}

/**
 * Is this a rate-limit refusal? Checked by status first (the relay now
 * forwards it) and by message text as fallback (one-shot paths stringify the
 * upstream body, e.g. "Provider error 429: {...temporarily rate-limited...}").
 */
export function isRateLimited(err) {
  if (!err || err?.name === 'AbortError') return false;
  if (Number(err.status) === 429) return true;
  const m = errText(err.message) || errText(err) || '';
  return /\b429\b|rate[\s_\-]*limit|too many requests|temporarily limited/i.test(m);
}

/**
 * Failures retrying cannot fix: bad keys, unknown models, malformed requests.
 * A 401 used to be retried twice like a blip, which burned two calls and, on
 * a shared key, two slots against the rate limit for an answer that could
 * never change.
 */
export function isNonRetryable(err) {
  if (!err || err?.name === 'AbortError') return false;
  const s = Number(err.status);
  if (s === 429) return false;
  if ([400, 401, 403, 404, 422].includes(s)) return true;
  if (isRateLimited(err)) return false;
  const m = (errText(err.message) || errText(err) || '').toLowerCase();
  return /invalid (api key|model)|incorrect api key|unauthorized|authentication|model not found|no such model|unknown model|bad request|billing|quota|permission denied|forbidden/.test(m);
}

/**
 * Should this failure be retried on the generic path?
 *
 * Timeouts, dropped connections and gateway errors are usually transient: a
 * slow reasoning model overrunning the server limit, a momentary blip.
 * Rate limits are deliberately NOT transient here -- they have their own path
 * in relayWithRetry that waits instead of hammering. Bad keys and bad model
 * ids are not, and retrying those just makes the user wait for the same error.
 */
function isTransientFailure(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;          // the user meant it
  if (isNonRetryable(err)) return false;
  if (isRateLimited(err)) return false;
  if (err.retryable === true) return true;
  if (err.retryable === false) return false;
  const m = errText(err.message).toLowerCase() || errText(err).toLowerCase();
  return /timed out|timeout|ns_binding_aborted|failed to fetch|network|load failed|aborted/.test(m)
    || /\b(500|502|503|504|520|522|524)\b/.test(m);
}

/**
 * How long to wait before attempt N (1-based). Pure apart from Math.random,
 * which is injectable so probes can assert exact values.
 *
 * Rate limits wait on a different scale from blips: a 20-requests/minute key
 * frees a slot every 3 seconds, so retrying after 1s is just spending the
 * next refusal. Honour the server's Retry-After when present (capped at a
 * minute), otherwise back off exponentially. Generic blips keep the old
 * short waits, slightly lengthened.
 */
export function retryDelayMs(err, attempt, rand = Math.random) {
  const jitter = Math.floor((typeof rand === 'function' ? rand() : Math.random()) * 1000);
  if (isRateLimited(err)) {
    const ra = Number(err.retryAfterMs);
    const base = Number.isFinite(ra) && ra > 0
      ? Math.min(ra, 60000)
      : Math.min(5000 * (2 ** (attempt - 1)), 30000);
    return base + jitter;
  }
  return (attempt === 1 ? 2000 : 5000) + jitter;
}

/** Sleep that an abort cuts short, so Stop still stops during a long wait. */
function backoff(ms, signal) {
  if (!signal) return new Promise(r => setTimeout(r, ms));
  if (signal.aborted) {
    const e = new Error('The user aborted a request.');
    e.name = 'AbortError';
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    let t = null;
    const onAbort = () => {
      if (t !== null) clearTimeout(t);
      const e = new Error('The user aborted a request.');
      e.name = 'AbortError';
      reject(e);
    };
    t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A one-shot relay failure as an Error that keeps status/retryable, so the
 * callers' classifiers see the same shape the streaming path throws. */
function relayError(res, fallback) {
  const err = new Error((res && res.error) || fallback);
  if (res && res.status) err.status = res.status;
  if (res && typeof res.retryable === 'boolean') err.retryable = res.retryable;
  return err;
}

/**
 * One model call, retrying transient upstream failures.
 *
 * This is what turns "one slow response and the agent gives up" into "the
 * agent finishes". The server reports a mid-stream failure as a thrown error
 * rather than an empty reply, so there is something to act on here.
 *
 * Rate limits take the waiting path: the delay is seconds, not a second, and
 * the operator is told how long the wait is. Everything else keeps the short
 * retries.
 */
async function relayWithRetry(spec, opts = {}) {
  const maxAttempts = opts.attempts ?? 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      const e = new Error('The user aborted a request.');
      e.name = 'AbortError';
      throw e;
    }
    try {
      return await api.relayStream(spec, opts);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      const rateLimited = isRateLimited(err);
      if (!rateLimited && !isTransientFailure(err)) throw err;
      lastErr = err;
      if (attempt === maxAttempts) throw err;
      const delay = retryDelayMs(err, attempt);
      opts.onRetry?.(attempt, err, delay);
      await backoff(delay, opts.signal);
    }
  }
  throw lastErr;
}

export class Chat {
  constructor() {
    this.messages = [];
    this.isTyping = false;
    this.currentSessionId = null;
    this.renderer = new MessageRenderer();
    /** Streaming placeholders, keyed by agentId. */
    this._liveNodes = new Map();
    /**
     * Images staged for the NEXT turn. Deliberately in memory only: persisting
     * base64 would blow the localStorage quota and the replayed-history budget,
     * and the bytes are needed for exactly one request.
     */
    this._attachments = [];
    /**
     * Agent-to-agent state for the current turn.
     * _mailbox: agentId -> [{from, message}]. Per turn, so an instruction does
     * not haunt an agent forever.
     * _busy: agentIds currently answering someone. The fan-out runs agents in
     * parallel, so two agents asking the same one at once would otherwise fire
     * two identical model calls; the second is refused instead.
     */
    this._mailbox = new Map();
    this._busy = new Set();
    // Nested ask_agent calls only. _busy also holds every agent in the current
    // user fan-out, so using it here refused every ask to a sibling agent with
    // "already answering another agent" -- the inter-agent traffic that used to
    // work stopped working. Nested asks get their own set; _busy still guards
    // the always-on scheduler.
    this._nestedBusy = new Set();
    /**
     * Agent IDs that already replied to the current user turn. Prevents the
     * same agent from answering twice when the always-on scheduler re-fires
     * immediately after the user turn ends (the "double response" bug).
     */
    this._turnResponded = new Set();

    // One call per tool run() is all the wiring the comms tools need; the
    // bridge below owns the roster and can start another agent.
    bindAgentComms({
      roster: () => (store.get('agents') || []).map(a => ({
        id: a.id, name: a.name, role: a.role, model: a.model, active: a.active,
      })),
      ask: (targetId, question, ctx) => this._askAgentSync(targetId, question, ctx),
      post: (targetId, fromId, message) => {
        const list = this._mailbox.get(targetId) || [];
        const from = (store.get('agents') || []).find(a => a.id === fromId);
        list.push({ from: from?.name || 'an agent', message });
        this._mailbox.set(targetId, list);
        // An order is communication too: one line out, none back, because
        // nothing is being awaited.
        store.emit('flow:speak', { from: fromId, to: targetId, kind: 'tell' });
      },
      mailbox: agentId => this._mailbox.get(agentId) || [],
      consume: agentId => this._mailbox.delete(agentId),
    });
  }

  init() {
    const sendBtn = document.getElementById('sendBtn');
    const inputField = document.getElementById('inputField');

    document.getElementById('clearScreenBtn')?.addEventListener('click', () => this.clearScreen());

    // Restore the open session across refreshes (no more duplicate sessions)
    try {
      this.currentSessionId = localStorage.getItem(CURRENT_SESSION_KEY) || null;
    } catch { this.currentSessionId = null; }

    // Follow session switches (sidebar select / +ADD) + render the dialog
    store.on('conversation:loaded', (conv) => {
      if (conv?.id) {
        this.currentSessionId = conv.id;
        try { localStorage.setItem(CURRENT_SESSION_KEY, conv.id); } catch {}
        if (Array.isArray(conv.messages)) {
          this.loadConversation(conv);
        }
      }
    });
    // Forget deleted sessions
    store.on('conversation:closed', ({ id } = {}) => {
      if (id && this.currentSessionId === id) {
        this.currentSessionId = null;
        try { localStorage.removeItem(CURRENT_SESSION_KEY); } catch {}
      }
    });

    sendBtn.addEventListener('click', () => this.sendMessage());
    inputField.addEventListener('keydown', (e) => {
      // Enter-to-send is a user preference, not a hardcoded rule. It used to
      // always fire: the toggle in Config saved fine and was read by nothing,
      // so turning it off appeared to do nothing.
      const enterToSend = store.get('settings.enterToSend') !== false;
      if (enterToSend && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // While a turn is running, this steers it rather than starting a
        // second one. It previously did neither: it called sendMessage()
        // again, which overwrote this.aborter with a fresh AbortController,
        // orphaning the first run so nothing could cancel it -- both runs then
        // completed and every agent answered twice.
        this.sendMessage();
      }
    });
    // The stop control. Separate from send precisely so that sending can mean
    // "steer", which is the whole point of the change.
    document.getElementById('stopBtn')?.addEventListener('click', () => this.stop());

    // Escape stops, from anywhere in the composer. Typing never triggers it.
    inputField.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.aborter) {
        e.preventDefault();
        this.stop();
      }
    });

    inputField.addEventListener('input', () => {
      inputField.style.height = 'auto';
      inputField.style.height = Math.min(inputField.scrollHeight, 100) + 'px';
    });

    // The "/" palette lives on the same textarea. It listens in the capture
    // phase, so it gets keys before the handler above turns Enter into a send.
    this.slash = new SlashCommands(inputField, this);
    this.slash.init();

    this._initAttachments(inputField);

    // Listen for message repeat events
    store.on('message:repeat', (msg) => {
      document.getElementById('inputField').value = msg.content;
      document.getElementById('inputField').focus();
    });

    // Deliver tell_agent instructions from user or other agents.
    store.on('agent:tell', ({ agentId, from, message } = {}) => {
      if (!agentId || !message) return;
      // Reuse the bridge's post logic to deliver to the mailbox.
      const list = this._mailbox.get(agentId) || [];
      const fromName = from === 'user' ? 'user' : (store.get('agents') || []).find(a => a.id === from)?.name || 'an agent';
      list.push({ from: fromName, message });
      this._mailbox.set(agentId, list);
      store.emit('flow:speak', { from: from || 'user', to: agentId, kind: 'tell' });
    });

    // Wake up an agent and prompt them to read their mailbox.
    store.on('agent:ping', ({ agentId } = {}) => {
      if (!agentId) return;
      // The mailbox already exists; we just need to prod the agent to read it.
      // Emit a 'tell' with a special instruction so the agent's next turn
      // naturally calls read_mailbox without any extra plumbing.
      const list = this._mailbox.get(agentId) || [];
      list.push({ from: 'system', message: 'PING — check your mailbox (read_mailbox) for new instructions.' });
      this._mailbox.set(agentId, list);
      store.emit('flow:speak', { from: 'user', to: agentId, kind: 'ping' });
    });
  }

  // ---------------------------------------------------------------
  // Image attachments (vision-capable agents)
  //
  // The bytes never touch the server: they become a data: URL held in memory
  // and are placed straight into the request body's image_url field. There is
  // no upload endpoint and no file on disk, which is what keeps the
  // webshell-via-file-upload family out of reach. See attachments.js.
  // ---------------------------------------------------------------

  _initAttachments(inputField) {
    const wrap = inputField.closest('.chat-input-wrapper') || inputField.parentElement;
    if (!wrap) return;

    // The strip is injected rather than added to index.html so the legacy
    // ui/index.html and the canonical index.html cannot drift apart.
    const strip = document.createElement('div');
    strip.className = 'attach-strip';
    strip.id = 'attachStrip';
    strip.hidden = true;
    wrap.insertBefore(strip, wrap.firstChild);

    const btn = document.createElement('button');
    btn.className = 'attach-btn';
    btn.id = 'attachBtn';
    btn.type = 'button';
    btn.title = 'Attach an image (or just paste one)';
    btn.setAttribute('aria-label', 'Attach an image');
    btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">'
      + '<rect x="1.5" y="2.5" width="13" height="11" rx="2"/>'
      + '<circle cx="5.5" cy="6" r="1.2"/>'
      + '<path d="M2 12l3.5-3.5 2.5 2.5 2.5-2.5L14 12"/></svg>';
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = acceptAttr();
    picker.multiple = true;
    picker.hidden = true;
    picker.id = 'attachPicker';
    btn.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
      this.attachFiles(Array.from(picker.files || []));
      picker.value = '';          // let the same file be picked twice
    });
    // Discoverability: name the syntax in the placeholder.
    const ph = inputField.getAttribute('placeholder') || '';
    if (!ph.includes('/CODE')) {
      inputField.setAttribute('placeholder',
        'Type a message... (Enter to send, Shift+Enter for newline)'
        + '   |  /CODE or /ROLE to address  |  /? for help');
    }
    wrap.parentElement.insertBefore(btn, wrap);
    wrap.parentElement.insertBefore(picker, wrap);

    // Paste a screenshot straight into the composer.
    inputField.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const it of Array.from(items)) {
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f && /^image\//.test(f.type)) files.push(f);
        }
      }
      if (!files.length) return;   // plain text paste: let the default happen
      e.preventDefault();
      this.attachFiles(files);
    });

    // ...or drop one onto the composer.
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    ['dragenter', 'dragover'].forEach(ev => wrap.addEventListener(ev, (e) => {
      stop(e);
      wrap.classList.add('drop-target');
    }));
    ['dragleave', 'drop'].forEach(ev => wrap.addEventListener(ev, (e) => {
      stop(e);
      if (ev === 'dragleave' && wrap.contains(e.relatedTarget)) return;
      wrap.classList.remove('drop-target');
    }));
    wrap.addEventListener('drop', (e) => {
      const files = (e.dataTransfer && e.dataTransfer.files) ? Array.from(e.dataTransfer.files) : [];
      if (files.length) this.attachFiles(files);
    });
  }

  /**
   * Stage images for the next turn. Each file is validated and downscaled
   * independently, so one bad file reports its own reason and does not
   * discard the good ones alongside it.
   */
  async attachFiles(files) {
    const images = files.filter(f => /^image\//.test(f.type || '') || /\.(png|jpe?g|webp|gif)$/i.test(f.name || ''));
    if (!images.length) {
      store.emit('toast', { message: 'Only PNG, JPEG, WebP and GIF images are accepted.', type: 'error' });
      return;
    }
    for (const f of images) {
      try {
        const { prepare } = await import('../attachments.js');
        this._attachments.push(await prepare(f));
      } catch (err) {
        store.emit('toast', { message: (err && err.message) || 'Could not read that image.', type: 'error' });
      }
    }
    this._renderAttachments();
  }

  clearAttachments() {
    this._attachments = [];
    this._renderAttachments();
  }

  _renderAttachments() {
    const strip = document.getElementById('attachStrip');
    if (!strip) return;
    const list = this._attachments;
    strip.hidden = list.length === 0;
    strip.innerHTML = '';
    list.forEach((a, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'attach-thumb';
      thumb.title = `${a.name} - ${a.w}x${a.h}, ${(a.bytes / 1024).toFixed(0)} KB`;
      // A data: URL the browser itself just produced, not user input.
      const img = document.createElement('img');
      img.src = a.dataUrl;
      img.alt = a.name;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'attach-x';
      x.title = 'Remove';
      x.textContent = '\u00d7';
      x.addEventListener('click', () => {
        this._attachments.splice(i, 1);
        this._renderAttachments();
      });
      thumb.appendChild(img);
      thumb.appendChild(x);
      strip.appendChild(thumb);
    });
  }

  async sendMessage() {
    const input = document.getElementById('inputField');
    // A run is already in flight: this is a steering message, not a new turn
    // and emphatically not a STOP. It joins the running agents' conversation
    // at their next tool-loop boundary, which is what lets you redirect work
    // that is already underway instead of killing it and starting over.
    if (this.aborter) {
      this.steer(input.value.trim());
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    const sendBtn = document.getElementById('sendBtn');
    const typed = input.value.trim();
    const pending = this._attachments.slice();
    // An image alone is a valid turn - "what's wrong with this?" needs no words.
    if (!typed && !pending.length) return;

    // Commands are checked BEFORE "/CODE" addressing, because "/clear" would
    // otherwise be read as addressing an agent whose role happens to be
    // "clear". Anything that is not a command returns false and falls through
    // to routing untouched.
    const slash = SlashCommands.parse(typed);
    if (slash && this.slash && this.slash.runCommand(slash.name, slash.args)) {
      input.value = '';
      input.style.height = 'auto';
      return;
    }

    // "/" addressing decides WHO answers, and strips the prefix so the agent is
    // never handed its own routing syntax. Resolved before the composer clears
    // so a bad target can be reported with the text still on screen.
    const route = parseRoute(typed, store.get('agents') || []);
    if (route.mode === 'none') {
      this._addMessage({ role: 'agent', content: route.reason, agentId: null, timestamp: Date.now() });
      store.emit('toast', { message: route.reason, type: 'error' });
      return;
    }
    // "/?" is a request for help rather than a task.
    if (typed.trim() === '/?' || typed.trim() === '/help') {
      this._addMessage({ role: 'agent', content: routingHelp(store.get('agents') || []),
        agentId: null, timestamp: Date.now() });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    const text = route.prompt;

    input.value = '';
    input.style.height = 'auto';
    // Cleared immediately: attachments live in memory for one turn only.
    this._attachments = [];
    this._renderAttachments();
    this.aborter = new AbortController();
    this._setSendMode(true);

    // Create session if none exists (or validate the restored one is still there)
    if (!this.currentSessionId) {
      try {
        const session = await api.createSession('Chat Session');
        this.currentSessionId = session.id || session.session_id;
        store.set('currentSessionId', this.currentSessionId);
        try { localStorage.setItem(CURRENT_SESSION_KEY, this.currentSessionId); } catch {}
      } catch (err) {
        console.error('Failed to create session:', err);
      }
    } else {
      try {
        await api.getSession(this.currentSessionId);
      } catch {
        // Stored session was deleted elsewhere — make a fresh one
        try {
          const session = await api.createSession('Chat Session');
          this.currentSessionId = session.id || session.session_id;
          try { localStorage.setItem(CURRENT_SESSION_KEY, this.currentSessionId); } catch {}
        } catch (err) {
          console.error('Failed to create session:', err);
        }
      }
    }

    // Add user message
    // The STORED message carries text only. A base64 image would bloat
    // localStorage and blow the replayed-history budget, so images are
    // referenced by name and never persisted as bytes.
    const userMsg = { role: 'user', content: text, timestamp: Date.now(),
      images: pending.map(a => ({ name: a.name, w: a.w, h: a.h })),
      // null when the message was a plain broadcast.
      addressed: route.addressed };
    this._addMessage(userMsg);

    // Show typing
    const typingId = this._showTyping();
    store.emit('session:busy', { sessionId: this.currentSessionId });

    // Detect if this turn is a ping - if so, preserve the mailbox so
    // tell_agent messages from the previous turn survive to be read.
    const isPing = SlashCommands.parse(typed)?.name === 'ping';

    // Instructions sent with tell_agent belong to THIS turn; a fresh mailbox
    // each time stops yesterday's orders from being re-read forever.
    // Exception: a ping right after a tell_agent should see those messages.
    if (!isPing) {
      this._mailbox.clear();
    }
    this._busy.clear();
    this._nestedBusy.clear();
    this._turnResponded.clear();

    try {
      const activeAgents = route.agents;
      if (activeAgents.length === 0) {
        this._removeTyping(typingId);
        this._addMessage({ role: 'agent',
          content: route.mode === 'all'
            ? 'No active agents. Please activate at least one agent.'
            : route.reason, agentId: null, timestamp: Date.now() });
        this.aborter = null;
        this._setSendMode(false);
        return;
      }

      // Fan out to all active agents in parallel, emitting flow
      // events in real time so the chart draws each leg as it happens
      const coord = (store.get('agents') || []).find(
        a => a.active && /coord|admin|command/i.test(a.role || '')
      );
      // Deduplicate by agent ID to prevent any accidental duplicate entries
      // from causing the same agent to be invoked multiple times.
      let uniqueAgents = Array.from(new Map(activeAgents.map(a => [a.id, a])).values());

      // ID alone is not enough. Two records with DIFFERENT ids but the same
      // code or name are two entries to the dedupe above and one agent to the
      // user -- the reply header shows the name, so both look like the same
      // agent answering twice, which is exactly the reported symptom.
      if (uniqueAgents.length) {
        const seen = new Map();
        const dupes = [];
        const kept = [];
        for (const a of uniqueAgents) {
          // Fall back through the fields that make an agent recognisable, so a
          // rename does not hide a genuine duplicate.
          const key = a.code || a.name || a.model || null;
          if (key && seen.has(key)) { dupes.push(key); continue; }
          if (key) seen.set(key, a);
          kept.push(a);
        }
        if (dupes.length) {
          const names = [...new Set(dupes)];
          store.emit('toast', {
            message: `Duplicate agent records ignored: ${names.join(', ')} -- only the first was called`,
            type: 'error',
          });
          console.warn('[chat] duplicate agent records collapsed:', names);
        }
        uniqueAgents = kept;
      }
      uniqueAgents.forEach(agent => {
        // Marked busy for the duration of the turn. _busy was only ever
        // populated by ask_agent, so the always-on scheduler's
        // "_busy.has(agent.id)" guard saw nothing during a normal turn and a
        // tick could start the SAME agent in parallel with this dispatch --
        // two replies, one of them truncated because both were streaming into
        // the same live node.
        this._busy.add(agent.id);
        store.emit('flow:start', { from: 'user', to: agent.id });
        store.emit('agent:status', { agentId: agent.id, status: 'thinking' });
        if (coord && coord.id !== agent.id) {
          store.emit('flow:delegate', { from: coord.id, to: agent.id });
        }
      });
      // Parallel fan-out: all agents dispatch at the same time so turns run
      // concurrently. The _turnResponded dedup below stops any agent from
      // answering twice if the scheduler re-fires after this turn ends.
      const results = await Promise.all(
        uniqueAgents.map(agent => this._callAgent(text, agent, this.aborter.signal, this._makeLiveNode(agent), pending).then(
          value => {
            this._busy.delete(agent.id);
            store.emit('flow:respond', { from: agent.id });
            return { status: 'fulfilled', value };
          },
          reason => {
            this._busy.delete(agent.id);
            store.emit('flow:fail', { to: agent.id });
            return { status: 'rejected', reason };
          }
        ))
      );

      this._removeTyping(typingId);

      results.forEach((result, i) => {
        const agent = uniqueAgents[i];
        // A given agent only answers once per user turn. The always-on
        // scheduler can re-fire the instant this turn ends; this guard stops
        // it from answering the same message a second time.
        if (this._turnResponded.has(agent.id)) return;
        this._turnResponded.add(agent.id);
        const live = this._liveNodes.get(agent.id);
        if (result.status === 'fulfilled' && result.value) {
          const agentMsg = {
            role: 'agent',
            // Raw content (fences intact): the renderer splits prose from code
            // itself, so a live reply and the same reply after reload render
            // identically. _saveDialog persists this same string.
            content: result.value.content ?? result.value.text,
            agentId: agent.id,
            reasoning: result.value.reasoning || null,
            toolCalls: result.value.toolCalls || (live && live.toolCalls) || null,
            timestamp: Date.now()
          };
          // If a streaming node was already on screen, swap it for the fully
          // rendered message rather than appending a duplicate.
          if (live) { this._replaceLiveNode(live, agentMsg); }
          else { this._addMessage(agentMsg); }
          this._recordAgentUse(agent.id);
          store.emit('agent:status', { agentId: agent.id, status: 'active' });
          setTimeout(() => store.emit('agent:status', { agentId: agent.id, status: 'idle' }), 2500);
        } else {
          const stopped = result.reason?.name === 'AbortError';
          // A stopped stream keeps whatever arrived before the abort — both
          // the reply text and any reasoning. Only fall back to a bare
          // notice if genuinely nothing streamed.
          const partialText = live && live.text ? live.text : null;
          const partialReason = live && live.reasoning ? live.reasoning : null;
          const errorMsg = {
            role: 'agent',
            content: stopped
              ? (partialText || 'Stopped by user.')
              : 'Error: ' + (result.reason?.message || 'Unknown error'),
            reasoning: partialReason || null,
            toolCalls: (live && live.toolCalls) || null,
            agentId: agent.id,
            timestamp: Date.now()
          };
          if (live) { this._replaceLiveNode(live, errorMsg); }
          else { this._addMessage(errorMsg); }
          store.emit('agent:status', { agentId: agent.id, status: 'idle' });
        }
      });

      // Persist the whole turn as one dialog (the only shape the backend keeps)
      this._saveDialog(text, uniqueAgents, results);
    } catch (err) {
      this._removeTyping(typingId);
      const errorMsg = { role: 'agent', content: 'Error: ' + err.message, agentId: null, timestamp: Date.now() };
      this._addMessage(errorMsg);
      this._saveMessageToBackend(errorMsg);
    } finally {
      store.emit('session:idle', { sessionId: this.currentSessionId });
      this.aborter = null;
      // Anything still queued when the turn ended was never delivered to an
      // agent. Left in place it would be injected into the NEXT unrelated
      // task, which is worse than losing it -- so say so and drop it.
      if (this._steerQueue && this._steerQueue.length) {
        const dropped = this._steerQueue.splice(0, this._steerQueue.length);
        store.emit('toast', {
          message: `${dropped.length} message(s) arrived after the agents finished and were not delivered - send again`,
          type: 'error',
        });
      }
      this._setSendMode(false);
      // Tells the always-on scheduler to hold off briefly. Without it a tick
      // that came due mid-turn started the instant this turn released the
      // session, and the agent answered the same message a second later.
      this.alwaysOn?.noteUserTurn();
      input.focus();
    }
  }

  /** User pressed STOP (or send while busy): cancel in-flight provider calls. */
  /**
   * Hand a message to agents that are already working.
   *
   * Queued rather than dispatched: a second full turn would run a second set of
   * model calls in parallel with the first, and the two would interleave in the
   * transcript. Instead it is injected into the live conversation at the next
   * tool-loop boundary, so the agent sees it as a person interrupting to add
   * direction -- which is what actually happened.
   */
  steer(text) {
    const msg = String(text || '').trim();
    if (!msg) return;
    this._steerQueue = this._steerQueue || [];
    this._steerQueue.push(msg);
    // Show it in the transcript straight away, so the person can see their
    // message was accepted rather than wondering why nothing happened.
    this._addMessage({ role: 'user', content: msg, timestamp: Date.now() });
    store.emit('toast', {
      message: 'Sent to the agents working now',
      type: 'info',
    });
  }

  /**
   * Drain queued steering messages. Called by the tool loop between steps, so a
   * message lands in the conversation the agent is building rather than
   * replacing it.
   */
  _drainSteer(working) {
    if (!this._steerQueue || !this._steerQueue.length) return 0;
    const queued = this._steerQueue.splice(0, this._steerQueue.length);
    for (const q of queued) {
      working.push({ role: 'user', content: q });
    }
    return queued.length;
  }

  stop() {
    if (this.aborter) {
      this.aborter.abort();
      store.emit('toast', { message: 'Stopped', type: 'info' });
    }
  }

  /**
   * Show or hide the dedicated Stop control.
   *
   * The send button used to BECOME a stop button while agents were working,
   * which meant you could not talk to a running agent at all -- the only two
   * options were "say nothing" and "kill it and start again". Sending is now
   * always available and steering is the point, so stopping gets its own
   * button and Escape stays bound to it.
   */
  _setSendMode(sending) {
    const stopBtn = document.getElementById('stopBtn');
    if (stopBtn) {
      stopBtn.hidden = !sending;
      stopBtn.classList.toggle('stop-visible', sending);
    }
    const input = document.getElementById('inputField');
    if (input) {
      if (!input.dataset.placeholder) input.dataset.placeholder = input.placeholder || 'Message';
      input.placeholder = sending
        ? 'Steer the agents working now, or press Esc to stop them'
        : (input.dataset.placeholder || input.placeholder);
    }
  }

  /** Render a stored conversation's messages (used on reload / select). */
  loadConversation(conv) {
    const container = document.getElementById('chatMessages');
    if (!container || !conv) return;
    this.currentSessionId = conv.id;
    // Materialise the record so replay can see it. Without this the sidebar's
    // loaded transcript stayed in currentConversation only.
    store.set('currentConversation', conv);
    this._ensureConversation();
    try { localStorage.setItem(CURRENT_SESSION_KEY, conv.id); } catch {}
    // The chart's traffic lines belong to the chat that produced them.
    store.emit('session:changed', { sessionId: conv.id });
    container.innerHTML = '';
    (conv.messages || []).forEach(m => {
      const el = this.renderer.render({
        role: m.role,
        content: m.content,
        agentId: m.agentId || null,
        reasoning: m.reasoning || null,
        toolCalls: m.toolCalls || m.tool_calls || null,
        timestamp: m.timestamp || Date.now(),
      });
      container.appendChild(el);
    });
    container.scrollTop = container.scrollHeight;
    store.set('currentConversation', conv);
  }
  clearScreen() {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    container.innerHTML = `<div class="empty" id="emptyState">
      <div class="empty-icon">&#9670;</div>
      <div>No messages yet. Start a conversation!</div>
    </div>`;
    this.messages = [];
  }

  _recordAgentUse(agentId) {
    if (!agentId) return;
    const convs = store.get('conversations') || [];
    const conv = convs.find(c => c.id === this.currentSessionId);
    if (!conv) return;
    conv.agentsUsed = conv.agentsUsed || [];
    if (!conv.agentsUsed.includes(agentId)) {
      conv.agentsUsed.push(agentId);
      store.set('conversations', [...convs]);
      persistence.set('conversations', store.get('conversations'));
    }
  }

  /** Persist one full turn (user prompt + all agent responses) as a dialog. */
  async _saveDialog(userText, agents, results) {
    if (!this.currentSessionId) return;
    // Create the record BEFORE the server round-trip, so a failed or slow
    // update can never leave this turn unrecorded.
    this._ensureConversation();
    const responses = results.map((result, i) => {
      const agent = agents[i];
      if (result.status === 'fulfilled' && result.value) {
        return {
          model_id: agent.id,
          model_name: `${agentCode(agent)} ${agent.name}`,
          response: result.value.content,
          reasoning: result.value.reasoning || null,
          usage: result.value.usage || null,
          tool_calls: result.value.toolCalls || null,
        };
      }
      return {
        model_id: agent.id,
        model_name: `${agentCode(agent)} ${agent.name}`,
        error: result.reason?.name === 'AbortError' ? 'Stopped by user.' : (result.reason?.message || 'Unknown error'),
      };
    });
    try {
      await api.updateSession(this.currentSessionId, {
        dialog: { timestamp: Math.floor(Date.now() / 1000), user_input: userText, responses },
      });
      // Refresh local copy so reload shows the new turn immediately
      const convs = store.get('conversations') || [];
      const conv = convs.find(c => c.id === this.currentSessionId);
      if (conv) {
        conv.messages = conv.messages || [];
        conv.messages.push({ role: 'user', content: userText, timestamp: Date.now() });
        responses.forEach(r => {
          conv.messages.push({
            role: 'agent',
            content: r.response || r.error || '',
            agentId: r.model_id,
            reasoning: r.reasoning || null,
            toolCalls: r.tool_calls || null,
            timestamp: Date.now(),
          });
        });
        conv.updatedAt = Date.now();
        store.set('conversations', [...convs]);
        persistence.set('conversations', store.get('conversations'));
      }
    } catch (err) {
      console.error('Failed to save dialog:', err);
    }
  }

  async _saveMessageToBackend(msg) {
    if (!this.currentSessionId) return;
    try {
      await api.request('POST', `/sessions/${this.currentSessionId}/messages`, msg);
    } catch (err) {
      console.error('Failed to save message:', err);
    }
  }

  /**
 * Create a message element up front so a streaming reply can be painted as
 * tokens arrive. Plain text while streaming (cheap); replaced by the fully
 * rendered message (markdown + code containers + reasoning) when it lands.
 */
_makeLiveNode(agent) {
    if (!this._liveNodes) this._liveNodes = new Map();
    // A previous turn for this agent never finalised (overlapping user and
    // autonomous turns both paint here): the map can only find the newest
    // node, so the older one would blink forever as an orphan. Remove it
    // silently -- the superseding turn carries the conversation forward.
    const prev = this._liveNodes.get(agent.id);
    if (prev && prev.isConnected) prev.remove();
    this._liveNodes.delete(agent.id);
    const node = this.renderer.render({
      role: 'agent', content: '', agentId: agent.id, timestamp: Date.now(),
    });
    node.classList.add('message-streaming');
    node.dataset.agentId = agent.id;
    const body = node.querySelector('.message-body');
    const toolBox = document.createElement('div');
    toolBox.className = 'tool-calls-slot';
    toolBox.hidden = true;
    body.appendChild(toolBox);
    const textEl = document.createElement('div');
    textEl.className = 'message-content stream-text';
    body.appendChild(textEl);
    document.getElementById('chatMessages').appendChild(node);
    node.text = '';
    node.reasoning = '';
    node.toolCalls = [];
    node.toolBox = toolBox;
    // Reasoning gets its own live block so a thinking model's thoughts appear
    // as they stream instead of arriving all at once at the end.
    const rDetails = document.createElement('details');
    rDetails.className = 'reasoning-block';
    rDetails.open = true;
    const rSum = document.createElement('summary');
    rSum.className = 'reasoning-summary';
    rSum.innerHTML = '<span class="reasoning-caret">\u25BC</span>'
      + '<span class="reasoning-label">Reasoning</span>'
      + '<span class="reasoning-hint">streaming</span>';
    const rBody = document.createElement('div');
    rBody.className = 'reasoning-content stream-reasoning';
    rDetails.appendChild(rSum);
    rDetails.appendChild(rBody);
    rDetails.style.display = 'none';
    body.appendChild(rDetails);
    node.reasonEl = rBody;
    node.reasonBlock = rDetails;
    if (!this._liveNodes) this._liveNodes = new Map();
    this._liveNodes.set(agent.id, node);
    this._scrollToBottom();
    return node;
  }

  /** Swap a streaming placeholder for the final rendered message. */
  _replaceLiveNode(node, msg) {
    if (!node || !node.isConnected) return;
    const finalEl = this.renderer.render(msg);
    node.replaceWith(finalEl);
    if (this._liveNodes) this._liveNodes.delete(node.dataset.agentId);
    this._scrollToBottom();

    if (msg && (msg.role === 'user' || msg.role === 'agent')) {
      const conv = this._ensureConversation();
      if (conv) {
        conv.messages = conv.messages || [];
        if (!conv.messages.includes(msg)) {
          conv.messages.push(msg);
        }
        conv.updatedAt = Date.now();
        store.set('currentConversation', conv);
        const convs = store.get('conversations') || [];
        const idx = convs.findIndex(c => c.id === conv.id);
        if (idx >= 0) {
          convs[idx] = conv;
          store.set('conversations', [...convs]);
        }
      }
    }
    store.emit('chat:message', msg);

    // Announce it, exactly as _addMessage does. This path is taken whenever a
    // reply streamed, which since streaming was fixed is very nearly every
    // reply -- so without this, auto-speak never fired for a streamed answer
    // at all. What you heard instead was the speaker button, which passes no
    // voice or pitch of its own, so every agent came out in the same global
    // voice. The Test button in the agent editor kept working because it
    // speaks directly rather than waiting to be told a reply landed.
    if (msg && msg.role === 'agent') {
      store.emit('chat:reply', msg);
    }
  }

  /** Append streamed text to a live node. */
  _paintStream(node, piece, whole) {
    if (!node) return;
    node.text = whole;
    const el = node.querySelector('.stream-text');
    if (el) el.textContent = whole;
    this._scrollToBottom();
    store.emit('chat:stream', { agentId: node.dataset.agentId, text: whole });
  }

  /** Append streamed reasoning to the live node's reasoning block. */
  _paintReasoning(node, whole) {
    if (!node) return;
    node.reasoning = whole;
    if (node.reasonBlock) node.reasonBlock.style.display = '';
    if (node.reasonEl) node.reasonEl.textContent = whole;
    this._scrollToBottom();
  }

  /** Paint the tool calls a live turn has made so far. */
  _paintToolCalls(node, calls) {
    if (!node) return;
    node.toolCalls = Array.isArray(calls) ? calls : [];
    const box = node.toolBox;
    if (!box) return;
    box.innerHTML = '';
    box.hidden = !node.toolCalls.length;
    if (node.toolCalls.length) {
      const rendered = renderToolCalls(node.toolCalls);
      if (rendered) box.appendChild(rendered);
    }
    this._scrollToBottom();
  }

  /**
   * Prior conversation turns for one agent, oldest first.
   *
   * Without this every request was stateless and each reply acted as though it
   * were the first message. Includes the user's earlier messages AND this
   * agent's own replies, so an agent can refer back to what it already said.
   * Other agents' replies are deliberately excluded — otherwise a fan-out to
   * four agents would put every sibling answer in everyone's context.
   *
   * A character budget as well as a turn count, so one enormous past message
   * can't blow the context window.
   */
  /**
   * Guarantee a LOCAL conversation record exists for the current session.
   *
   * This was never done anywhere: the sidebar built a record from the server
   * but stored it only in `currentConversation`, and sendMessage() created the
   * session without a record at all. So `conversations` stayed empty, and
   * _historyFor() -- which reads that array -- found no messages and replayed
   * nothing. The user saw a full transcript on screen while the agent was
   * handed only the latest message, and kept answering as if the chat had just
   * begun. Seeding from currentConversation keeps the on-screen history and the
   * replayed history the same list.
   */
  _ensureConversation() {
    if (!this.currentSessionId) return null;
    const convs = store.get('conversations') || [];
    const existing = convs.find(c => c.id === this.currentSessionId);
    if (existing) return existing;

    const live = store.get('currentConversation');
    const conv = (live && live.id === this.currentSessionId)
      ? { ...live, messages: (live.messages || []).slice() }
      : {
          id: this.currentSessionId,
          title: 'Chat Session',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          active: true,
          messages: [],
          agentsUsed: [],
        };
    store.set('conversations', [...convs, conv]);
    persistence.set('conversations', store.get('conversations'));
    return conv;
  }

  _historyFor(agentId) {
    const agent = (store.get('agents') || []).find(a => a.id === agentId);
    const turns = agent
      ? settingFor(agent, 'historyTurns')
      : (store.get('settings.historyTurns') ?? DEFAULT_HISTORY_TURNS);
    const limit = turns === undefined || turns === null ? DEFAULT_HISTORY_TURNS : turns;
    if (!limit || limit <= 0) return [];

    const convs = store.get('conversations') || [];
    let conv = convs.find(c => c.id === this.currentSessionId);
    // Belt and braces: if the array somehow lacks this session, fall back to the
    // record the sidebar loaded rather than silently replaying nothing.
    if (!conv) {
      const live = store.get('currentConversation');
      if (live && live.id === this.currentSessionId) conv = live;
    }
    const stored = (conv && conv.messages) || [];
    if (!stored.length) return [];

    const picked = [];
    let userTurns = 0;
    let replies = 0;
    for (let i = stored.length - 1; i >= 0 && userTurns < limit; i--) {
      const m = stored[i];
      if (!m || typeof m.content !== 'string') continue;
      if (m.role === 'user') {
        picked.push({ role: 'user', content: m.content });
        userTurns++;
      } else if (m.role === 'agent') {
        // Failure notices are stored as agent messages. Replaying them would
        // teach the model that it previously answered "Relay request failed".
        if (isFailureNotice(m.content)) continue;
        // Replies are NOT filtered by agentId: agents get deleted and recreated,
        // which orphans their old ids, and a strict match silently dropped every
        // past reply — the model then saw only bare user turns and behaved as
        // if it had no memory. Sibling replies are included instead, capped.
        if (replies >= limit) continue;
        picked.push({ role: 'assistant', content: m.content, mine: m.agentId === agentId });
        replies++;
      }
    }
    picked.reverse();

    // Budget against the model's real context window when we know it. A 128k
    // model should not replay history as if it had 6k tokens.
    const budget = historyCharBudget(agent ? contextLimitFor(agent.model) : null);
    let total = picked.reduce((s, m) => s + m.content.length, 0);
    while (picked.length > 2 && total > budget) {
      const dropped = picked.shift();
      total -= dropped.content.length;
    }
    // Scale the per-message ceiling with the total. The old fixed 4k cap made
    // the larger budget useless: one long file or reply was cut no matter how
    // much context the model actually had.
    const perMessage = Math.max(4000, Math.min(24000, Math.floor(budget / 3)));
    return picked.map(({ role, content }) => ({ role, content: trimForContext(content, perMessage) }));
  }

  /** Full message list to send: history + system prompt + the new message. */
  _messagesFor(agentId, prompt, systemPrompt, attachments) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    // Replayed history is string-only by construction, so only the live turn
    // can ever carry image parts.
    return messages.concat(
      this._historyFor(agentId),
      [{ role: 'user', content: buildContent(prompt, attachments) }]);
  }

  /**
   * Run one agent turn, optionally through the tool harness.
   *
   * With no tools enabled this is a single call. With tools, the model may
   * reply with a JSON tool request; we run it in the browser, feed the result
   * back, and let the model answer in plain text — up to MAX_TOOL_STEPS, which
   * mirrors /test/t/snippet.py's 4-step loop. Anything we can't parse is
   * treated as the final answer, so a sloppy model degrades to a normal reply
   * instead of stalling.
   */
  async _runWithTools(prompt, agent, provider, effectiveKey, signal, liveNode, attachments, commsCtx) {
    const spec = {
      provider: 'auto',
      endpoint: this._endpointFor(agent, provider),
      api_key: effectiveKey,
      agent_id: agent.id,
      model: agent.model,
      temperature: settingFor(agent, 'temperature') ?? 1.0,
      max_tokens: settingFor(agent, 'maxTokens') ?? 16384,
    };
    const withMemory = sys => (sys || '') + memoryFor(agent);
    return this._runToCompletion({
      agent, signal, liveNode, commsCtx,
      messages: () => this._messagesFor(agent.id, prompt,
        withMemory(systemPromptFor(agent)) + budgetBlockFor(agent, spec.endpoint, effectiveKey), attachments),
      specFor: messages => ({ ...spec, messages }),
    });
  }

  /**
   * Run one agent turn to completion, persisting until it says it is done.
   *
   * _toolLoop alone stops when its step budget runs out and forces a final
   * answer, which cuts an agent off mid-task -- the "stops without finishing"
   * symptom. This wrapper keeps starting new rounds while the agent is still
   * asking for tools, up to a hard ceiling, and only then makes it summarise.
   *
   * @param {object}   o
   * @param {Function} o.messages  () => starting message array
   * @param {Function} o.specFor   messages => relay spec for one round trip
   */
  async _runToCompletion({ agent, signal, liveNode, commsCtx, messages, specFor }) {
    const deadline = Date.now() + PERSISTENCE_WALL_CLOCK_MS;
    // Everything the agent has already been told this turn, so a new round
    // continues the same work instead of restarting it.
    let carried = [];
    let used = 0;
    let rounds = 0;
    let last = null;
    // Shared by every round so the tool panel shows the whole task, not just
    // the last round's calls.
    const toolLog = [];

    while (true) {
      rounds++;
      last = await this._toolLoop({
        agent, signal, liveNode, commsCtx, specFor, toolLog,
        messages: () => (carried.length
          ? [...messages(), ...carried]
          : messages()),
        remainingSteps: PERSISTENCE_MAX_STEPS - used,
        deadline,
      });
      used += last.steps || 0;
      carried = [...carried, ...(last.transcript || [])];

      // It finished on its own terms -- a real answer, not a forced one.
      if (!last.exhausted) break;

      // The agent declared its standing goal met. That is a deliberate stop,
      // not "still working": without this it would start yet another round and
      // the run would never end.
      if (last.completed) break;

      // A round that failed outright (retries used up, or an empty reply) is
      // not an agent that is "still working". Starting a fresh round here threw
      // the error message away and let a doomed turn keep going.
      if (last.failed) break;

      const outOfTime = Date.now() >= deadline;
      const outOfSteps = used >= PERSISTENCE_MAX_STEPS;
      if (outOfTime || outOfSteps) {
        store.emit('toast', {
          message: `${agent.name}: hit the ${outOfTime ? 'time' : 'step'} limit, summarising`,
          type: 'info',
        });
        // One last chance to say what got done, with the reason in view.
        last = await this._toolLoop({
          agent, signal, liveNode, commsCtx, specFor, toolLog,
          messages: () => [...messages(), ...carried],
          remainingSteps: 1,
          deadline: Date.now() + FINAL_SUMMARY_MS,
          forceSummarise: outOfTime
            ? 'You ran out of time on this task.'
            : `You used all ${PERSISTENCE_MAX_STEPS} tool calls on this task.`,
        });
        break;
      }
      store.emit('toast', {
        message: `${agent.name}: still working (round ${rounds}, ${used} tool calls)`,
        type: 'info',
      });
    }
    return last;
  }

  /**
   * The tool loop, shared by every call path.
   *
   * The model may answer with a JSON tool request; we run it, feed the result
   * back, and let the model answer in plain text, up to the step budget. An
   * unparseable reply is treated as the final answer, so a sloppy model
   * degrades to a normal reply instead of stalling.
   *
   * This used to live inside _runWithTools, which only the plain provider path
   * reached. Agents driven by a pasted curl/Python/Node snippet never got the
   * loop at all -- hence "these models don't work with the harness".
   *
   * @param {object}   o
   * @param {Function} o.messages  () => starting message array
   * @param {Function} o.specFor   messages => relay spec for one round trip
   * @param {number}   o.remainingSteps  step budget for this round
   * @param {number}   o.deadline        absolute ms after which to stop calling
   */
  async _toolLoop({ agent, signal, liveNode, commsCtx, messages, specFor,
    remainingSteps, deadline, forceSummarise, toolLog }) {
    const log = Array.isArray(toolLog) ? toolLog : [];
    // Memory tools ride along unless the agent has memory explicitly switched off.
    // An agent with no tools array at all predates the "everything on by
    // default" change, so it gets the same set a new agent would. An explicit
    // [] is respected: that is someone who deliberately turned tools off.
    const ticked = Array.isArray(agent.tools) ? agent.tools.filter(Boolean) : defaultTools();
    let enabled = agent.memory === false ? ticked : Array.from(new Set(ticked.concat(MEMORY_TOOLS)));
    // An agent with a standing goal needs the stop tool, and only those agents
    // are offered it — to everyone else it is a stray function in the prompt.
    if (agent.alwaysOn) {
      enabled = Array.from(new Set(enabled.concat(ALWAYS_ON_TOOLS)));
    }

    // The built-in browser's tools ride along for EVERY agent while the feature
    // is on (Config → Labs → Browser), the same way memory tools do — so a model
    // is never in the dark about being able to drive a browser. Off in one place
    // and they simply aren't listed (and the API refuses them anyway).
    if (await browserEnabled()) {
      enabled = Array.from(new Set(enabled.concat(BROWSER_TOOLS)));
    }

    if (!enabled.length) {
      // No tools means a single request, so there is no step boundary at which
      // a steering message could land. Without this loop, anything typed while
      // the agent was thinking sat in the queue and was never seen -- shown in
      // the transcript, so it looked delivered, and simply did nothing.
      const inputBudget = inputBudgetFor(agent);
      let convo = messages();
      let res = null;
      for (let pass = 0; pass <= MAX_STEER_STEPS; pass++) {
        if (pass > 0 && !this._drainSteer(convo)) break;
        convo = compactMessages(convo, inputBudget);
        // Same retry policy as the tool path. This branch used to call the
        // relay directly, so one rate-limit refusal killed an agent that had
        // tools switched off, with no retry at all.
        res = await relayWithRetry(specFor(convo), {
          signal,
          attempts: 3,
          onDelta: (_p, w) => this._paintStream(liveNode, _p, w),
          onRetry: (attempt, err, delayMs) => store.emit('toast', {
            message: `${agent.name}: ${String(err.message).slice(0, 60)} — waiting ${Math.max(1, Math.round((delayMs || 0) / 1000))}s (retry ${attempt})`,
            type: 'info',
          }),
        });
        // Only keep looping if the person actually said something new.
        if (!(this._steerQueue && this._steerQueue.length)) break;
      }
      // Usage has to be picked up on every path that streams, not just the
      // tool loop, or an agent with tools switched off bills nothing. Recorded
      // even without a usage block so the request is always counted.
      if (res) this._recordUsage(agent, res.usage || null, res.content || '');
      return {
        content: res.content, text: res.content, sections: null,
        reasoning: res.reasoning || null,
        usage: res.usage || null,
        toolCalls: log.slice(),
      };
    }

    // Tool-enabled: stream the first step, then keep the text we already have
    // and continue the loop on the server.
    let working = messages();
    const inputBudget = inputBudgetFor(agent);
    const sandboxRoot = sandboxRootFor(agent);

    // Native tool calling is used where the API family supports it. The model
    // still gets the same tools, but as schemas instead of a JSON/XML protocol
    // it has to imitate. If a provider rejects the request, the first step
    // falls back to the prompt dialect without losing the turn.
    const baseSpec = specFor(working);
    const family = detectFamily({
      provider: agent.provider, endpoint: baseSpec.endpoint, model: agent.model,
    });
    let nativeMode = NATIVE_FAMILIES.has(family) && agent.nativeTools !== false;
    const describeTool = name => TOOL_REGISTRY[name]?.describe || name;
    const nativeDefinitions = () => nativeToolDefs(
      enabled.map(name => ({ name, description: describeTool(name) })),
      family,
    );
    const requestFor = messagesForCall => {
      const spec = specFor(messagesForCall);
      if (!nativeMode) return spec;
      const tools = nativeDefinitions();
      if (!tools.length) return spec;
      const out = { ...spec, tools };
      if (family === 'google') {
        out.tool_config = { functionCallingConfig: { mode: 'AUTO' } };
      } else {
        const choice = nativeToolChoice(family);
        if (choice) out.tool_choice = choice;
      }
      return out;
    };

    // Teach the model the protocol BEFORE anything else, appended to whatever
    // system message the caller already produced (which may carry the agent's
    // own prompt and its memory block).
    //
    // `dialect` is kept in a variable so the parse-failure escalation below can
    // move it without rebuilding everything. Env facts (OS, cwd, which commands
    // exist) come from the SERVER, cached — see toolManifest.js.
    let dialect = toolProtocolFor(agent);
    const envFacts = await getEnvFacts().catch(() => null);
    let instructions = buildToolInstructions(enabled, sandboxRoot,
      nativeMode ? 'native-api' : dialect, envFacts);
    if (instructions) {
      // Prepend, never overwrite index 0. A messages array with no system
      // message starts with the oldest history turn, and overwriting that
      // silently deleted it.
      const sysIdx = working.findIndex(m => m && m.role === 'system');
      if (sysIdx === -1) {
        working.unshift({ role: 'system', content: instructions });
      } else {
        working[sysIdx] = {
          ...working[sysIdx],
          content: `${working[sysIdx].content || ''}${instructions}`,
        };
      }
    }

    let text = '';
    let reasoning = '';
    let painted = '';
    // An empty completion is usually a one-off: the output is sampled, and the
    // same request almost always succeeds a second time. Re-asking once is
    // exactly what a person does when this happens, so do it for them rather
    // than making them resend the whole prompt.
    let emptyRetries = 0;
    // One nudge if the model DESCRIBES a tool call instead of sending it
    // ("I'll use the remember tool"). See the narration rescue below.
    let narratedRetries = 0;
    // One re-teach if the model SENDS something that looks like a tool call but
    // parses to nothing — usually the wrong dialect for this model. See the
    // parse-failure escalation below.
    let parseRetries = 0;
    const triedDialects = new Set([dialect]);
    // Only the tool exchanges, so a follow-up round can resume this work.
    const transcript = [];
    // ??, not ||: an explicit 0 means "no tool rounds left" (the max floors
    // it at one final answer call). || resurrected the full 12-step budget
    // from a 0, so a round that should have ended kept working for 12 steps.
    const budget = Math.max(1, remainingSteps ?? MAX_TOOL_STEPS);
    // Headroom for steering only. The agent still stops at `budget` unless a
    // message from the person is waiting; this just gives the loop room to take
    // those extra steps instead of terminating the moment budget runs out.
    const maxSteps = budget + MAX_STEER_STEPS;
    const outOfTime = () => !!deadline && Date.now() >= deadline;

    for (let step = 0; step < maxSteps; step++) {
      // Stop asking before the wall-clock runs out rather than starting a
      // request that cannot possibly finish.
      if (step > 0 && outOfTime()) break;

      // Anything the person typed while this agent was working goes in here,
      // at the top of a step. Between steps is the only safe place: mid-request
      // the array is already serialised, and appending before the next call is
      // what makes it read as an interruption rather than a fresh task.
      if (step > 0) {
        const steered = this._drainSteer(working);
        if (steered) {
          store.emit('toast', {
            message: `${agent.name}: ${steered} steering message(s) applied`,
            type: 'info',
          });
        }
      }

      // The live tool transcript is the part that grows without bound. Compact
      // it against the same input budget the history already respects.
      working = compactMessages(working, inputBudget);

      let res;
      try {
        res = await relayWithRetry(requestFor(working), {
          signal,
          // Retried on every step, not just later ones: the first call of a
          // turn is the long generation and the one most likely to overrun the
          // server's 180s limit.
          attempts: 3,
          onDelta: (_p, whole) => {
            text = whole;
            this._paintStream(liveNode, _p, whole);
          },
          onReasoning: (_p, whole) => { reasoning = whole; },
          onRetry: (attempt, err, delayMs) => store.emit('toast', {
            message: `${agent.name}: ${String(err.message).slice(0, 60)} — waiting ${Math.max(1, Math.round((delayMs || 0) / 1000))}s (retry ${attempt})`,
            type: 'info',
          }),
        });
      } catch (err) {
        // A provider that does not accept native tool schemas rejects the
        // request before doing any work. Retry the same step in the prompt
        // dialect rather than failing the turn. Only the first step is retried:
        // later failures are real work, not a capability probe.
        if (nativeMode && step === 0 && err?.name !== 'AbortError'
            && (Number(err?.status) === 400 || Number(err?.status) === 422)) {
          nativeMode = false;
          dialect = toolProtocolFor(agent);
          const promptInstructions = buildToolInstructions(enabled, sandboxRoot, dialect, envFacts);
          const sysIdx = working.findIndex(m => m && m.role === 'system');
          if (sysIdx !== -1) {
            const old = String(working[sysIdx].content || '');
            working[sysIdx] = {
              ...working[sysIdx],
              content: old.includes(instructions)
                ? old.replace(instructions, promptInstructions)
                : `${old}${promptInstructions}`,
            };
          }
          instructions = promptInstructions;
          step--;   // the fallback retry is not a tool step
          store.emit('toast', {
            message: `${agent.name}: native tools unavailable — using the prompt protocol`,
            type: 'info',
          });
          continue;
        }
        // Out of retries. Say so plainly instead of returning an empty reply,
        // which used to look like the agent had finished with nothing to say.
        // errText, not String(err.message): a message that is itself an object
        // rendered as the literal "[object Object]", which told the user
        // nothing about why the call failed.
        const why = err?.name === 'AbortError' ? 'cancelled' : (errText(err.message) || errText(err) || 'unknown error');
        if (err?.name === 'AbortError') throw err;
        const prefix = forceSummarise ? `${forceSummarise}\n\n` : '';
        return {
          content: `${prefix}I could not finish: the model request failed (${why}).`,
          text: `${prefix}I could not finish: the model request failed (${why}).`,
          sections: null, reasoning: reasoning || null,
          steps: step, exhausted: true, failed: true, transcript,
          toolCalls: log.slice(),
        };
      }

      const chunk = res && res.content ? res.content : '';
      if (res && res.reasoning) reasoning = res.reasoning;
      // Usage comes back on the streaming path too. Without this the streamed
      // turns — which is every turn in practice — recorded nothing, leaving
      // every agent panel and every model breakdown empty. The request is
      // counted even when the provider streams no usage block.
      if (res) this._recordUsage(agent, res.usage || null, chunk || res.content || '');

      // Content first, then THIS response's reasoning channel: see parseToolCall's
      // second argument. Without it a reasoning model narrates the tool call
      // instead of sending it, and the loop ends with that narration as the
      // answer.
      //
      // Deliberately res.reasoning, not the accumulated `reasoning` variable:
      // that one carries over between steps, so reusing it would re-find the
      // same JSON on every subsequent round and call the same tool over and
      // over until the budget ran out.
      const nativeCalls = Array.isArray(res?.toolCalls)
        ? res.toolCalls.filter(c => c && c.name)
        : [];
      const calls = nativeCalls.map(c => {
        const { arg, note } = nativeToolArgs(c.name, c.arguments);
        return { tool: c.name, arg, note, native: true };
      });
      if (!calls.length) {
        const call = parseToolCall(chunk, res && res.reasoning);
        if (call) calls.push(call);
      }
      if (calls.length) {
        // It parsed. Remember this dialect for this provider::model so the next
        // turn starts here instead of re-guessing.
        rememberDialect(agent.provider, agent.model, dialect);
      }
      if (!calls.length) {
        // Parse-failure escalation. The model TRIED to call a tool — the reply
        // carries JSON/XML/tag shapes — but nothing parsed, usually because the
        // dialect taught was the wrong one for this model. Re-teach ONCE with a
        // different dialect rather than letting the near-miss become the final
        // answer, which reads as "the tool did not work".
        const looksLikeTool = enabled.length > 0
          && /(\{\s*"tool"\s*:|<\|tool_call\||<function_calls|<invoke\s|\{"tool")/i.test(String(chunk || ''));
        if (looksLikeTool && parseRetries < 1 && !outOfTime() && !(signal && signal.aborted)) {
          const alt = nextDialect(dialect, triedDialects);
          if (alt) {
            parseRetries++;
            triedDialects.add(alt);
            dialect = alt;
            const reteach = buildToolInstructions(enabled, sandboxRoot, dialect, envFacts);
            const si = working.findIndex(m => m && m.role === 'system');
            if (si !== -1) {
              const old = String(working[si].content || '');
              working[si] = {
                ...working[si],
                content: old.includes(instructions) ? old.replace(instructions, reteach) : `${old}${reteach}`,
              };
            }
            instructions = reteach;
            text = '';
            painted = '';
            working = working.concat([
              { role: 'assistant', content: chunk },
              {
                role: 'user',
                content: `That reply was not a valid tool call. Send it again using the "${alt}" `
                  + 'format exactly as instructed, or answer the user in plain prose.',
              },
            ]);
            store.emit('toast', {
              message: `${agent.name}: tool call did not parse — retrying with the "${alt}" dialect`,
              type: 'info',
            });
            continue;
          }
        }
        // Narration rescue. With tools offered, a model sometimes SAYS it will
        // use one ("I'll use the remember tool") instead of emitting the call —
        // typically when a global pre-prompt tells it to reply only in text.
        // Without this the turn ends having done nothing, which reads as "the
        // tool did not work". Nudge it ONCE to actually send the call.
        const claim = String(chunk || '');
        const claimsTool = enabled.length > 0
          && /(\btool\b|\b\w+_?tool\b)/i.test(claim)
          && /(i'?ll|i will|let me|i'?m going|going to|i would|now i|i'?d )/i.test(claim);
        if (claimsTool && narratedRetries < 1 && !outOfTime() && !(signal && signal.aborted)) {
          narratedRetries++;
          text = '';
          painted = '';
          working = working.concat([
            { role: 'assistant', content: chunk },
            {
              role: 'user',
              content: nativeMode
                ? 'That reply contained no tool call. If you meant to use a tool, call it '
                  + 'now through the provided tool interface. If no tool is needed, just '
                  + 'answer the user.'
                : 'That reply contained no tool call. If you meant to use a tool, send it '
                  + 'now as a single JSON object: {"tool":"NAME","arg":...} and nothing else. '
                  + 'If no tool is needed, just answer the user.',
            },
          ]);
          store.emit('toast', {
            message: `${agent.name} described a tool instead of calling it — asking again…`,
            type: 'info',
          });
          continue;
        }
        // A normal reply, or an unparseable one — either way we're done. An
        // empty chunk means the upstream said nothing at all; treat it as a
        // failure to report, not as an answer.
        if (!chunk.trim()) {
          // Work out WHY it was empty. "No reply" and "spent everything
          // thinking" look identical from out here but need opposite fixes.
          const thoughtChars = (res && res.reasoning) ? res.reasoning.length : 0;
          const truncated = res && res.finishReason === 'length';
          const thoughtOnly = thoughtChars > 0 && !!(res && res.reasoningOnly);
          console.warn(`[${agent.name}] empty completion (step ${step + 1}/${budget}):`, {
            finishReason: res && res.finishReason,
            reasoningOnly: !!(res && res.reasoningOnly),
            reasoningChars: thoughtChars,
          });

          if (emptyRetries < 1 && !outOfTime() && !(signal && signal.aborted)) {
            emptyRetries++;
            // Clear the half-drawn stream so the retry does not appear to
            // append to the abandoned attempt.
            text = '';
            painted = '';
            store.emit('toast', {
              message: `${agent.name} returned an empty response — asking again…`,
              type: 'info',
            });
            continue;
          }

          const msg = (truncated || thoughtOnly)
            ? `${agent.name} thought through this but used its whole token budget before `
              + 'writing an answer. Raise Max Tokens in Settings, or ask for a shorter reply.'
            : 'The model returned an empty response. Sending the same prompt again '
              + 'usually gets an answer — if it keeps happening, the model may be '
              + 'unreachable; check the provider status.';
          return {
            content: msg, text: msg, sections: null, reasoning: reasoning || null,
            steps: step, exhausted: true, failed: true, transcript,
            toolCalls: log.slice(),
          };
        }
        return {
          content: chunk, text: chunk, sections: null, reasoning: reasoning || null,
          steps: step, exhausted: false, transcript,
          toolCalls: log.slice(),
        };
      }

      // Show the tool request(s) as real entries, then run them. Native
      // responses can carry several independent calls; prompt-protocol
      // responses carry one. All calls are painted before the first await so
      // a slow tool cannot hide its siblings.
      if (liveNode) {
        const el = liveNode.querySelector('.stream-text');
        if (el) el.textContent = `${painted}${chunk}`.trimEnd();
      }
      const records = calls.map(call => ({
        tool: call.tool,
        arg: toolArgForUi(call.arg),
        note: call.note || '',
        status: 'running',
        started: Date.now(),
      }));
      log.push(...records);
      this._paintToolCalls(liveNode, log);

      const exchanges = [];
      let completedSummary = null;
      for (let ci = 0; ci < calls.length; ci++) {
        const call = calls[ci];
        const record = records[ci];
        let result;
        try {
          result = await runTool(call.tool, call.arg, call.note, {
            agentId: agent.id, sessionId: this.currentSessionId,
            sandboxRoot,
            // Carries who has already spoken in this reply, so ask_agent can
            // refuse to close a loop.
            chain: (commsCtx && commsCtx.chain) || [agent.id],
          });
        } catch (err) {
          record.status = 'error';
          record.ms = Date.now() - record.started;
          record.result = `Error: ${err && err.message ? err.message : String(err)}`;
          this._paintToolCalls(liveNode, log);
          throw err;
        }
        record.status = toolResultStatus(asText(result));
        record.ms = Date.now() - record.started;
        record.result = toolResultForUi(result);
        this._paintToolCalls(liveNode, log);

        this._recordToolCall(agent.id, call.tool);
        store.emit('toast', { message: `${agent.name}: ${call.tool} → ${asText(result).slice(0, 40)}`, type: 'info' });
        if (call.tool === 'todo_write') refreshTodoBlock(working);

        // An autonomous agent declares its goal met with a tool, not a phrase.
        // Ending the turn here turns the summary into that agent's reply, which
        // is what lands in the transcript.
        if (call.tool === 'declare_goal_complete') {
          completedSummary = String(
            call.arg && call.arg.summary ? call.arg.summary : (call.note || result),
          ).trim();
          records.slice(ci + 1).forEach(skipped => {
            skipped.status = 'error';
            skipped.result = 'Skipped after the agent declared its goal complete.';
          });
          this._paintToolCalls(liveNode, log);
          break;
        }

        // Native calls often have no prose alongside them. Give the model a
        // short assistant turn so the following TOOL_RESULT has something to
        // attach to; otherwise the message list starts with a user result.
        const assistantText = (ci === 0 && chunk) ? chunk : `[called ${call.tool}]`;
        exchanges.push({ role: 'assistant', content: assistantText });
        exchanges.push({
          role: 'user',
          content: `TOOL_RESULT: ${asText(result)}\nNow answer the user plainly.`,
        });
      }

      if (completedSummary !== null) {
        const msg = completedSummary || 'Goal declared complete.';
        return {
          content: msg, text: msg, sections: null, reasoning: reasoning || null,
          steps: step + 1, exhausted: true, completed: true, transcript,
          toolCalls: log.slice(),
        };
      }

      working = working.concat(exchanges);
      transcript.push(...exchanges);
      painted = (painted || '') + chunk + '\n';

      // Out of budget, but the person may have steered while this step was in
      // flight. Honouring that means spending one more model call, so the round
      // only ends when the budget is spent AND nothing is queued. Without this
      // a correction typed at the last moment was accepted, shown in the
      // transcript, and then never seen by the agent -- the worst possible
      // outcome, because it looks like it worked.
      if (step >= budget - 1 && !(this._steerQueue && this._steerQueue.length)) {
        // Budget for this round is gone. Hand back to _runToCompletion, which
        // starts a fresh round if the agent is still working.
        return {
          content: text, text, sections: null, reasoning: reasoning || null,
          steps: step + 1, exhausted: true, transcript,
          toolCalls: log.slice(),
        };
      }
    }
    return {
      content: text, text, sections: null, reasoning: reasoning || null,
      steps: budget, exhausted: true, transcript,
      toolCalls: log.slice(),
    };
  }

  /**
 * Run another agent on demand and return their reply as text.
 *
 * Called from ask_agent. The chain of agents already involved in this reply is
 * threaded through, which is what stops A asking B who asks A: a model can
 * consult as many distinct colleagues as it likes, but the loop has to
 * terminate. That guard is a correctness requirement rather than a budget cap
 * -- the call depth is bounded by the size of the roster.
 */
  async _askAgentSync(targetId, question, ctx) {
    const agents = store.get('agents') || [];
    const target = agents.find(a => a.id === targetId);
    if (!target) return `error: no agent with id "${targetId}"`;

    const me = agents.find(a => a.id === ctx?.agentId);
    const chain = (ctx && Array.isArray(ctx.chain) ? ctx.chain : []).filter(Boolean);

    if (chain.includes(targetId)) {
      const names = chain.map(id => agents.find(a => a.id === id)?.name || id);
      return `error: ${target.name} is already involved in this reply (${names.join(' -> ')}), `
        + 'so asking them again would loop forever. Answer from what you have, '
        + 'or ask someone outside that chain.';
    }
    if (this._nestedBusy.has(targetId)) {
      return `error: ${target.name} is already answering another agent right now. `
        + 'Try again after this turn.';
    }

    this._nestedBusy.add(targetId);
    store.emit('agent:status', { agentId: targetId, status: 'thinking' });
    // Draw the ask itself, so the map shows who is talking to whom rather
    // than only the fan-out from the user.
    store.emit('flow:speak', { from: ctx?.agentId, to: targetId });
    store.emit('toast', {
      message: `${me?.name || 'An agent'} asked ${target.name}…`, type: 'info',
    });

    // Say who is asking, so the reply addresses the right party.
    const prompt = me
      ? `${me.name} asks you: ${question}\n\nAnswer ${me.name} directly and concisely.`
      : question;

    try {
      // No live node: a nested reply belongs to the asking agent's answer, not
      // the transcript, or the panel fills with duplicates.
      const res = await this._callAgent(
        prompt, target, this.aborter?.signal, null, null,
        { chain: [...chain, targetId] },
      );
      const text = asText(res?.content ?? res?.text ?? '').trim();
      return text || `(${target.name} returned an empty reply)`;
    } catch (err) {
      // Only abandon the whole turn when the USER cancelled it. A nested
      // request that failed or was dropped on its own (Firefox reports those
      // as NS_BINDING_ABORTED) must not kill the agent that asked the
      // question -- it gets the error as a tool result and can carry on.
      if (err?.name === 'AbortError' && this.aborter?.signal?.aborted) throw err;
      const why = err?.message === 'The user aborted a request.'
        ? 'the request was cancelled'
        : (err?.message || asText(err));
      return `error: ${target.name} could not answer — ${why}`;
    } finally {
      this._nestedBusy.delete(targetId);
      // And the answer travelling back, so each exchange is a line each way.
      store.emit('flow:speak', { from: targetId, to: ctx?.agentId });
      store.emit('agent:status', { agentId: targetId, status: 'active' });
      setTimeout(() => store.emit('agent:status', { agentId: targetId, status: 'idle' }), 2500);
    }
  }

  /**
   * Where an agent's call actually goes: its own Endpoint when it has one,
   * otherwise the provider row's.
   */
  _endpointFor(agent, provider) {
    return (agent && agent.endpoint && String(agent.endpoint).trim())
      || (provider && provider.endpoint)
      || '';
  }

  async _callAgent(prompt, agent, signal, liveNode, attachments, commsCtx) {
    const providers = store.get('providers');
    const found = providers.find(p => p.id === agent.provider);
    if (!found) {
      throw new Error(`Provider "${agent.provider}" not found — set it on the agent, or it was deleted.`);
    }

    // Effective key precedence: an explicit agent override (a manual pin) wins;
    // then the provider's API pool when the feature is on; then the single
    // provider key. pickKey rotates after the operator's request count.
    const poolKey = poolEnabled() ? pickKey(found, agent) : null;
    const effectiveKey = agent.keyOverride || (poolKey && poolKey.key) || found.apiKey || '';
    if (!effectiveKey) {
      throw new Error(`No API key for ${found.name} — paste a current key into the provider's Key box, `
        + `or give ${agent.name} its own Key Override.`);
    }

    // An agent that carries its own Endpoint (and usually its own Key Override
    // to match) is talking to a DIFFERENT host than its provider row names.
    // Resolving both here means every path below — streaming, one-shot, and the
    // relay fallback — agrees on where the call goes. Previously only the curl
    // template path honoured agent.endpoint, so the other paths sent the
    // agent's key to the provider's host: an NVIDIA key to api.openai.com,
    // which is a 401 from OpenAI and reads exactly like "the model is down".
    const provider = { ...found, endpoint: this._endpointFor(agent, found), apiKey: effectiveKey };

    try {
      const reply = await this._callAgentCore(
        prompt, agent, provider, effectiveKey, signal, liveNode, attachments, commsCtx);
      if (poolKey) noteResult(found, poolKey, { ok: true });
      return reply;
    } catch (err) {
      // A 429 puts this key on cooldown so the next call rotates away from it.
      if (poolKey) noteResult(found, poolKey, { ok: false, rateLimited: isRateLimited(err) });
      throw err;
    }
  }

  /** The request path with a key already chosen. See _callAgent. */
  async _callAgentCore(prompt, agent, provider, effectiveKey, signal, liveNode, attachments, commsCtx) {
    // Custom curl template setup: substitute vars, run via server relay
    if (agent.curlTemplate && agent.curlTemplate.trim()) {
      return this._callAgentViaTemplate(prompt, agent, provider, effectiveKey, signal, liveNode, attachments, commsCtx);
    }

    // Precedence: the agent's own setting, then the global setting, then the
    // default. This path previously read only the global value, so per-agent
    // temperature/max-tokens were silently ignored here (the template path
    // already did this correctly).
    const options = {
      model: agent.model,
      agentId: agent.id,
      temperature: settingFor(agent, 'temperature') ?? 1.0,
      maxTokens: settingFor(agent, 'maxTokens') ?? 16384,
    };

    let content = null;
    let usage = null;
    let reasoning = null;

    // Streaming first (agent.stream === false opts out). Any failure falls
    // back to the ordinary one-shot call, so streaming can never be the
    // reason a reply is lost.
    if (agent.stream !== false) {
      try {
        const streamed = await this._runWithTools(
          prompt, agent, provider, effectiveKey, signal, liveNode, attachments, commsCtx);
        if (streamed && (streamed.content || streamed.reasoning
          || (streamed.toolCalls && streamed.toolCalls.length))) {
          return {
            content: streamed.content,
            text: streamed.content,
            sections: null,
            reasoning: streamed.reasoning || null,
            // Carried through so an autonomous run can see that the agent
            // deliberately stopped. Rebuilding the object here used to drop it,
            // which meant declaring the goal met never ended the run.
            completed: streamed.completed === true,
            toolCalls: streamed.toolCalls || [],
          };
        }
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        // Fall through to the non-streaming path.
      }
    }

    try {
      const res = await api.callProvider(provider, this._messagesFor(agent.id, prompt, `${systemPromptFor(agent)}${memoryFor(agent)}${budgetBlockFor(agent, provider.endpoint, effectiveKey)}`, attachments), options, signal);
      content = res?.content ?? null;
      usage = res?.usage ?? null;
      reasoning = res?.reasoning ?? null;
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      // Network-level failure (e.g. CORS block) → retry via server-side relay
      if (e instanceof TypeError) {
        console.log(`Direct call failed for ${agent.name}, trying relay...`);
        try {
          const res = await api.relayCall({
            provider: provider.id,
            endpoint: provider.endpoint,
            api_key: provider.apiKey,
            agent_id: agent.id,
            model: agent.model,
            temperature: options.temperature,
            max_tokens: options.maxTokens,
            messages: this._messagesFor(agent.id, prompt,
              `${systemPromptFor(agent)}${memoryFor(agent)}${budgetBlockFor(agent, provider.endpoint, effectiveKey)}`,
              attachments),
            proxy: store.get('settings.proxyActive') || null,
          }, signal);
          if (res?.success && res.content) {
            content = res.content;
            usage = res.usage ?? null;
          }
          else if (res?.error) throw relayError(res, `Relay call failed for ${agent.name}`);
        } catch (relayErr) {
          console.log('Relay call failed:', relayErr);
          throw relayErr;
        }
      } else {
        console.log('API call failed:', e);
        throw e;
      }
    }

    if (content) {
      this._recordUsage(agent.id, usage || null, content);
      const parsed = this._parseSections(content);
      return { content, text: parsed.text, sections: parsed.sections, reasoning };
    }
    // Say WHY there is no reply. A bare null here used to surface as
    // "Error: Unknown error", which reads like a crash and hides the real
    // cause (an empty or refused provider response).
    throw new Error(`No reply content from ${provider?.name || 'provider'} `
      + `for model "${agent.model}" — the provider returned an empty response `
      + `(check the key, the model id, and that the endpoint matches the API).`);
  }

  /**
   * Record token usage for this turn.
   *
   * Two buckets are written, not one:
   *   agents[agentId] — "what did this agent cost me"
   *   models[key]     — "what did this model cost me"
   *
   * The second is keyed provider::model, because two providers routinely offer
   * the same model id and pooling them would make per-model figures wrong in
   * exactly the way a single per-provider bucket already was.
   *
   * Accepts an agent id (older callers) or the agent itself.
   */
  /**
   * Count one tool invocation against this agent, for the current session.
   *
   * Kept apart from token usage: "what did it cost" and "what did it actually
   * do" are different questions, and the topology shows both. Per-tool-name
   * counts are kept too, so the map can say which tool an agent leans on.
   */
  _recordToolCall(agentId, toolName) {
    if (!agentId || !this.currentSessionId) return;
    const metrics = store.get('metrics') || { sessions: {} };
    metrics.sessions = metrics.sessions || {};
    const sess = metrics.sessions[this.currentSessionId] || { agents: {} };
    sess.tools = sess.tools || {};
    const t = sess.tools[agentId] || { calls: 0, byTool: {} };
    t.calls += 1;
    if (toolName) t.byTool[toolName] = (t.byTool[toolName] || 0) + 1;
    sess.tools[agentId] = t;
    metrics.sessions[this.currentSessionId] = sess;
    store.set('metrics', metrics);
    persistence.set('metrics', metrics);
    store.emit('metrics:changed', { sessionId: this.currentSessionId, agentId });
  }

  _recordUsage(agentOrId, usage, approxText = '') {
    if (!agentOrId || !this.currentSessionId) return;
    const agent = typeof agentOrId === 'string'
      ? (store.get('agents') || []).find(a => a.id === agentOrId)
      : agentOrId;
    const agentId = typeof agentOrId === 'string' ? agentOrId : agentOrId.id;

    const metrics = store.get('metrics') || { sessions: {} };
    metrics.sessions = metrics.sessions || {};
    const sess = metrics.sessions[this.currentSessionId] || { agents: {} };
    sess.agents = sess.agents || {};
    const entry = sess.agents[agentId] || { prompt: 0, completion: 0, calls: 0, requests: 0 };
    // Every turn is a request, whether or not the provider sent a usage block.
    // `calls` stays the number the provider actually billed/reported.
    entry.requests = (entry.requests || 0) + 1;

    let pIn = 0, pOut = 0;
    if (usage) {
      pIn = usage.prompt || 0;
      pOut = usage.completion || 0;
      entry.calls = (entry.calls || 0) + 1;
    } else if (approxText) {
      // No usage block (several free tiers stream without one). Estimate the
      // completion from the reply text so the usage line is not blank, and
      // flag it so the UI can show the figure as approximate.
      pOut = Math.ceil(String(approxText).length / 4);
      entry.approx = true;
    }
    entry.prompt += pIn;
    entry.completion += pOut;
    sess.agents[agentId] = entry;

    if (agent && agent.model) {
      const key = `${agent.provider || '?'}::${agent.model}`;
      sess.models = sess.models || {};
      const m = sess.models[key]
        || { prompt: 0, completion: 0, calls: 0, requests: 0, provider: agent.provider || '', model: agent.model };
      m.requests = (m.requests || 0) + 1;
      if (usage) m.calls = (m.calls || 0) + 1;
      m.prompt += pIn;
      m.completion += pOut;
      sess.models[key] = m;
    }

    metrics.sessions[this.currentSessionId] = sess;
    store.set('metrics', metrics);
    persistence.set('metrics', metrics);
    store.emit('metrics:changed', { sessionId: this.currentSessionId, agentId });
    try {
      // The call that produced this usage was just timed by api.js; its
      // sample is the newest one for this agent.
      const lastSample = latency.get(agentId).slice(-1)[0];
      const ms = lastSample && lastSample.ok && (Date.now() - lastSample.at) < 5000 ? lastSample.ms : undefined;
      trace('model', {
        agentId,
        agentName: agent?.name,
        model: agent?.model,
        ms,
        prompt: pIn,
        completion: pOut,
        approx: !usage,
        ok: true,
      });
    } catch { /* tracing is best-effort */ }
  }

/**
   * Custom setup: paste a provider snippet (curl / shell / Python / Node /
   * SDK) into the agent settings. Templates that carry $VARIABLEs are
   * substituted at send time; a template the editor never normalized is
   * parsed here and the prompt is injected directly, so a missed auto-fill
   * can no longer break the request. The call runs through the server relay.
   */
  async _callAgentViaTemplate(prompt, agent, provider, effectiveKey, passedSignal, liveNode, attachments, commsCtx) {
    // The signal belongs to whoever started this call -- the main composer or
    // a routing-chart run each have their own AbortController. Reading
    // chat.aborter here instead meant Stop on the routing screen (and on
    // ask-directly) could never reach a template agent: chat.aborter is null
    // there, so the run was unabortable.
    const signal = passedSignal ?? this.aborter?.signal;
    const temperature = settingFor(agent, 'temperature') ?? 1.0;
    const maxTokens = settingFor(agent, 'maxTokens') ?? 16384;
    const systemPrompt = systemPromptFor(agent)
      + budgetBlockFor(agent, agent.endpoint || provider.endpoint, effectiveKey);
    const tpl = agent.curlTemplate || '';

    // A short, safe preview so a failure is diagnosable instead of a shrug.
    const preview = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const jsonError = (dataText, why) => {
      console.warn(`[${agent.name}] template body is not JSON (${why})`,
        { template: preview(tpl), data: preview(dataText) });
      return new Error(
        `Bad curl template for ${agent.name}: body is not JSON (${why}). `
        + `Body started: ${preview(dataText) || '(empty)'}`
      );
    };

    /**
     * Inject the live prompt into an already-parsed body, splicing the prior
     * conversation in between the system message and the new user message.
     * A template with a single user turn gets the history in front of it.
     */
    const injectContext = obj => {
      if (obj && Array.isArray(obj.messages)) {
        // Replay history ahead of the live prompt (after any system message).
        const history = this._historyFor(agent.id);
        if (history.length) {
          const firstUser = obj.messages.findIndex(m => m && m.role === 'user');
          if (firstUser > 0) {
            obj.messages.splice(firstUser, 0, ...history);
          } else if (firstUser === -1) {
            // No user turn yet (history-only body): append history, then let
            // the caller add the prompt.
            obj.messages.push(...history);
          }
        }
        // Memory goes after any system message the template already defined.
        const memBlock = memoryFor(agent);
        if (memBlock) {
          const sysMsg = obj.messages.find(m => m && m.role === 'system');
          if (sysMsg) sysMsg.content = `${sysMsg.content || ''}${memBlock}`.trim();
          else obj.messages.unshift({ role: 'system', content: memBlock.trim() });
        }
        if (systemPrompt && !obj.messages.some(m => m && m.role === 'system')) {
          obj.messages.unshift({ role: 'system', content: systemPrompt });
        }
      }
      return obj;
    };

    /**
     * Set the live prompt on an already-contextualised body.
     *
     * Split from injectContext because the two template branches need
     * different halves: a normalised template already carries the prompt
     * (substituted into $USER-PROMPT-VARIABLE) and only needs history and
     * memory; re-running the prompt merge there would append the attached
     * images a second time.
     */
    const injectPrompt = obj => {
      if (obj && Array.isArray(obj.messages)) {
        const userMsg = obj.messages.find(m => m && m.role === 'user');
        // mergeContent, not setMessageContent: a pasted template may carry its
        // own hard-coded image_url part, and the new images must be ADDED to it
        // rather than replacing the array wholesale.
        if (userMsg) mergeContent(userMsg, prompt, attachments);
        else obj.messages.push({ role: 'user', content: buildContent(prompt, attachments) });
        injectContext(obj);
      }
      return obj;
    };

    /**
     * Give a messageless body a chat shape: history, the live prompt (with
     * attachments), and memory. Used when a template carried connection
     * details but no message shape at all. Call it INSTEAD of
     * injectContext/injectPrompt, never after either -- both of those would
     * add history and memory a second time.
     */
    const startChatShape = obj => {
      try {
        const hist = this._historyFor(agent.id);
        if (hist.length) obj.messages.push(...hist);
      } catch { /* history is best-effort */ }
      obj.messages.push({ role: 'user', content: buildContent(prompt, attachments) });
      const memBlock = memoryFor(agent);
      if (memBlock) obj.messages.unshift({ role: 'system', content: memBlock.trim() });
      return obj;
    };

    /** True for a body that needs startChatShape: an object with no message
     * shape of its own. Non-chat shapes (Responses-API `input`, completions
     * `prompt`) are left alone to travel verbatim. */
    const needsChatShape = obj => !!obj && typeof obj === 'object' && !Array.isArray(obj)
      && !Array.isArray(obj.messages) && !('input' in obj) && !('prompt' in obj);

    // A template counts as normalized when it carries ANY Router Studio
    // placeholder, not just a prompt one. Gating on $USER-PROMPT alone meant
    // a template with only $ENDPOINT-VARIABLE (or only a key) skipped
    // substitution entirely and the literal went out as the URL.
    // substituteCurlTemplate itself is placeholder-independent; this gate was
    // the only thing coupling them.
    const isNormalized = /\$\{?USER-PROMPT-VARIABLE\}?/.test(tpl) || /\$\{?PROMPT\}?/.test(tpl) || hasTemplateVars(tpl);

    let parsed;
    let body = {};

    if (isNormalized) {
      const { text: substituted, restore } = substituteCurlTemplate(tpl, {
        endpoint: agent.endpoint || provider.endpoint,
        apiKey: effectiveKey,
        prompt,
        temperature,
        maxTokens,
        systemPrompt,
      });
      try {
        parsed = parseCurl(substituted);
      } catch (err) {
        throw new Error(`Bad curl template for ${agent.name}: ${err.message}`);
      }
      // Prompt/system-prompt text went in behind shell-inert sentinels so an
      // apostrophe couldn't break the quoting. Put the real text back BEFORE
      // parsing, so the body holds real JSON string values.
      const dataText = restore(parsed.data || '');
      try {
        body = JSON.parse(dataText || '{}');
      } catch (e) {
        throw jsonError(dataText, e.message);
      }
      // $SYSTEM-PROMPT already carried the agent's prompt and (in most saved
      // templates) its memory. History and memory still have to be injected
      // here: this branch used to skip the whole block, which is why a saved
      // curl/Python/Node agent had no conversation history and no memory while
      // every ordinary agent had both.
      // A template that carried connection details but no message shape (no
      // prompt placeholder to have delivered one) gets a fresh chat shape
      // instead: the live prompt, history, memory and attachments.
      if (needsChatShape(body)) {
        body.messages = [];
        if (!body.model && agent.model) body.model = agent.model;
        startChatShape(body);
      } else {
        injectContext(body);
      }
    } else {
      // Never normalized — parse whatever language it is and do the injection.
      if (!tpl.trim()) {
        throw new Error(`${agent.name} has no snippet — paste a curl, shell, Python, Node or SDK snippet into the agent's Curl Template box.`);
      }
      const kind = snippetKind(tpl);
      try {
        parsed = kind === 'curl' ? parseCurl(tpl) : parseSnippet(tpl);
      } catch (err) {
        throw new Error(`Bad curl template for ${agent.name}: ${err.message}`);
      }
      if (parsed.data) {
        try {
          body = JSON.parse(parsed.data);
        } catch (e) {
          try {
            body = parseJsonLenient(parsed.data).value;
          } catch {
            throw jsonError(parsed.data, e.message);
          }
        }
      }
      if (needsChatShape(body)) {
        // Provider example with no message shape at all (or a body that
        // collapsed to {}): start a chat request around the configured model
        // so the live prompt, history, memory and attachments have somewhere
        // to land.
        body.messages = [];
        if (!body.model && agent.model) body.model = agent.model;
        startChatShape(body);
      } else {
        injectPrompt(body);
      }
      if (parsed.stream !== false && body && typeof body === 'object' && 'stream' in body) {
        body.stream = false;   // the relay is non-streaming
      }
    }

    const templateMentionsSystem = /\$\{?SYSTEM-PROMPT\}?/.test(tpl);
    if (Array.isArray(body.messages)) {
      // $SYSTEM-PROMPT present but the template has no system message:
      // add one, or the variable silently goes nowhere.
      if (templateMentionsSystem && !bodyHasSystemMessage(body)) {
        body.messages.unshift({ role: 'system', content: systemPrompt });
      }
      // A custom system prompt with no system message in the template:
      // merge it INTO any existing system block (chat shapes only). Memory
      // injection above may already have created a system message holding
      // only notes -- the old "skip if a system message exists" check treated
      // that as done, silently dropping the actual instructions so the model
      // answered with no system prompt at all.
      if (systemPrompt) {
        const sysMsg = body.messages.find(m => m && m.role === 'system');
        if (sysMsg) {
          if (!String(sysMsg.content || '').includes(systemPrompt)) {
            sysMsg.content = `${systemPrompt}\n\n${sysMsg.content || ''}`.trim();
          }
        } else {
          body.messages.unshift({ role: 'system', content: systemPrompt });
        }
      }
    }
    // Never send a raw placeholder to a provider.
    const leftover = findLeftoverVars(body);
    if (leftover.length) {
      throw new Error(`Template still contains ${leftover.join(', ')} — paste a curl into the template box so it gets rewritten with variables.`);
    }
    // Chat-shaped template bodies go through the same streaming + tool loop as
    // every other agent (agent.stream === false opts out of streaming). Falls
    // back to the one-shot relay below on any failure.
    if (Array.isArray(body.messages) && agent.stream !== false) {
      // Everything the snippet's own body carries (its model, temperature,
      // reasoning config and any endpoint-specific parameters) is preserved;
      // only `messages` changes as the loop runs.
      const specFor = messages => ({
        provider: 'auto',
        endpoint: parsed.url,
        api_key: bearerFromHeaders(parsed.headers) || effectiveKey,
        agent_id: agent.id,
        model: body.model || agent.model,
        temperature: body.temperature ?? temperature,
        max_tokens: body.max_tokens ?? maxTokens,
        // Route through selected proxy if one is configured
        proxy: store.get('settings.proxyActive') || null,
        // Carry any extra top-level keys the snippet set (e.g. `reasoning`,
        // `top_p`, provider switches) so custom models keep working.
        ...Object.fromEntries(
          Object.entries(body).filter(([k]) => ![
            'messages', 'model', 'temperature', 'max_tokens', 'stream', 'proxy',
          ].includes(k))
        ),
        messages,
      });

      try {
        const streamed = await this._runToCompletion({
          agent,
          signal,
          liveNode,
          commsCtx,
          messages: () => body.messages.map(m => ({ ...m })),
          specFor,
        });
        if (streamed && (streamed.content || streamed.reasoning
          || (streamed.toolCalls && streamed.toolCalls.length))) {
          return {
            content: streamed.content,
            text: streamed.content,
            sections: null,
            reasoning: streamed.reasoning || null,
            toolCalls: streamed.toolCalls || [],
          };
        }
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        // A snippet endpoint that can't stream must not lose the reply; the
        // one-shot relay below still uses the exact same body.
      }
    }
    // Chat-style bodies go through the normal messages flow; anything else
    // (Responses-API `input`, custom shapes, …) is forwarded verbatim.
    if (!Array.isArray(body.messages)) {
      const rawRes = await api.relayCall({
        provider: 'auto',
        endpoint: parsed.url,
        api_key: bearerFromHeaders(parsed.headers) || effectiveKey,
        agent_id: agent.id,
        model: body.model || agent.model,
        raw_payload: body,
        proxy: store.get('settings.proxyActive') || null,
      }, signal);
      if (!rawRes?.success || !rawRes.content) {
        throw relayError(rawRes, `Template call failed for ${agent.name}`);
      }
      this._recordUsage(agent.id, rawRes.usage || null, rawRes.content || '');
      const rawSplit = this._parseSections(rawRes.content);
      return { content: rawRes.content, text: rawSplit.text, sections: rawSplit.sections, reasoning: rawRes.reasoning || null };
    }
    const res = await api.relayCall({
      provider: 'auto',
      endpoint: parsed.url,
      api_key: bearerFromHeaders(parsed.headers) || effectiveKey,
      agent_id: agent.id,
      model: body.model || agent.model,
      temperature: body.temperature ?? temperature,
      max_tokens: body.max_tokens ?? maxTokens,
      messages: body.messages || [],
      proxy: store.get('settings.proxyActive') || null,
    }, signal);
    if (!res?.success || !res.content) {
      throw relayError(res, `Template call failed for ${agent.name}`);
    }
    this._recordUsage(agent.id, res.usage || null, res.content || '');
    const split = this._parseSections(res.content);
    return { content: res.content, text: split.text, sections: split.sections, reasoning: res.reasoning || null };
  }

  _parseSections(content) {
    const sections = [];
    let text = content || '';

    // Extract code blocks into collapsible sections (removed from body text
    // so they don't render twice)
    const codeRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let match;
    while ((match = codeRegex.exec(content || '')) !== null) {
      sections.push({
        type: 'code',
        title: match[1] ? `Code — ${match[1]}` : 'Code',
        content: match[2].trim(),
        language: match[1],
        collapsed: true
      });
    }
    text = text.replace(codeRegex, '').replace(/\n{3,}/g, '\n\n').trim();

    return { sections, text };
  }

  /**
   * Ask one agent a question directly, with no fan-out.
   *
   * This is the "always reachable" half of always-on: any agent can be
   * questioned on its own, outside a turn, and the exchange lands in this
   * session so it survives a reload and syncs like everything else.
   */
  async askAgentDirectly(agentId, question) {
    const agents = store.get('agents') || [];
    const agent = agents.find(a => a.id === agentId);
    if (!agent) {
      store.emit('toast', { message: 'That agent no longer exists', type: 'error' });
      return;
    }
    const text = String(question || '').trim();
    if (!text) return;
    // Already answering someone else: say so rather than running two turns.
    if (this.aborter || this._busy.has(agentId) || this._nestedBusy.has(agentId)) {
      store.emit('toast', {
        message: `${agent.name} is already answering — wait for that to finish`,
        type: 'info',
      });
      return;
    }
    // A direct ask is still a user turn: hold off autonomous ticks for the
    // grace period, or the answer arrives twice (once asked, once ticked).
    try { this.alwaysOn?.noteUserTurn(); } catch { /* scheduler not ready */ }

    this._addMessage({ role: 'user', content: text, timestamp: Date.now() });
    const empty = document.getElementById('emptyState');
    if (empty) empty.remove();

    store.emit('agent:status', { agentId: agent.id, status: 'thinking' });
    this.aborter = new AbortController();
    this._busy.add(agent.id);
    const live = this._makeLiveNode(agent);
    try {
      const reply = await this._callAgent(
        text, agent, this.aborter.signal, live, null, { direct: true },
      );
      const agentMsg = {
        role: 'agent', content: (reply && reply.content) || '', agentId: agent.id,
        reasoning: (reply && reply.reasoning) || null,
        toolCalls: (reply && reply.toolCalls) || (live && live.toolCalls) || null,
        timestamp: Date.now(),
      };
      // The live node already holds the streamed text. Appending the final
      // message on top of it was the double reply: once while streaming, once
      // when it landed. Swap the placeholder instead, exactly as the main
      // send path does.
      if (live && live.isConnected) this._replaceLiveNode(live, agentMsg);
      else this._addMessage(agentMsg);
      this._recordAgentUse(agent.id);
    } catch (err) {
      const stopped = err && err.name === 'AbortError';
      const why = stopped ? 'cancelled' : (err?.message || String(err));
      const errorMsg = {
        role: 'agent',
        content: stopped ? (live?.text || 'Stopped by user.') : `Could not answer: ${why}`,
        agentId: agent.id,
        reasoning: (live && live.reasoning) || null,
        toolCalls: (live && live.toolCalls) || null,
        timestamp: Date.now(),
      };
      if (live && live.isConnected) this._replaceLiveNode(live, errorMsg);
      else this._addMessage(errorMsg);
    } finally {
      this._busy.delete(agent.id);
      this.aborter = null;
      // Idle, not active: a direct ask is a one-shot, and nothing keeps
      // working afterwards. Leaving 'active' lit the agent's indicator until
      // something else happened to clear it.
      store.emit('agent:status', { agentId: agent.id, status: 'idle' });
    }
  }

  /**
   * Ask one agent from the topology's inline ASK box.
   *
   * Deliberately isolated: the exchange never touches the transcript, never
   * fans out, and never becomes part of the session, so the map's little chat
   * cannot disturb the main conversation. The difference from a plain
   * askAgentDirectly is the traffic: every hop is announced with the same flow
   * events a normal prompt uses, so the graph lights up and animates the
   * request and reply exactly as it would for a turn sent from the composer.
   *
   * @returns {Promise<{text?: string, error?: string}>}
   */
  async askAgentInline(agentId, question) {
    const agent = (store.get('agents') || []).find(a => a.id === agentId);
    if (!agent) return { error: 'That agent no longer exists.' };
    const text = String(question || '').trim();
    if (!text) return { error: '' };
    if (this._busy.has(agentId) || this._nestedBusy.has(agentId)) {
      return { error: `${agent.name} is already answering — wait for that to finish.` };
    }
    // A question is a user turn: hold autonomous ticks off so the same agent
    // does not also answer a scheduled prompt on top of this one.
    try { this.alwaysOn?.noteUserTurn(); } catch { /* scheduler not ready */ }

    this._busy.add(agent.id);
    const ctrl = new AbortController();
    store.emit('agent:status', { agentId: agent.id, status: 'thinking' });
    store.emit('flow:start', { from: 'user', to: agent.id });
    try {
      // No live node and no attachments: the reply is only ever rendered in
      // the topology's floating box, never as a transcript bubble.
      const reply = await this._callAgent(text, agent, ctrl.signal, null, null, { direct: true, inline: true });
      store.emit('flow:respond', { from: agent.id });
      // Hand back the whole run, not just the closing sentence: every tool call
      // with its arguments and its output, plus any reasoning, so the graph's
      // box can show the actual work as raw text.
      return {
        text: (reply && reply.content) || '',
        reasoning: (reply && reply.reasoning) || null,
        toolCalls: (reply && reply.toolCalls) || [],
      };
    } catch (err) {
      const stopped = err && err.name === 'AbortError';
      store.emit('flow:fail', { to: agent.id });
      return { error: stopped ? 'cancelled' : (err?.message || String(err)) };
    } finally {
      this._busy.delete(agent.id);
      store.emit('agent:status', { agentId: agent.id, status: 'idle' });
    }
  }

  _addMessage(msg) {
    const empty = document.getElementById('emptyState');
    if (empty) empty.remove();

    // Last line of defence: whatever reaches the transcript is text-only, so a
    // base64 blob can never be written to localStorage.
    stripImages([msg]);

    const el = this.renderer.render(msg);
    document.getElementById('chatMessages').appendChild(el);
    this._scrollToBottom();

    if (msg && (msg.role === 'user' || msg.role === 'agent')) {
      const conv = this._ensureConversation();
      if (conv) {
        conv.messages = conv.messages || [];
        if (!conv.messages.includes(msg)) {
          conv.messages.push(msg);
        }
        conv.updatedAt = Date.now();
        store.set('currentConversation', conv);
        const convs = store.get('conversations') || [];
        const idx = convs.findIndex(c => c.id === conv.id);
        if (idx >= 0) {
          convs[idx] = conv;
          store.set('conversations', [...convs]);
        }
      }
    }
    store.emit('chat:message', msg);

    // Announce the reply rather than speaking here: audio.js owns playback,
    // and auto-speak is a setting it can honour or ignore. Emitted only for
    // agent messages — reading your own question back is never wanted.
    if (msg && msg.role === 'agent') {
      store.emit('chat:reply', msg);
    }
  }

  _showTyping() {
    const id = 'typing-' + Date.now();
    const div = document.createElement('div');
    div.id = id;
    div.className = 'message message-agent';
    // Robot avatar, eyes scanning — it's working right now.
    const avatar = createAvatar('agent');
    avatar.classList.add('thinking');
    div.appendChild(avatar);
    const body = document.createElement('div');
    body.className = 'message-body';
    body.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    div.appendChild(body);
    document.getElementById('chatMessages').appendChild(div);
    this._scrollToBottom();
    return id;
  }

  _removeTyping(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  /**
   * Scroll the transcript to the newest message.
   *
   * Honours the Auto Scroll toggle. It previously always scrolled, so the
   * setting was written by the Config tab and read by nobody -- which is why
   * turning it off looked broken. Opt-out, not opt-in: a missing/garbage value
   * keeps the old behaviour rather than freezing the view.
   */
  _scrollToBottom() {
    if (store.get('settings.autoScroll') === false) return;
    const container = document.getElementById('chatMessages');
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }
}

/** Keep the head and tail of an over-long past message; the middle is usually filler. */
function trimForContext(text, maxChars = 4000) {
  const s = String(text ?? '');
  const cap = Math.max(1000, Number(maxChars) || 4000);
  if (s.length <= cap) return s;
  const tail = Math.min(2000, Math.floor(cap * 0.25));
  const head = Math.max(800, cap - tail - 40);
  return s.slice(0, head) + '\n…[earlier part trimmed]…\n' + s.slice(-tail);
}

/**
 * Put the live prompt into a message without destroying a multimodal body.
 *
 * Vision payloads carry `content` as an ARRAY of typed parts — a text part and
 * one or more image_url parts. Overwriting the whole array would silently drop
 * the images, so only the text part is replaced and every other part is kept.
 */
function setMessageContent(msg, prompt) {
  if (!Array.isArray(msg.content)) {
    msg.content = prompt;
    return;
  }
  const textPart = msg.content.find(p => p && p.type === 'text');
  if (textPart) {
    textPart.text = prompt;
    // A text part can also arrive as {type:'text', text:…} — covered above.
  } else {
    msg.content.unshift({ type: 'text', text: prompt });
  }
  // Any legacy {type:'input_text'} style parts get the prompt too.
  msg.content.forEach(p => {
    if (p && p.type === 'input_text' && typeof p.text === 'string') p.text = prompt;
  });
}

/**
 * The memory block for an agent, honouring the per-agent switch.
 *
 * The switch has to gate the block itself, not just the tool set: gating only
 * the tools left an agent reading its notes in the prompt while the editor
 * said memory was off, which is the worst kind of setting that lies.
 *
 * Default ON. An agent saved before this default has no `memory` field at all
 * and is treated like a new one; only an explicit `false` switches it off,
 * because that is somebody who deliberately turned memory off for that agent.
 */
const memoryFor = agent =>
  (agent && agent.memory !== false ? memoryBlockFor(agent.id) : '');

/** Global pre-prompt override (Agents tab header). When active with text, it
 *  is prepended to every agent's system prompt on every call path. */
const globalPrePromptFor = () => {
  const g = store.get('settings.globalPrePrompt');
  return (g && g.active && g.text && g.text.trim()) ? g.text.trim() : '';
};

/**
 * Optional budget line appended to the system prompt. Default OFF.
 *
 * Coarse by design, and silent while the bucket is healthy: injecting "you
 * have 14 requests left" every turn costs tokens on every call (including
 * tool loops) for information the model cannot count reliably and cannot see
 * across agents sharing the key. Below half full there is nothing actionable,
 * so nothing is injected at all.
 */
function budgetBlockFor(agent, endpoint, apiKey) {
  if (store.get('settings.budgetInjection') !== true) return '';
  let u;
  try {
    u = usageFor(endpoint, apiKey, agent?.id);
  } catch {
    return '';
  }
  if (!u || u.used <= 0) return '';
  const frac = u.used / Math.max(1, u.rpm);
  if (frac < 0.5) return '';
  if (frac < 0.85) {
    return `\n\n[Rate budget: ${u.used}/${u.rpm} requests used on this key in the last minute. Keep this reply short.]`;
  }
  return `\n\n[Rate budget nearly exhausted: ${u.used}/${u.rpm} requests used on this key in the last minute. Answer briefly, with no tool calls unless essential.]`;
}

/** The system prompt an agent should carry, if any. While the global
 *  override is armed it REPLACES the agent's own prompt (which stays stored
 *  untouched and returns the moment the override is switched off). Brain Lab
 *  profiles marked ALWAYS APPEND are added last and cannot be replaced by the
 *  global override. */
/** Input-token budget for one request, given the model window and output ask. */
const inputBudgetFor = agent => contextInputBudget(
  contextLimitFor(agent?.model),
  settingFor(agent, 'maxTokens') ?? 4096,
);

/**
 * Attached reference files, capped against the model's real input window.
 *
 * The old 260k-character ceiling was independent of the model: a 32k-token
 * agent could receive 65k tokens of files before the conversation even
 * started. Files now get at most half of the input budget, with the absolute
 * ceiling retained for very large windows.
 */
const filesBlockFor = agent => {
  const files = Array.isArray(agent?.files) ? agent.files : [];
  if (!files.length) return '';
  const maxChars = Math.min(AGENT_FILES_BUDGET,
    Math.max(8000, Math.floor(inputBudgetFor(agent) * 0.5 * 2.5)));
  let used = 0;
  const parts = [];
  for (const file of files) {
    const text = String(file?.text || '').replace(/\r\n?/g, '\n').trim();
    if (!text) continue;
    const name = String(file?.name || 'file').replace(/\s+/g, ' ').slice(0, 120);
    const header = `--- ${name} ---`;
    const room = maxChars - used;
    if (room <= header.length + 200) {
      parts.push('[...attached files truncated...]');
      break;
    }
    const body = text.length > room - header.length - 2
      ? compactText(text, room - header.length - 2)
      : text;
    parts.push(header, body);
    used += header.length + body.length + 2;
  }
  if (!parts.length) return '';
  return `\n\n<agent-files>\n${parts.join('\n')}\n</agent-files>`;
};

/**
 * The plan the agent wrote with todo_write. It is re-injected on every call
 * because the original tool result is exactly the kind of old exchange the
 * context assembler compacts first; without this the plan survives in
 * localStorage but disappears from the model's view halfway through a task.
 */
const todosBlockFor = () => {
  const todos = store.get('ui.todos');
  if (!Array.isArray(todos) || !todos.length) return '';
  const mark = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
  const lines = todos.slice(0, 50).map((t, i) => {
    const status = mark[t?.status] ? t.status : 'pending';
    return `${mark[status]} ${i + 1}. ${String(t?.content || '').slice(0, 300)}`;
  }).filter(Boolean);
  if (!lines.length) return '';
  return `\n\n<current-plan>\n${lines.join('\n')}\n</current-plan>`;
};

/** Re-inject the plan after todo_write, so it survives the same long turn. */
const refreshTodoBlock = messages => {
  const idx = messages.findIndex(m => m && m.role === 'system');
  if (idx === -1) return;
  const base = String(messages[idx].content || '')
    .replace(/\n\n<current-plan>[\s\S]*?<\/current-plan>/, '');
  messages[idx] = { ...messages[idx], content: `${base}${todosBlockFor()}` };
};

const systemPromptFor = agent => {
  const pre = globalPrePromptFor();
  const base = pre || agent.systemPrompt || '';
  const append = [alwaysAppendFor(agent), filesBlockFor(agent), todosBlockFor()].filter(Boolean).join('\n\n');
  return append ? `${base}${base ? '\n\n' : ''}${append}` : base;
};

/**
 * True when a stored "agent message" is really a failure notice rather than a
 * reply. These are written into the dialog when a call errors or is stopped,
 * and must never be replayed as the assistant's own words.
 */
function isFailureNotice(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return /^(error\b|error:|no response\b|stopped by user|aborted|failed\b|bad curl template|relay request failed|template call failed|no api key|no reply content|provider .*not found|unrecognized provider response|provider returned no readable content)/i.test(t);
}

export default Chat;
