/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// NATIVE TOOLS — provider tool schemas + stream-call parsing
// ============================================
//
// The prompt protocol in tools.js teaches a model to print JSON/XML. That is
// portable, but it is also a second syntax the model has to remember, and it
// only carries one call per step. This module supplies the same registry as
// native tool definitions and reads the tool-call frames the providers stream
// back.
//
// No dependencies and no provider SDKs: the shapes below are the published
// OpenAI, Anthropic and Google JSON shapes.

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const bool = (description, extra = {}) => ({ type: 'boolean', description, ...extra });
const arr = (description, items = { type: 'string' }) => ({ type: 'array', description, items });
const obj = (properties = {}, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const anyObj = description => ({ type: 'object', description, additionalProperties: true });
const oneOf = (values, description) => ({ type: 'string', enum: values, description });

const TODO_SCHEMA = obj({
  content: str('What needs to be done'),
  status: oneOf(['pending', 'in_progress', 'completed'], 'Current status'),
}, ['content', 'status']);

const EDIT_SCHEMA = obj({
  path: str('File path'),
  old_string: str('Exact text to replace'),
  new_string: str('Replacement text'),
  replace_all: bool('Replace every match instead of requiring exactly one'),
}, ['path', 'old_string', 'new_string']);

/** JSON Schema for every built-in tool. Unknown/custom tools get a permissive object. */
export const TOOL_SCHEMAS = {
  now: obj(),
  echo: obj({ text: str('Text to repeat') }, ['text']),
  read_note: obj({ name: str('Note name') }, ['name']),
  write_note: obj({
    text: str('Text to append'),
    name: str('Note name (defaults to notes)'),
  }, ['text']),
  remember: obj({ fact: str('Fact to remember') }, ['fact']),
  share: obj({ fact: str('Fact to share with every agent') }, ['fact']),
  recall: obj(),
  adopt: obj({ id: str('Collective note id') }, ['id']),
  list_agents: obj(),
  ask_agent: obj({
    name: str('Agent name, or "ALL" for every other agent'),
    question: str('Question to ask'),
  }, ['name', 'question']),
  tell_agent: obj({
    name: str('Agent name, or "ALL" for every other agent'),
    message: str('Instruction to deliver'),
  }, ['name', 'message']),
  read_mailbox: obj(),
  exec: obj({
    argv: arr('Command and arguments, one array entry per argument'),
    timeout: num('Seconds before the command is killed (default 60, max 600)'),
    max_bytes: num('Cap on output kept per stream'),
  }, ['argv']),
  exec_start: obj({
    argv: arr('Command and arguments, one array entry per argument'),
    timeout: num('Seconds before an overrun is killed on poll (default 60, max 600)'),
    max_bytes: num('Cap on output kept per stream'),
  }, ['argv']),
  exec_poll: obj({ handle: str('Handle returned by exec_start') }, ['handle']),
  exec_kill: obj({ handle: str('Handle returned by exec_start') }, ['handle']),
  web_search: obj({ query: str('Search query') }, ['query']),
  fetch_url: obj({ url: str('Page URL') }, ['url']),
  read_file: obj({
    path: str('Path, optionally "path 20-80" for a line range'),
    range: str('Optional line range, e.g. "1-1" (same as appending it to path)'),
  }, ['path']),
  list_dir: obj({ path: str('Directory (omit for the sandbox root)') }),
  glob_files: obj({ pattern: str('Glob pattern, e.g. ui/js/**/*.js') }, ['pattern']),
  grep_code: obj({ pattern: str('Regular expression') }, ['pattern']),
  write_file: obj({
    path: str('File path'),
    content: str('Full file content'),
    mode: oneOf(['write', 'append'], 'Write or append (defaults to write)'),
  }, ['path', 'content']),
  str_replace_editor: obj({
    command: oneOf(['view', 'create', 'str_replace', 'insert'], 'Editor command'),
    path: str('File path'),
    old_str: str('Exact text to replace (str_replace)'),
    new_str: str('Replacement text, or text to insert'),
    file_text: str('File content (create)'),
    insert_line: num('Insert after this line number (insert)'),
    view_range: arr('Start and end line (view)', { type: 'number' }),
    replace_all: bool('Replace every match'),
  }, ['command', 'path']),
  edit_file: EDIT_SCHEMA,
  apply_patch: obj({ patch: str('Codex/GPT V4A patch text') }, ['patch']),
  git: obj({ args: arr('Git arguments, e.g. ["status"]') }, ['args']),
  http_request: obj({
    method: oneOf(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], 'HTTP method'),
    url: str('Request URL'),
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    body: str('Request body'),
  }, ['url']),
  multi_edit: obj({ edits: arr('All edits, applied atomically', EDIT_SCHEMA) }, ['edits']),
  git_commit: obj({
    message: str('Commit message'),
    paths: arr('Paths to stage (omit for everything)'),
  }, ['message']),
  run_code: obj({
    language: oneOf(['python', 'node', 'bash'], 'Interpreter'),
    code: str('Code to run'),
  }, ['code']),
  todo_write: obj({ todos: arr('The complete task list', TODO_SCHEMA) }, ['todos']),
  think: obj({ thought: str('Private reasoning') }, ['thought']),
  mcp_list: obj({ server: str('MCP server name (omit to list servers)') }),
  mcp_call: obj({
    server: str('MCP server name'),
    tool: str('Tool name'),
    arguments: anyObj('Arguments for that tool'),
  }, ['server', 'tool']),
  browser_open: obj({ url: str('URL to open, e.g. https://example.com') }, ['url']),
  browser_click: obj({
    selector: str('CSS selector to click (if not using x/y)'),
    x: num('Viewport x to click'),
    y: num('Viewport y to click'),
  }),
  browser_type: obj({
    text: str('Text to type into the focused field'),
    selector: str('CSS selector to focus first (optional)'),
    enter: bool('Press Enter after typing'),
  }, ['text']),
  browser_read: obj(),
  browser_wait: obj({ ms: num('Milliseconds to wait for the page to settle') }),
  declare_goal_complete: obj({ summary: str('What was finished') }, ['summary']),
  show_file: obj({
    path: str('File to show the operator'),
    range: str('Line range, e.g. "1-200" (optional)'),
  }, ['path']),
  show_command: obj({
    argv: arr('Command and arguments, one array entry per argument'),
    timeout: num('Seconds before the command is killed (default 60, max 600)'),
  }, ['argv']),
  show_find: obj({
    query: str('Text or file name to find'),
  }, ['query']),
  show_url: obj({ url: str('Page URL') }, ['url']),
};

