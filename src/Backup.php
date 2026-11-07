<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Full backup, in parts: what is backed up, and what a restore touches.
 *
 * The backup used to be all-or-nothing: GET /backup returned the whole copy
 * and POST /import replaced the whole copy, refusing anything that was not
 * recognisably a complete backup. Three things about that hurt:
 *
 *   1. A restore onto a DIFFERENT copy (or from an older file) failed or
 *      misled. The gate flag, the access token and the sandbox roots already
 *      stay local (Config::sanitizeImportedConfig), but the route still
 *      refused a file that missed a section outright, and restoring wiped
 *      every section even when the file only meant to carry one.
 *   2. There was no way to take -- or restore -- only part of the copy: the
 *      models catalog (storage/models.json) was not backed up at all, and
 *      "just my providers" meant carrying everyone's sessions with it.
 *   3. The file downloaded under a fixed stamp name with no say in the matter.
 *
 * Sections are the unit now. Each one names a storage unit -- a state.json
 * slot, a sessions file, the models catalog, the config, the approval
 * grants -- and both directions honour the same list: export writes only the
 * chosen sections into the file, import touches only the chosen sections on
 * disk. Anything absent from the file is LEFT ALONE, never blanked: a partial
 * file restores partially, which is also what lets a backup from any version
 * land on any copy. Sections nobody selected (or the file does not carry)
 * are reported as skipped, so a restore that kept something is visible.
 *
 * The routes stay thin: api/index.php parses the request and prints the
 * answer; everything below works on plain arrays and a storage directory, so
 * the tests drive it against a throwaway folder and the operator's own
 * storage/ is never read or written.
 */

namespace Src;

class Backup
{
    /**
     * The sections, in the order the UI offers them. Slots are state.json
     * slot keys; file is a storage file (sessions is the whole directory).
     * The JS picker (ui/js/backupSections.js) carries the same list with the
     * same ids -- keep the two in step.
     */
    const SECTIONS = [
        'agents'        => ['label' => 'Agents', 'slots' => ['agents']],
        'providers'     => ['label' => 'Providers & API keys', 'slots' => ['providers']],
        'models'        => ['label' => 'Models', 'file' => 'models'],
        'settings'      => ['label' => 'Settings', 'slots' => ['settings', 'theme', 'temp', 'maxTokens', 'currentSession']],
        'memory'        => ['label' => 'Memory & notes', 'slots' => ['memory']],
        'pipelines'     => ['label' => 'Pipelines & workflows', 'slots' => ['pipelines']],
        'conversations' => ['label' => 'Conversations', 'slots' => ['conversations']],
        'metrics'       => ['label' => 'Usage metrics', 'slots' => ['metrics']],
        'sessions'      => ['label' => 'Chat sessions', 'file' => 'sessions'],
        'config'        => ['label' => 'Access & shell config', 'file' => 'config'],
        'approvals'     => ['label' => 'Approval grants', 'file' => 'approvals'],
    ];

    /** Every section id, in UI order. */
    public static function allSections()
    {
        return array_keys(self::SECTIONS);
    }

    /**
     * Validate a requested section list (a comma string or an array, or null
     * for everything). Returns sections + unknown -- the route answers 400
     * naming the unknowns.
     */
    public static function parseList($raw)
    {
        if ($raw === null) {
            return ['sections' => self::allSections(), 'unknown' => []];
        }
        $ids = is_array($raw) ? $raw : explode(',', (string) $raw);
        $sections = [];
        $unknown = [];
        foreach ($ids as $id) {
            $id = trim((string) $id);
            if ($id === '') continue;
            if (isset(self::SECTIONS[$id])) {
                if (!in_array($id, $sections, true)) $sections[] = $id;
            } else {
                if (!in_array($id, $unknown, true)) $unknown[] = $id;
            }
        }
        return ['sections' => $sections, 'unknown' => $unknown];
    }

