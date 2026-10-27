<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

namespace Src;

/**
 * Download, verify and DIFF a published release — without installing it.
 *
 * This class never writes outside `storage/updates/`. Nothing in the app tree
 * is replaced, and `storage/` itself (config, keys, sessions, state) is not
 * read for comparison or written at all. The only output is a plan: which
 * files are new, which changed, what the new version calls itself.
 *
 * Two facts about this project shaped the implementation, and both are easy to
 * get wrong:
 *
 *   1. The published repo SHIPS a `storage/` folder (a default config and empty
 *      logs). A plain "unzip over the app" would therefore overwrite the
 *      operator's config, token and provider keys with defaults. Every entry
 *      under `storage/` is refused here — at extraction time, not merely
 *      excluded from the report — so the archived copy can never land.
 *
 *   2. This PHP commonly has no ZipArchive (stock XAMPP does not enable it),
 *      so archives are read through PharData, which can open .zip and is
 *      compiled in by default. PharData is used strictly as a reader; no phar
 *      is ever created.
 *
 * Nothing here trusts the archive: entries are resolved to relative paths by
 * hand, `..`/absolute/drive-letter names are refused, and the whole extraction
 * is capped by entry count and byte budget.
 */
class Update
{
    /** Refuse anything bigger than this before touching the disk. */
    const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

    /** A real repo has ~400 files; this is the ceiling for a hostile one. */
    const MAX_ENTRIES = 20000;

    /** The published tree. codeload is GitHub's archive host (no API redirect). */
    const DEFAULT_SOURCE = 'https://codeload.github.com/MBHudson/Autonomous/zip/refs/heads/master';

    // ------------------------------------------------------- the two signals
    //
    // A release is announced by TWO independent numbers, and the check reads
    // both. They move for different reasons, and neither one alone is enough:
    //
    //   1. VERSION (repo root) — the RELEASE number. Bumped on every release,
    //      including one that touches no browser file at all (a PHP fix, a
    //      docs fix). This is what makes such a release visible: without it,
    //      a PHP-only release was undetectable, because the only thing the
    //      check watched was the browser cache-buster, which correctly does
    //      NOT move when no cached asset changed.
    //
    //   2. APP_VERSION in ui/js/store.js — the CACHE-BUSTER. It moves when
    //      browser-loaded files change, and MUST move then, or a browser serves
    //      a new module next to an old one. It is also the fallback signal for
    //      a published copy old enough to predate VERSION.
    //
    // A release that bumps either one is detected. Both of these are tiny, and
    // raw.githubusercontent is already in the host allowlist below, so both
    // probes reuse the same source rules as the download itself.

    /** The published release number. */
    const RELEASE_PROBE = 'https://raw.githubusercontent.com/MBHudson/Autonomous/master/VERSION';

    /** The published cache-buster, and the fallback when there is no VERSION. */
    const APP_PROBE = 'https://raw.githubusercontent.com/MBHudson/Autonomous/master/ui/js/store.js';

    /**
     * The published CHANGELOG, read only to name what changed in a release.
     *
     * Asked for ONLY when a newer release actually exists: it is by far the
     * largest file in the repo (six figures of bytes and growing) and every
     * byte of it is worthless while the two copies match.
     */
    const CHANGELOG_PROBE = 'https://raw.githubusercontent.com/MBHudson/Autonomous/master/CHANGELOG.md';

    /**
     * Only the TOP of the CHANGELOG is ever wanted -- the newest release is the
     * first section -- so the transfer is stopped once this many bytes have
     * arrived. That bounds a load-time check no matter how long the file grows.
     */
    const CHANGELOG_BYTES = 65536;

    /**
     * A successful check is trusted for six hours: the version number moves
     * when the maintainer ships, which is not an every-minute event, and a
     * drag-and-drop app must not call out to GitHub on every single reload.
     * A FAILED check is cached far more briefly -- see CHECK_FAIL_TTL.
     */
    const CHECK_TTL = 21600;

    /**
     * A failed check is remembered for 15 minutes. Without this, a machine
     * that is offline (or behind a proxy that eats the request) would retry
     * the full connect timeout on every single page load.
     */
    const CHECK_FAIL_TTL = 900;

    /** Where an update may be fetched from, before and after redirects. */
    private static $allowedHosts = array(
        'codeload.github.com',
        'github.com',
        'api.github.com',
        'raw.githubusercontent.com',
        'objects.githubusercontent.com',
    );

    /** Top-level names that are never compared and never extracted. */
    private static $neverTouch = array('storage', '.git', 'node_modules', '.freebuff');

    /**
     * Folders whose contents are the operator's data, not app files. A release
     * may ship an empty `screenshots/` or `sandbox/`, and every file the
     * operator put there would otherwise be reported as "not in the update" --
     * noise that reads like a deletion list.
     */
    private static $noRemovalReport = array('screenshots', 'sandbox');

    // ------------------------------------------------------------- locations

    /** The app root (parent of src/), forward-slashed, no trailing slash. */
    public static function appDir()
    {
        return rtrim(str_replace('\\', '/', dirname(__DIR__)), '/');
    }

    /** Everything this feature owns. Denied over HTTP by every serving mode. */
    public static function workDir()
    {
        return self::appDir() . '/storage/updates';
    }

    public static function stagingDir()
    {
        return self::workDir() . '/staging';
    }

    public static function pendingArchive()
    {
        return self::workDir() . '/pending.zip';
    }

    public static function planPath()
    {
        return self::workDir() . '/plan.json';
    }

    /** The cached answer of the last load-time check. */
    public static function checkPath()
    {
        return self::workDir() . '/check.json';
    }

    // ---------------------------------------------------------------- source