/** API families whose native tool interface this client can drive. */
export const NATIVE_FAMILIES = new Set(['openai', 'anthropic', 'google']);

const CUSTOM_SCHEMA = { type: 'object', properties: {}, additionalProperties: true };

/**
 * Schema keys Gemini's `parameters` proto has no field for.
 *
 * `functionDeclarations[].parameters` is a bare OpenAPI 3.0 subset, not JSON
 * Schema: an unknown key is a parse error, and the error fails the whole
 * request rather than the one declaration. `additionalProperties` is the one
 * that matters, because every schema above is built with it; the rest are the
 * same class of problem.
 */
const GOOGLE_UNSUPPORTED = new Set([
  'additionalProperties', '$schema', '$ref', '$defs', 'definitions',
  'patternProperties', 'propertyNames', 'title', 'default', 'examples',
]);

/** Recursively drop the keywords Gemini rejects, keeping the schema's shape. */
function googleSchema(schema) {
  if (Array.isArray(schema)) return schema.map(googleSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (GOOGLE_UNSUPPORTED.has(key)) continue;
    out[key] = googleSchema(value);
  }
  return out;
}

/**
 * Build the provider-specific tool definitions for an enabled tool list.
 * @param {Array<{name:string,description?:string}>} defs
 * @param {'openai'|'anthropic'|'google'} family
 */
