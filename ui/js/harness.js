// ============================================
// HARNESS.JS — one registry: which API each provider speaks, and which
// tool-call dialect each model answers best
// ============================================
//
// Providers are not one API with different URLs. Two things vary:
//
//   1. The REQUEST/RESPONSE shape ("family"), decided by the endpoint and the
//      provider id — not by the model. On OpenRouter a Claude model is still
//      called through the OpenAI-compatible endpoint; only the tool dialect
//      below differs.
//   2. The TOOL-CALL dialect the model emits, decided by provider + model id.
//
// The DATA (aliases, host matchers, tool patterns, context windows, default
// RPM) is GENERATED from src/Harness.php into harness.data.js — edit the PHP
// and run `php tools/gen-harness.php`. Only the logic lives here.

import {
  API_FAMILIES,
  PROVIDER_ALIASES,
  HOST_MATCHERS,
  TOOL_PATTERNS,
  CONTEXT_LIMITS,
  DEFAULT_RPM,
} from './harness.data.js?v=310';
import { store } from './store.js?v=310';
import { persistence } from './persistence.js?v=310';

export { API_FAMILIES };

export const TOOL_PROTOCOLS = [
  {
    id: 'auto',
    label: 'Auto (provider default)',
    hint: 'Picks the dialect from the provider and model name.',
  },
  {
    id: 'json',
    label: 'JSON object',
    hint: 'Best for OpenAI-compatible APIs: OpenAI, OpenRouter, NVIDIA, Groq, DeepSeek, LM Studio, Gemini.',
  },
  {
    id: 'anthropic',
    label: 'Claude XML',
    hint: 'Best for Claude and GLM-style models: <function_calls><invoke><parameter>.',
  },
  {
    id: 'native',
    label: 'Native tags',
    hint: 'Best for Qwen, Hermes, and local templates: <|tool_call|>{"tool":…}<|/tool_call|>.',
  },
  {
    id: 'plain',
    label: 'Plain JSON only',
    hint: 'Strictest form, no wrapper or fence. Good for small local models that copy prose into the reply.',
  },
];

const BY_ID = new Map(TOOL_PROTOCOLS.map(p => [p.id, p]));
const PROTOCOL_RE = TOOL_PATTERNS.map(([re, protocol]) => [new RegExp(re, 'i'), protocol]);

function hostOf(endpoint) {
  try { return new URL(String(endpoint || ''), 'http://placeholder').host.toLowerCase(); }
  catch { return ''; }
}
function pathOf(endpoint) {
  try { return new URL(String(endpoint || ''), 'http://placeholder').pathname.toLowerCase(); }
  catch { return ''; }
}
function isOllamaPath(path) {
  if (!path || path.includes('/v1')) return false;
  return /\/api\/(chat|generate|tags|embed)/.test(path);
}

/**
 * Which API family does this spec speak? Endpoint host wins, then provider id,
 * then (only for agents whose shape is implied by the model) the model name.
 * @param {{provider?:string,endpoint?:string,model?:string}} spec
 * @returns {'openai'|'anthropic'|'google'|'ollama'}
 */
export function detectFamily(spec = {}) {
  const endpoint = String(spec.endpoint || '');
  const provider = String(spec.provider || '').trim().toLowerCase();
  const model = String(spec.model || '').trim().toLowerCase();
  const host = hostOf(endpoint);
  const path = pathOf(endpoint);

  // 1. Endpoint host — where the bytes actually go.
  if (host) {
    for (const [needle, family] of HOST_MATCHERS) {
      if (host.includes(needle)) return family;
    }
  }
  // Ollama native API, and the /v1 shim which must stay OpenAI-shaped.
  if (isOllamaPath(path)) return 'ollama';
  if (endpoint.includes(':11434') && !path.includes('/v1')) return 'ollama';
  // An explicit OpenAI chat/completions (or Responses) path is the OpenAI
  // shape whatever the provider is called.
  if (/\/chat\/completions$/.test(path) || /\/completions$/.test(path) || path.includes('/responses')) {
    return 'openai';
  }

  // 2. Provider id.
  if (PROVIDER_ALIASES[provider]) return PROVIDER_ALIASES[provider];

  // 3. Model id, only when nothing above committed.
  if (!provider || provider === 'auto' || provider === 'custom') {
    if (/(^|[/_:])claude/.test(model)) return 'anthropic';
    if (/gemini|gemma/.test(model)) return 'google';
  }

  return 'openai';
}

/**
 * The full descriptor for a spec: family id + its capabilities + the tool
 * dialect the model should be taught.
 */
