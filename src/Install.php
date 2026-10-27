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
            // Files written but not yet in place, from an install that had to
            // defer them. Not a problem — a state the UI has to be able to name.
            'pending' => self::pendingSwaps(),
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

        // Clear anything an earlier run left half-swapped before adding to it.
        self::finish(2);

        self::lock();
        $backup = null;
        try {
            $plan = self::plan();
            $staged = self::stagedRoot($plan);
            $from = $pre['currentVersion'];
            $to = $pre['targetVersion'];
            $deferred = array();

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
                if (self::put($rel, $data)) {
                    $written++;
                } else {
                    // Held open by another process — in practice the script that
                    // is running this very request, which Windows will not let
                    // anyone rename over. Written beside its target already;
                    // finish() swaps it in from a process that is not holding it.
                    $deferred[] = $rel;
                    self::log('deferred (file is in use): ' . $rel);
                }
                if ($written % 50 === 0) {
                    self::log('written ' . $written . ' file(s)…');
                }
            }

            if ($deferred) {
                // Everything else is in place; these are written and waiting for
                // a moment when nothing is executing them. A separate process
                // does it, because the only thing that cannot swap the entry
                // script is the entry script.
                self::mark(array(
                    'phase' => 'finishing',
                    'from' => $from,
                    'to' => $to,
                    'backup' => $backup['dir'],
                    'deferred' => $deferred,
                    'at' => time(),
                ));
                self::log('waiting on ' . count($deferred) . ' file(s) held by the running server');
                $spawned = self::spawnFinisher();
                self::log($spawned
                    ? 'finisher started (' . basename($spawned) . '); it will swap them in when the request ends'
                    : 'could not start the finisher automatically — run install-update.php --finish');
            }

            $now = self::version();
            self::log('install wrote ' . $written . ' file(s), skipped ' . $skipped
                . ', deferred ' . count($deferred)
                . ' | tree now reports v' . ($now ?: '?'));

            // The one check that catches a half-broken tree: if the version we
            // just wrote is not the version we meant to install, put it back.
            if ($to !== '' && $now !== '' && $now !== $to) {
                self::log('VERSION MISMATCH: wanted v' . $to . ', found v' . $now . ' — rolling back');
                self::rollback($backup['dir']);
                throw new \RuntimeException('The installed files report v' . $now
                    . ' but the release is v' . $to . '. Rolled back to v' . ($from ?: 'the previous copy') . '.');
            }

            if (!$deferred) {
                self::mark(array(
                    'phase' => 'done',
                    'from' => $from,
                    'to' => $now ?: $to,
                    'backup' => $backup['dir'],
                    'files' => $written,
                    'at' => time(),
                ));
            }
            self::log('install done: now v' . ($now ?: '?') . ' (' . $written . ' file(s) replaced)');
            self::cleanupStaged();

            return array(
                'ok' => true,
                'installed' => $written,
                'skipped' => $skipped,
                'deferred' => $deferred,
                'finishing' => (bool) $deferred,
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
            throw new \RuntimeException('Could not write the new copy of ' . $rel . '.'
                . ' Check that the web server can write to ' . dirname($rel) . '/.');
        }
        if (!@rename($tmp, $target)) {
            // There is deliberately NO unlink-and-retry here. That fallback
            // existed and it destroyed api/index.php on Windows: the running
            // script cannot be renamed over, so the unlink succeeded, the
            // second rename failed too, and the entry point was simply gone.
            // A file that cannot be swapped is left as .router-new-<name> for
            // finish() to put in place when nothing is executing it.
            return false;
        }
        if (function_exists('opcache_invalidate')) {
            @opcache_invalidate($target, true);
        }
        return true;
    }

    /**
     * Swap in any `.router-new-<name>` sibling that is waiting, retrying briefly.
     *
     * Called by a process that is NOT the file it is replacing — the finisher
     * spawned at the end of an install, `install-update.php --finish`, or the
     * next install — so the lock that forced the deferral is gone by definition.
     * The retry covers the second or two between a request ending and Windows
     * releasing the handle on its script.
     */
    public static function finish($tries = 12)
    {
        $pending = self::pendingSwaps();
        if (!$pending) {
            return array('ok' => true, 'swapped' => array(), 'pending' => array());
        }
        self::log('finish: ' . count($pending) . ' file(s) to swap in');
        $swapped = array();
        for ($i = 0; $i < max(1, $tries); $i++) {
            $still = array();
            foreach ($pending as $rel) {
                $target = self::appDir() . '/' . $rel;
                $tmp = dirname($target) . '/.router-new-' . basename($target);
                if (!is_file($tmp)) {
                    continue;
                }
                $age = time() - (int) @filemtime($tmp);
                if (@rename($tmp, $target)) {
                    if (function_exists('opcache_invalidate')) {
                        @opcache_invalidate($target, true);
                    }
                    $swapped[] = $rel;
                    self::log('finish: swapped ' . $rel . ' (waited ' . ($age > 0 ? $age : 0) . 's)');
                } else {
                    $still[] = $rel;
                }
            }
            if (!$still) {
                break;
            }
            usleep(250000);
        }

        if (!$swapped && $still) {
            self::log('finish: still held by the running server: ' . implode(', ', $still));
            return array('ok' => false, 'swapped' => array(), 'pending' => $still);
        }

        $marker = self::readMarker();
        if (is_array($marker) && ($marker['phase'] ?? '') === 'finishing' && !$still) {
            $marker['phase'] = 'done';
            $marker['finished'] = time();
            unset($marker['deferred']);
            self::mark($marker);
            self::log('install done — every file is now in place');
        }
        return array('ok' => !$still, 'swapped' => $swapped, 'pending' => $still ?: array());
    }

    /** Files waiting as `.router-new-<name>` anywhere in the app tree. */
    public static function pendingSwaps()
    {
        $out = array();
        foreach (self::walk(true) as $rel) {
            if (strpos(basename($rel), '.router-new-') === 0) {
                // The sibling is named after the file it replaces, minus the
                // dotfile prefix: .router-new-index.php -> index.php
                $out[] = dirname($rel) === '.'
                    ? substr(basename($rel), strlen('.router-new-'))
                    : dirname($rel) . '/' . substr(basename($rel), strlen('.router-new-'));
            }
        }
        return $out;
    }

    /**
     * Ask a separate process to finish the swap.
     *
     * Detached and fire-and-forget: nothing here waits, because waiting would
     * mean holding the very handle that is in the way. The child retries for a
     * few seconds, which is more than enough for the parent request to end.
     * Every failure is a returned false, never an exception — a host with
     * proc_open disabled gets the manual instruction instead of a broken install.
     */
    public static function spawnFinisher()
    {
        // Test hook: the suite exercises writeFinisher() and the generated
        // script directly, and a real detached child would race it for the
        // same files (and outlive the temporary tree it was pointed at).
        if (defined('INSTALL_NO_SPAWN') && INSTALL_NO_SPAWN) {
            return null;
        }
        $pending = self::pendingSwaps();
        if (!$pending) {
            return null;
        }
        if (!function_exists('popen')) {
            return null;
        }
        $php = self::phpCli();
        if ($php === null) {
            return null;
        }
        $script = self::writeFinisher($pending);
        if ($script === null) {
            return null;
        }

        // Detached on purpose: this runs while the request that called it is
        // still holding api/index.php open, so it retries for a few seconds
        // rather than expecting the handle to be gone immediately.
        $cmd = escapeshellarg($php) . ' ' . escapeshellarg($script);
        try {
            if (DIRECTORY_SEPARATOR === '\\') {
                $h = @popen('start /B "" ' . $cmd, 'r');
            } else {
                $h = @popen($cmd . ' > /dev/null 2>&1 &', 'r');
            }
            if ($h === false) {
                return null;
            }
            @pclose($h);
            return $script;
        } catch (\Throwable $e) {
            return null;
        }
    }

    /**
     * The PHP command-line binary, or null.
     *
     * NOT PHP_BINARY: under Apache's mod_php that constant is the *web server*
     * (`httpd.exe`), so the first version of this spawned Apache with a script
     * path as an argument. It reported success and did nothing at all. Under
     * the CLI, PHP_BINARY is right; everywhere else PHP_BINDIR is.
     */
    private static function phpCli()
    {
        $isWin = DIRECTORY_SEPARATOR === '\\';
        $exe = $isWin ? 'php.exe' : 'php';
        $candidates = array();

        if (PHP_SAPI === 'cli' && defined('PHP_BINARY')) {
            $candidates[] = PHP_BINARY;                       // already the CLI
        }
        if (defined('PHP_BINDIR')) {
            $candidates[] = rtrim(str_replace('\\', '/', PHP_BINDIR), '/') . '/' . $exe;
        }

        // XAMPP (and every layout where the CLI does not sit at PHP_BINDIR):
        // PHP_BINARY is apache/bin/httpd.exe and PHP_BINDIR is the COMPILE-TIME
        // prefix, which on XAMPP is C:\php — a directory that does not exist.
        // The CLI is a sibling of the apache folder, two levels up.
        if (defined('PHP_BINARY')) {
            $binDir = str_replace('\\', '/', dirname(PHP_BINARY));
            $candidates[] = $binDir . '/' . $exe;                 // bundled beside it
            $candidates[] = $binDir . '/../../php/' . $exe;       // xampp/apache/bin -> xampp/php
            $candidates[] = $binDir . '/../php/' . $exe;
        }

        // Last resort: ask the OS. Harmless when exec is disabled — the spawn
        // is impossible on such a host anyway, and the caller says so.
        if (function_exists('exec')) {
            $out = array();
            $code = 1;
            @exec(($isWin ? 'where php' : 'which php') . ' 2>&1', $out, $code);
            if ($code === 0 && !empty($out[0])) {
                $candidates[] = trim((string) $out[0]);
            }
        }

        foreach ($candidates as $candidate) {
            if (!is_string($candidate) || $candidate === '') {
                continue;
            }
            $candidate = str_replace('\\', '/', $candidate);
            if (preg_match('#/php(\.exe)?$#i', $candidate) && @is_file($candidate)) {
                return $candidate;
            }
        }
        return null;
    }

    /**
     * Write a self-contained swap script under storage/updates and return it.
     *
     * Contained, because the thing that finishes an install must not be part of
     * the install: `install-update.php` and `src/Install.php` are both replaced
     * by the release being installed, so a finisher that required them would
     * either run the NEW code (which may not have the method it calls) or die
     * on a half-written tree. This file lives under storage/, which no update
     * ever touches, carries its own list of pairs, deletes itself when done and
     * appends to the same journal.
     */
    private static function writeFinisher(array $pending)
    {
        $pairs = array();
        foreach ($pending as $rel) {
            $target = self::appDir() . '/' . $rel;
            $pairs[] = array(
                'target' => $target,
                'temp' => dirname($target) . '/.router-new-' . basename($target),
                'rel' => $rel,
            );
        }
        if (!$pairs) {
            return null;
        }

        $script = self::workDir() . '/finish-' . bin2hex(random_bytes(4)) . '.php';
        // Nowdoc: the generated file is PHP source, and nothing here should be
        // interpreted on the way in.
        $template = <<<'PHP'
<?php
// Written by Src\Install — do not edit, it deletes itself when it is done.
//
// Swaps in files an install could not replace while the request that was
// installing them held them open (on Windows that is always the entry script).
// Deliberately self-contained: see Src\Install::writeFinisher() for why it
// cannot call back into the app it is patching.
$pairs = %PAIRS%;
$log = %LOG%;

// Delete this file whatever happens — a fatally broken finisher that leaves
// itself behind would be re-run by nothing, missed by nobody, and sit in
// storage/ forever.
register_shutdown_function(function () { @unlink(__FILE__); });

$note = function ($line) use ($log) {
    if (!is_string($log) || $log === '') { return; }
    @file_put_contents($log, gmdate('Y-m-d\TH:i:s\Z') . '  ' . $line . "\n", FILE_APPEND);
};

for ($i = 0; $i < 40; $i++) {
    $left = 0;
    foreach ($pairs as $p) {
        if (!is_file($p['temp'])) { continue; }
        if (@rename($p['temp'], $p['target'])) {
            $note('finish: swapped ' . $p['rel']);
            // opcache is not always loaded (a CLI build, a bare PHP), and an
            // unguarded call here is a fatal that skips the rest of the loop.
            if (function_exists('opcache_invalidate')) {
                @opcache_invalidate($p['target'], true);
            }
        } else {
            $left++;
        }
    }
    if (!$left) { break; }
    usleep(250000);
}

$note($left
    ? 'finish: still held — ' . $left . ' file(s) left for install-update.php --finish'
    : 'finish: every file is in place');
PHP;

        $log = self::logPath();
        $body = str_replace(
            array('%PAIRS%', '%LOG%'),
            array(var_export($pairs, true), var_export($log, true)),
            $template
        );

        if (@file_put_contents($script, $body) === false) {
            return null;
        }
        return $script;
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

    /**
     * Every app file under the root, relative, forward-slashed.
     *
     * With $includeScratch, `.router-new-*` siblings are listed too — they are
     * normally skipped (a snapshot must not back up scratch), but finding them
     * again after a crash is exactly how a deferred swap is completed.
     */
    private static function walk($includeScratch = false, $rel = '')
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
            if (!$includeScratch && strpos($entry, '.router-new-') === 0) {
                continue;
            }
            $full = $base . '/' . $childRel;
            if (is_dir($full)) {
                $out = array_merge($out, self::walk($includeScratch, $childRel));
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