export function nativeToolDefs(defs, family) {
  const list = (Array.isArray(defs) ? defs : [])
    .filter(d => d && d.name)
    .map(d => ({
      name: d.name,
      description: d.description || d.name,
      parameters: TOOL_SCHEMAS[d.name] || CUSTOM_SCHEMA,
    }));
  if (!list.length) return [];
  if (family === 'anthropic') {
    return list.map(d => ({
      name: d.name, description: d.description, input_schema: d.parameters,
    }));
  }
  if (family === 'google') {
    return [{ functionDeclarations: list.map(d => {
      const parameters = googleSchema(d.parameters);
      const props = parameters && parameters.properties ? Object.keys(parameters.properties) : [];
      // Gemini's docs say to leave `parameters` unset when a function takes
      // none; an empty properties object is the shape it is least happy with.
      return props.length
        ? { name: d.name, description: d.description, parameters }
        : { name: d.name, description: d.description };
    }) }];
  }
  return list.map(d => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));
}

/** Provider-specific "choose automatically" value, or null when set separately. */
export function nativeToolChoice(family) {
  if (family === 'anthropic') return { type: 'auto' };
  if (family === 'google') return null;
  return 'auto';
}

/** Tools whose native arguments are a single scalar rather than an object. */
const SCALAR_ARGS = {
  echo: 'text',
  read_note: 'name',
  write_note: 'text',
  remember: 'fact',
  share: 'fact',
  adopt: 'id',
  web_search: 'query',
  fetch_url: 'url',
  list_dir: 'path',
  glob_files: 'pattern',
  grep_code: 'pattern',
  think: 'thought',
  exec_poll: 'handle',
  exec_kill: 'handle',
  show_url: 'url',
  show_find: 'query',
};

/**
 * Convert a native call's argument object to the shape runTool expects.
 * Sandbox/editor tools already take objects; the small tools historically took
 * a bare string, so unwrap those here instead of changing every implementation.
 */
export function nativeToolArgs(name, args) {
  let a = args;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { a = { arg: a }; }
  }
  a = (a && typeof a === 'object' && !Array.isArray(a)) ? a : {};
  if (name === 'declare_goal_complete') {
    return { arg: undefined, note: String(a.summary ?? '') };
  }
  // read_file is the one scalar tool whose range is a second field. Native
  // models commonly send {path, range}; unwrapping only path silently read the
  // whole file, so the ranged drill step could never pass.
  if (name === 'read_file') {
    const path = a.path ?? a.file_path ?? a.filepath ?? a.arg;
    if (path === undefined) return { arg: a };
    const out = { path };
    if (a.range !== undefined && a.range !== null && a.range !== '') out.range = String(a.range);
    if (a.offset !== undefined) out.offset = a.offset;
    if (a.limit !== undefined) out.limit = a.limit;
    return { arg: Object.keys(out).length === 1 ? path : out };
  }
  const key = SCALAR_ARGS[name];
  if (key) {
    return {
      arg: a[key] !== undefined ? a[key] : a.arg,
      note: name === 'write_note' ? a.name : undefined,
    };
  }
  return { arg: a };
}

/** Accumulator for one streamed response. */
export function createNativeCallState() {
  return { calls: new Map(), seq: 0 };
}

function slot(state, key, seed = {}) {
  let call = state.calls.get(key);
  if (!call) {
    call = {
      id: seed.id || key,
      name: seed.name || '',
      argsText: '',
      initial: seed.initial,
    };
    state.calls.set(key, call);
  }
  if (seed.id) call.id = seed.id;
  if (seed.name) call.name = seed.name;
  if (seed.initial && typeof seed.initial === 'object') call.initial = seed.initial;
  return call;
}

/**
 * Feed one decoded SSE frame into the accumulator.
 *
 * Covers OpenAI/OpenRouter (delta.tool_calls and the legacy function_call),
 * Anthropic (tool_use blocks + input_json_delta), Google (functionCall parts)
 * and Ollama (message.tool_calls). Unknown frames are ignored.
 */
