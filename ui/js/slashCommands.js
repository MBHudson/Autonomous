/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// SLASHCOMMANDS.JS — "/" palette in the input box
// ============================================
//
// Typing "/" lists what you can type there: the app commands, and the agents
// you can address.
//
// The agent targets are not a new idea -- /CODE, /ROLE, /NAME and /ALL already
// route a message (see routing.js). They are here so one keystroke shows both
// kinds of thing, and so the palette never suggests a command that would
// shadow an agent you actually wanted to address.
//
// Commands are plain data in COMMANDS: adding one is a single entry.

import { store } from './store.js?v=350';
import { agentCode } from './utils.js?v=350';
import { share } from './memory.js?v=350';
import { matchesQuery, agentTokens } from './agentSearch.js?v=350';

/**
 * @typedef {object} Command
 * @property {string}   name       without the slash
 * @property {string}   hint       one line, shown in the list
 * @property {string}   [args]     placeholder for a required argument
 * @property {boolean}  [needsArg] true when it cannot run bare
 * @property {(ctx: {chat: object, args: string}) => void} run
 */

/** @type {Command[]} */
export const COMMANDS = [
  {
    name: 'help',
    hint: 'List every command you can type here',
    run: ({ chat }) => {
      const lines = COMMANDS.map(c => `/${c.name}${c.args ? ' ' + c.args : ''} — ${c.hint}`);
      chat._addMessage({
        role: 'agent', agentId: null, timestamp: Date.now(),
        content: 'Commands\n\n' + lines.join('\n')
          + '\n\nYou can also address an agent directly with /CODE, /ROLE, /NAME or /ALL.',
      });
    },
  },
  {
    name: 'agents',
    hint: 'List agents with their codes',
    run: ({ chat }) => {
      const agents = store.get('agents') || [];
      const body = agents
        .map(a => `${agentCode(a)}  ${a.name}${a.active ? '' : '  (inactive)'}`)
        .join('\n');
      // Into the transcript, not a toast: a list is not a notification, and
      // this way it survives a reload like everything else.
      chat._addMessage({
        role: 'agent', agentId: null, timestamp: Date.now(),
        content: 'Agents\n\n' + (body || 'No agents yet.'),
      });
    },
  },
  {
    name: 'ask',
    args: '<agent>',
    hint: 'Ask one agent a question on its own',
    needsArg: true,
    run: ({ chat, args }) => {
      const wanted = String(args || '').trim().toLowerCase();
      if (!wanted) return;
      const agents = store.get('agents') || [];
      const agent = agents.find(a => a.name.toLowerCase() === wanted)
        || agents.find(a => agentCode(a).toLowerCase() === wanted);
      if (!agent) {
        store.emit('toast', {
          message: `No agent called "${args}". Try /agents to see the list.`,
          type: 'error',
        });
        return;
      }
      // Only asked; what they say arrives in the transcript.
      store.emit('agent:ask', agent.id);
      chat._addMessage({
        role: 'user', content: `/ask ${args}`, timestamp: Date.now(),
      });
    },
  },
  {
    name: 'tell_agent',
    args: '<target> <message>',
    hint: 'Send an instruction to one agent, a role, or all agents',
    needsArg: true,
    run: ({ chat, args }) => {
      const text = String(args || '').trim();
      if (!text) return;
      // Split into target and message: "admin say hello" or "all hello"
      const parts = text.match(/^(\S+)\s+(.+)$/);
      if (!parts) {
        store.emit('toast', { message: 'Usage: /tell_agent <target> <message>', type: 'error' });
        return;
      }
      const target = parts[1].toLowerCase();
      const message = parts[2];
      const agents = store.get('agents') || [];
      let targets = [];
      if (target === 'all') {
        targets = agents.filter(a => a.active);
      } else {
        // Try exact name match first, then exact code match, then role
        const nameAgent = agents.find(a => a.active && a.name.toLowerCase() === target);
        if (nameAgent) {
          targets = [nameAgent];
        } else {
          const codeAgent = agents.find(a => a.active && String(agentCode(a)).toLowerCase() === target);
          if (codeAgent) {
            targets = [codeAgent];
          } else {
            const roleAgents = agents.filter(a => a.active && String(a.role || '').toLowerCase() === target);
            if (roleAgents.length) targets = roleAgents;
          }
        }
      }
      if (!targets.length) {
        store.emit('toast', { message: `No active agents match "${parts[1]}"`, type: 'error' });
        return;
      }
      for (const agent of targets) {
        store.emit('agent:tell', { agentId: agent.id, from: 'user', message });
      }
      // Echo to transcript
      chat._addMessage({
        role: 'user', content: `/tell_agent ${text}`, timestamp: Date.now(),
      });
    },
  },
  {
    name: 'shared_mem',
    args: '<text>',
    hint: 'Save to the shared memory every agent reads',
    needsArg: true,
    run: ({ chat, args }) => {
      const text = String(args || '').trim();
      if (!text) return;
      // The collective pool: readable by every agent on its next turn, kept
      // out of any one agent's private notes, synced to other devices by the
      // memory hook. agentId is unused for collective entries.
      const entry = share(null, text);
      chat._addMessage({
        role: 'agent', agentId: null, timestamp: Date.now(),
        content: entry
          ? `Saved to shared memory:\n\n${entry.text}`
          : 'Shared memory is full and nothing could be trimmed — delete a collective note in an agent editor first.',
      });
    },
  },
  {
    name: 'ping',
    args: '<target>',
    hint: 'Wake up agent(s) and prompt them to read their mailbox',
    needsArg: true,
    run: async ({ chat, args }) => {
      const text = String(args || '').trim();
      if (!text) return;
      const parts = text.match(/^(\S+)\s*(.*)$/);
      if (!parts) {
        store.emit('toast', { message: 'Usage: /ping <target>', type: 'error' });
        return;
      }
      const target = parts[1].toLowerCase();
      const agents = store.get('agents') || [];
      let targets = [];
      if (target === 'all') {
        targets = agents.filter(a => a.active);
      } else {
        const nameAgent = agents.find(a => a.active && a.name.toLowerCase() === target);
        if (nameAgent) targets = [nameAgent];
        else {
          const codeAgent = agents.find(a => a.active && String(agentCode(a)).toLowerCase() === target);
          if (codeAgent) targets = [codeAgent];
          else {
            const roleAgents = agents.filter(a => a.active && String(a.role || '').toLowerCase() === target);
            if (roleAgents.length) targets = roleAgents;
          }
        }
      }
      if (!targets.length) {
        store.emit('toast', { message: `No active agents match "${parts[1]}"`, type: 'error' });
        return;
      }

      // Deduplicate targets by agent ID (name/code/role overlap)
      const uniqueTargets = Array.from(new Map(targets.map(a => [a.id, a])).values());

      // Prevent accidental double-execution (rapid Enter, etc.)
      const cmdKey = `ping:${target}:${Date.now()}`;
      if (window.__pingGuard === cmdKey) return;
      window.__pingGuard = cmdKey;
      setTimeout(() => { window.__pingGuard = null; }, 1000);

      // Add a ping message to each target's mailbox
      for (const agent of uniqueTargets) {
        store.emit('agent:ping', { agentId: agent.id, from: 'user' });
      }
      // Invoke each target ONCE to read their mailbox
      for (const agent of uniqueTargets) {
        try {
          await chat.askAgentDirectly(agent.id, 'Check your mailbox (read_mailbox) for new instructions and respond once.');
        } catch (err) {
          store.emit('toast', { message: `Failed to ping ${agent.name}: ${err.message}`, type: 'error' });
        }
      }
      chat._addMessage({
        role: 'user', content: `/ping ${text}`, timestamp: Date.now(),
      });
    },
  },
  {
    name: 'alwayson',
    hint: 'Switch the always-on agents on or off',
    run: () => {
      const next = !(store.get('settings.alwaysOn'));
      store.set('settings.alwaysOn', next);
      store.emit('settings:changed');
      store.emit('toast', {
        message: next ? 'Always-on agents switched on' : 'Always-on agents switched off',
        type: 'success',
      });
    },
  },
  {
    name: 'clear',
    hint: 'Clear this screen (the session is kept)',
    run: ({ chat }) => chat.clearScreen(),
  },
  {
    name: 'stop',
    hint: 'Stop what the agents are doing now',
    run: ({ chat }) => {
      if (chat.aborter) { chat.stop(); store.emit('toast', { message: 'Stopped', type: 'info' }); }
      else store.emit('toast', { message: 'Nothing is running', type: 'info' });
    },
  },
  {
    name: 'usage',
    hint: 'Open the usage metrics',
    run: () => store.emit('metrics:showUsage'),
  },
  {
    name: 'export',
    hint: 'Export this session',
    run: () => store.emit('export:open'),
  },
  {
    name: 'settings',
    hint: 'Open the configuration modal',
    run: () => document.getElementById('configBtn')?.click(),
  },
];

