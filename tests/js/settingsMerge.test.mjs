/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// settings merge tests -- does adopting another device's settings keep what
// THIS browser learned?
//
// Usage: node tests/js/settingsMerge.test.mjs
//
// The sync bundle replaced the whole `settings` slot. So a device that pushed
// an older copy (or a browser that had never run a given model) erased the two
// things that are learned locally rather than configured: the tool dialect that
// worked for a provider::model, and the context window a runner reported. That
// is "the agent stopped learning its dialect" with no visible cause. The maps
// are unioned now; everything else still follows the incoming copy.

import { mergeLearnedSettings } from '../../ui/js/utils.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('settings merge tests');
console.log('-'.repeat(60));

// --- a learned map survives an older incoming copy ---------------------------
{
  const local = { theme: 'dark', toolDialectMap: { 'openai::m': 'json' }, contextLimits: { 'openrouter|m': 131072 } };
  const incoming = { theme: 'light' };
  const merged = mergeLearnedSettings(local, incoming);
  eq(merged.toolDialectMap, { 'openai::m': 'json' }, 'the learned dialect map is kept');
  eq(merged.contextLimits, { 'openrouter|m': 131072 }, 'the learned context windows are kept');
  eq(merged.theme, 'light', 'ordinary settings still follow the incoming copy');
}

// --- both sides contribute, incoming wins on a conflict ---------------------
{
  const merged = mergeLearnedSettings(
    { toolDialectMap: { a: 'json', b: 'plain' } },
    { toolDialectMap: { b: 'native', c: 'anthropic' } },
  );
  eq(merged.toolDialectMap, { a: 'json', b: 'native', c: 'anthropic' },
    'maps are unioned and the incoming copy wins on the same key');
}

// --- an incoming map is adopted when the local one is absent ----------------
{
  const merged = mergeLearnedSettings({}, { toolDialectMap: { x: 'json' } });
  eq(merged.toolDialectMap, { x: 'json' }, 'a map this browser never had is adopted');
}

// --- nothing to merge -------------------------------------------------------
{
  eq(mergeLearnedSettings({ a: 1 }, null), { a: 1 }, 'an empty incoming bundle changes nothing');
  eq(mergeLearnedSettings(null, { b: 2 }), { b: 2 }, 'a first sync adopts the bundle');
}

// --- garbage is not a map ---------------------------------------------------
{
  const merged = mergeLearnedSettings({ toolDialectMap: ['not', 'a', 'map'] }, {});
  ok(merged.toolDialectMap === undefined, 'an array is not treated as a learned map');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(errors.join('\n')); process.exit(1); }
