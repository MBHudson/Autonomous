/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// Gemini tool schemas, and the tool list an agent may actually run.
//
// Usage: node tests/js/googleTools.test.mjs
//
// Two bugs are pinned here:
//   - every tool schema was built with additionalProperties, which Gemini's
//     functionDeclarations.parameters (a proto OpenAPI subset, not JSON
//     Schema) rejects with a 400 for the whole request;
//   - a tool the operator never gave an agent could still run, so the registry
//     was acting as the permission list. toolsForAgent() is the read side of
//     the fix; runTool() enforces it.

import { nativeToolDefs } from '../../ui/js/nativeTools.js';
import { toolsForAgent, deniedToolNames } from '../../ui/js/tools.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('Google tool schema + tool scope tests');
console.log('-'.repeat(60));

// --- Gemini's schema subset --------------------------------------------------
const defs = [
  { name: 'exec', description: 'Run a command' },
  { name: 'now', description: 'Clock' },
  { name: 'read_file', description: 'Read a file' },
];
const google = nativeToolDefs(defs, 'google')[0].functionDeclarations;

ok(!JSON.stringify(google).includes('additionalProperties'),
  'gemini declarations carry no additionalProperties');
eq(google[0].parameters.type, 'object', 'gemini parameters survive');
eq(google[0].parameters.required, ['argv'], 'gemini required survives');
ok(!('parameters' in google[1]), 'a tool with no arguments omits parameters entirely');
eq(google[2].parameters.properties.path.type, 'string', 'nested property schemas survive');
eq(google.filter(d => d.name).length, 3, 'every declaration is still present');

// The other families take full JSON Schema, so they keep it.
ok(JSON.stringify(nativeToolDefs(defs, 'openai')).includes('additionalProperties'),
  'openai declarations are unchanged');
ok(JSON.stringify(nativeToolDefs(defs, 'anthropic')).includes('additionalProperties'),
  'anthropic declarations are unchanged');

// --- what an agent may actually run -----------------------------------------
eq(toolsForAgent({ tools: [], memory: false }), [], 'no ticks and memory off means no tools');
ok(toolsForAgent({ tools: ['exec'] }).includes('remember'), 'memory tools ride along by default');
ok(!toolsForAgent({ tools: ['exec'], memory: false }).includes('remember'),
  'memory off drops them');
eq(toolsForAgent({ tools: ['exec'], memory: false, alwaysOn: true }),
  ['exec', 'declare_goal_complete'], 'always-on adds the stop tool');
ok(toolsForAgent({ tools: ['not_a_tool'] }).length > 0,
  'unknown names are filtered out rather than passed through');
ok(Array.isArray(deniedToolNames()), 'the deny list reads as an array');

console.log('-'.repeat(60));
if (errors.length) errors.forEach(e => console.log(e));
console.log(`googleTools: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