export function ingestNativeDelta(state, obj, family) {
  if (!state || !obj || typeof obj !== 'object') return;

  // OpenAI-compatible, including OpenRouter and most local shims.
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  const delta = choice && choice.delta;
  if (delta) {
    const parts = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const idx = Number.isFinite(part.index) ? part.index : 0;
      const fn = part.function || {};
      const call = slot(state, `o${idx}`, { id: part.id, name: fn.name });
      if (typeof fn.arguments === 'string') call.argsText += fn.arguments;
      else if (fn.arguments && typeof fn.arguments === 'object') call.initial = fn.arguments;
    }
    // Legacy OpenAI function_call (one call, no id).
    const legacy = delta.function_call;
    if (legacy && typeof legacy === 'object') {
      const call = slot(state, 'o0', { name: legacy.name });
      if (typeof legacy.arguments === 'string') call.argsText += legacy.arguments;
      else if (legacy.arguments && typeof legacy.arguments === 'object') call.initial = legacy.arguments;
    }
  }
  // Some relays put the whole call on a non-delta message frame.
  const msg = choice && choice.message;
  if (msg && Array.isArray(msg.tool_calls)) {
    msg.tool_calls.forEach((part, i) => {
      if (!part || typeof part !== 'object') return;
      const fn = part.function || {};
      const call = slot(state, `o${Number.isFinite(part.index) ? part.index : i}`,
        { id: part.id, name: fn.name });
      if (typeof fn.arguments === 'string') call.argsText += fn.arguments;
      else if (fn.arguments && typeof fn.arguments === 'object') call.initial = fn.arguments;
    });
  }

  // Anthropic Messages.
  if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
    const block = obj.content_block;
    const call = slot(state, `a${obj.index ?? 0}`, {
      id: block.id, name: block.name,
      initial: (block.input && typeof block.input === 'object') ? block.input : undefined,
    });
    if (block.name) call.name = block.name;
  }
  if (obj.type === 'content_block_delta' && obj.delta?.type === 'input_json_delta') {
    const call = slot(state, `a${obj.index ?? 0}`);
    if (typeof obj.delta.partial_json === 'string') call.argsText += obj.delta.partial_json;
  }

  // Google streamGenerateContent.
  const candidate = Array.isArray(obj.candidates) ? obj.candidates[0] : null;
  const gparts = candidate?.content?.parts;
  if (Array.isArray(gparts)) {
    for (const part of gparts) {
      const fc = part && part.functionCall;
      if (!fc || !fc.name) continue;
      const id = fc.id || `g${state.seq++}`;
      const call = slot(state, `g${id}`, { id, name: fc.name });
      if (fc.args && typeof fc.args === 'object') call.initial = fc.args;
      else if (typeof fc.args === 'string') call.argsText += fc.args;
    }
  }

  // Ollama native chat.
  const otc = obj.message?.tool_calls;
  if (Array.isArray(otc)) {
    otc.forEach((part, i) => {
      const fn = part?.function || {};
      if (!fn.name) return;
      const call = slot(state, `l${i}`, { id: part.id || `l${i}`, name: fn.name });
      if (typeof fn.arguments === 'string') call.argsText += fn.arguments;
      else if (fn.arguments && typeof fn.arguments === 'object') call.initial = fn.arguments;
    });
  }
}

/** Finish the accumulator: parse argument JSON and return call objects. */
export function nativeCalls(state) {
  if (!state || !state.calls) return [];
  const out = [];
  for (const call of state.calls.values()) {
    if (!call.name) continue;
    let args = call.initial;
    if (String(call.argsText || '').trim()) {
      try { args = JSON.parse(call.argsText); } catch { args = call.argsText; }
    }
    out.push({ id: call.id || call.name, name: call.name, arguments: args ?? {} });
  }
  return out;
}