    /**
     * A filename stem safe to save under: letters, digits, dash, underscore
     * and dot, everything else a dash, capped at 80 characters. An empty or
     * hopeless name falls back to $fallback.
     */
    public static function sanitizeName($name, $fallback = 'router-backup')
    {
        $stem = trim((string) $name);
        $stem = preg_replace('#^.*[\/]#', '', $stem);
        $stem = preg_replace('/\.json$/i', '', $stem);
        $stem = preg_replace('/[^A-Za-z0-9._-]+/', '-', $stem);
        $stem = trim($stem, '-.');
        if ($stem === '' || $stem === '.' || $stem === '..') $stem = $fallback;
        if (strlen($stem) > 80) $stem = substr($stem, 0, 80);
        return $stem;
    }
    /**
     * Build the backup bundle: only the requested sections.
     *
     * $storageDir holds state.json, sessions/ and exec-approvals.json; the
     * config and the models catalog come through Config (which honours
     * ROUTER_CONFIG / ROUTER_MODELS, so tests can point them elsewhere).
     * $meta carries name and exportedFrom for the file's own label.
     */
    public static function exportBundle($storageDir, $sections, $meta = [])
    {
        $sections = array_values(array_intersect(self::allSections(), (array) $sections));
        $stateSlots = [];
        foreach ($sections as $id) {
            foreach ((array) (self::SECTIONS[$id]['slots'] ?? []) as $slot) {
                $stateSlots[] = $slot;
            }
        }

        $state = null;
        if ($stateSlots) {
            $raw = is_file($storageDir . '/state.json')
                ? json_decode((string) @file_get_contents($storageDir . '/state.json'), true) : null;
            $slots = (is_array($raw) && isset($raw['slots']) && is_array($raw['slots'])) ? $raw['slots'] : [];
            $picked = [];
            foreach ($stateSlots as $slot) {
                if (array_key_exists($slot, $slots)) $picked[$slot] = $slots[$slot];
            }
            $state = [
                'slots' => $picked,
                'rev' => isset($raw['rev']) ? (int) $raw['rev'] : 0,
                'updated' => isset($raw['updated']) ? $raw['updated'] : null,
            ];
        }

        $bundle = [
            'app' => 'router-studio',
            'backupVersion' => 2,
            'name' => isset($meta['name']) && trim((string) $meta['name']) !== ''
                ? (string) $meta['name'] : null,
            'exportedAt' => time(),
            'exportedFrom' => isset($meta['exportedFrom']) ? (string) $meta['exportedFrom'] : null,
            'sections' => $sections,
        ];
        if ($state !== null) $bundle['state'] = $state;

        if (in_array('sessions', $sections, true)) {
            $sessions = [];
            foreach ((array) glob($storageDir . '/sessions/*.json') as $file) {
                $s = json_decode((string) @file_get_contents($file), true);
                if (is_array($s)) $sessions[] = $s;
            }
            $bundle['sessions'] = $sessions;
        }
        if (in_array('models', $sections, true)) {
            $bundle['models'] = Config::getModels();
        }
        if (in_array('config', $sections, true)) {
            $bundle['config'] = Config::loadConfig();
        }
        if (in_array('approvals', $sections, true)) {
            $path = $storageDir . '/exec-approvals.json';
            if (is_file($path)) {
                $bundle['approvals'] = json_decode((string) @file_get_contents($path), true);
            }
        }
        return $bundle;
    }

    /**
     * Which sections of $backup an import with $only (null = every section
     * the file carries) will actually restore, and which it skips and why.
     * A section the file does not carry is skipped, never blanked -- that is
     * what makes a partial or older file safe to restore.
     */
    public static function planRestore($backup, $only = null)
    {
        if (!is_array($backup) || ($backup['app'] ?? null) !== 'router-studio') {
            return ['error' => 'Not an Autonomous Loop Studio backup file'];
        }
        $parsed = self::parseList($only === null ? null : $only);
        if ($parsed['unknown']) {
            return ['error' => 'Unknown backup section(s): ' . implode(', ', $parsed['unknown'])];
        }
        $restore = [];
        $skipped = [];
        foreach ($parsed['sections'] as $id) {
            $reason = self::missingReason($backup, $id);
            if ($reason === null) $restore[] = $id;
            else $skipped[] = ['section' => $id, 'reason' => $reason];
        }
        return ['restore' => $restore, 'skipped' => $skipped];
    }

    /** Why section $id cannot be restored from $backup, or null when it can. */
    public static function missingReason($backup, $id)
    {
        if (!isset(self::SECTIONS[$id])) return 'unknown section';
        $slots = (array) (self::SECTIONS[$id]['slots'] ?? []);
        if ($slots) {
            if (!isset($backup['state']) || !is_array($backup['state'])) {
                return 'not in this backup';
            }
            $have = isset($backup['state']['slots']) && is_array($backup['state']['slots'])
                ? $backup['state']['slots'] : [];
            foreach ($slots as $slot) {
                if (array_key_exists($slot, $have)) return null;
            }
            return 'not in this backup';
        }
        if ($id === 'sessions') {
            return (isset($backup['sessions']) && is_array($backup['sessions']))
                ? null : 'not in this backup';
        }
        if ($id === 'models') {
            return (isset($backup['models']) && is_array($backup['models']))
                ? null : 'not in this backup';
        }
        if ($id === 'config') {
            return (isset($backup['config']) && is_array($backup['config']))
                ? null : 'not in this backup';
        }
        if ($id === 'approvals') {
            return (isset($backup['approvals']) && $backup['approvals'] !== null)
                ? null : 'not in this backup';
        }
        return 'not in this backup';
    }
    /**
     * Merge restored state slots over the current state: per-slot replace for
     * the listed keys, everything else kept, revision bumped so other devices
     * adopt it on their next poll. Device credentials never roam (stripped
     * the same way live PUTs strip them), and keys listed but absent from the
     * backup are left alone.
     */
    public static function mergeState($current, $incoming, $slotKeys)
    {
        $current = is_array($current) ? $current : [];
        $incoming = is_array($incoming) ? $incoming : [];
        $currentSlots = (isset($current['slots']) && is_array($current['slots'])) ? $current['slots'] : [];
        $incomingSlots = (isset($incoming['slots']) && is_array($incoming['slots'])) ? $incoming['slots'] : [];
        foreach ((array) $slotKeys as $slot) {
            if (array_key_exists($slot, $incomingSlots)) {
                $currentSlots[$slot] = $incomingSlots[$slot];
            }
        }
        if (isset($currentSlots['settings']) && is_array($currentSlots['settings'])) {
            unset($currentSlots['settings']['routerToken'], $currentSlots['settings']['sandboxToken']);
        }
        $current['slots'] = $currentSlots;
        $current['rev'] = (int) ($current['rev'] ?? 0) + 1;
        $current['updated'] = time();
        return $current;
    }

