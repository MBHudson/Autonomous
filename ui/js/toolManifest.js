// ============================================
// TOOL-MANIFEST.JS — environment + dialect aware tool instructions
// ============================================
//
// The prompt protocol teaches a model to PRINT a tool call, which means it is a
// second syntax to imitate. Free/quantised models get it wrong and burn several
// steps relearning the same shape. This module removes the guesswork we can:
// it tells the model, up front, which shell it is actually on and which
// commands exist — built from the SERVER's facts, not the browser's user-agent
// (which lies whenever the app is served from a different machine than the one
// the sandbox runs on).
//
// Toggle: Config → Labs → "Dynamic tools" (settings.dynamicTools). Off = the
// exact classic toolInstructions() output, byte for byte.

import { store } from './store.js?v=318';
import { api } from './api.js?v=318';
import { toolInstructions } from './tools.js?v=318';

const TTL_MS = 5 * 60 * 1000;
let _facts = null;
let _at = 0;
let _inflight = null;

/** Config → Labs → "Dynamic tools". Default ON; off restores classic output. */
export function dynamicToolsEnabled() {
  return (store.get('settings') || {}).dynamicTools !== false;
}

/** Whether a working dialect should be remembered per provider::model. */
export function dialectMemoEnabled() {
  return (store.get('settings') || {}).toolDialectMemo !== false;
}

/** Server environment facts (OS, cwd, allowlist, which binaries resolve). */
export async function getEnvFacts() {
  if (_facts && (Date.now() - _at) < TTL_MS) return _facts;
  if (_inflight) return _inflight;
  _inflight = api.getSandboxStatus()
    .then((res) => { _facts = res || null; _at = Date.now(); return _facts; })
    .catch(() => _facts || null)
    .finally(() => { _inflight = null; });
  return _inflight;
}

/** Drop the cache (e.g. after the operator saves config). */
export function resetEnvFacts() { _facts = null; _at = 0; }

// The browser feature's on/off lives server-side (Config → Labs → Browser).
// Cached so the tool loop can offer browser tools without a fetch every turn.
let _browserEnabled = false;
let _browserAt = 0;
let _browserInflight = null;

/** Whether the built-in browser is switched on (cached ~5 min). */
export async function browserEnabled() {
  if ((Date.now() - _browserAt) < TTL_MS) return _browserEnabled;
  if (_browserInflight) return _browserInflight;
  _browserInflight = api.browserStatus()
    .then((s) => { _browserEnabled = !!(s && s.enabled); _browserAt = Date.now(); return _browserEnabled; })
    .catch(() => _browserEnabled)
    .finally(() => { _browserInflight = null; });
  return _browserInflight;
}

/** Forget the cached browser state (call after the Labs toggle changes). */
export function resetBrowserEnabled() { _browserEnabled = false; _browserAt = 0; }

// The commands a model actually reaches for, so the header names the ones that
// matter instead of dumping a 60-entry allowlist.
const COMMON = [
  'grep', 'sed', 'awk', 'cat', 'ls', 'find', 'head', 'tail', 'sort', 'uniq',
  'curl', 'wget', 'git', 'python', 'python3', 'node', 'jq', 'rg',
  'findstr', 'dir', 'where', 'type', 'more', 'tasklist', 'ipconfig',
];

function pick(list, cap) {
  return COMMON.filter(n => list.includes(n)).slice(0, cap);
}

function envHeader(env, enabledTools) {
  if (!env) return '';
  const lines = ['\n\nENVIRONMENT — these facts are true here; do not assume otherwise:'];
  lines.push(`- Shell: ${env.os === 'windows' ? 'Windows' : 'POSIX (Linux/macOS)'}.`);

  const root = (env.write_roots && env.write_roots[0]) || env.app_dir || '';
  if (root) lines.push(`- Working directory: "${root}".`);
  if (Array.isArray(env.read_roots) && env.read_roots.length) {
    lines.push(`- Readable paths: ${env.read_roots.join(', ')}.`);
  }

  const shellTools = enabledTools.includes('exec') || enabledTools.includes('run_code');
  if (shellTools) {
    const bins = env.binaries || {};
    const have = Object.keys(bins).filter(k => bins[k]);
    const missing = Object.keys(bins).filter(k => !bins[k]);
    const notableHave = pick(have, 18);
    const notableMissing = pick(missing, 12);
    if (notableHave.length) lines.push(`- Shell commands present: ${notableHave.join(', ')}.`);
    if (notableMissing.length) lines.push(`- NOT installed here: ${notableMissing.join(', ')} — do not try these.`);
    if (env.os === 'windows') {
      lines.push('- Windows: echo, pwd, type, where, dir, mkdir and sleep are handled internally; '
        + 'pass an argv array to real .exe programs (findstr, ipconfig, tasklist). '
        + '.cmd/.bat shims (npm.cmd) are not run, and PowerShell/cmd syntax is not interpreted.');
    }
    lines.push(`- exec is ${env.exec_enabled ? 'ON' : 'OFF'}; run_code is ${env.code_enabled ? 'ON' : 'OFF'}.`);
  }
  return lines.join('\n');
}

/**
 * The instruction block to append to the system message.
 *
 * @param {string[]} enabledTools
 * @param {string}   sandboxRoot
 * @param {string}   dialect        'json' | 'plain' | 'native' | 'anthropic' | 'native-api'
 * @param {object}   env            getEnvFacts() result (or null)
 */
export function buildToolInstructions(enabledTools, sandboxRoot, dialect, env) {
  const base = toolInstructions(enabledTools, sandboxRoot, dialect);
  if (!base || !dynamicToolsEnabled() || !env) return base;
  const header = envHeader(env, enabledTools);
  return header ? `${header}\n${base}` : base;
}

/**
 * The next dialect to try when a tool-looking reply parsed to nothing.
 * Ordered simplest-first, and never returns one already tried.
 */
export function nextDialect(current, tried) {
  const order = ['plain', 'json', 'native', 'anthropic'];
  for (const d of order) {
    if (d !== current && !tried.has(d)) return d;
  }
  return null;
}
