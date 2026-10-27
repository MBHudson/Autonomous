<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// Update installer
namespace Src;

/**
 * Writes a downloaded release over the app tree.
 *
 * The updater next door (Src\Update) deliberately stops one step short: it
 * fetches, verifies and diffs, and refuses to touch a single app file. This is
 * that missing step, and it is the most dangerous code in the app, because it
 * replaces the files it is running from.
 *
 * The rules, each one a way this goes wrong:
 *
 *  1. storage/ is never written. Not filtered file by file — the walk refuses
 *     those top-level names before it looks at anything, so sessions, keys, the
 *     token and the allow/deny lists are unreachable by an install.
 *  2. A file is never overwritten in place. New bytes go to a hidden sibling
 *     (`.router-new-<name>`) and are renamed over the target, so a reader sees
 *     the old file or the new one, never half of either. The hidden name is
 *     also a dotfile, which every serving mode refuses — a crash leaves files
 *     that cannot be fetched.
 *  3. Nothing is deleted. A release that dropped a file leaves it behind. A
 *     stale file is inert; a wrong delete is somebody's work gone.
 *  4. There is always a way back. Before the first write the current tree is
 *     copied to storage/backups/<version>-<timestamp>/. A copy, not a zip:
 *     XAMPP's PHP ships with no ZipArchive and phar.readonly on, and a rollback
 *     that needs an extension the host may not have is not a rollback.
 *  5. It says what it did. Every step is journalled to storage/updates/install.log
 *     and the phase is recorded in install.json, so install-update.php can
 *     finish or undo the job from a command line when the app will not load.
 *
 * This class deliberately depends on nothing else in Src (including Update),
 * because the recovery path has to work while the rest of the tree is suspect.
 * The paths are the only thing it knows about the project.
 */
class Install
{
    /** Top-level names an install may never write. Mirrors Src\Update's list. */
    private static $neverTouch = array('storage', '.git', 'node_modules', '.freebuff');

    /** Folders that hold the operator's own files rather than app code. */
    private static $dataFolders = array('screenshots', 'sandbox');

    /** Rollback trees kept on disk. Two is enough to undo a bad install twice. */
    const BACKUP_KEEP = 2;

    /** A lock older than this is from a run that died, not one in progress. */
    const LOCK_TTL = 900;

    /** @var string|null Test/side-by-side override for the app root. */
    private static $root = null;

    /** Point every path at another tree. Tests use this; nothing else should. */
    public static function useRoot($dir)
    {
        self::$root = $dir === null ? null : rtrim(str_replace('\\', '/', (string) $dir), '/');
    }

    // ------------------------------------------------------------- locations

    /** The app root (parent of src/), forward-slashed, no trailing slash. */
    public static function appDir()
    {
        if (self::$root !== null) {
            return self::$root;
        }
        return rtrim(str_replace('\\', '/', dirname(__DIR__)), '/');
    }

    /** The updater's folder. Denied over HTTP by every serving mode. */
    public static function workDir()
    {
        return self::appDir() . '/storage/updates';
    }

    public static function markerPath()
    {
        return self::workDir() . '/install.json';
    }

    public static function logPath()
    {
        return self::workDir() . '/install.log';
    }

    public static function lockPath()
    {
        return self::workDir() . '/install.lock';
    }

    /** Rollback trees. Also under storage/, so also denied over HTTP. */
    public static function backupRoot()
    {
        return self::appDir() . '/storage/backups';
    }

    // --------------------------------------------------------------- reading

    /** The plan Src\Update wrote when it downloaded, or null. */
    public static function plan()
    {
        $path = self::workDir() . '/plan.json';
        if (!is_file($path)) {
            return null;
        }
        $plan = json_decode((string) @file_get_contents($path), true);
        return is_array($plan) ? $plan : null;
    }

    /** Absolute path of the extracted release, from the plan's own record. */
    private static function stagedRoot(array $plan)
    {
        $rel = (string) ($plan['stagedRoot'] ?? '');
        if ($rel === '') {
            return null;
        }
        return self::appDir() . '/' . ltrim(str_replace('\\', '/', $rel), '/');
    }

