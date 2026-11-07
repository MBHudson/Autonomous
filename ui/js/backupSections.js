/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// BACKUP SECTIONS — the pickable parts of a backup
// ============================================
//
// The same section list the server keeps in src/Backup.php (same ids, same
// order). Deliberately free of imports and DOM so the picker logic is worth
// testing on its own: import it straight into Node.
//
// Sections name storage units, not screens: state.json slots on the left,
// whole files on the right. `slots` is what the restore dialog looks for
// under backup.state.slots; a missing key means the file does not carry it.

export const BACKUP_SECTIONS = [
  { id: 'agents', label: 'Agents', hint: 'Roster, per-agent settings, prompts', slots: ['agents'] },
  { id: 'providers', label: 'Providers & API keys', hint: 'Providers including their keys', slots: ['providers'] },
  { id: 'models', label: 'Models', hint: 'The Brain Lab model catalog', file: 'models' },
  { id: 'settings', label: 'Settings', hint: 'Toggles, limits, theme, budgets', slots: ['settings', 'theme', 'temp', 'maxTokens', 'currentSession'] },
  { id: 'memory', label: 'Memory & notes', hint: 'Private and collective notes', slots: ['memory'] },
  { id: 'pipelines', label: 'Pipelines & workflows', hint: 'Orchestrate graphs', slots: ['pipelines'] },
  { id: 'conversations', label: 'Conversations', hint: 'Agent conversation history', slots: ['conversations'] },
  { id: 'metrics', label: 'Usage metrics', hint: 'Spend and run counters', slots: ['metrics'] },
  { id: 'sessions', label: 'Chat sessions', hint: 'Every session transcript', file: 'sessions' },
  { id: 'config', label: 'Access & shell config', hint: 'Token, allow/deny lists, roots, MCP server', file: 'config' },
  { id: 'approvals', label: 'Approval grants', hint: 'Pending always-allow grants', file: 'approvals' },
];

export const BACKUP_SECTION_IDS = BACKUP_SECTIONS.map(s => s.id);

/**
 * A filename stem safe to save under: letters, digits, dash, underscore
 * and dot, everything else a dash, capped at 80 characters. Mirrors
 * Backup::sanitizeName on the server, which labels the file independently.
 */
export function sanitizeBackupName(name, fallback = 'router-backup') {
  let stem = String(name == null ? '' : name).trim();
  stem = stem.replace(/^.*[\/]/, '');
  stem = stem.replace(/\.json$/i, '');
  stem = stem.replace(/[^A-Za-z0-9._-]+/g, '-');
  stem = stem.replace(/^[-.]+|[-.]+$/g, '');
  if (!stem || stem === '.' || stem === '..') stem = fallback;
  if (stem.length > 80) stem = stem.slice(0, 80);
  return stem;
}

/** Default name for a fresh backup dialog: router-backup-YYYYMMDD-HHMM. */
export function defaultBackupName(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `router-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/**
 * Which sections a parsed backup file actually carries. A section counts as
 * present when ANY of its slots is under backup.state.slots (even an empty
 * list -- exported emptiness is still a choice), or when its file key holds
 * a value (approvals may be null, which means "no grants file", not empty).
 */
export function sectionsInBackup(backup) {
  if (!backup || typeof backup !== 'object') return [];
  const have = backup.state && typeof backup.state === 'object' &&
    backup.state.slots && typeof backup.state.slots === 'object'
    ? backup.state.slots : {};
  return BACKUP_SECTIONS
    .filter(s => {
      if (s.slots) return s.slots.some(slot => Object.prototype.hasOwnProperty.call(have, slot));
      if (s.id === 'sessions') return Array.isArray(backup.sessions);
      if (s.id === 'models') return Array.isArray(backup.models);
      if (s.id === 'config') return !!backup.config && typeof backup.config === 'object';
      if (s.id === 'approvals') return backup.approvals != null;
      return false;
    })
    .map(s => s.id);
}

/**
 * What the restore dialog shows about a file before offering its sections:
 * name, export date, the release it came from, and what it carries.
 */
export function summarizeBackup(backup) {
  const b = backup && typeof backup === 'object' ? backup : {};
  return {
    name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : null,
    exportedAt: typeof b.exportedAt === 'number' && b.exportedAt > 0 ? b.exportedAt : null,
    exportedFrom: typeof b.exportedFrom === 'string' && b.exportedFrom ? b.exportedFrom : null,
    backupVersion: b.backupVersion != null ? b.backupVersion : null,
    sections: sectionsInBackup(b),
  };
}

/**
 * Did this backup come from a copy with a different access token? Compares
 * the token EMBEDDED in the file with the one this browser is using -- a
 * mismatch is expected and harmless (the restore keeps this copy's own), but
 * the dialog says so out loud instead of letting "same token?" be a mystery.
 */
export function backupTokenDiffers(backup, currentToken) {
  const cur = String(currentToken || '').trim();
  const theirs = backup && backup.config && backup.config.sandbox
    ? String(backup.config.sandbox.token || '').trim() : '';
  return cur !== '' && theirs !== '' && cur !== theirs;
}