    /**
     * Only https on a known repo host. An update URL that the caller controls
     * would otherwise be a server-side request forgery primitive: this endpoint
     * fetches and writes what it finds, so "point it at http://127.0.0.1:8080"
     * must be impossible before the request is made, not filtered afterwards.
     */
    public static function assertSafeSource($url)
    {
        $p = parse_url((string) $url);
        if (!is_array($p) || empty($p['scheme']) || strtolower($p['scheme']) !== 'https') {
            throw new \RuntimeException('Refused: the update source must be an https URL.');
        }
        if (!empty($p['user']) || !empty($p['pass'])) {
            throw new \RuntimeException('Refused: the update source must not carry credentials.');
        }
        if (isset($p['port']) && (int) $p['port'] !== 443) {
            throw new \RuntimeException('Refused: the update source must use port 443.');
        }
        $host = strtolower((string) ($p['host'] ?? ''));
        if (!in_array($host, self::$allowedHosts, true)) {
            throw new \RuntimeException(
                'Refused: ' . ($host === '' ? 'that host' : $host) . ' is not a release host. '
                . 'Allowed: ' . implode(', ', self::$allowedHosts) . '.'
            );
        }
        return $url;
    }

    // ------------------------------------------------------------------ plan

    /** The cached plan from the last download, or null when nothing is staged. */
    public static function plan()
    {
        $path = self::planPath();
        if (!is_file($path)) {
            return null;
        }
        $plan = json_decode((string) @file_get_contents($path), true);
        return is_array($plan) ? $plan : null;
    }

    /** What the UI shows before anything is downloaded. */
    public static function status()
    {
        return array(
            'ok' => true,
            'currentVersion' => self::versionIn(self::appDir()),
            'staged' => is_file(self::pendingArchive()) && is_dir(self::stagingDir()),
            'plan' => self::plan(),
            'source' => self::DEFAULT_SOURCE,
            'workDir' => 'storage/updates',
        );
    }

    /** Create storage/updates if the web user can. Returns its path. */
    public static function ensureWorkDir()
    {
        $work = self::workDir();
        if (!is_dir($work) && !@mkdir($work, 0755, true) && !is_dir($work)) {
            throw new \RuntimeException('Cannot create storage/updates — the web user cannot write to storage/.');
        }
        return $work;
    }

    // -------------------------------------------------------- update available

    /**
     * Is there a newer release published? Cheap enough to run at page load.
     *
     * This NEVER throws. A check that cannot reach GitHub is a normal outcome
     * for an app that is meant to run on a laptop with no network, so the
     * caller gets `ok => false` plus a reason instead of an exception, and the
     * UI stays quiet. The reason is cached too, so an offline machine does not
     * pay the connect timeout on every reload.
     *
     * The comparison is deliberately only version NUMBERS: that is all a
     * couple of small files can honestly tell you. Whether files actually
     * differ needs the full archive, which is what DOWNLOAD UPDATE does.
     */
    public static function check($force = false)
    {
        $local = self::versionPairIn(self::appDir());
        $now = time();

        if (!$force) {
            $hit = self::applyCache(self::readCheck(), $local, $now);
            if ($hit !== null) {
                return $hit;
            }
        }

        $remote = array('release' => null, 'app' => null);
        $problems = array();
        // Probed separately so that one unreachable file does not discard the
        // other's answer: VERSION alone is enough to know about a release, and
        // it is the smaller request. A 404 is not a failure -- it means the
        // published copy predates that file.
        try {
            self::ensureWorkDir();
            $remote['release'] = self::versionFromText(self::probeText(self::RELEASE_PROBE, 8));
        } catch (\Throwable $e) {
            $problems[] = 'VERSION: ' . $e->getMessage();
        }
        try {
            $remote['app'] = self::versionFromJs(self::probeText(self::APP_PROBE, 12));
        } catch (\Throwable $e) {
            $problems[] = 'store.js: ' . $e->getMessage();
        }

        if ($remote['release'] === null && $remote['app'] === null) {
            $result = array(
                'ok' => false,
                'cached' => false,
                'error' => $problems
                    ? implode('; ', $problems)
                    : 'The published copy answered, but carried no version in either file.',
                'checkedAt' => $now,
                'localVersion' => self::preferred($local),
                'remoteVersion' => null,
                'localRelease' => $local['release'],
                'remoteRelease' => null,
                'localApp' => $local['app'],
                'remoteApp' => null,
                'remoteChange' => null,
                'updateAvailable' => false,
                'source' => self::RELEASE_PROBE,
            );
        } else {
            $available = self::isNewerVersion($remote, $local);
            $result = array(
                'ok' => true,
                'cached' => false,
                'error' => null,
                'checkedAt' => $now,
                'localVersion' => self::preferred($local),
                'remoteVersion' => self::preferred($remote),
                'localRelease' => $local['release'],
                'remoteRelease' => $remote['release'],
                'localApp' => $local['app'],
                'remoteApp' => $remote['app'],
                'updateAvailable' => $available,
                // Asked for only when there is something to announce. The
                // CHANGELOG is the largest file in the repo, and every byte of
                // it is worthless while the two copies match.
                'remoteChange' => $available ? self::remoteChange() : null,
                'source' => self::RELEASE_PROBE,
            );
        }

        self::writeCheck($result);
        return $result;
    }

    /**
     * The published CHANGELOG's newest entry, or null.
     *
     * NEVER throws. A release that cannot be *named* is still a release, so an
     * unreachable or unreadable CHANGELOG must not turn a real update into a
     * failed check -- the notification then just says less.
     */
    private static function remoteChange()
    {
        try {
            return self::changelogEntry(self::probeHead(
                self::CHANGELOG_PROBE,
                self::CHANGELOG_BYTES,
                12
            ));
        } catch (\Throwable $e) {
            return null;
        }
    }