export class SlashCommands {
  /**
   * @param {HTMLElement} inputField the message textarea
   * @param {object} chat            used by commands that act on the conversation
   */
  constructor(inputField, chat) {
    this.input = inputField;
    this.chat = chat;
    this.panel = null;
    this.items = [];
    this.index = 0;
    this.open = false;
  }

  init() {
    if (!this.input) return;
    this._inputId = this.input.id || '';
    this._bindInput(this.input);
  }

  /**
   * Bind to one textarea, and make sure only one palette is bound to it.
   *
   * Two instances on the same box (an init that ran twice) each append their own
   * panel to the composer, so which one the operator saw depended on append
   * order while the other sat on top of it, stale. The newest instance wins and
   * the older one is disposed.
   */
  _bindInput(input) {
    if (!input || this._bound === input) return;
    if (this._bound) this.dispose();          // rebinding: drop the old listeners
    const previous = input.__slashCommands;
    if (previous && previous !== this) { try { previous.dispose(); } catch { /* already gone */ } }
    input.__slashCommands = this;
    this._bound = input;
    this._onInputBound = () => this._onInput();
    // Capture phase: the palette has to see keys before the send handler turns
    // Enter into a message.
    this._onKeyBound = (e) => this._onKeyDown(e);
    this._onBlurBound = () => setTimeout(() => this.close(), 120);
    input.addEventListener('input', this._onInputBound);
    input.addEventListener('keydown', this._onKeyBound, true);
    input.addEventListener('blur', this._onBlurBound);
    if (!this._docBound) {
      this._docBound = (e) => {
        if (this.open && this.panel && !this.panel.contains(e.target)) this.close();
      };
      document.addEventListener('click', this._docBound);
    }
  }