export function harnessFor(spec = {}) {
  const id = detectFamily(spec);
  const family = API_FAMILIES[id] || API_FAMILIES.openai;
  const toolProtocol = autoProtocol(spec.provider, spec.model, id);
  return { ...family, id, toolProtocol };
}

export function protocolLabel(id) {
  return BY_ID.get(String(id || '').toLowerCase())?.label || 'JSON object';
}

export function protocolHint(id) {
  return BY_ID.get(String(id || '').toLowerCase())?.hint || '';
}

function providerId(provider) {
  return String(provider || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * Automatic tool-dialect mapping. Order matters: a model name is more specific
 * than the provider, and OpenRouter fronts all of them under one provider id.
 *
 * @param {string} provider
 * @param {string} model
 * @param {string} [familyId] the detected API family id (optional)
 */
export function autoProtocol(provider, model, familyId) {
  const p = providerId(provider);
  const m = String(model || '').trim().toLowerCase();
  const fam = familyId || detectFamily({ provider, model });

  // The API family already implies the dialect for Claude.
  if (fam === 'anthropic' || p === 'anthropic') return 'anthropic';

  // Model-name rules from the generated table (Claude, Qwen/GLM/Hermes/…).
  for (const [re, protocol] of PROTOCOL_RE) {
    if (re.test(m)) return protocol;
  }

  return 'json';
}

/**
 * The dialect this agent should be taught. An explicit choice wins; otherwise
 * fall back to the provider/model mapping. Unknown ids are treated as auto so
 * a stale saved value can never break a call.
 */
export function toolProtocolFor(agent, provider) {
  const chosen = String(agent?.toolProtocol || '').trim().toLowerCase();
  if (chosen && chosen !== 'auto' && BY_ID.has(chosen)) return chosen;
  // Learned dialect: a choice that actually worked on a previous turn for this
  // exact provider::model wins over the heuristic. Feature-gated, and skipped
  // when the operator has pinned one above.
  const memo = learnedDialect(provider || agent?.provider, agent?.model);
  if (memo && BY_ID.has(memo)) return memo;
  return autoProtocol(provider || agent?.provider, agent?.model,
    detectFamily({ provider: provider || agent?.provider, endpoint: agent?.endpoint, model: agent?.model }));
}

// --- Learned tool dialect (Config → Labs → "Remember the working dialect") ---

function dialectMemoEnabled() {
  return (store.get('settings') || {}).toolDialectMemo !== false;
}

function dialectMemoKey(provider, model) {
  const p = String(provider || '').trim().toLowerCase();
  const m = String(model || '').trim().toLowerCase();
  return (p || m) ? `${p}::${m}` : '';
}

/** The remembered dialect for this provider+model, or '' if none applies. */
export function learnedDialect(provider, model) {
  if (!dialectMemoEnabled()) return '';
  const key = dialectMemoKey(provider, model);
  if (!key) return '';
  const map = (store.get('settings') || {}).toolDialectMap || {};
  return map[key] || '';
}

/** Remember that `dialect` parsed successfully for this provider+model. */
export function rememberDialect(provider, model, dialect) {
  if (!dialectMemoEnabled()) return;
  const d = String(dialect || '').trim().toLowerCase();
  if (!BY_ID.has(d)) return;
  const key = dialectMemoKey(provider, model);
  if (!key) return;
  const settings = store.get('settings') || {};
  const map = { ...(settings.toolDialectMap || {}) };
  if (map[key] === d) return;
  map[key] = d;
  store.set('settings.toolDialectMap', map);
  try { persistence.set('settings', store.get('settings')); } catch { /* best effort */ }
}

/** Known context window for a model id, or null. */
export function contextLimitFor(model) {
  const m = String(model || '').toLowerCase();
  for (const [sub, limit] of CONTEXT_LIMITS) {
    if (m.includes(sub)) return limit;
  }
  return null;
}

/**
 * The free-tier requests/minute for an endpoint host, or 20 when unknown.
 * 0 means "no pacing" (a local runner). Used by the rate governor only when
 * the operator has not set an explicit global limit.
 */
export function defaultRpmFor(endpoint) {
  const host = hostOf(endpoint);
  for (const [needle, rpm] of DEFAULT_RPM) {
    if (needle && host.includes(String(needle).toLowerCase())) return Number(rpm) || 0;
  }
  return 20;
}

/** A one-line "what did we detect" string for hints and diagnostics. */
export function describeHarness(spec = {}) {
  const h = harnessFor(spec);
  return `${h.label} · ${protocolLabel(h.toolProtocol).replace(/ \(.*\)$/, '')}`;
}