    /** The release number this tree calls itself, or '' when it has none. */
    public static function version()
    {
        $text = @file_get_contents(self::appDir() . '/VERSION');
        if (!is_string($text)) {
            return '';
        }
        foreach (preg_split('/\R/', $text) as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#' || strpos($line, '//') === 0) {
                continue;
            }
            if (preg_match('/^(\d+)$/', $line, $m)) {
                return $m[1];
            }
        }
        return '';
    }

    /** The browser cache-buster from the tree on disk, or ''. */
    public static function appVersion()
    {
        $js = @file_get_contents(self::appDir() . '/ui/js/store.js');
        if (is_string($js) && preg_match('/APP_VERSION\s*=\s*(\d+)/', $js, $m)) {
            return $m[1];
        }
        return '';
    }

    /** What the UI needs before it offers the button. */
    public static function preflight()
    {
        $problems = array();
        $plan = self::plan();
        $staged = $plan ? self::stagedRoot($plan) : null;

        if (!$plan) {
            $problems[] = 'No update is downloaded yet — download it first.';
        } elseif (!$staged || !is_dir($staged)) {
            $problems[] = 'The downloaded copy is gone. Download the update again.';
        }

        // Can the web user actually write over the app? On Windows/XAMPP the
        // answer is yes; on a Linux host with root-owned files it is usually
        // no. Finding that out here costs one file, not a half-finished install.
        $probe = self::appDir() . '/.router-write-probe';
        $writable = @file_put_contents($probe, 'probe') !== false;
        if ($writable) {
            @unlink($probe);
        } else {
            $problems[] = 'The web server cannot write to the app folder, so it cannot replace app files. '
                . 'Run install-update.php from a terminal instead.';
        }

        if (!is_dir(self::workDir()) && !@mkdir(self::workDir(), 0755, true) && !is_dir(self::workDir())) {
            $problems[] = 'storage/updates cannot be created, so there is nowhere to write the log.';
        }

        $target = (string) ($plan['targetVersion']['label'] ?? ($plan['targetVersion'] ?? ''));
        if (is_array($plan['targetVersion'] ?? null)) {
            $target = (string) ($plan['targetVersion']['label'] ?? '');
        }

        return array(
            'ok' => !$problems,
            'problems' => $problems,
            'writable' => $writable,
            'currentVersion' => self::version(),
            'targetVersion' => $target,
            'staged' => (bool) ($staged && is_dir($staged)),
            'busy' => self::isLocked(),
            'snapshots' => self::snapshots(),
        );
    }

    // ---------------------------------------------------------------- locking

    private static function isLocked()
    {
        if (!is_file(self::lockPath())) {
            return false;
        }
        $age = time() - (int) @filemtime(self::lockPath());
        return $age >= 0 && $age < self::LOCK_TTL;
    }

    /**
     * Held for as long as THIS process is inside apply() or rollback().
     *
     * Re-entrant on purpose: apply() calls rollback() when the tree comes up
     * on the wrong version, and a plain non-reentrant lock turns that recovery
     * path into "an install is already running" — the app refusing to rescue
     * itself because it is holding its own lock.
     */
    private static $lockDepth = 0;

    private static function lock()
    {
        if (self::$lockDepth > 0) {
            self::$lockDepth++;
            return true;
        }
        if (self::isLocked()) {
            throw new \RuntimeException('An install is already running (started less than '
                . self::LOCK_TTL . ' seconds ago). Wait for it to finish, or delete storage/updates/install.lock.');
        }
        @file_put_contents(self::lockPath(), (string) getmypid() . ' ' . time());
        self::$lockDepth = 1;
        return true;
    }

    private static function unlock()
    {
        if (self::$lockDepth > 1) {
            self::$lockDepth--;
            return;
        }
        self::$lockDepth = 0;
        @unlink(self::lockPath());
    }

    /** The marker install.json, or null. */
    private static function readMarker()
    {
        if (!is_file(self::markerPath())) {
            return null;
        }
        $decoded = json_decode((string) @file_get_contents(self::markerPath()), true);
        return is_array($decoded) ? $decoded : null;
    }

    // ------------------------------------------------------------- reporting

    private static function log($line)
    {
        @file_put_contents(
            self::logPath(),
            gmdate('Y-m-d\TH:i:s\Z') . '  ' . $line . "\n",
            FILE_APPEND
        );
    }

    private static function mark(array $state)
    {
        $state['at'] = $state['at'] ?? time();
        @file_put_contents(
            self::markerPath(),
            json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)
        );
    }

    public static function tailLog($lines = 40)
    {
        if (!is_file(self::logPath())) {
            return '';
        }
        $all = @file(self::logPath(), FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if (!is_array($all)) {
            return '';
        }
        return implode("\n", array_slice($all, -$lines));
    }

    public static function state()
    {
        $marker = null;
        if (is_file(self::markerPath())) {
            $decoded = json_decode((string) @file_get_contents(self::markerPath()), true);
            $marker = is_array($decoded) ? $decoded : null;
        }
        return array(
            'ok' => true,
            'marker' => $marker,
            'busy' => self::isLocked(),
            'preflight' => self::preflight(),
            'snapshots' => self::snapshots(),
            'log' => self::tailLog(),
        );
    }

    // ------------------------------------------------------------ the install

    /**
     * Replace the app's files with the staged release.
     *
     * Order matters and is the whole safety argument: preflight, then the
     * rollback copy, then the marker, then the writes, then a version check
     * that undoes everything if the tree does not come up calling itself the
     * release we just installed.
     */
    public static function apply()
    {
        $pre = self::preflight();
        if (!$pre['ok']) {
            throw new \RuntimeException(implode(' ', $pre['problems']));
        }

        self::lock();
        $backup = null;
        try {
            $plan = self::plan();
            $staged = self::stagedRoot($plan);
            $from = $pre['currentVersion'];
            $to = $pre['targetVersion'];

            $backup = self::snapshot();
            self::mark(array(
                'phase' => 'installing',
                'from' => $from,
                'to' => $to,
                'backup' => $backup['dir'],
                'started' => time(),
            ));
            self::log('install start: v' . ($from ?: '?') . ' -> v' . ($to ?: '?')
                . ' | backup ' . $backup['dir'] . ' (' . $backup['files'] . ' files)');

            $written = 0;
            $skipped = 0;
            foreach (($plan['files'] ?? array()) as $entry) {
                $rel = (string) ($entry['path'] ?? '');
                $status = (string) ($entry['status'] ?? '');
                if ($rel === '' || $status === 'same') {
                    $skipped++;
                    continue;
                }
                // Belt and braces: the plan is a file on disk and this is the
                // function that writes. Refuse rather than trust it.
                if (self::isSkipped($rel)) {
                    self::log('REFUSED (never written by an install): ' . $rel);
                    $skipped++;
                    continue;
                }
                $source = $staged . '/' . $rel;
                $data = @file_get_contents($source);
                if ($data === false) {
                    throw new \RuntimeException('Could not read ' . $rel
                        . ' from the downloaded copy. Nothing after this file was written; '
                        . 'install-update.php --rollback restores the backup.');
                }
                self::put($rel, $data);
                $written++;
                if ($written % 50 === 0) {
                    self::log('written ' . $written . ' file(s)…');
                }
            }

            $now = self::version();
            self::log('install wrote ' . $written . ' file(s), skipped ' . $skipped
                . ' | tree now reports v' . ($now ?: '?'));

            // The one check that catches a half-broken tree: if the version we
            // just wrote is not the version we meant to install, put it back.
            if ($to !== '' && $now !== '' && $now !== $to) {
                self::log('VERSION MISMATCH: wanted v' . $to . ', found v' . $now . ' — rolling back');
                self::rollback($backup['dir']);
                throw new \RuntimeException('The installed files report v' . $now
                    . ' but the release is v' . $to . '. Rolled back to v' . ($from ?: 'the previous copy') . '.');
            }

            self::mark(array(
                'phase' => 'done',
                'from' => $from,
                'to' => $now ?: $to,
                'backup' => $backup['dir'],
                'files' => $written,
                'at' => time(),
            ));
            self::log('install done: now v' . ($now ?: '?') . ' (' . $written . ' file(s) replaced)');
            self::cleanupStaged();

            return array(
                'ok' => true,
                'installed' => $written,
                'skipped' => $skipped,
                'from' => $from,
                'to' => $now ?: $to,
                'appVersion' => self::appVersion(),
                'backup' => $backup['dir'],
                'log' => self::tailLog(20),
            );
        } catch (\Throwable $e) {
            self::log('install failed: ' . $e->getMessage());
            // A failure that already rolled back is not just "failed": the
            // tree is back on the version it started on, and saying only
            // "failed" would send the operator hunting for a problem that no
            // longer exists.
            $marker = self::readMarker();
            if (($marker['phase'] ?? '') === 'rolled-back') {
                $marker['error'] = $e->getMessage();
                self::mark($marker);
            } else {
                self::mark(array(
                    'phase' => 'failed',
                    'error' => $e->getMessage(),
                    'backup' => $backup['dir'] ?? null,
                    'at' => time(),
                ));
            }
            throw $e;
        } finally {
            self::unlock();
        }
    }

    /**
     * Write one file: hidden sibling, then rename over the target.
     *
     * Nothing is ever truncated in place, so a crash mid-install leaves a tree
     * with some new files and some old ones — never a file that is half of each
     * and cannot be parsed by the next request.
     */
    private static function put($rel, $data)
    {
        $target = self::appDir() . '/' . $rel;
        $dir = dirname($target);
        if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir)) {
            throw new \RuntimeException('Cannot create the folder for ' . $rel . '.');
        }
        $tmp = $dir . '/.router-new-' . basename($target);

        if (@file_put_contents($tmp, $data) !== strlen($data)) {
            @unlink($tmp);
            throw new \RuntimeException('Could not write the new copy of ' . $rel . '.');
        }
        if (!@rename($tmp, $target)) {
            // Some Windows builds refuse to rename onto an existing file. The
            // gap that creates is one unlink wide, and the alternative is
            // leaving the new version on disk under a name nothing loads.
            @unlink($target);
            if (!@rename($tmp, $target)) {
                @unlink($tmp);
                throw new \RuntimeException('Could not replace ' . $rel . '.');
            }
        }
        if (function_exists('opcache_invalidate')) {
            @opcache_invalidate($target, true);
        }
    }

    // -------------------------------------------------------------- snapshot

    /** Copy the current app files aside. Returns [dir, files, bytes]. */
    public static function snapshot()
    {
        $root = self::backupRoot();
        if (!is_dir($root) && !@mkdir($root, 0755, true) && !is_dir($root)) {
            throw new \RuntimeException('Cannot create storage/backups — the install was not started.');
        }
        $dir = $root . '/' . (self::version() ?: 'dev') . '-' . gmdate('Ymd-His');
        if (is_dir($dir)) {
            $dir .= '-' . substr(bin2hex(random_bytes(3)), 0, 6);
        }
        if (!@mkdir($dir, 0755, true)) {
            throw new \RuntimeException('Cannot create the rollback folder in storage/backups.');
        }

        $files = self::walk();
        $manifest = array();
        $bytes = 0;
        foreach ($files as $rel) {
            $target = $dir . '/' . $rel;
            $parent = dirname($target);
            if (!is_dir($parent) && !@mkdir($parent, 0755, true) && !is_dir($parent)) {
                throw new \RuntimeException('Cannot copy ' . $rel . ' into the rollback folder. The install was not started.');
            }
            if (!@copy(self::appDir() . '/' . $rel, $target)) {
                throw new \RuntimeException('Could not back up ' . $rel . '. The install was not started.');
            }
            $size = (int) @filesize($target);
            $bytes += $size;
            $manifest[$rel] = array('size' => $size, 'sha256' => hash_file('sha256', $target));
        }

        @file_put_contents($dir . '/manifest.json', json_encode(array(
            'version' => self::version(),
            'appVersion' => self::appVersion(),
            'at' => time(),
            'files' => $manifest,
        ), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        self::pruneSnapshots();
        return array('dir' => $dir, 'files' => count($manifest), 'bytes' => $bytes);
    }

    /**
     * Put a snapshot back.
     *
     * Restores what the backup contains and deletes nothing, so a release's new
     * files survive as inert leftovers while every file the app actually loads
     * is back at the version that worked.
     */
    public static function rollback($dir = null)
    {
        if ($dir === null || $dir === '') {
            $dir = self::latestSnapshot();
        }
        if (!$dir || !is_dir($dir)) {
            throw new \RuntimeException('There is no rollback copy in storage/backups to restore.');
        }
        // The API passes this path in from the browser, so it is untrusted: a
        // rollback restores files into the app root, and a caller that could
        // point it at any folder with a manifest.json would be choosing what
        // the app writes. Only storage/backups is a rollback source.
        $real = realpath($dir);
        $rootReal = realpath(self::backupRoot());
        if ($real === false || $rootReal === false
            || strpos(str_replace('\\', '/', $real), rtrim(str_replace('\\', '/', $rootReal), '/') . '/') !== 0) {
            throw new \RuntimeException('Refused: a rollback can only restore a copy kept in storage/backups.');
        }
        $dir = rtrim(str_replace('\\', '/', $real), '/');
        $raw = @file_get_contents($dir . '/manifest.json');
        $manifest = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($manifest) || !isset($manifest['files']) || !is_array($manifest['files'])) {
            throw new \RuntimeException('That rollback copy has no readable manifest.json.');
        }

        self::lock();
        try {
            self::log('rollback start from ' . $dir . ' (v' . ($manifest['version'] ?? '?') . ')');
            $restored = 0;
            $already = 0;
            foreach ($manifest['files'] as $rel => $meta) {
                if (self::isSkipped($rel)) {
                    continue;   // cannot happen; the snapshot never held one
                }
                $current = self::appDir() . '/' . $rel;
                if (is_file($current) && hash_file('sha256', $current) === ($meta['sha256'] ?? '')) {
                    $already++;
                    continue;
                }
                $data = @file_get_contents($dir . '/' . $rel);
                if ($data === false) {
                    throw new \RuntimeException('The rollback copy is missing ' . $rel . '.');
                }
                self::put($rel, $data);
                $restored++;
            }
            $now = self::version();
            self::log('rollback done: restored ' . $restored . ', already current ' . $already
                . ' | tree reports v' . ($now ?: '?'));
            self::mark(array(
                'phase' => 'rolled-back',
                'to' => $now,
                'from' => $dir,
                'at' => time(),
            ));
            return array(
                'ok' => true,
                'restored' => $restored,
                'unchanged' => $already,
                'to' => $now,
                'from' => $dir,
                'log' => self::tailLog(20),
            );
        } finally {
            self::unlock();
        }
    }

    /** Newest snapshot first, as [dir, version, at, files]. */
    public static function snapshots()
    {
        $root = self::backupRoot();
        if (!is_dir($root)) {
            return array();
        }
        $out = array();
        foreach ((array) @scandir($root) as $entry) {
            if ($entry === '.' || $entry === '..' || !is_dir($root . '/' . $entry)) {
                continue;
            }
            $manifest = json_decode((string) @file_get_contents($root . '/' . $entry . '/manifest.json'), true);
            $out[] = array(
                'dir' => $root . '/' . $entry,
                'name' => $entry,
                'version' => is_array($manifest) ? ($manifest['version'] ?? '') : '',
                'at' => (int) @filemtime($root . '/' . $entry),
                'files' => is_array($manifest) && isset($manifest['files']) ? count($manifest['files']) : 0,
            );
        }
        usort($out, fn($a, $b) => $b['at'] <=> $a['at']);
        return $out;
    }

    public static function latestSnapshot()
    {
        $all = self::snapshots();
        return $all ? $all[0]['dir'] : null;
    }

    private static function pruneSnapshots()
    {
        $all = self::snapshots();
        foreach (array_slice($all, self::BACKUP_KEEP) as $old) {
            self::removeTree($old['dir']);
        }
    }

    // ---------------------------------------------------------------- walking

    /** True for paths an install or a snapshot must leave alone. */
    private static function isSkipped($rel)
    {
        $first = strtolower(explode('/', str_replace('\\', '/', $rel))[0]);
        return in_array($first, self::$neverTouch, true)
            || in_array($first, self::$dataFolders, true);
    }

    /** Every app file under the root, relative, forward-slashed. */
    private static function walk($rel = '')
    {
        $base = self::appDir();
        $path = $rel === '' ? $base : $base . '/' . $rel;
        $entries = @scandir($path);
        if (!is_array($entries)) {
            return array();
        }
        $out = array();
        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $childRel = $rel === '' ? $entry : $rel . '/' . $entry;
            if ($rel === '' && self::isSkipped($childRel)) {
                continue;
            }
            // A crashed install can leave these behind; never back them up.
            if (strpos($entry, '.router-new-') === 0) {
                continue;
            }
            $full = $base . '/' . $childRel;
            if (is_dir($full)) {
                $out = array_merge($out, self::walk($childRel));
            } elseif (is_file($full)) {
                $out[] = $childRel;
            }
        }
        return $out;
    }

    private static function removeTree($dir)
    {
        if (!is_dir($dir)) {
            return true;
        }
        foreach ((array) @scandir($dir) as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = $dir . '/' . $entry;
            if (is_dir($path)) {
                self::removeTree($path);
            } else {
                @unlink($path);
            }
        }
        return @rmdir($dir);
    }

    /** Drop the download and its plan. The install log and backups stay. */
    private static function cleanupStaged()
    {
        $work = self::workDir();
        self::removeTree($work . '/staging');
        @unlink($work . '/pending.zip');
        @unlink($work . '/plan.json');
    }
}
