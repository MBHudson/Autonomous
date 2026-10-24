/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// TOPOLOGY3D / ASK.JS — inline "ask this model" dock
// ============================================
//
// Two pieces, both floating over the graph's root:
//   * a small prompt box that drops in just below a node's metrics card, with
//     a play-button send and a Voice toggle (read-aloud, default ON, its own
//     choice and separate from the main Config default of off);
//   * a semi-transparent reply box pinned to whichever top corner has the
//     room, which flips sides as the graph (and the node) is orbited.
//
// The exchange is raw text only — no markdown, no code fences, no tool cards —
// and it is isolated from the main transcript. The traffic still shows on the
// graph because chat.askAgentInline emits the normal flow events.

import { store } from '../../store.js?v=323';
import { audio } from '../../audio.js?v=323';
import { k } from '../../storage.js?v=323';

const VOICE_KEY = k('topoAskVoice');
const PAD = 12;

/** Render a tool argument verbatim: strings as-is, objects pretty-printed. */
function toolArgText(arg) {
  if (arg === undefined || arg === null || arg === '') return '';
  if (typeof arg === 'string') return arg;
  if (arg && arg._truncated) return `${arg.preview || ''}\n… (truncated)`;
  try { return JSON.stringify(arg, null, 2); } catch { return String(arg); }
}

export class AskDock {
  /**
   * @param {HTMLElement} host the graph root (position:absolute, inset:0)
   * @param {object} ctx { onSend(agentId, question) }
   */
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx || {};
    this.agentId = null;      // agent the prompt/reply belongs to
    this._replyAgentId = null;
    this.pending = false;
    this.side = 'right';

    this.promptEl = document.createElement('div');
    this.promptEl.className = 't3d-ask-prompt';
    this.promptEl.hidden = true;
    this.promptEl.innerHTML = `
      <textarea class="t3d-ask-input" rows="2" spellcheck="false"
        placeholder="Ask this model directly. Nobody else is consulted."></textarea>
      <div class="t3d-ask-row">
        <button class="t3d-ask-voice" type="button" title="Read the reply aloud">&#128266;<span>Voice</span></button>
        <button class="t3d-ask-send" type="button" title="Send (Enter)">&#9654;</button>
      </div>`;
    host.appendChild(this.promptEl);

    this.replyEl = document.createElement('div');
    this.replyEl.className = 't3d-ask-reply side-right';
    this.replyEl.hidden = true;
    this.replyEl.innerHTML = `
      <div class="t3d-ask-reply-head">
        <span class="t3d-ask-reply-who"></span>
        <button class="t3d-x t3d-ask-reply-x" type="button" title="Close">&times;</button>
      </div>
      <div class="t3d-ask-reply-body"></div>`;
    host.appendChild(this.replyEl);

    // Default ON. Kept under its own key so toggling the big Config switch (or
    // its default of off) never reaches into this little box.
    this.voiceOn = this._loadVoice();

    this.input = this.promptEl.querySelector('.t3d-ask-input');
    this.sendBtn = this.promptEl.querySelector('.t3d-ask-send');
    this.voiceBtn = this.promptEl.querySelector('.t3d-ask-voice');
    this.whoEl = this.replyEl.querySelector('.t3d-ask-reply-who');
    this.bodyEl = this.replyEl.querySelector('.t3d-ask-reply-body');

    // Never let a click or wheel inside the dock orbit/zoom the camera behind it.
    for (const el of [this.promptEl, this.replyEl]) {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    }