    /**
     * Decide whether a cached check still answers the question. Pure, so the
     * cache rules (what expires, what a clock jump does) are testable without
     * a network or a disk.
     *
     * Returns the resolved result, or null meaning "must ask now".
     */
    public static function applyCache($cache, $local, $now)
    {
        if (!is_array($cache)) {
            return null;
        }
        $at = isset($cache['checkedAt']) ? (int) $cache['checkedAt'] : 0;
        $age = $now - $at;
        // A missing timestamp is unusable, and a timestamp in the FUTURE
        // (the clock was corrected, or the file was copied between machines)
        // must not pin one answer forever.
        if ($at <= 0 || $age < 0) {
            return null;
        }
        $failed = !empty($cache['error']);
        if ($age >= ($failed ? self::CHECK_FAIL_TTL : self::CHECK_TTL)) {
            return null;
        }

        // `remoteVersion` is this record's shape from before VERSION existed;
        // it was the cache-buster, so it is read as one. An old cache file
        // therefore still answers instead of forcing a probe.
        $remote = array(
            'release' => $cache['remoteRelease'] ?? null,
            'app' => $cache['remoteApp'] ?? ($cache['remoteVersion'] ?? null),
        );
        if (!$failed && self::preferred($remote) === null) {
            return null;   // "succeeded" with no version at all is not an answer
        }
        return array(
            'ok' => !$failed,
            'cached' => true,
            'error' => $failed ? (string) $cache['error'] : null,
            'checkedAt' => $at,
            // Read LIVE, never from the cache: this copy's numbers move every
            // time a release or a cache-buster is bumped, and a stale "this
            // copy" would have the panel announcing an update the operator
            // already installed.
            'localVersion' => self::preferred($local),
            'remoteVersion' => $failed ? null : self::preferred($remote),
            'localRelease' => is_array($local) ? ($local['release'] ?? null) : null,
            'remoteRelease' => $remote['release'],
            'localApp' => is_array($local) ? ($local['app'] ?? null) : null,
            'remoteApp' => $remote['app'],
            // Passed through from the record: naming the release costs a
            // CHANGELOG fetch, and re-earning it on every cached read would
            // defeat the cache entirely.
            'remoteChange' => $failed ? null : ($cache['remoteChange'] ?? null),
            'updateAvailable' => $failed ? false : self::isNewerVersion($remote, $local),
            'source' => self::RELEASE_PROBE,
        );
    }

    /**
     * Is the published copy newer? Either signal is enough.
     *
     * This is the whole point of carrying two: a release that changes files
     * without touching the cache-buster still moves the release number, and a
     * release that bumps only the cache-buster (a UI-only change by someone who
     * forgot VERSION) is still caught by the second comparison. An unknown
     * number on either side never counts -- see isNewer.
     */
    public static function isNewerVersion($remote, $local)
    {
        return self::isNewer(self::labelOf($remote['release'] ?? null), self::labelOf($local['release'] ?? null))
            || self::isNewer(self::labelOf($remote['app'] ?? null), self::labelOf($local['app'] ?? null));
    }

    /** The numeric label out of a version shape, a bare string, or nothing. */
    public static function labelOf($v)
    {
        if (is_array($v)) {
            $v = $v['label'] ?? null;
        }
        if ($v === null || $v === '') {
            return null;
        }
        return (string) $v;
    }

    /**
     * Is $remote newer than $local? Numeric, because both labels are plain
     * integers. An unknown on either side is NOT an update: a missing number
     * must never be read as "you are out of date".
     */
    public static function isNewer($remote, $local)
    {
        $r = self::labelOf($remote);
        $l = self::labelOf($local);
        if ($r === null || $l === null || !ctype_digit($r) || !ctype_digit($l)) {
            return false;
        }
        return (int) $r > (int) $l;
    }

    /** The cached check on disk, or null. Never trusted for "this copy". */
    private static function readCheck()
    {
        $path = self::checkPath();
        if (!is_file($path)) {
            return null;
        }
        $data = json_decode((string) @file_get_contents($path), true);
        return is_array($data) ? $data : null;
    }

