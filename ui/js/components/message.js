/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// MESSAGE.JS — Message renderer
// ============================================

import { esc, formatTime, copyToClipboard, asText } from '../utils.js?v=358';
import { renderMarkdown } from '../markdown.js?v=358';
import { CodeBlock, splitFences } from './codeBlock.js?v=358';
import { createAvatar } from './avatar.js?v=358';
import { store } from '../store.js?v=358';
import { audio, AudioController } from '../audio.js?v=358';

const TOOL_DISPLAY_LIMIT = 8000;

function toolValueText(value, limit = TOOL_DISPLAY_LIMIT) {
  if (value === undefined || value === null) return '';
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  text = String(text || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\u2026 (${text.length - limit} more characters)`;
}

function toolPreview(arg) {
  if (arg === undefined || arg === null) return '';
  let text;
  if (typeof arg === 'string') {
    text = arg;
  } else if (Array.isArray(arg)) {
    text = arg.join(' ');
  } else {
    const pick = arg.path ?? arg.file ?? arg.query ?? arg.pattern ?? arg.url
      ?? arg.name ?? arg.server ?? arg.tool ?? arg.command;
    if (pick !== undefined && pick !== null) {
      text = Array.isArray(pick) ? pick.join(' ') : String(pick);
    } else if (Array.isArray(arg.argv)) {
      text = arg.argv.join(' ');
    } else {
      try {
        text = JSON.stringify(arg);
      } catch {
        text = String(arg);
      }
    }
  }
  text = String(text || '').replace(/\s+/g, ' ').trim();
  return text.length > 100 ? `${text.slice(0, 99)}\u2026` : text;
}

function toolStatus(call) {
  const key = call && call.status ? String(call.status) : (call && call.result ? 'ok' : 'running');
  const meta = {
    running: { icon: '\u25CC', label: 'running' },
    pending: { icon: '\u23F8', label: 'approval' },
    ok: { icon: '\u2713', label: 'done' },
    error: { icon: '\u2715', label: 'error' },
  }[key] || { icon: '\u2022', label: key };
  const ms = call && call.ms !== undefined && call.ms !== null && Number.isFinite(Number(call.ms))
    ? ` ${Math.round(Number(call.ms))}ms` : '';
  return { key, ...meta, ms };
}

function renderToolCall(call, opts) {
  const status = toolStatus(call);
  const open = opts.open === true || status.key === 'running'
    || status.key === 'pending' || status.key === 'error';

  const details = document.createElement('details');
  details.className = 'tool-call';
  details.dataset.status = status.key;
  details.open = open;

  const summary = document.createElement('summary');
  summary.className = 'tool-call-summary';

  const caret = document.createElement('span');
  caret.className = 'tool-call-caret';
  caret.textContent = '\u25B6';
  summary.appendChild(caret);

  const icon = document.createElement('span');
  icon.className = 'tool-call-icon';
  icon.textContent = status.icon;
  summary.appendChild(icon);

  const name = document.createElement('span');
  name.className = 'tool-call-name';
  name.textContent = call && call.tool ? String(call.tool) : 'tool';
  summary.appendChild(name);

  const preview = toolPreview(call && call.arg);
  if (preview) {
    const arg = document.createElement('span');
    arg.className = 'tool-call-arg';
    arg.textContent = preview;
    arg.title = preview;
    summary.appendChild(arg);
  }

  const meta = document.createElement('span');
  meta.className = 'tool-call-status';
  meta.textContent = `${status.label}${status.ms}`;
  summary.appendChild(meta);

  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'tool-call-body';

  const argText = toolValueText(call && call.arg);
  if (argText) {
    const label = document.createElement('div');
    label.className = 'tool-call-label';
    label.textContent = 'Arguments';
    const pre = document.createElement('pre');
    pre.className = 'tool-call-value';
    pre.textContent = argText;
    body.appendChild(label);
    body.appendChild(pre);
  }

  const resultText = toolValueText(call && call.result);
  if (resultText) {
    const label = document.createElement('div');
    label.className = 'tool-call-label';
    label.textContent = 'Result';
    const pre = document.createElement('pre');
    pre.className = 'tool-call-value';
    pre.textContent = resultText;
    body.appendChild(label);
    body.appendChild(pre);
  } else if (status.label === 'running') {
    const wait = document.createElement('div');
    wait.className = 'tool-call-wait';
    wait.textContent = 'Waiting for the result\u2026';
    body.appendChild(wait);
  } else if (status.label === 'approval') {
    const wait = document.createElement('div');
    wait.className = 'tool-call-wait';
    wait.textContent = 'Waiting for your approval.';
    body.appendChild(wait);
  }

  if (body.childNodes.length) details.appendChild(body);
  return details;
}

export function renderToolCalls(calls, opts = {}) {
  if (!Array.isArray(calls) || !calls.length) return null;
  const box = document.createElement('div');
  box.className = 'tool-calls';
  const head = document.createElement('div');
  head.className = 'tool-calls-head';
  head.textContent = `${calls.length} tool call${calls.length === 1 ? '' : 's'}`;
  box.appendChild(head);
  calls.forEach(call => box.appendChild(renderToolCall(call, opts)));
  return box;
}

/**
 * Plain-text form of a message for the copy button. The reply is what the
 * user asked to keep, and the tool-call boxes are part of it -- copying only
 * msg.content silently dropped every argument and result.
 */
export function messageToText(msg) {
  if (!msg) return '';
  const parts = [];
  const content = asText(msg.content).trim();
  if (content) parts.push(content);

  const calls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
  if (calls.length) {
    const lines = calls.map(call => {
      const name = (call && call.tool) || 'tool';
      const status = (call && call.status) || 'done';
      let block = `--- tool: ${name} [${status}] ---`;
      const arg = toolValueText(call && call.arg).trim();
      const result = toolValueText(call && call.result).trim();
      if (arg) block += `\nArguments:\n${arg}`;
      if (result) block += `\nResult:\n${result}`;
      return block;
    });
    parts.push(lines.join('\n\n'));
  }

  const reasoning = asText(msg.reasoning).trim();
  if (reasoning && reasoning !== content) parts.push(`--- reasoning ---\n${reasoning}`);
  return parts.join('\n\n');
}

export class MessageRenderer {
  /**
   * Render a message element
   * @param {Object} msg - Message data
   * @param {string} msg.role - 'user' | 'agent'
   * @param {string} msg.content - Message text content
   * @param {string} msg.agentId - Agent ID (for agent messages)
   * @param {number} msg.timestamp - Unix timestamp
   * @param {Array} msg.sections - Collapsible sections
   */
  render(msg) {
    const wrapper = document.createElement('div');
    wrapper.className = `message message-${msg.role}`;
    wrapper.dataset.messageId = msg.id || '';

    // An always-on turn posts through exactly the same path as a reply you
    // asked for, so without this the two are pixel-identical and an
    // autonomous pass reads as "the agent answered me twice". Marked here
    // because this is the only place the distinction still exists.
    const autonomous = !!msg.autonomous;
    if (autonomous) {
      wrapper.classList.add('message-autonomous');
      wrapper.title = 'Sent on its own by an always-on agent, not in answer to you';
    }

    // Avatar (user glyph / robot with eyes that move only while it works)
    wrapper.appendChild(createAvatar(msg.role, msg.role === 'agent' ? msg.agentId : null));

    // Header
    const header = document.createElement('div');
    header.className = 'message-header';

    if (msg.role === 'user') {
      const sender = document.createElement('span');
      sender.className = 'message-sender';
      sender.textContent = 'You';
      header.appendChild(sender);
    } else {
      const agent = store.get('agents').find(a => a.id === msg.agentId);
      const sender = document.createElement('span');
      sender.className = 'message-sender';
      sender.textContent = agent ? agent.name : 'Agent';
      if (agent) sender.style.color = agent.color;
      header.appendChild(sender);

      // A label distinguishes several copies of the same model on different
      // accounts. Without it, three agents named the same thing are
      // indistinguishable in the transcript and it reads as a rendering bug.
      if (agent && agent.label) {
        const label = document.createElement('span');
        label.className = 'message-label';
        label.textContent = agent.label;
        header.appendChild(label);
      }

      if (agent) {
        const role = document.createElement('span');
        role.className = 'message-role';
        role.textContent = agent.role;
        header.appendChild(role);
      }

      if (autonomous) {
        const badge = document.createElement('span');
        badge.className = 'message-auto-badge';
        badge.textContent = 'AUTO';
        badge.title = 'Sent on its own by an always-on agent, not in answer to you';
        header.appendChild(badge);
      }
    }

    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = formatTime(msg.timestamp || Date.now());
    header.appendChild(time);

    wrapper.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'message-body';

    // Real model reasoning ONLY — never when it's just the reply. Some
    // providers echo content as reasoning (exact, wrapped, or embedded),
    // so suppress whenever either normalized side contains the other.
    const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const reasoningText = asText(msg.reasoning).trim();
    const contentText = asText(msg.content).trim();
    const rNorm = norm(reasoningText);
    const cNorm = norm(contentText);
    const isEcho = !rNorm || !cNorm || rNorm === cNorm
      || rNorm.includes(cNorm) || cNorm.includes(rNorm);
    if (!isEcho) body.appendChild(this._renderReasoning(reasoningText));

    const toolCalls = renderToolCalls(msg.toolCalls);
    if (toolCalls) body.appendChild(toolCalls);

    // Attached images.
    //
    // chat.js records images as NAME/DIMENSIONS ONLY on the message object --
    // the base64 never goes near localStorage, so it cannot be re-rendered
    // from a saved conversation. What is missing here is any rendering at all:
    // `msg.images` was written on every send and read by nothing, so a turn
    // that was a picture and no words rendered as an empty bubble and looked
    // like the upload had silently failed. Showing the thumbnail placeholder
    // makes the turn legible and states plainly why there is no picture.
    if (Array.isArray(msg.images) && msg.images.length) {
      const holder = document.createElement('div');
      holder.className = 'msg-images';
      msg.images.forEach(img => {
        if (!img) return;
        const chip = document.createElement('span');
        chip.className = 'msg-image-chip';
        const dims = img.w && img.h ? ` - ${img.w}x${img.h}` : '';
        chip.textContent = `\u{1F5BC} ${img.name || 'image'}${dims}`;
        chip.title = 'Image attached and sent to the agent. '
          + 'It is not stored here, so only the current turn can show it.';
        holder.appendChild(chip);
      });
      body.appendChild(holder);
    }

    // Content: prose through markdown, each fenced block in its own
    // always-open code container with language identity + copy/download.
    // Coerced: stored messages from older builds can hold non-strings.
    const raw = asText(msg.content);
    // "Show Code" off = render fenced blocks as plain text instead of dropping
    // them into a code container. The toggle existed in Config but nothing read
    // it, so flipping it changed nothing.
    const showCode = store.get('settings.showCode') !== false;
    if (!showCode) {
      // Plain text: no code containers, but still a WHOLE message. This used to
      // `return body` -- a node with no wrapper, no header and no actions -- and
      // every caller that swaps a streaming placeholder for it was replacing one
      // kind of element with another.
      if (raw.trim()) body.appendChild(renderMarkdown(raw));
    } else if (msg.sections && msg.sections.length > 0) {
      // Legacy path: callers that pre-split into sections.
      const prose = raw.replace(/```[A-Za-z0-9_+#.-]*\r?\n?[\s\S]*?```/g, '').trim();
      if (prose) body.appendChild(renderMarkdown(prose));
      msg.sections.forEach(section => {
        if (section.type === 'code') {
          body.appendChild(new CodeBlock(section.content, section.language).render());
        } else if (section.content) {
          body.appendChild(renderMarkdown(section.content));
        }
      });
    } else {
      const parts = splitFences(raw);
      if (parts.length === 0) {
        if (raw.trim()) body.appendChild(renderMarkdown(raw));
      } else {
        parts.forEach(part => {
          if (part.type === 'code') {
            body.appendChild(new CodeBlock(part.content, part.lang).render());
          } else {
            body.appendChild(renderMarkdown(part.content));
          }
        });
      }
    }

    wrapper.appendChild(body);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'message-actions';

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>';
    copyBtn.title = 'Copy message';
    copyBtn.addEventListener('click', async () => {
      const text = messageToText(msg);
      const success = await copyToClipboard(text);
      if (success) {
        copyBtn.style.color = 'var(--accent-green)';
        setTimeout(() => { copyBtn.style.color = ''; }, 1500);
      }
    });
    actions.appendChild(copyBtn);

    // Speak button, on agent replies only. Reading your own question back at
    // you is never what anyone wants.
    if (msg.role !== 'user' && AudioController.isSpeakable(msg.content)) {
      const speakBtn = document.createElement('button');
      speakBtn.className = 'msg-action-btn msg-speak-btn';
      const ICON_PLAY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3.5v9l7-4.5z" fill="currentColor" stroke="none"/><path d="M4 2.5v11"/></svg>';
      const ICON_STOP = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" stroke="none"/></svg>';
      let playing = false;
      const setIcon = () => {
        speakBtn.innerHTML = playing ? ICON_STOP : ICON_PLAY;
        speakBtn.title = playing ? 'Stop speaking' : 'Speak this reply';
        speakBtn.style.color = playing ? 'var(--accent-cyan)' : '';
      };
      setIcon();

      speakBtn.addEventListener('click', async () => {
        // Speaking something else already? This button becomes a stop control,
        // because two replies talking over each other is never the intent.
        if (playing || audio.speaking) {
          audio.stop();
          playing = false;
          setIcon();
          return;
        }
        playing = true;
        setIcon();
        try {
          // Speak in the agent's OWN voice. This called speak() with only the
          // text, so it fell back to the global voice and every agent read
          // alike even after each had been given its own -- and an agent set to
          // 'off' was still read aloud when you pressed play on it.
          const agent = msg.agentId
            ? (store.get('agents') || []).find(a => a.id === msg.agentId)
            : null;
          const voice = agent ? (agent.voice || '') : '';
          const pitch = agent && agent.pitch !== undefined && agent.pitch !== null
            ? Number(agent.pitch)
            : undefined;
          await audio.speak(msg.content, { voice, pitch });
        } catch (err) {
          store.emit('toast', {
            message: `Speech failed: ${err.message}`,
            type: 'error',
          });
        } finally {
          playing = false;
          setIcon();
        }
      });
      actions.appendChild(speakBtn);
    }

    // Repeat button (user messages only)
    if (msg.role === 'user') {
      const repeatBtn = document.createElement('button');
      repeatBtn.className = 'msg-action-btn';
      repeatBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3"/></svg>';
      repeatBtn.title = 'Repeat message';
      repeatBtn.addEventListener('click', () => {
        store.emit('message:repeat', msg);
      });
      actions.appendChild(repeatBtn);
    }

    wrapper.appendChild(actions);

    return wrapper;
  }

  /**
   * The model's printed thought trace, above the reply, collapsed by default.
   * Only reached when msg.reasoning genuinely differs from the reply.
   */
  _renderReasoning(text) {
    const details = document.createElement('details');
    details.className = 'reasoning-block';

    const summary = document.createElement('summary');
    summary.className = 'reasoning-summary';
    const caret = document.createElement('span');
    caret.className = 'reasoning-caret';
    caret.textContent = '\u25B6';
    const label = document.createElement('span');
    label.className = 'reasoning-label';
    label.textContent = 'Reasoning';
    const hint = document.createElement('span');
    hint.className = 'reasoning-hint';
    hint.textContent = 'model thoughts';
    summary.appendChild(caret);
    summary.appendChild(label);
    summary.appendChild(hint);
    details.appendChild(summary);

    const inner = document.createElement('div');
    inner.className = 'reasoning-content';
    // Reasoning is plain text: no markdown, no code fences.
    inner.textContent = text;
    details.appendChild(inner);

    return details;
  }

  /**
   * Create a typing indicator element
   */
  static createTypingIndicator() {
    const el = document.createElement('div');
    el.className = 'typing-indicator';
    el.innerHTML = `
      <div class="typing-dots">
        <span></span><span></span><span></span>
      </div>
      <span>Processing...</span>
    `;
    return el;
  }

  /**
   * Create an empty chat state element
   */
  static createEmptyState() {
    const el = document.createElement('div');
    el.className = 'chat-empty';
    el.innerHTML = `
      <div class="chat-empty-icon">&#9670;</div>
      <div>No messages yet. Start a conversation!</div>
    `;
    return el;
  }
}

export default MessageRenderer;