  /** Unbind and drop the panel. Used when another instance takes over the box. */
  dispose() {
    const input = this._bound;
    if (input) {
      if (this._onInputBound) input.removeEventListener('input', this._onInputBound);
      if (this._onKeyBound) input.removeEventListener('keydown', this._onKeyBound, true);
      if (this._onBlurBound) input.removeEventListener('blur', this._onBlurBound);
      if (input.__slashCommands === this) delete input.__slashCommands;
    }
    if (this._docBound) document.removeEventListener('click', this._docBound);
    this._docBound = null;
    this._bound = null;
    if (this.panel) { this.panel.remove(); this.panel = null; }
    this.open = false;
    this.items = [];
  }

  // --- what is being typed ---

  /**
   * The box this palette belongs to.
   *
   * The composer is looked up again when the original node has left the
   * document: a rebuilt chat area left `this.input` pointing at a detached
   * textarea, so the palette kept rendering into a panel nobody could see.
   */
  _liveInput() {
    if (this._bound && this._bound.isConnected) return this._bound;
    const found = this._inputId ? document.getElementById(this._inputId) : null;
    if (found) { this._bindInput(found); return found; }
    return this._bound || this.input || null;
  }

  /** The fragment after the slash, or null when this is not a slash line. */
  query() {
    const input = this._liveInput();
    const value = input ? input.value : '';
    const m = /^\s*\/([a-z0-9_@#-]*)$/i.exec(value);
    return m ? m[1] : null;
  }

  /**
   * Everything that could follow the slash: commands, /ALL, one entry per
   * agent code and name, and one per distinct role.
   */
  suggestions(query) {
    const q = String(query || '').toLowerCase();
    // The rule itself lives in agentSearch.js: a fragment matches the start of
    // the code (with or without its "#"), the name, or any word inside the name.
    const hits = (tokens) => matchesQuery(tokens, q);

    const out = [];
    for (const c of COMMANDS) {
      if (hits([c.name])) {
        out.push({
          type: 'command', cmd: c, insert: `/${c.name} `,
          label: `/${c.name}`, hint: c.hint, needsArg: !!c.needsArg,
        });
      }
    }
    // Commands first, then who you can talk to. A bare "/" shows both.
    if (hits(['all'])) {
      out.push({ type: 'all', insert: '/ALL ', label: '/ALL', hint: 'Every active agent', needsArg: true });
    }
    const agents = (store.get('agents') || []).filter(a => a && a.active);
    for (const a of agents) {
      const code = String(agentCode(a) || '');
      if (matchesQuery(agentTokens(a, code), q)) {
        out.push({
          type: 'agent', agent: a, insert: `/${code} `,
          label: `/${code}`, hint: `${a.name} — only this agent answers`, needsArg: true,
        });
      }
    }
    const roles = [...new Set(agents.map(a => String(a.role || '').trim()).filter(Boolean))];
    for (const role of roles) {
      if (hits([role])) {
        out.push({
          type: 'role', role, insert: `/${role} `,
          label: `/${role}`, hint: 'Every agent with that role', needsArg: true,
        });
      }
    }
    return out;
  }

  _onInput() {
    const q = this.query();
    if (q === null) { this.close(); return; }
    this.items = this.suggestions(q);
    this.index = 0;
    if (!this.items.length) { this.close(); return; }
    this._render(q);
  }

  // --- the list ---

  _render(query) {
    const input = this._liveInput();
    // Rebuild a panel that is no longer in the document: the composer area can
    // be replaced, and appending to the detached node is what made the palette
    // stop appearing at all with no error anywhere.
    if (!this.panel || !this.panel.isConnected) {
      const wrap = (input && (input.closest('.chat-input-area') || input.parentElement)) || document.body;
      this.panel = document.createElement('div');
      this.panel.className = 'slash-commands';
      wrap.appendChild(this.panel);
    }
    const head = `<div class="slash-commands-head">Commands &amp; agents — ↑↓ to move, Tab to fill, Enter to run</div>`;
    this.panel.innerHTML = head + this.items.map((it, i) => `
      <div class="slash-command ${i === this.index ? 'selected' : ''}" data-slash="${i}">
        <span class="slash-command-name">${escCmd(it.label)}</span>
        <span class="slash-command-hint">${escCmd(it.hint)}</span>
      </div>`).join('');

    this.panel.querySelectorAll('[data-slash]').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        // mousedown, not click: the blur that follows would close the panel
        // before a click could land on it.
        e.preventDefault();
        this.index = Number(el.dataset.slash);
        this._complete({ run: false });
      });
    });
    this.panel.classList.add('open');
    this.open = true;
  }

  close() {
    if (this.panel) this.panel.classList.remove('open');
    this.open = false;
    this.items = [];
  }

  // --- keyboard ---

  _onKeyDown(e) {
    const q = this.query();
    // A bare command runs on Enter even when the list is closed, so
    // "/clear" + Enter always works whether or not the palette opened.
    if (e.key === 'Enter' && !e.shiftKey && !this.open && q) {
      if (this.runCommand(q, '')) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (!this.open) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.index = (this.index + 1) % this.items.length;
      this._render(q || '');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.index = (this.index - 1 + this.items.length) % this.items.length;
      this._render(q || '');
    } else if (e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation();
      this._complete({ run: false });
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); e.stopPropagation();
      this._complete({ run: true });
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      this.close();
    }
  }

  /**
   * Fill the box with the highlighted entry.
   * @param {{run: boolean}} opts run it when it takes nothing more
   */
  _complete({ run }) {
    const item = this.items[this.index];
    if (!item) { this.close(); return; }
    const input = this._liveInput();

    // Enter on something that needs a message fills it in instead of running,
    // so "/#YLAUX4 what broke" works from the palette.
    if (item.needsArg) {
      if (input) { input.value = item.insert; input.focus(); }
      this.close();
      return;
    }
    if (run && item.type === 'command') {
      if (input) input.value = '';
      this.close();
      this.runCommand(item.cmd.name, '');
      return;
    }
    if (input) { input.value = item.insert; input.focus(); }
    this.close();
  }

  /**
   * Run a command by name.
   * @returns {boolean} true when it ran (or deliberately refused), so the
   *          caller knows not to send it as a message.
   */
  runCommand(name, args) {
    const cmd = COMMANDS.find(c => c.name === String(name || '').toLowerCase());
    if (!cmd) return false;
    if (cmd.needsArg && !String(args || '').trim()) {
      // /ask with nothing after it: leave the box ready rather than erroring.
      const input = this._liveInput();
      if (input) { input.value = `/${cmd.name} `; input.focus(); }
      store.emit('toast', { message: `/${cmd.name} needs ${cmd.args || 'a value'}`, type: 'error' });
      return true;
    }
    cmd.run({ chat: this.chat, args });
    return true;
  }

  /** True when this line is a command we own, so sendMessage can skip it. */
  static parse(text) {
    const m = /^\s*\/([a-z0-9_-]+)\s*([\s\S]*)$/i.exec(String(text || ''));
    if (!m) return null;
    return { name: m[1].toLowerCase(), args: m[2] };
  }
}

function escCmd(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default SlashCommands;