    /**
     * Persist the answer. Best effort on purpose: a storage/ that cannot be
     * written is a reason to probe again next load, not a reason to fail the
     * check the operator is looking at.
     */
    private static function writeCheck($result)
    {
        try {
            self::ensureWorkDir();
            $record = array(
                'checkedAt' => (int) ($result['checkedAt'] ?? time()),
                // Only the REMOTE side is remembered. "This copy" is read live
                // on every call, so a cache written before a bump cannot claim
                // the operator is out of date for an update they installed.
                'remoteRelease' => $result['remoteRelease'] ?? null,
                'remoteApp' => $result['remoteApp'] ?? null,
                'remoteChange' => $result['remoteChange'] ?? null,
                'error' => $result['error'] ?? null,
                'source' => self::RELEASE_PROBE,
            );
            @file_put_contents(self::checkPath(), json_encode($record, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        } catch (\Throwable $e) {
            // nothing to do: the answer still returns to the caller
        }
    }

    // -------------------------------------------------------------- download

    /**
     * Fetch → verify → stage → diff. Returns the plan, throws on any doubt.
     *
     * The archive is renamed into place only after it verifies, and the staging
     * tree is rebuilt from scratch each run, so a half-downloaded or rejected
     * archive cannot leave a misleading plan behind.
     */
    public static function download($url = null)
    {
        $url = $url === null || $url === '' ? self::DEFAULT_SOURCE : (string) $url;
        self::assertSafeSource($url);

        $work = self::ensureWorkDir();

        $tmp = $work . '/incoming-' . bin2hex(random_bytes(5)) . '.part';
        try {
            $got = self::fetch($url, $tmp);

            // Fresh staging every time: a stale file from a previous release
            // would otherwise look like "unchanged" and hide a real change.
            self::removeTree(self::stagingDir());
            if (!@mkdir(self::stagingDir(), 0755, true) && !is_dir(self::stagingDir())) {
                throw new \RuntimeException('Cannot create the staging folder under storage/updates.');
            }

            $extracted = self::extractVerified($tmp, self::stagingDir());
            $root = self::detectStagedRoot(self::stagingDir());

            foreach (array('index.html', 'api/index.php', 'ui/js/store.js', 'src/Sandbox.php') as $must) {
                if (!is_file($root . '/' . $must)) {
                    throw new \RuntimeException(
                        'That archive is not an Autonomous Loop Studio release (missing ' . $must . ').'
                    );
                }
            }

            @unlink(self::pendingArchive());
            if (!@rename($tmp, self::pendingArchive())) {
                throw new \RuntimeException('Downloaded the archive but could not save it under storage/updates.');
            }

            $plan = self::planFor($root, self::appDir());
            $plan['ok'] = true;
            $plan['fetchedAt'] = time();
            $plan['source'] = $url;
            $plan['finalUrl'] = $got['finalUrl'];
            $plan['bytes'] = $got['bytes'];
            $plan['sha256'] = $got['sha256'];
            $plan['entries'] = $extracted['entries'];
            $plan['targetVersion'] = self::versionIn($root);
            $plan['currentVersion'] = self::versionIn(self::appDir());
            $plan['stagedRoot'] = self::relativeTo(self::appDir(), $root);
            $plan['notes'] = self::notesFor($plan);

            @file_put_contents(self::planPath(), json_encode($plan, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
            return $plan;
        } catch (\Throwable $e) {
            @unlink($tmp);
            self::removeTree(self::stagingDir());
            throw $e;
        }
    }

    /** Delete the staged copy and the plan. The app tree is untouched. */
    public static function discard()
    {
        self::removeTree(self::stagingDir());
        @unlink(self::pendingArchive());
        @unlink(self::planPath());
        // Tidy the folder itself only if nothing else is in it.
        $left = @glob(self::workDir() . '/*');
        if (is_array($left) && count($left) === 0) {
            @rmdir(self::workDir());
        }
        return array('ok' => true, 'discarded' => true);
    }

    /** curl with https-only redirects, a size ceiling and a host check after. */
    private static function fetch($url, $dest, $timeout = 180, $allowMissing = false)
    {
        $fp = @fopen($dest, 'wb');
        if ($fp === false) {
            throw new \RuntimeException('Cannot write to storage/updates.');
        }
        $ch = curl_init($url);
        $opts = array(
            CURLOPT_FILE => $fp,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_USERAGENT => 'Autonomous-Loop-Studio-Updater',
        );
        if (defined('CURLOPT_PROTOCOLS_STR')) {
            $opts[CURLOPT_PROTOCOLS_STR] = 'https';
            $opts[CURLOPT_REDIR_PROTOCOLS_STR] = 'https';
        } elseif (defined('CURLOPT_PROTOCOLS')) {
            $opts[CURLOPT_PROTOCOLS] = CURLPROTO_HTTPS;
            $opts[CURLOPT_REDIR_PROTOCOLS] = CURLPROTO_HTTPS;
        }
        curl_setopt_array($ch, $opts);
        $ok = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $finalUrl = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        $err = curl_error($ch);
        curl_close($ch);
        fclose($fp);

        if ($err !== '') {
            throw new \RuntimeException('Download failed: ' . $err);
        }
        if ($code === 404 && $allowMissing) {
            // Not an error for a probe: the published copy simply predates
            // this file. The caller falls back to its other signal.
            return null;
        }
        if ($code !== 200) {
            throw new \RuntimeException('GitHub answered HTTP ' . $code . ' — nothing was staged.');
        }
        // A redirect can leave the allowlist; check where we actually ended up.
        self::assertSafeSource($finalUrl);

        $bytes = (int) @filesize($dest);
        if ($bytes < 1024) {
            throw new \RuntimeException('That download was empty (' . $bytes . ' bytes).');
        }
        if ($bytes > self::MAX_ARCHIVE_BYTES) {
            throw new \RuntimeException('That archive is too large (' . round($bytes / 1048576, 1) . ' MB).');
        }
        return array(
            'bytes' => $bytes,
            'sha256' => (string) hash_file('sha256', $dest),
            'finalUrl' => $finalUrl,
        );
    }

    /**
     * Read the START of a published file, stopping at a byte cap.
     *
     * Curl is handed a write callback that returns 0 once the cap is reached,
     * which aborts the transfer; that abort is an expected outcome here, not a
     * failure, so it is checked BEFORE the curl error is (curl reports it as a
     * write error, and the HTTP code is still 200).
     */
    private static function probeHead($url, $maxBytes, $timeout)
    {
        $buf = '';
        $ch = curl_init($url);
        $opts = array(
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_USERAGENT => 'Autonomous-Loop-Studio-Updater',
            CURLOPT_WRITEFUNCTION => function ($handle, $chunk) use (&$buf, $maxBytes) {
                $room = $maxBytes - strlen($buf);
                if ($room <= 0) {
                    return 0;
                }
                if (strlen($chunk) > $room) {
                    $buf .= substr($chunk, 0, $room);
                    return 0;   // the cap is reached: stop asking for more
                }
                $buf .= $chunk;
                return strlen($chunk);
            },
        );
        if (defined('CURLOPT_PROTOCOLS_STR')) {
            $opts[CURLOPT_PROTOCOLS_STR] = 'https';
            $opts[CURLOPT_REDIR_PROTOCOLS_STR] = 'https';
        } elseif (defined('CURLOPT_PROTOCOLS')) {
            $opts[CURLOPT_PROTOCOLS] = CURLPROTO_HTTPS;
            $opts[CURLOPT_REDIR_PROTOCOLS] = CURLPROTO_HTTPS;
        }
        curl_setopt_array($ch, $opts);
        curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $finalUrl = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        $err = curl_error($ch);
        curl_close($ch);

        if ($code === 404) {
            return null;   // the published copy is simply too old to have it
        }
        if ($buf !== '' && strlen($buf) >= $maxBytes) {
            self::assertSafeSource($finalUrl);
            return $buf;
        }
        if ($err !== '') {
            throw new \RuntimeException('Download failed: ' . $err);
        }
        if ($code !== 200) {
            throw new \RuntimeException('GitHub answered HTTP ' . $code . '.');
        }
        // A redirect can leave the allowlist; check where we actually ended up.
        self::assertSafeSource($finalUrl);
        return $buf;
    }

    /**
     * The top entry of a CHANGELOG: its heading, and the first paragraph under
     * it, as plain text.
     *
     * Everything above the first `## ` heading is preamble and is skipped, so
     * the file can lead with a title, notes or rules and the newest release is
     * still found. Reading stops at the next heading, which is why a 100 KB file
     * answers in one pass over its first few lines.
     *
     * Returns null when there is no entry, or when the text is not usable as
     * UTF-8 -- a mangled title would break the JSON the whole check is returned
     * in, and an unnamed release is a far smaller problem than a failed check.
     */
    public static function changelogHead($text, $titleMax = 140, $summaryMax = 240)
    {
        $entry = self::changelogEntry($text, $titleMax, $summaryMax);
        return $entry === null
            ? null
            : array('title' => $entry['title'], 'summary' => $entry['summary']);
    }

    /**
     * The whole newest entry, in the shape an expandable view needs: the title,
     * the first paragraph as a one-line summary, and every following line as its
     * own item.
     *
     * The summary is what the bell and the collapsed row say; `items` is what
     * the panel opens up to. They come from ONE pass, so the thing you expand
     * can never disagree with the thing you clicked -- the old version built only
     * the summary and the rest of the entry was simply never read.
     *
     * A line that starts with `**bold**` is split into `lead` (that bold run) and
     * `body` (the rest), so the view can bold the lead-in without ever putting
     * remote text in a position where it is parsed as HTML.
     *
     * Bounded twice over: `$maxItems` lines and `$maxChars` characters, with
     * `truncated` telling the view whether it is seeing all of it. A CHANGELOG
     * entry is a few kilobytes, but this text comes off the network and the cap
     * is what keeps that from becoming the panel's problem.
     */
    public static function changelogEntry($text, $titleMax = 140, $summaryMax = 240,
                                          $maxItems = 60, $maxChars = 4000)
    {
        $text = (string) $text;
        // Checked once, up front. A byte sequence that is not UTF-8 cannot be
        // put in the JSON the whole check comes back in, and every regex below
        // would fail on it anyway -- so refuse the file, not the response.
        if ($text !== '' && !preg_match('//u', $text)) {
            return null;
        }

        $title = null;
        $raw = array();
        // A blank line ends whatever came before it, so the next line starts a
        // new item instead of being glued onto the previous one.
        $fresh = false;
        foreach (preg_split('/\r\n|\r|\n/', $text) as $line) {
            $trimmed = trim($line);
            if ($title === null) {
                if (strpos($trimmed, '## ') === 0) {
                    $title = trim(substr($trimmed, 3));
                }
                continue;
            }
            if ($trimmed !== '' && $trimmed[0] === '#') {
                break;                        // the next entry starts here
            }
            if ($trimmed === '' || $trimmed === '---') {
                $fresh = true;
                continue;
            }
            if (preg_match('/^[-*+]\s+/', $trimmed)) {
                // Indented bullets are sub-points; the view indents them.
                $indent = strlen($line) - strlen(ltrim($line, " \t"));
                $raw[] = array(
                    'text' => (string) preg_replace('/^[-*+]\s+/', '', $trimmed),
                    'depth' => $indent >= 2 ? 1 : 0,
                );
                $fresh = false;
                continue;
            }
            // A wrapped line belongs to the item above it. Without this, every
            // line of a wrapped bullet would become its own row.
            $last = count($raw) - 1;
            if ($last < 0 || $fresh) {
                $raw[] = array('text' => $trimmed, 'depth' => 0);
            } else {
                $raw[$last]['text'] = $raw[$last]['text'] . ' ' . $trimmed;
            }
            $fresh = false;
        }

        if ($title === null) {
            return null;
        }

        $items = array();
        $chars = 0;
        $truncated = false;
        foreach ($raw as $row) {
            $body = $row['text'];
            $lead = '';
            if (preg_match('/^\*\*(.+?)\*\*/su', $body, $m)) {
                $lead = self::plainMarkdown($m[1]);
                $body = (string) preg_replace('/^\*\*(.+?)\*\*/su', '', $body);
            }
            $body = self::plainMarkdown($body);
            if ($lead === '' && $body === '') {
                continue;
            }
            $len = (int) preg_match_all('/./us', $lead . $body);
            if (count($items) >= $maxItems || $chars + $len > $maxChars) {
                $truncated = true;
                break;
            }
            $chars += $len;
            $items[] = array('lead' => $lead, 'body' => $body, 'depth' => (int) $row['depth']);
        }

        $first = $items ? $items[0] : array('lead' => '', 'body' => '');
        return array(
            'title' => self::trimToWords(self::plainMarkdown($title), $titleMax),
            'summary' => self::trimToWords(trim($first['lead'] . ' ' . $first['body']), $summaryMax),
            'items' => $items,
            'truncated' => $truncated,
        );
    }

    /** Strip the markdown a CHANGELOG entry is written in, leaving prose. */
    private static function plainMarkdown($s)
    {
        $s = (string) $s;
        $s = (string) preg_replace('/!\[[^\]]*\]\([^)]*\)/u', '', $s);            // images
        $s = (string) preg_replace('/\[([^\]]+)\]\([^)]*\)/u', '$1', $s);          // links -> text
        $s = (string) preg_replace('/`([^`]*)`/u', '$1', $s);                        // `code`
        $s = (string) preg_replace('/\*\*(.+?)\*\*/su', '$1', $s);                  // **bold**
        $s = (string) preg_replace('/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*/su', '$1', $s); // *italic*
        $s = (string) preg_replace('/^\s*[-*+]\s+/u', '', $s);                       // a bullet
        $s = (string) preg_replace('/\s+/u', ' ', $s);                               // fold wrapping
        return trim($s);
    }

    /**
     * Truncate to a character budget, at a word boundary.
     *
     * Counted in CHARACTERS, not bytes: these strings carry em dashes and
     * emoji, and a byte slice can cut one in half and produce invalid UTF-8,
     * which json_encode() then refuses outright. No mbstring needed for that.
     */
    private static function trimToWords($s, $maxLen)
    {
        if ($maxLen <= 0 || !preg_match_all('/./us', (string) $s, $m)) {
            return (string) $s;
        }
        $chars = $m[0];
        if (count($chars) <= $maxLen) {
            return (string) $s;
        }
        $cut = implode('', array_slice($chars, 0, $maxLen));
        $space = strrpos($cut, ' ');
        // Only break at a space if that keeps most of the budget; otherwise a
        // single long word (a path, a URL) would leave almost nothing.
        if ($space !== false && $space > (int) ($maxLen * 0.6)) {
            $cut = substr($cut, 0, $space);
        }
        return rtrim($cut, " \t.,;:-\u{2014}") . "\u{2026}";
    }

    /**
     * Read one small published file and return its text.
     *
     * Returns null when the published copy does not have the file at all -- a
     * release from before that file existed. That is a normal answer for the
     * release probe, not a failure, so it is NOT reported as an error: the
     * caller falls back to its other signal and the check still works.
     */
    private static function probeText($url, $timeout)
    {
        $dest = self::workDir() . '/probe-' . bin2hex(random_bytes(4)) . '.txt';
        try {
            $info = self::fetch($url, $dest, $timeout, true);
            if ($info === null) {
                return null;
            }
            return (string) @file_get_contents($dest);
        } finally {
            @unlink($dest);
        }
    }

    // ------------------------------------------------------------- extraction

    /**
     * Extract a .zip into $dest, refusing anything that could escape it.
     *
     * PharData because it opens .zip and ships with PHP; ZipArchive when it is
     * available is still preferred, since it reports entry metadata directly.
     * Returns the number of files written.
     */
    public static function extractVerified($zipPath, $dest)
    {
        $dest = rtrim(str_replace('\\', '/', $dest), '/');
        if (!is_file($zipPath)) {
            throw new \RuntimeException('There is no downloaded archive to open.');
        }

        $paths = self::archiveEntries($zipPath);
        if (!$paths) {
            throw new \RuntimeException('That file is not a readable zip archive.');
        }
        if (count($paths) > self::MAX_ENTRIES) {
            throw new \RuntimeException('That archive has too many entries (' . count($paths) . ').');
        }

        // GitHub wraps everything in ONE folder. Strip it BEFORE deciding what
        // to skip: with the wrapper still on the front, every entry's first
        // segment is `Autonomous-master`, so `storage/config.json` inside it
        // read as `Autonomous-master/config.json` and sailed past the storage
        // rule -- which then staged the published DEFAULT config right next to
        // the operator's real one, and diffed them. That is the exact accident
        // this class exists to prevent.
        $rootPrefix = self::archiveRootPrefix(array_keys($paths));

        $written = 0;
        $bytes = 0;
        foreach ($paths as $path => $reader) {
            $rel = self::safeEntryName($path);
            if ($rel === null) {
                throw new \RuntimeException('Refused: the archive contains an unsafe path (' . $path . ').');
            }
            if ($rootPrefix !== '' && strpos($rel, $rootPrefix) === 0) {
                $rel = substr($rel, strlen($rootPrefix));
            }
            if ($rel === '' || self::isNeverTouch($rel)) {
                continue;   // storage/ and friends never land. See the class note.
            }
            $target = $dest . '/' . $rel;
            $parent = dirname($target);
            if (!is_dir($parent) && !@mkdir($parent, 0755, true) && !is_dir($parent)) {
                throw new \RuntimeException('Cannot create ' . $rel . ' in the staging folder.');
            }
            // Belt and braces: the resolved target must still be under $dest.
            $resolvedParent = realpath($parent);
            if ($resolvedParent === false || strpos(str_replace('\\', '/', $resolvedParent), $dest) !== 0) {
                throw new \RuntimeException('Refused: ' . $rel . ' resolves outside the staging folder.');
            }
            $data = $reader();
            if ($data === null) {
                throw new \RuntimeException('Could not read ' . $rel . ' from the archive.');
            }
            if (@file_put_contents($target, $data) === false) {
                throw new \RuntimeException('Could not write ' . $rel . ' in the staging folder.');
            }
            $written++;
            $bytes += strlen($data);
        }

        // Belt and braces, in the one place that matters most: if a storage/
        // tree somehow appeared in the staging folder, stop rather than hand a
        // diff (or a later "apply") a copy of the published default config.
        if (is_dir($dest . '/storage')) {
            throw new \RuntimeException('Refused: the archive tried to stage a storage/ folder.');
        }

        return array('entries' => $written, 'bytes' => $bytes);
    }

    /**
     * The single wrapper folder GitHub puts every entry under, as a prefix with
     * its trailing slash, or '' when the archive has no wrapper.
     *
     * Deliberately conservative: only a directory that EVERY entry sits inside
     * qualifies, and it must not be a name the app itself uses at the top level
     * (otherwise a one-folder repo like `ui/` would be mistaken for a wrapper).
     */
    public static function archiveRootPrefix(array $paths)
    {
        $appTops = array('api', 'src', 'ui', 'tests', 'tools', 'public', 'sandbox',
            'screenshots', 'storage', 'index.html', 'serve.php', 'autoload.php');
        $first = null;
        foreach ($paths as $path) {
            $p = str_replace('\\', '/', (string) $path);
            $slash = strpos($p, '/');
            if ($slash === false) {
                return '';          // a top-level file: no wrapper
            }
            $seg = substr($p, 0, $slash);
            if ($first === null) {
                $first = $seg;
            } elseif ($seg !== $first) {
                return '';          // more than one top-level folder
            }
        }
        if ($first === null || in_array(strtolower($first), $appTops, true)) {
            return '';
        }
        return $first . '/';
    }

    /**
     * Every file in the archive, as [relative path => reader].
     *
     * Two mechanisms because the hosts differ: a stock XAMPP PHP (this project's
     * default) has no ZipArchive at all, only PharData.
     */
    private static function archiveEntries($zipPath)
    {
        $out = array();

        if (class_exists('\ZipArchive')) {
            $zip = new \ZipArchive();
            if ($zip->open($zipPath) === true) {
                for ($i = 0; $i < $zip->numFiles; $i++) {
                    $stat = $zip->statIndex($i);
                    if (!$stat || substr($stat['name'], -1) === '/') {
                        continue;
                    }
                    $name = $stat['name'];
                    $out[$name] = function () use ($zip, $i) {
                        return $zip->getFromIndex($i);
                    };
                }
                return $out;   // readers stay valid: the caller extracts immediately
            }
        }

        try {
            $phar = new \PharData($zipPath);
        } catch (\Throwable $e) {
            return array();
        }
        $prefix = str_replace('\\', '/', $zipPath);
        foreach (new \RecursiveIteratorIterator($phar, \RecursiveIteratorIterator::LEAVES_ONLY) as $file) {
            /** @var \SplFileInfo $file */
            if (!$file->isFile()) {
                continue;
            }
            $full = str_replace('\\', '/', $file->getPathname());
            $pos = strpos($full, $prefix);
            if ($pos === false) {
                // PharData reports phar://<zip>/<entry>; fall back to the marker.
                $pos = strpos($full, '.zip/');
                if ($pos === false) {
                    return array();       // cannot relate it to the archive: refuse all
                }
                $rel = substr($full, $pos + 5);
            } else {
                $rel = ltrim(substr($full, $pos + strlen($prefix)), '/');
            }
            if ($rel === '') {
                continue;
            }
            $out[$rel] = function () use ($full) {
                $data = @file_get_contents($full);
                return $data === false ? null : $data;
            };
        }
        return $out;
    }

    /**
     * A relative path that is safe to join onto a directory, or null.
     *
     * Deliberately strict: an archive entry is attacker-controlled text, and
     * the one thing this must never do is write outside storage/updates.
     */
    public static function safeEntryName($name)
    {
        $n = str_replace('\\', '/', (string) $name);
        if ($n === '' || strpos($n, "\0") !== false) {
            return null;
        }
        if (strpos($n, '://') !== false || stripos($n, 'phar:') === 0) {
            return null;   // wrappers, not paths
        }
        if ($n[0] === '/') {
            return null;   // absolute
        }
        if (preg_match('#^[A-Za-z]:#', $n)) {
            return null;   // C: drive
        }
        $parts = explode('/', $n);
        foreach ($parts as $part) {
            if ($part === '' || $part === '.' || $part === '..') {
                return null;
            }
        }
        return implode('/', $parts);
    }

    /** True for top-level names that are never staged (storage/, .git, ...). */
    private static function isNeverTouch($rel)
    {
        $first = strtolower(explode('/', $rel)[0]);
        return in_array($first, self::$neverTouch, true);
    }

    /**
     * GitHub wraps an archive in one folder (`Autonomous-master/`). Find it, so
     * the diff is against the app root rather than that wrapper.
     */
    private static function detectStagedRoot($staging)
    {
        $entries = @scandir($staging);
        if (!is_array($entries)) {
            return $staging;
        }
        $entries = array_values(array_filter($entries, fn($e) => $e !== '.' && $e !== '..'));
        if (count($entries) === 1 && is_dir($staging . '/' . $entries[0])) {
            return $staging . '/' . $entries[0];
        }
        return $staging;
    }

    // ------------------------------------------------------------------ diff

    /**
     * Classify every file: new / changed / same, plus what is on disk but not
     * in the release. Pure filesystem work — no network, no writes — so it is
     * the part that can be tested directly.
     *
     * `removed` is deliberately narrow: only inside the top-level folders the
     * release actually ships. Root-level files that are not in the archive are
     * NOT listed, because that is where an operator keeps their own notes, and
     * "we would delete your folder" is not a message this feature may send.
     */
    public static function planFor($stagedRoot, $appDir)
    {
        $stagedRoot = rtrim(str_replace('\\', '/', $stagedRoot), '/');
        $appDir = rtrim(str_replace('\\', '/', $appDir), '/');

        $staged = self::listFiles($stagedRoot);
        $files = array();
        $counts = array('new' => 0, 'changed' => 0, 'same' => 0, 'removed' => 0);
        $appDirs = array();

        foreach ($staged as $rel => $meta) {
            $top = explode('/', $rel)[0];
            // Data/doc folders are not app files: listing a README screenshot as
            // "new" pads the plan with things nobody is deciding about, and an
            // apply step should leave those alone entirely.
            if (in_array(strtolower($top), self::$noRemovalReport, true)) {
                continue;
            }
            if (strpos($rel, '/') !== false) {
                $appDirs[$top] = true;
            }
            $current = $appDir . '/' . $rel;
            if (!is_file($current)) {
                $status = 'new';
            } elseif ((int) @filesize($current) === $meta['size']
                && hash_file('sha256', $current) === $meta['sha256']) {
                $status = 'same';
            } else {
                $status = 'changed';
            }
            $counts[$status]++;
            $files[] = array(
                'path' => $rel,
                'status' => $status,
                'to' => $meta['size'],
                'from' => is_file($current) ? (int) @filesize($current) : null,
            );
        }

        // Files the release no longer contains, only within folders it ships.
        $removed = array();
        foreach (array_keys($appDirs) as $dir) {
            if (in_array(strtolower($dir), self::$neverTouch, true)
                || in_array(strtolower($dir), self::$noRemovalReport, true)) {
                continue;
            }
            foreach (self::listFiles($appDir . '/' . $dir) as $rel => $meta) {
                $full = $dir . '/' . $rel;
                if (!isset($staged[$full])) {
                    $removed[] = $full;
                }
            }
        }
        sort($removed);
        $counts['removed'] = count($removed);

        usort($files, fn($a, $b) => strcmp($a['path'], $b['path']));

        return array(
            'counts' => $counts,
            'files' => $files,
            'removed' => $removed,
        );
    }

    /** rel path => [size, sha256] for every regular file under $dir. */
    private static function listFiles($dir)
    {
        $out = array();
        if (!is_dir($dir)) {
            return $out;
        }
        $base = rtrim(str_replace('\\', '/', $dir), '/');
        $it = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($base, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::LEAVES_ONLY
        );
        foreach ($it as $file) {
            /** @var \SplFileInfo $file */
            if (!$file->isFile()) {
                continue;
            }
            $full = str_replace('\\', '/', $file->getPathname());
            $rel = ltrim(substr($full, strlen($base)), '/');
            if ($rel === '' || self::isNeverTouch($rel)) {
                continue;
            }
            $out[$rel] = array(
                'size' => (int) $file->getSize(),
                'sha256' => (string) hash_file('sha256', $full),
            );
        }
        ksort($out);
        return $out;
    }

    // --------------------------------------------------------------- versions

    /**
     * What this tree calls itself: the VERSION release number if one ships,
     * otherwise the cache-buster integer in ui/js/store.js. Read, never written.
     */
    public static function versionIn($dir)
    {
        return self::preferred(self::versionPairIn($dir));
    }

    /**
     * Both of a tree's version signals: the release number and the
     * cache-buster. Either may be null, and that is information, not an error --
     * a published copy that predates VERSION has no release number, and a tree
     * with no ui/js/store.js has no cache-buster.
     */
    public static function versionPairIn($dir)
    {
        $dir = rtrim(str_replace('\\', '/', $dir), '/');
        $versionFile = $dir . '/VERSION';
        return array(
            'release' => is_file($versionFile)
                ? self::versionFromText((string) @file_get_contents($versionFile))
                : null,
            'app' => self::cacheBusterIn($dir),
        );
    }

    /** The cache-buster integer from ui/js/store.js, or null. */
    public static function cacheBusterIn($dir)
    {
        $store = rtrim(str_replace('\\', '/', $dir), '/') . '/ui/js/store.js';
        if (!is_file($store)) {
            return null;
        }
        return self::versionFromJs((string) @file_get_contents($store));
    }

    /**
     * The release number out of a VERSION file's text.
     *
     * Blank lines and `#` / `//` comment lines are skipped, so the file can
     * explain its own rule to whoever opens it, and the first real line is the
     * number. That number must be a PLAIN INTEGER: the comparison is numeric, so
     * a dotted date like `2026.10.26` would never compare as newer. A file with
     * nothing but comments reads as no version at all, and the cache-buster is
     * used instead.
     */
    public static function versionFromText($text)
    {
        foreach (preg_split('/\r\n|\r|\n/', (string) $text) as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#' || substr($line, 0, 2) === '//') {
                continue;
            }
            return array('label' => $line, 'source' => 'VERSION');
        }
        return null;
    }

    /**
     * Collapse a version pair to the single label the UI shows, preferring the
     * release number. Also passes through a plain label/source shape, so a
     * caller holding one of those keeps working.
     */
    public static function preferred($pair)
    {
        if (!is_array($pair)) {
            return null;
        }
        if (isset($pair['label'])) {
            return $pair;
        }
        if (isset($pair['release']) && $pair['release'] !== null) {
            return $pair['release'];
        }
        return $pair['app'] ?? null;
    }

    /**
     * Pull APP_VERSION out of a store.js source text.
     *
     * Shared by the local read and the load-time probe so that "what counts as
     * this copy's version" cannot drift between the two -- the whole check is a
     * comparison, and a difference in how the two sides are parsed would be a
     * difference in the answer.
     */
    public static function versionFromJs($js)
    {
        if (preg_match('/APP_VERSION\s*=\s*(\d+)/', (string) $js, $m)) {
            return array('label' => $m[1], 'source' => 'APP_VERSION');
        }
        return null;
    }

    /** Human-readable caveats attached to a plan. */
    private static function notesFor($plan)
    {
        $notes = array();
        $notes[] = 'Nothing has been changed. This is a comparison only.';
        $notes[] = 'Nothing under storage/ is read, compared or written — the '
            . 'published copy ships a default storage/ folder and every one of its '
            . 'entries is refused during extraction.';

        $cur = $plan['currentVersion']['label'] ?? null;
        $next = $plan['targetVersion']['label'] ?? null;
        if ($cur !== null && $next !== null) {
            if ((string) $cur === (string) $next) {
                $notes[] = 'The published copy calls itself v' . $cur
                    . ', the same as this one — either you are level with master, or that '
                    . 'release did not bump the number.';
            } elseif (is_numeric($cur) && is_numeric($next) && (int) $next < (int) $cur) {
                $notes[] = 'This copy (v' . $cur . ') is AHEAD of the published one (v' . $next
                    . '): most of the differences below are work that has not been pushed yet. '
                    . 'Downloading it would take you backwards, which is why nothing is applied '
                    . 'automatically.';
            } else {
                $notes[] = 'Published: v' . $next . ' — this copy: v' . $cur . '.';
            }
        }
        if (!empty($plan['removed'])) {
            $notes[] = count($plan['removed']) . ' file(s) on disk are not in the release. '
                . 'They are listed, never deleted — nothing is removed here.';
        }

        $localOnly = array('cleancopy', 'the-copy-before-the-huge-ui-change', 'screenshots', 'sandbox');
        $present = array();
        foreach ($localOnly as $dir) {
            if (is_dir(self::appDir() . '/' . $dir)) {
                $present[] = $dir . '/';
            }
        }
        if ($present) {
            $notes[] = 'Local folders that are not part of the release are left alone: '
                . implode(', ', $present) . '.';
        }
        return $notes;
    }

    // ----------------------------------------------------------------- tools

    private static function relativeTo($root, $path)
    {
        $root = rtrim(str_replace('\\', '/', $root), '/') . '/';
        $path = str_replace('\\', '/', $path);
        return strpos($path, $root) === 0 ? substr($path, strlen($root)) : $path;
    }

    private static function removeTree($dir)
    {
        if (!is_dir($dir)) {
            return;
        }
        $it = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($it as $file) {
            /** @var \SplFileInfo $file */
            if ($file->isDir()) {
                @rmdir($file->getPathname());
            } else {
                @unlink($file->getPathname());
            }
        }
        @rmdir($dir);
    }
}
