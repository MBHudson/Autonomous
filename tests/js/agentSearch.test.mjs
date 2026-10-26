/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// agentSearch tests -- what the "/" palette lists for a typed fragment.
//
// Usage: node tests/js/agentSearch.test.mjs
//
// DOM-free: agentSearch.js imports nothing and touches no browser global. The
// names and codes here are the shapes the app actually stores (a leading "#" on
// codes, hyphenated model names, multi-word agent names), because the rule that
// failed was about exactly those spellings: "/B8NL6F" and "/alpha" and "/light"
// all used to come back empty even though the agent was right there.

import { matchesQuery, agentTokens, searchWords } from '../../ui/js/agentSearch.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };

// One real-shaped agent: the code carries the hash the card displays.
const north = { name: 'North-mini', role: 'Code' };
const northCode = '#B8NL6F';
const ox = { name: 'Ox Alpha', role: 'Review' };
const light = { name: 'nemotron-lightning', role: 'Code' };
const mini = { name: 'minimax-m3.1-flash', role: 'Code' };

console.log('agentSearch tests');
console.log('-'.repeat(60));

// --- a bare "/" lists everything --------------------------------------------
ok(matchesQuery(agentTokens(north, northCode), ''), 'a bare slash lists the agent');
ok(matchesQuery(['help'], ''), 'a bare slash lists a command');
ok(matchesQuery([], ''), 'a bare slash matches even an entry with no tokens');

// --- the code, with and without its "#" -------------------------------------
ok(matchesQuery(agentTokens(north, northCode), 'b8'), 'code without the hash: /b8');
ok(matchesQuery(agentTokens(north, northCode), 'B8NL'), 'code, mixed case, without the hash');
ok(matchesQuery(agentTokens(north, northCode), '#b8'), 'code with the hash: /#b8');
ok(matchesQuery(agentTokens(north, northCode), '#B8NL6F'), 'the whole code as the card shows it');
ok(matchesQuery(agentTokens(north, northCode), 'b8nl6f'), 'the whole code, no hash');

// A hash-only query is a code query: it must not match every entry.
ok(matchesQuery(agentTokens(north, northCode), '#'), '/# lists entries that have a code');
ok(!matchesQuery(['help'], '#'), '/# does not match a plain command name');

// --- names, in every word ---------------------------------------------------
ok(matchesQuery(agentTokens(north, northCode), 'north'), 'the first word of a hyphenated name');
ok(matchesQuery(agentTokens(north, northCode), 'mini'), 'a later word of a hyphenated name');
ok(matchesQuery(agentTokens(north, northCode), 'north-mini'), 'the whole hyphenated name');
ok(matchesQuery(agentTokens(ox, '#JCTM9L'), 'alpha'), 'the second word of a spaced name');
ok(matchesQuery(agentTokens(ox, '#JCTM9L'), 'ox a'), 'a prefix that spans the space');
ok(matchesQuery(agentTokens(light, '#HPVXF4'), 'light'), 'a word inside nemotron-lightning');
ok(matchesQuery(agentTokens(mini, '#ACTULF'), 'm3.1'), 'a version inside a model name');
ok(matchesQuery(agentTokens(mini, '#ACTULF'), 'flash'), 'the last word of a model name');
ok(matchesQuery(['Code'], 'co'), 'a role still matches its first letters');

// --- and it does not over-match --------------------------------------------
ok(!matchesQuery(agentTokens(north, northCode), 'zzz'), 'nonsense finds nothing');
ok(!matchesQuery(agentTokens(north, northCode), 'northx'), 'a fragment past the name finds nothing');
ok(!matchesQuery(agentTokens(north, northCode), 'alpha'), 'another agent\'s name is not this one');
ok(!matchesQuery([], 'a'), 'an entry with no tokens matches nothing but a bare slash');
ok(!matchesQuery(undefined, 'a'), 'a missing token list is safe');

// --- token building ---------------------------------------------------------
const tokens = agentTokens(north, northCode);
ok(tokens.includes('#B8NL6F'), 'tokens keep the display code');
ok(tokens.includes('b8nl6f'), 'tokens add the code without the hash');
ok(tokens.includes('North-mini'), 'tokens keep the whole name');
ok(tokens.includes('north') && tokens.includes('mini'), 'tokens add each word of the name');
ok(!tokens.includes('Code'), 'tokens do not include the role -- it is its own entry');
ok(agentTokens(null, null).length === 0, 'a missing agent has no tokens');

// --- the words inside a name ------------------------------------------------
const words = searchWords('minimax-m3.1-flash');
ok(words.includes('minimax') && words.includes('flash'), 'searchWords splits the hyphenated name');
ok(words.includes('m3.1') && words.includes('m3'), 'searchWords keeps a version whole and split');
ok(searchWords('').length === 0, 'searchWords on empty text is empty');
ok(searchWords(undefined).length === 0, 'searchWords on undefined is empty');

// --- a sweep: every word of every name finds its own agent ------------------
const roster = [
  { a: { name: 'North-mini' }, code: '#B8NL6F' },
  { a: { name: 'OpenRouter-TEST' }, code: '#WPZN8D' },
  { a: { name: 'nemotron-3-ultra' }, code: '#XLEVDD' },
  { a: { name: 'Ox Alpha' }, code: '#JCTM9L' },
  { a: { name: 'KIMI-K3' }, code: '#BHW3DJ' },
  { a: { name: 'minimax-m3.1-flash' }, code: '#ACTULF' },
  { a: { name: 'GLM-5.3' }, code: '#4DFLVU' },
];
const missed = [];
for (const entry of roster) {
  for (const word of searchWords(entry.a.name)) {
    for (const typed of [word, word.slice(0, 2)]) {
      if (!matchesQuery(agentTokens(entry.a, entry.code), typed)) {
        missed.push(`${entry.a.name} not found by "/${typed}"`);
      }
    }
  }
}
ok(missed.length === 0, 'every word (and its first two letters) finds its agent'
  + (missed.length ? `: ${missed.slice(0, 4).join(' | ')}` : ''));

// And the hash-free code of every one of them.
const badCodes = roster
  .filter(entry => !matchesQuery(agentTokens(entry.a, entry.code), entry.code.slice(1)))
  .map(entry => entry.code);
ok(badCodes.length === 0, 'every hash-free code finds its agent'
  + (badCodes.length ? `: ${badCodes.join(', ')}` : ''));

console.log('-'.repeat(60));
if (fail) {
  console.error(errors.join('\n'));
  console.error(`${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`${pass} passed`);
