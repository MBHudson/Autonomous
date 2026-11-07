/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// backupSections tests -- the restore dialog's picture of a backup file.
//
// Usage: node tests/js/backupSections.test.mjs
//
// DOM-free: backupSections.js imports nothing and touches no browser global,
// so the section math the dialog paints can be checked here. The cases that
// matter most are the quiet ones: a section counts as present when its slot
// key EXISTS (even an emptied list -- exported emptiness is still a choice),
// and a file from any older version, with no section list at all, still
// resolves to what it carries rather than refusing.

import {
  BACKUP_SECTIONS,
  BACKUP_SECTION_IDS,
  sanitizeBackupName,
  defaultBackupName,
  sectionsInBackup,
  summarizeBackup,
  backupTokenDiffers,
} from '../../ui/js/backupSections.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// --- the list both sides share -------------------------------------------------
eq(BACKUP_SECTION_IDS, ['agents', 'providers', 'models', 'settings', 'memory',
  'pipelines', 'conversations', 'metrics', 'sessions', 'config', 'approvals'],
  'eleven sections in UI order');
eq(BACKUP_SECTIONS.length, 11, 'metadata for every section');
ok(BACKUP_SECTIONS.every(s => s.id && s.label && s.hint), 'every section has a label and a hint');

// --- filenames -----------------------------------------------------------------
eq(sanitizeBackupName('My backup!'), 'My-backup', 'spaces and bangs become dashes');
eq(sanitizeBackupName('a.json'), 'a', 'a pasted extension is not doubled');
eq(sanitizeBackupName('..\\..\\x'), 'x', 'a pasted path keeps only the last part');
eq(sanitizeBackupName(''), 'router-backup', 'empty falls back');
eq(sanitizeBackupName('...'), 'router-backup', 'dots fall back');
eq(sanitizeBackupName('x'.repeat(200)).length, 80, 'long names capped at 80');
eq(defaultBackupName(new Date('2026-11-07T14:05:00')), 'router-backup-20261107-1405', 'the default stamp');

// --- what a file carries ---------------------------------------------------------
const full = {
  app: 'router-studio',
  state: { slots: { agents: [], providers: [], settings: {}, memory: {}, pipelines: [], conversations: [], metrics: {} } },
  sessions: [],
  models: [],
  config: { sandbox: { token: 'T' } },
  approvals: { grants: [] },
};
eq(sectionsInBackup(full), BACKUP_SECTION_IDS, 'a full file carries everything, even emptied lists');

// An older file, from before section lists existed: no name, no sections key,
// sessions as a bare list. It still resolves to what it holds.
const v1 = {
  app: 'router-studio',
  backupVersion: 1,
  exportedAt: 111,
  state: { slots: { agents: [{ id: 'a' }] } },
  sessions: [{ id: 's' }],
  config: { sandbox: {} },
};
eq(sectionsInBackup(v1), ['agents', 'sessions', 'config'], 'an older file resolves to what it carries');
eq(sectionsInBackup(null), [], 'garbage carries nothing');
eq(sectionsInBackup({ app: 'router-studio' }), [], 'an empty shell carries nothing');
ok(!sectionsInBackup({ app: 'router-studio', approvals: null }).includes('approvals'),
  'a null approvals file means "no grants", not a section');

// --- the dialog summary ------------------------------------------------------------
const sum = summarizeBackup({ ...v1, name: '  trip  ', exportedFrom: '359' });
eq(sum.name, 'trip', 'the name is trimmed');
eq(sum.exportedAt, 111, 'the date survives');
eq(sum.exportedFrom, '359', 'the release survives');
eq(sum.sections, ['agents', 'sessions', 'config'], 'the summary lists the carried sections');
eq(summarizeBackup({}).name, null, 'no name is null, not an empty string');

// --- the token question ---------------------------------------------------------------
ok(backupTokenDiffers({ config: { sandbox: { token: 'OTHER' } } }, 'MINE'),
  'a different embedded token differs');
ok(!backupTokenDiffers({ config: { sandbox: { token: 'SAME' } } }, 'SAME'),
  'the same token does not differ');
ok(!backupTokenDiffers({ config: { sandbox: { token: 'OTHER' } } }, ''),
  'no pasted token means nothing to compare');
ok(!backupTokenDiffers({}, 'MINE'), 'a file with no token does not differ');

for (const line of errors) console.log(line);
console.log(`backupSections: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
