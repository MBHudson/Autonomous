/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// AGENTSEARCH.JS — how a "/" fragment matches an agent
// ============================================
//
// Split out of slashCommands.js so the rule can be checked without a browser:
// the palette needs the store and the DOM, but "should /b8 list North-mini" is
// pure arithmetic on strings.
//
// The rule, in one sentence: a fragment matches when it starts any searchable
// word of the entry — the code with or without its leading "#", the whole name,
// or any word/segment inside a multi-word or hyphenated name.
//
// Why it is that generous:
//   * Codes are DISPLAYED as "#B8NL6F". The hash is decoration -- routing.js
//     strips it before matching -- so someone reading the code off an agent card
//     and typing "/B8NL6F" was previously shown an empty list, because the
//     comparison started at the "#".
//   * Names are not single words. "Ox Alpha" answered "/ox" but not "/alpha",
//     and "nemotron-lightning" answered "/nem" but not "/light". Both are the
//     name they were typing.

/** Lowercase, trim, and drop a leading @ or # (the same rule routing.js uses). */
const strip = s => String(s == null ? '' : s).trim().replace(/^[@#]+/, '').toLowerCase();

/**
 * The words inside a display name: "Ox Alpha" -> ox, alpha;
 * "nemotron-lightning" -> nemotron, lightning.
 */
export function searchWords(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .split(/[\s\-_/|:]+/)
    .filter(Boolean)
    // A dot is kept inside a word AND offered on its own, so "minimax-m3.1-flash"
    // answers both "/m3.1" (a version, the way it is written) and "/flash".
    .flatMap(word => [word, ...word.split('.').filter(Boolean)]);
}

/**
 * Does any of these tokens start with what was typed?
 *
 * @param {string[]} tokens candidate strings (display form; "#" is optional)
 * @param {string}   query  the fragment after the slash
 * @returns {boolean} true when the entry should be listed
 */
export function matchesQuery(tokens, query) {
  const raw = String(query == null ? '' : query).trim().toLowerCase();
  if (!raw) return true;              // a bare "/" lists everything
  const needle = strip(raw);          // "/b8" and "/#b8" are the same search
  for (const token of tokens || []) {
    const tok = String(token == null ? '' : token).trim().toLowerCase();
    if (!tok) continue;
    if (tok.startsWith(raw)) return true;
    // strip('') is '' and startsWith('') is always true, so the hash-only query
    // ("/#") is left to the branch above rather than matching every entry.
    if (needle && strip(tok).startsWith(needle)) return true;
  }
  return false;
}

/**
 * Everything about one agent a "/" fragment may be matched against: its code
 * (both spellings) and its name and the words inside it.
 *
 * @param {object} agent the stored agent record
 * @param {string} code  the value agentCode() returns, e.g. "#B8NL6F"
 */
export function agentTokens(agent, code) {
  const out = [];
  const c = String(code == null ? '' : code).trim();
  if (c) out.push(c, strip(c));
  const name = String((agent && agent.name) || '');
  if (name) out.push(name, ...searchWords(name));
  return out;
}

export default { matchesQuery, agentTokens, searchWords };
