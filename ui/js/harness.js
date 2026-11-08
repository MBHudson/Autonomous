/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

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
} from './harness.data.js?v=382';
import { store } from './store.js?v=382';
import { persistence } from './persistence.js?v=382';

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

/**
 * The API SHAPES an agent can be pinned to. 'auto' is not a shape: it means
 * "keep detecting", which is what every agent did before this existed.
 *
 * Shape and dialect are different questions. Shape is how the bytes are
 * framed (and which auth header carries the key); dialect is how the model is
 * taught to ask for a tool. Pinning one never changes the other.
 */
export const HARNESS_CHOICES = [
  {
    id: 'auto',
    label: 'Auto — detect it',
    hint: 'Picks the shape from the endpoint host, then the provider, then the model. Right for almost every agent.',
  },
  {
    id: 'openai',
    label: 'OpenAI-compatible',
    hint: 'chat/completions + Bearer: OpenRouter, OpenAI, Groq, NVIDIA NIM, DeepSeek, Together, Mistral, and every /v1 shim.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Messages',
    hint: 'x-api-key + anthropic-version, top-level system, max_tokens required. api.anthropic.com, or a proxy that mirrors it.',
  },
  {
    id: 'google',
    label: 'Google generateContent',
    hint: '?key= with contents/parts and a generationConfig. generativelanguage.googleapis.com or Vertex AI.',
  },
  {
    id: 'ollama',
    label: 'Ollama (native)',
    hint: "Ollama's own /api/chat on :11434. Its /v1 shim is OpenAI-compatible, not this.",
  },
];

const HARNESS_BY_ID = new Map(HARNESS_CHOICES.map(h => [h.id, h]));
/** Every id that names a real shape ('auto' excluded). */
const HARNESS_IDS = new Set(HARNESS_CHOICES.map(h => h.id).filter(id => id !== 'auto'));

/** Display label for a shape id; anything unknown reads as auto. */
export function harnessLabel(id) {
  return HARNESS_BY_ID.get(String(id || '').trim().toLowerCase())?.label
    || HARNESS_CHOICES[0].label;
}

/** The one-line description of a shape, for hints and tooltips. */
export function harnessHintFor(id) {
  return HARNESS_BY_ID.get(String(id || '').trim().toLowerCase())?.hint || '';
}

/**
 * The agent's pinned API shape, or '' when it should be detected.
 *
 * Stored as agent.harness. Unknown or stale values are treated as auto, so a
 * saved choice can never break a call.
 */
export function harnessOverride(agent) {
  const chosen = String(agent?.harness || '').trim().toLowerCase();
  return HARNESS_IDS.has(chosen) ? chosen : '';
}

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
  // 0. An explicit per-agent harness wins. The operator said which shape this
  //    endpoint speaks, and no host, provider or model heuristic may overrule
  //    that -- pinning one is the whole point.
  const forced = harnessOverride(spec);
  if (forced) return forced;

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

/**
 * Text out of a body that keeps its answer in an `output` list instead of one
 * of the vendor shapes, e.g. {output:[{type:'message', content:'…'}], stats:{…}}.
 *
 * Some local runners answer like this. Nothing recognised the shape, so the
 * reply fell through to the raw-body fallback and the whole JSON envelope was
 * shown in chat as the agent's message.
 *
 * @param {object} data   decoded body
 * @param {string[]} kinds block types to read; empty reads every block
 * @returns {string|null} the text, or null when there is no output list
 */
export function outputText(data, kinds = ['message', 'output_text', 'text']) {
  const blocks = data && Array.isArray(data.output) ? data.output : null;
  if (!blocks) return null;
  const pieces = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const type = String(block.type ?? 'message');
    if (kinds && kinds.length && !kinds.includes(type)) continue;
    let text = block.content ?? block.text ?? '';
    if (Array.isArray(text)) {
      // Inside one block the fragments are a single stream of text.
      text = text.map(part => {
        if (typeof part === 'string') return part;
        return part && typeof part.text === 'string' ? part.text : '';
      }).join('');
    }
    if (typeof text === 'string' && text !== '') pieces.push(text);
  }
  // Separate blocks are separate thoughts; keep the break the author wrote.
  return pieces.length ? pieces.join('\n\n') : null;
}

/** Token counts from that envelope's `stats` block, or null. */
export function outputUsage(data) {
  const s = data && data.stats && typeof data.stats === 'object' ? data.stats : null;
  if (!s) return null;
  const p = Number(s.input_tokens);
  const c = Number(s.total_output_tokens ?? s.output_tokens);
  if (!Number.isFinite(p) && !Number.isFinite(c)) return null;
  const prompt = Number.isFinite(p) ? p : 0;
  const completion = Number.isFinite(c) ? c : 0;
  return { prompt, completion, total: prompt + completion };
}