    /** The models catalog must be a plain array to be writable. */
    public static function validModels($models)
    {
        return is_array($models);
    }

    /**
     * Restore the planned sections of $backup into $storageDir.
     *
     * Only planned sections are touched: state slots merge per-slot, sessions
     * are replaced only when the sessions section is restored, and the config
     * goes through sanitizeImportedConfig so this copy keeps its own gate,
     * token and roots. Returns the result array the route prints, including
     * what was restored, what was skipped and why, and whether the backup
     * carried a DIFFERENT access token (this copy's own still applies).
     */
    public static function importBundle($storageDir, $backup, $only = null)
    {
        $plan = self::planRestore($backup, $only);
        if (isset($plan['error'])) return $plan;
        $restore = $plan['restore'];
        $skipped = $plan['skipped'];
        $restored = [];

        // State slots: merge, never replace.
        $slotKeys = [];
        foreach ($restore as $id) {
            foreach ((array) (self::SECTIONS[$id]['slots'] ?? []) as $slot) {
                $slotKeys[] = $slot;
            }
        }
        $rev = null;
        if ($slotKeys) {
            $statePath = $storageDir . '/state.json';
            $current = is_file($statePath)
                ? json_decode((string) @file_get_contents($statePath), true) : null;
            $merged = self::mergeState($current, $backup['state'], $slotKeys);
            $rev = $merged['rev'];
            $json = json_encode($merged, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
            if ($json === false) {
                return ['error' => 'Restored state could not be encoded as JSON'];
            }
            $tmp = $statePath . '.' . getmypid() . '.tmp';
            if (@file_put_contents($tmp, $json, LOCK_EX) === false || !@rename($tmp, $statePath)) {
                @unlink($tmp);
                return ['error' => 'Could not write storage/state.json'];
            }
            foreach ($restore as $id) {
                if (!empty(self::SECTIONS[$id]['slots'])) $restored[] = $id;
            }
        }

        // Sessions: replaced only when the section is restored.
        $sessionCount = null;
        if (in_array('sessions', $restore, true)) {
            $sessionsDir = $storageDir . '/sessions/';
            if (!is_dir($sessionsDir)) @mkdir($sessionsDir, 0755, true);
            foreach ((array) glob($sessionsDir . '*.json') as $file) @unlink($file);
            $sessionCount = 0;
            foreach ((array) $backup['sessions'] as $session) {
                if (!is_array($session)) continue;
                $sid = isset($session['id']) ? basename((string) $session['id']) : '';
                if (!preg_match('/^[A-Za-z0-9_.-]+$/', $sid)) continue;
                $session['id'] = $sid;
                if (@file_put_contents($sessionsDir . $sid . '.json',
                    json_encode($session, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) !== false) {
                    $sessionCount++;
                }
            }
            $restored[] = 'sessions';
        }

        // Models catalog.
        if (in_array('models', $restore, true)) {
            if (!self::validModels($backup['models'])) {
                $skipped[] = ['section' => 'models', 'reason' => 'models catalog is not valid'];
            } elseif (Config::saveModels($backup['models'])) {
                $restored[] = 'models';
            } else {
                return ['error' => 'Could not write the models catalog'];
            }
        }

        // Config: restored, except what describes THIS machine.
        $configSaved = null;
        $keptLocal = [];
        $tokenDiffers = false;
        if (in_array('config', $restore, true)) {
            $stored = Config::loadConfig();
            $storedToken = trim((string) ($stored['sandbox']['token'] ?? ''));
            $incomingToken = trim((string) ($backup['config']['sandbox']['token'] ?? ''));
            if ($storedToken !== '' && $incomingToken !== '' && $storedToken !== $incomingToken) {
                $tokenDiffers = true;
            }
            list($importConfig, $keptLocal) = Config::sanitizeImportedConfig($backup['config'], $stored);
            $configSaved = Config::saveConfig($importConfig);
            $restored[] = 'config';
        }

        // Approval grants.
        if (in_array('approvals', $restore, true)) {
            $ok = @file_put_contents($storageDir . '/exec-approvals.json',
                json_encode($backup['approvals'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
            if ($ok === false) {
                return ['error' => 'Could not write storage/exec-approvals.json'];
            }
            $restored[] = 'approvals';
        }

        $out = [
            'success' => true,
            'restored' => array_values(array_unique($restored)),
            'skipped' => $skipped,
            'rev' => $rev,
            'config_saved' => $configSaved,
            'kept_local' => $keptLocal,
            'token_differs' => $tokenDiffers,
        ];
        if ($sessionCount !== null) $out['sessions'] = $sessionCount;
        return $out;
    }
}