    this._syncVoiceBtn();
    this.sendBtn.addEventListener('click', () => this.send());
    this.voiceBtn.addEventListener('click', () => this.toggleVoice());
    this.replyEl.querySelector('.t3d-ask-reply-x').addEventListener('click', () => this.closeReply());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
      else if (e.key === 'Escape') { e.stopPropagation(); this.closePrompt(); }
    });
  }

  _loadVoice() {
    try { const v = localStorage.getItem(VOICE_KEY); return v === null ? true : v === '1'; }
    catch { return true; }
  }
  _saveVoice() {
    try { localStorage.setItem(VOICE_KEY, this.voiceOn ? '1' : '0'); } catch { /* private mode */ }
  }
  _syncVoiceBtn() {
    this.voiceBtn.classList.toggle('on', this.voiceOn);
    this.voiceBtn.setAttribute('aria-pressed', this.voiceOn ? 'true' : 'false');
    this.voiceBtn.title = this.voiceOn ? 'Voice on — replies are read aloud' : 'Voice off — replies stay silent';
  }
  toggleVoice() { this.voiceOn = !this.voiceOn; this._saveVoice(); this._syncVoiceBtn(); }

  get promptOpen() { return !this.promptEl.hidden; }
  get replyOpen() { return !this.replyEl.hidden; }
  get replyAgentId() { return this._replyAgentId || this.agentId; }

  openPrompt(agentId) {
    this.agentId = agentId;
    this.promptEl.hidden = false;
    this.promptEl.classList.remove('t3d-ask-in');
    void this.promptEl.offsetWidth;
    this.promptEl.classList.add('t3d-ask-in');
    this.input.focus();
  }

  closePrompt() { this.promptEl.hidden = true; }

  async send() {
    if (this.pending || !this.agentId) return;
    const text = String(this.input.value || '').trim();
    if (!text) return;
    const agentId = this.agentId;
    this.pending = true;
    this.sendBtn.classList.add('busy');
    this.input.value = '';
    // Show the reply box right away as a "thinking" placeholder, so the answer
    // has somewhere obvious to land.
    this._showReply(agentId, {}, true);
    this.ctx.onSend?.(agentId, text);
  }

  /** Called by the topology when the store reports the answer. */
  settle({ agentId, text, error, toolCalls, reasoning } = {}) {
    this.pending = false;
    this.sendBtn?.classList.remove('busy');
    if (agentId && this.agentId && agentId !== this.agentId) return; // stale ask
    const id = agentId || this.agentId;
    this._replyAgentId = id;
    this._showReply(id, { text, error, toolCalls, reasoning }, false);
    if (!error && text && this.voiceOn) {
      const agent = (store.get('agents') || []).find(a => a.id === id) || {};
      // An agent muted in its own settings stays silent here too.
      if (agent.voice !== 'off' && agent.muteVoice !== true) {
        try {
          // Only the closing answer is read aloud -- never the tool dumps.
          audio.speak(text, { voice: agent.voice, pitch: agent.pitch });
        } catch { /* a failed read-aloud must never break the reply */ }
      }
    }
  }

  _showReply(agentId, detail = {}, thinking) {
    const agent = (store.get('agents') || []).find(a => a.id === agentId) || {};
    const color = agent.color || '#00e5ff';
    this.replyEl.hidden = false;
    this.replyEl.style.setProperty('--c', color);
    this.whoEl.textContent = agent.name || 'Model';
    const err = !thinking && detail.error;
    this.bodyEl.classList.toggle('thinking', !!thinking);
    this.bodyEl.classList.toggle('error', !!err);
    if (thinking) this.bodyEl.textContent = 'Thinking…';
    else if (err) this.bodyEl.textContent = detail.error;
    else this.bodyEl.textContent = this._compose(detail);
    // Always show the newest content.
    this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
  }

  /**
   * Everything the model did, as raw text: reasoning (if any), then each tool
   * call with its arguments and its output, then the closing answer. No boxes,
   * no collapsing -- verbose on purpose.
   */
  _compose({ text, toolCalls, reasoning } = {}) {
    const parts = [];
    const reason = String(reasoning || '').trim();
    if (reason) parts.push(reason, '');
    const calls = Array.isArray(toolCalls) ? toolCalls : [];
    calls.forEach((c) => {
      const name = (c && c.tool) || 'tool';
      parts.push(`── tool: ${name} ──`);
      const arg = toolArgText(c && c.arg);
      if (arg) parts.push(`args: ${arg}`);
      const status = (c && c.status) || 'done';
      const ms = (c && c.ms != null) ? ` (${c.ms}ms)` : '';
      const out = String((c && c.result) != null ? c.result : '').trimEnd();
      parts.push(`result [${status}]${ms}:`, out || '(no output)', '');
    });
    const answer = String(text || '').trim();
    if (answer) parts.push(answer);
    if (!parts.length) return '(empty reply)';
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  closeReply() { this.replyEl.hidden = true; }

  /** Dock the prompt box just under its card (overlap when there is no room). */
  placePrompt(rect, w, h) {
    if (this.promptEl.hidden) return;
    const pw = this.promptEl.offsetWidth || 290;
    const ph = this.promptEl.offsetHeight || 92;
    let left = rect ? rect.left : 0;
    left = Math.max(PAD, Math.min(w - pw - PAD, left));
    // Prefer just below the card; if that runs off the bottom (phones, a card
    // low on the screen), let it overlap upward rather than disappear.
    let top = rect ? rect.top + rect.h + 8 : PAD;
    if (top + ph > h - PAD) top = Math.max(PAD, h - ph - PAD);
    this.promptEl.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  /**
   * Keep the reply box in the top corner with the most room for the node.
   * Passing the node's live screen x (or null when it is off-view) lets the
   * box flip sides as the operator orbits the graph.
   */
  placeReply(nodeScreenX, w) {
    if (this.replyEl.hidden) return;
    const rw = this.replyEl.offsetWidth || 320;
    const side = (nodeScreenX != null && nodeScreenX > w / 2) ? 'left' : 'right';
    if (side !== this.side) {
      this.side = side;
      this.replyEl.classList.toggle('side-left', side === 'left');
      this.replyEl.classList.toggle('side-right', side === 'right');
    }
    const left = side === 'left' ? PAD : Math.max(PAD, w - rw - PAD);
    this.replyEl.style.transform = `translate3d(${Math.round(left)}px, ${PAD}px, 0)`;
  }

  dispose() {
    this.promptEl.remove();
    this.replyEl.remove();
  }
}

export default AskDock;
