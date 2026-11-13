/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// Display-tool backfill: an agent's tools are a saved snapshot, so agents that
// predate show_file/show_command/show_find/show_url never offered them. The
// migration adds them once -- and must never fight the operator afterwards.

import { withDisplayTools, backfillDisplayTools, DISPLAY_TOOL_NAMES, MAX_DISPLAY_CHARS, TOOL_DISPLAY_LIMIT, renderLimitFor, toolValueText } from '../../ui/js/utils.js';
import { DISPLAY_TOOLS, MAX_DISPLAY_CHARS as TOOL_SIDE_CAP } from '../../ui/js/tools.js';

let pass = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else errors.push(`FAIL: ${name}`); };
const eq = (got, want, name) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else errors.push(`FAIL: ${name} (got ${g}, want ${w})`);
};

// One list, so the migration and the harness can never disagree about which
// tools are display tools.
eq(DISPLAY_TOOLS, DISPLAY_TOOL_NAMES, 'tools.js re-exports the one display list');
eq(DISPLAY_TOOL_NAMES.length, 4, 'there are four display tools');
// The renderer and the tool side must agree, or a record is stored in full and
// then painted with an 8,000-character clip that looks like the tool failed.
eq(MAX_DISPLAY_CHARS, TOOL_SIDE_CAP, 'one display cap, shared by tools and the renderer');
eq(MAX_DISPLAY_CHARS, 400000, 'and it is the big one');

// --- a legacy list gains them, in place --------------------------------------
eq(withDisplayTools(['exec', 'read_file']),
  ['exec', 'read_file', 'show_file', 'show_command', 'show_find', 'show_url'],
  'a legacy list gains all four, after the tools it already had');

// --- idempotent ---------------------------------------------------------------
eq(withDisplayTools(['exec', 'show_file', 'show_command', 'show_find', 'show_url']), null,
  'a list that already has them is left untouched');
eq(withDisplayTools(['show_command', 'show_file', 'show_url', 'show_find']), null,
  'order does not matter');

// --- choices the migration must respect ---------------------------------------
eq(withDisplayTools([]), null, 'an empty list means tools are OFF, not missing');
eq(withDisplayTools(undefined), null, 'no list means the defaults, which already include them');
eq(withDisplayTools(['exec'], ['show_find']), ['exec', 'show_file', 'show_command', 'show_url'],
  'a denied tool is not added back');
eq(withDisplayTools(['exec'], { show_url: true }), ['exec', 'show_file', 'show_command', 'show_find'],
  'a denied map is understood as well as an array');

// --- nothing else changes ------------------------------------------------------
const kept = ['now', 'read_note', 'exec'];
eq(withDisplayTools(kept).slice(0, 3), kept, 'existing order and contents are preserved');
ok(!kept.includes('show_file'), 'the input array is not mutated');
eq(withDisplayTools('show_file'), null, 'a non-array is ignored');

// --- the migration itself ------------------------------------------------------
// The marker is per agent because state sync replaces the whole list. A test
// that only covered "it adds them" would have passed while the flag sat there
// claiming the work was done and the server's old copy came back.
{
  const agents = [
    { name: 'old', tools: ['exec', 'read_file'] },
    { name: 'fresh', tools: ['exec', ...DISPLAY_TOOL_NAMES] },
    { name: 'off', tools: [] },
    { name: 'defaults' },
  ];
  eq(backfillDisplayTools(agents), 1, 'only the agent with a legacy list is changed');
  ok(agents[0].tools.includes('show_file'), 'and it gains the display tools');
  ok(agents[0].displayToolsBackfilled === true, 'and is marked as done');
  ok(agents[1].displayToolsBackfilled === true, 'an agent that already had them is marked too');
  eq(agents[2].tools, [], 'tools switched off stay switched off');
  eq(backfillDisplayTools(agents), 0, 'a second pass changes nothing');

  // The case that actually broke: the operator removes one afterwards.
  agents[0].tools = agents[0].tools.filter(t => t !== 'show_url');
  eq(backfillDisplayTools(agents), 0, 'a removal is never undone by a later load');
  ok(!agents[0].tools.includes('show_url'), 'show_url stays removed');

  // And a server copy with no marker is fixed even if some other copy is marked.
  const fromServer = [{ name: 'old', tools: ['exec'] }];
  eq(backfillDisplayTools(fromServer, ['show_find']), 1, 'a marker-less copy is migrated');
  ok(!fromServer[0].tools.includes('show_find'), 'honouring the denied list');
}

// --- what gets painted ----------------------------------------------------------
// The bug the operator hit: a display result was stored in full and then
// painted with the 8,000-character per-call budget, so a 58,963-character log
// showed its first paragraph and "… (50963 more characters)".
const bigLog = 'x'.repeat(58963);
eq(renderLimitFor(true), MAX_DISPLAY_CHARS, 'a display result gets the display budget');
eq(renderLimitFor(false), TOOL_DISPLAY_LIMIT, 'everything else keeps the small one');
eq(toolValueText(bigLog, renderLimitFor(true)).length, bigLog.length,
  'a 58,963-character display result is painted whole');
eq(toolValueText(bigLog, renderLimitFor(true)).includes('more characters'), false,
  'with no truncation marker');
const clipped = toolValueText(bigLog, renderLimitFor(false));
ok(clipped.length < bigLog.length, 'a plain tool result is still clipped');
ok(clipped.includes(`(${bigLog.length - TOOL_DISPLAY_LIMIT} more characters)`),
  'and says exactly how much was left out');
eq(toolValueText({ a: 1 }), '{\n  "a": 1\n}', 'objects are pretty-printed');
eq(toolValueText(null), '', 'null renders as nothing');

for (const line of errors) console.log(line);
console.log(`displayBackfill: ${pass} passed, ${errors.length} failed`);
process.exit(errors.length ? 1 : 0);
