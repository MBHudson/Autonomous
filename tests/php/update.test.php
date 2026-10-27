<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Update download: verification and diff logic.
 *
 * Usage: php tests/php/update.test.php
 *
 * The network half is exercised by the app itself (a real GitHub archive was
 * downloaded and diffed while this was built); what is tested here is the part
 * that has to be right every time and cannot be seen by looking at a plan:
 *
 *   - entry names are resolved by hand, so `..`, absolute paths and drive
 *     letters are refused rather than written;
 *   - the single wrapper folder GitHub adds is stripped BEFORE the storage rule
 *     runs. It was not, at first: entries read as `Autonomous-master/storage/
 *     config.json`, the storage rule never fired, and the published copy's
 *     DEFAULT config was staged next to the operator's real one and diffed
 *     against it. That is the regression this file exists for;
 *   - the diff classifies new/changed/same, and never reports anything under
 *     storage/ or inside a data folder like screenshots/ as removable.
 *
 * Exits 0 on success, 1 on any failure.
 */

require_once __DIR__ . '/../../autoload.php';

use Src\Update;

$pass = 0;
$fail = 0;
$skips = 0;
$errors = array();

function ok($cond, $name, &$pass, &$fail, &$errors)
{
    if ($cond) {
        $pass++;
        return true;
    }
    $fail++;
    $errors[] = 'FAIL: ' . $name;
    return false;
}

function throws($fn, $name, $needle, &$pass, &$fail, &$errors)
{
    try {
        $fn();
    } catch (\Throwable $e) {
        return ok(stripos($e->getMessage(), $needle) !== false,
            $name . ' (message: ' . $e->getMessage() . ')', $pass, $fail, $errors);
    }
    return ok(false, $name . ' (expected an exception)', $pass, $fail, $errors);
}

$tmp = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-update-test-' . getmypid();
@mkdir($tmp, 0777, true);

// ------------------------------------------------------------ entry names
$goodNames = array('index.html', '.htaccess', 'ui/js/app.js', 'a/b/c.txt', 'ui/vendor/three/three.module.min.js');
foreach ($goodNames as $name) {
    ok(Update::safeEntryName($name) === $name, 'accepts a normal entry name: ' . $name, $pass, $fail, $errors);
}

$badNames = array(
    '../evil.txt'          => 'parent traversal',
    '/etc/passwd'          => 'absolute path',
    'C:\\Windows\\x.exe'   => 'drive letter',
    'a/../../b.txt'        => 'nested traversal',
    'a//b.txt'             => 'empty segment',
    './a.txt'              => 'dot segment',
    'a/b/..'               => 'trailing parent',
    ''                     => 'empty name',
    "a\0b.txt"             => 'NUL byte',
    'phar://x/y.zip/z.txt' => 'stream wrapper',
);
foreach ($badNames as $name => $why) {
    ok(Update::safeEntryName($name) === null, 'refuses ' . $why . ' (' . str_replace("\0", '\\0', $name) . ')', $pass, $fail, $errors);
}

// --------------------------------------------------------- wrapper folder
ok(Update::archiveRootPrefix(array('Autonomous-master/index.html', 'Autonomous-master/ui/x.js')) === 'Autonomous-master/',
    'detects the GitHub wrapper folder', $pass, $fail, $errors);
ok(Update::archiveRootPrefix(array('index.html', 'ui/x.js')) === '',
    'no wrapper when a file sits at the top level', $pass, $fail, $errors);
ok(Update::archiveRootPrefix(array('ui/a.js', 'api/b.php')) === '',
    'no wrapper when entries span several top-level folders', $pass, $fail, $errors);
ok(Update::archiveRootPrefix(array('storage/config.json', 'storage/exec.log')) === '',
    'an app folder name is never mistaken for a wrapper', $pass, $fail, $errors);

// ----------------------------------------------------------------- version
$vVersion = $tmp . '/v-version';
@mkdir($vVersion . '/ui/js', 0777, true);
file_put_contents($vVersion . '/VERSION', "1.4.0\n");
file_put_contents($vVersion . '/ui/js/store.js', 'export const APP_VERSION = 900;');
$got = Update::versionIn($vVersion);
ok(($got['label'] ?? null) === '1.4.0' && ($got['source'] ?? null) === 'VERSION',
    'a VERSION file wins over the cache-buster', $pass, $fail, $errors);

$vStore = $tmp . '/v-store';
@mkdir($vStore . '/ui/js', 0777, true);
file_put_contents($vStore . '/ui/js/store.js', 'export const APP_VERSION = 342;');
$got = Update::versionIn($vStore);
ok(($got['label'] ?? null) === '342' && ($got['source'] ?? null) === 'APP_VERSION',
    'falls back to APP_VERSION in store.js', $pass, $fail, $errors);

ok(Update::versionIn($tmp . '/nope') === null, 'a tree with no version reads as null', $pass, $fail, $errors);

// ------------------------------------------------------------------- diff
$staged = $tmp . '/staged';
$app = $tmp . '/app';
$write = function ($dir, $rel, $body) {
    $full = $dir . '/' . $rel;
    @mkdir(dirname($full), 0777, true);
    file_put_contents($full, $body);
};
// The release
$write($staged, 'index.html', 'same page');
$write($staged, 'api/a.php', 'new body of a');
$write($staged, 'api/sub/new.php', 'brand new');
$write($staged, 'storage/config.json', '{"defaults":true}');      // must be ignored
$write($staged, 'screenshots/shot.png', 'release image');
// This install
$write($app, 'index.html', 'same page');
$write($app, 'api/a.php', 'old body of a');
$write($app, 'api/sub/old.php', 'gone from the release');
$write($app, 'storage/config.json', '{"mine":true,"token":"secret"}');   // must be ignored
$write($app, 'screenshots/mine.png', 'my own screenshot');               // must not be "removed"

$plan = Update::planFor($staged, $app);
$byPath = array();
foreach ($plan['files'] as $f) {
    $byPath[$f['path']] = $f['status'];
}

ok(($byPath['index.html'] ?? null) === 'same', 'identical file is "same"', $pass, $fail, $errors);
ok(($byPath['api/a.php'] ?? null) === 'changed', 'different body is "changed"', $pass, $fail, $errors);
ok(($byPath['api/sub/new.php'] ?? null) === 'new', 'absent on disk is "new"', $pass, $fail, $errors);
ok(!isset($byPath['storage/config.json']), 'storage/ never appears in the diff', $pass, $fail, $errors);
ok(!isset($byPath['screenshots/shot.png']), 'a data folder is not diffed either', $pass, $fail, $errors);
ok($plan['counts']['new'] === 1 && $plan['counts']['changed'] === 1 && $plan['counts']['same'] === 1,
    'counts add up (' . json_encode($plan['counts']) . ')', $pass, $fail, $errors);
ok(in_array('api/sub/old.php', $plan['removed'], true),
    'a file dropped by the release is listed as not-in-update', $pass, $fail, $errors);
ok(!in_array('screenshots/mine.png', $plan['removed'], true),
    'the operator\'s own screenshots are not called removable', $pass, $fail, $errors);
ok(!in_array('storage/config.json', $plan['removed'], true)
    && strpos(implode("\n", $plan['removed']), 'storage/') === false,
    'storage/ is never listed as removable', $pass, $fail, $errors);

// ------------------------------------------------------------- source guard
$default = Update::DEFAULT_SOURCE;
ok(Update::assertSafeSource($default) === $default, 'the published archive URL is allowed', $pass, $fail, $errors);
ok(Update::assertSafeSource('https://raw.githubusercontent.com/MBHudson/Autonomous/master/VERSION') !== '',
    'raw.githubusercontent is allowed', $pass, $fail, $errors);

throws(fn() => Update::assertSafeSource('http://codeload.github.com/x.zip'),
    'plain http is refused', 'must be an https URL', $pass, $fail, $errors);
throws(fn() => Update::assertSafeSource('https://example.com/x.zip'),
    'an unrelated host is refused', 'not a release host', $pass, $fail, $errors);
throws(fn() => Update::assertSafeSource('https://user:pass@codeload.github.com/x.zip'),
    'credentials in the URL are refused', 'must not carry credentials', $pass, $fail, $errors);
throws(fn() => Update::assertSafeSource('https://codeload.github.com:8443/x.zip'),
    'a non-443 port is refused', 'port 443', $pass, $fail, $errors);
throws(fn() => Update::download('https://example.com/x.zip'),
    'download refuses a bad host before touching the disk', 'not a release host', $pass, $fail, $errors);

// --------------------------------------------------- archive read (no net)
// PharData can build a zip even with phar.readonly=1 (that flag is for Phar).
$zipPath = $tmp . '/sample.zip';
$made = false;
try {
    @unlink($zipPath);
    $z = new \PharData($zipPath, 0, null, \Phar::ZIP);
    $z->addFromString('Autonomous-master/index.html', 'page');
    $z->addFromString('Autonomous-master/api/index.php', '<?php');
    $z->addFromString('Autonomous-master/ui/js/store.js', 'export const APP_VERSION = 999;');
    $z->addFromString('Autonomous-master/src/Sandbox.php', '<?php');
    $z->addFromString('Autonomous-master/storage/config.json', '{"defaults":true}');
    unset($z);
    $made = true;
} catch (\Throwable $e) {
    $skips++;
    echo 'SKIP: cannot build a zip here (' . $e->getMessage() . ")\n";
}

if ($made) {
    $dest = $tmp . '/extracted';
    @mkdir($dest, 0777, true);
    $res = Update::extractVerified($zipPath, $dest);
    ok(is_file($dest . '/index.html'), 'the wrapper folder is stripped during extraction', $pass, $fail, $errors);
    ok(is_file($dest . '/api/index.php') && is_file($dest . '/src/Sandbox.php'),
        'real app files land in the staging folder', $pass, $fail, $errors);
    ok(!is_dir($dest . '/storage'),
        'the archive\'s storage/ is refused, not staged', $pass, $fail, $errors);
    ok($res['entries'] === 4, 'entry count excludes the refused storage file (got ' . $res['entries'] . ')',
        $pass, $fail, $errors);
    $v = Update::versionIn($dest);
    ok(($v['label'] ?? null) === '999', 'the staged tree reports its own version', $pass, $fail, $errors);

    // A hostile name must be refused even if a zip somehow contains one. The
    // exact message is not the point (PharData may not even reopen a zip it
    // wrote such a name into); "refused, nothing escaped" is.
    $evilZip = $tmp . '/evil.zip';
    $built = false;
    try {
        @unlink($evilZip);
        $z = new \PharData($evilZip, 0, null, \Phar::ZIP);
        $z->addFromString('../escaped.txt', 'x');
        unset($z);
        $built = true;
    } catch (\Throwable $e) {
        // phar refusing to create the name is also a fine outcome.
    }
    if ($built) {
        $threw = false;
        try {
            Update::extractVerified($evilZip, $tmp . '/evil-out');
        } catch (\Throwable $e) {
            $threw = true;
        }
        ok($threw, 'an archive with a traversal entry is refused', $pass, $fail, $errors);
        ok(!is_file($tmp . '/escaped.txt'), 'nothing was written outside the staging folder', $pass, $fail, $errors);
    } else {
        $skips++;
        echo "SKIP: phar refused to build a traversal entry\n";
    }
}

// ------------------------------------------------------ the load-time check
//
// This is the half that runs on EVERY page load, so what matters most is not
// that it can reach GitHub but that it knows when NOT to ask, and that it can
// never throw at boot. `applyCache` is that whole decision, kept pure so it can
// be tested here with no network and no disk. As with the download half, the
// live call itself is exercised by the app, not by this file.
// A "this copy" pair: the release number and the cache-buster. They start out
// equal, and diverge the moment a release touches no browser file -- which is
// the case this whole second signal exists for.
$local = array(
    'release' => array('label' => '345', 'source' => 'VERSION'),
    'app' => array('label' => '345', 'source' => 'APP_VERSION'),
);
$localAhead = array(
    'release' => array('label' => '400', 'source' => 'VERSION'),
    'app' => array('label' => '400', 'source' => 'APP_VERSION'),
);
$now = 1793000000;

ok(Update::versionFromJs('export const APP_VERSION = 345;') === array('label' => '345', 'source' => 'APP_VERSION'),
    'versionFromJs reads the version out of a store.js', $pass, $fail, $errors);
ok(Update::versionFromJs("// no version here\nlet x = 1;\n") === null,
    'versionFromJs returns null for a file without a version', $pass, $fail, $errors);
// A quoted NUMBER, not just junk: the published file writes an unquoted
// integer, and this asserts the reader stays that strict. (An earlier version
// of this very test used "not-a-number", which passes whether or not the
// reader tolerates quotes -- it had no digits to find either way.)
ok(Update::versionFromJs('export const APP_VERSION = "345";') === null,
    'a quoted version is not mistaken for a number', $pass, $fail, $errors);
ok(Update::versionFromJs('const APP_VERSION = 345;') === array('label' => '345', 'source' => 'APP_VERSION'),
    'an indented or const (non-export) declaration is still read', $pass, $fail, $errors);

// The comparison has to be right in BOTH directions. The published release can
// be BEHIND a development copy -- it was for this entire feature (published
// v337 against this copy at v344) -- and an arrow-style "v344 -> v337" would
// then read as an upgrade when it is the opposite.
ok(Update::isNewer('350', '344') === true, 'a higher published version is an update', $pass, $fail, $errors);
ok(Update::isNewer('344', '344') === false, 'an equal version is not an update', $pass, $fail, $errors);
ok(Update::isNewer('337', '344') === false, 'a LOWER published version is not an update', $pass, $fail, $errors);
ok(Update::isNewer(null, '344') === false, 'an unknown published version is not an update', $pass, $fail, $errors);
ok(Update::isNewer('350', null) === false, 'an unknown local version is not an update', $pass, $fail, $errors);
ok(Update::isNewer(array('label' => '350'), array('label' => '344')) === true,
    'the array shape versionIn returns is accepted', $pass, $fail, $errors);

// The fixture deliberately carries a STALE localVersion. Nothing today writes
// that key, but if the cache ever started recording "this copy" it must still
// not be believed -- so the assertion below is made against a cache that would
// give the wrong answer if it were read.
$fresh = array(
    'checkedAt' => $now - 60,
    'remoteRelease' => array('label' => '351', 'source' => 'VERSION'),
    'remoteApp' => array('label' => '350', 'source' => 'APP_VERSION'),
    'localVersion' => array('label' => '340', 'source' => 'APP_VERSION'),
    'error' => null,
);
ok(Update::applyCache(null, $local, $now) === null, 'no cache at all means ask now', $pass, $fail, $errors);

$hit = Update::applyCache($fresh, $local, $now);
ok(is_array($hit) && $hit['cached'] === true && $hit['updateAvailable'] === true,
    'a fresh check answers without asking GitHub again', $pass, $fail, $errors);

// The reason "this copy" is read live instead of stored: the local number moves
// the moment the UI is bumped, and a cached "this copy is v344" would keep
// announcing an update that had already been installed.
$hit = Update::applyCache($fresh, $localAhead, $now);
ok(is_array($hit) && $hit['updateAvailable'] === false && ($hit['localVersion']['label'] ?? null) === '400',
    'a cached answer is re-compared against the CURRENT local version', $pass, $fail, $errors);

// The TTL boundaries are measured from the cache's OWN timestamp, so these two
// fixtures are stamped at $now rather than 60 seconds before it. (Getting that
// wrong makes a boundary test pass by accident: a fixture a minute old is
// already outside a TTL as short as the 15-minute failure window.)
$freshNow = array(
    'checkedAt' => $now,
    'remoteRelease' => array('label' => '351', 'source' => 'VERSION'),
    'remoteApp' => array('label' => '350', 'source' => 'APP_VERSION'),
    'error' => null,
);
ok(Update::applyCache($freshNow, $local, $now + Update::CHECK_TTL - 1) !== null,
    'a check one second inside its TTL is still trusted', $pass, $fail, $errors);
ok(Update::applyCache($freshNow, $local, $now + Update::CHECK_TTL) === null,
    'a check exactly at its TTL expires', $pass, $fail, $errors);

// A failure is cached too, but far more briefly. Without caching it at all, an
// offline machine pays the connect timeout on every single reload; with the
// full TTL it would stay blind for six hours after the network came back.
$failed = array(
    'checkedAt' => $now - 60,
    'remoteRelease' => null,
    'remoteApp' => null,
    'error' => 'Download failed: Could not resolve host',
);
$miss = Update::applyCache($failed, $local, $now);
ok(is_array($miss) && $miss['ok'] === false && $miss['updateAvailable'] === false,
    'a cached failure is reported as a failure, not as "no update available"', $pass, $fail, $errors);
ok(is_string($miss['error']) && $miss['error'] !== '', 'a cached failure keeps its reason', $pass, $fail, $errors);
ok(Update::CHECK_FAIL_TTL < Update::CHECK_TTL,
    'a failure is remembered for less time than a success', $pass, $fail, $errors);
$failedNow = array('checkedAt' => $now, 'remoteRelease' => null, 'remoteApp' => null, 'error' => 'Download failed: Could not resolve host');
ok(Update::applyCache($failedNow, $local, $now + Update::CHECK_FAIL_TTL - 1) !== null,
    'a recent failure is reused instead of retried', $pass, $fail, $errors);
ok(Update::applyCache($failedNow, $local, $now + Update::CHECK_FAIL_TTL) === null,
    'a failed check is retried once the short TTL passes', $pass, $fail, $errors);
ok(Update::applyCache($failedNow, $local, $now + Update::CHECK_TTL) === null,
    'a failed check is never trusted for the full TTL', $pass, $fail, $errors);

// Clock trouble and malformed records. A timestamp in the future would
// otherwise pin one answer forever.
// This fixture carries a perfectly good remote version on purpose: with an
// empty one it would be rejected by the "no version is not an answer" rule
// underneath, and the test would pass without ever exercising the clock guard
// it is named for.
// array_merge, not `+`: with `+` the left operand wins on a duplicate key, so
// the future timestamp would never be applied and this would test nothing.
ok(Update::applyCache(array_merge($freshNow, array('checkedAt' => $now + 600)), $local, $now) === null,
    'a timestamp from the future is treated as stale', $pass, $fail, $errors);
ok(Update::applyCache(array('checkedAt' => 0, 'remoteRelease' => null, 'remoteApp' => null, 'error' => null), $local, $now) === null,
    'a missing timestamp is treated as stale', $pass, $fail, $errors);
ok(Update::applyCache(array('checkedAt' => $now - 60, 'remoteRelease' => null, 'remoteApp' => null, 'error' => null), $local, $now) === null,
    'a "success" carrying no version is not an answer', $pass, $fail, $errors);

// The probe must survive the same source rules as the download, or the
// allowlist and the check would disagree about where a release may live.
foreach (array('the release probe' => Update::RELEASE_PROBE, 'the cache-buster probe' => Update::APP_PROBE) as $what => $url) {
    try {
        Update::assertSafeSource($url);
        ok(true, $what . ' is an allowed source', $pass, $fail, $errors);
    } catch (\Throwable $e) {
        ok(false, $what . ' is an allowed source (' . $e->getMessage() . ')', $pass, $fail, $errors);
    }
}
ok(strpos(str_replace('\\', '/', Update::checkPath()), 'storage/updates') !== false,
    'the check cache lives inside storage/updates, never in the app tree', $pass, $fail, $errors);

// --- the release number: a second, independent signal ---------------------
//
// The whole reason VERSION exists. The cache-buster answers "would a browser
// load a stale asset?", which is NOT the same question as "is there a new
// release?", and using it for the second question meant a PHP-only release
// could never be announced at all.
ok(Update::versionFromText("# comment\n\n345\n") === array('label' => '345', 'source' => 'VERSION'),
    'versionFromText skips comments and blank lines', $pass, $fail, $errors);
ok(Update::versionFromText("// comment\n7\n99\n") === array('label' => '7', 'source' => 'VERSION'),
    'versionFromText takes the FIRST real line', $pass, $fail, $errors);
ok(Update::versionFromText("# nothing but comments\n\n") === null,
    'a VERSION file with only comments reads as no version', $pass, $fail, $errors);
ok(Update::versionFromText("2026.10.26\n") === array('label' => '2026.10.26', 'source' => 'VERSION'),
    'a dotted date is still returned as a label', $pass, $fail, $errors);
ok(Update::isNewer('2026.10.27', '2026.10.26') === false,
    'a dotted date never compares as newer -- which is WHY VERSION must be an integer', $pass, $fail, $errors);

// versionPairIn reads both signals out of one tree.
$pairTree = $tmp . '/pair-tree';
@mkdir($pairTree . '/ui/js', 0777, true);
file_put_contents($pairTree . '/VERSION', "# release\n346\n");
file_put_contents($pairTree . '/ui/js/store.js', 'export const APP_VERSION = 345;');
$pair = Update::versionPairIn($pairTree);
ok(($pair['release']['label'] ?? null) === '346' && ($pair['app']['label'] ?? null) === '345',
    'versionPairIn reads the release number and the cache-buster separately', $pass, $fail, $errors);
ok((Update::preferred($pair)['label'] ?? null) === '346',
    'the release number is what the UI is shown', $pass, $fail, $errors);

// A tree with no VERSION is the pre-VERSION case, and must keep working.
@unlink($pairTree . '/VERSION');
$pair = Update::versionPairIn($pairTree);
// Not `$pair['release'] ?? 'x'`: the key is always PRESENT and null when there
// is no VERSION file, and `??` treats a null value as absent, so that form
// could never match either way.
ok(array_key_exists('release', $pair) && $pair['release'] === null && ($pair['app']['label'] ?? null) === '345',
    'a tree without VERSION has no release number', $pass, $fail, $errors);
ok((Update::versionIn($pairTree)['label'] ?? null) === '345',
    'versionIn still answers for a tree without VERSION', $pass, $fail, $errors);

// --- either signal is enough to announce a release ------------------------
ok(Update::isNewerVersion(array('release' => '346', 'app' => '345'), array('release' => '345', 'app' => '345')) === true,
    'a newer RELEASE alone is an update (the PHP-only release case)', $pass, $fail, $errors);
ok(Update::isNewerVersion(array('release' => '345', 'app' => '346'), array('release' => '345', 'app' => '345')) === true,
    'a newer CACHE-BUSTER alone is an update', $pass, $fail, $errors);
ok(Update::isNewerVersion(array('release' => '345', 'app' => '345'), array('release' => '345', 'app' => '345')) === false,
    'identical signals are not an update', $pass, $fail, $errors);
ok(Update::isNewerVersion(array('release' => '337', 'app' => '337'), array('release' => '345', 'app' => '345')) === false,
    'a published copy behind on BOTH signals is not an update', $pass, $fail, $errors);
ok(Update::isNewerVersion(array('release' => null, 'app' => '350'), array('release' => '345', 'app' => '345')) === true,
    'a published copy with no VERSION yet is judged on its cache-buster', $pass, $fail, $errors);
ok(Update::isNewerVersion(array('release' => '346', 'app' => null), array('release' => '345', 'app' => '345')) === true,
    'a published VERSION with an unreachable store.js still announces the release', $pass, $fail, $errors);
ok(Update::isNewerVersion(array('release' => null, 'app' => null), array('release' => '345', 'app' => '345')) === false,
    'no remote signal at all is never an update', $pass, $fail, $errors);

// --- cached records, both shapes ------------------------------------------
// The record written by this version of the code, and one written before
// VERSION existed -- whose `remoteVersion` was the cache-buster. The old shape
// has to keep answering, or every install probes again on the first load after
// an upgrade (harmless, but pointless).
$oldShape = array('checkedAt' => $now - 60, 'remoteVersion' => array('label' => '350', 'source' => 'APP_VERSION'), 'error' => null);
ok((Update::applyCache($oldShape, $local, $now)['updateAvailable'] ?? null) === true,
    'a cache written before VERSION existed is still read, as the cache-buster', $pass, $fail, $errors);

$releaseOnly = array('checkedAt' => $now - 60, 'remoteRelease' => array('label' => '346', 'source' => 'VERSION'), 'error' => null);
ok((Update::applyCache($releaseOnly, $local, $now)['updateAvailable'] ?? null) === true,
    'a cached RELEASE with no cache-buster is still an answer', $pass, $fail, $errors);

$sameBoth = array(
    'checkedAt' => $now - 60,
    'remoteRelease' => array('label' => '345', 'source' => 'VERSION'),
    'remoteApp' => array('label' => '345', 'source' => 'APP_VERSION'),
    'error' => null,
);
ok((Update::applyCache($sameBoth, $local, $now)['updateAvailable'] ?? null) === false,
    'a cached copy that matches on both signals is not an update', $pass, $fail, $errors);

// --- naming the release: the top CHANGELOG entry --------------------------
//
// The notification says WHAT shipped, read from the top of the published
// CHANGELOG. That file is large, its shape belongs to the maintainer, and every
// release appends to the top of it -- so the reader has to be fussy about where
// the newest entry starts and, more easily got wrong, where it STOPS.
$log = "# Changelog\n\nPreamble that is not an entry.\n\n---\n\n"
    . "## \u{1F389} First entry \u{2014} with a title\n\n"
    . "- **Why.** A reason long enough to matter, padded out across\n"
    . "  a wrapped line so the folding has to be undone \u{2014} see [the file](x.md)\n"
    . "  and `storage/updates` for it.\n"
    . "- **What.** The second bullet, which must not be in the summary.\n\n"
    . "## Second entry\n\n- nope\n";
$head = Update::changelogHead($log);
ok(($head['title'] ?? null) === "\u{1F389} First entry \u{2014} with a title",
    'the title is the FIRST ## heading, with the preamble skipped', $pass, $fail, $errors);
ok(strpos($head['summary'] ?? '', 'a wrapped line so the folding has to be undone') !== false,
    'wrapped lines are folded back into one line', $pass, $fail, $errors);
ok(strpos($head['summary'] ?? '', 'padded out across') !== false,
    'the whole first bullet is kept', $pass, $fail, $errors);
// The bug this section exists for: entries are a bullet list with NO blank line
// between bullets, so "stop at the first blank line" ran on through the whole
// entry and the summary came back reading "... - **What.** ...".
ok(strpos($head['summary'] ?? '', 'What.') === false,
    'the summary stops at the second bullet', $pass, $fail, $errors);
ok(strpos($head['summary'] ?? '', 'Second entry') === false,
    'the summary never reaches the next entry', $pass, $fail, $errors);
// Every marker, not just "**": with the bold rule removed the ITALIC rule still
// swallows one of the two stars, so a check for "**" specifically passes while a
// stray "*" sits in the notification. Asserting on the markers themselves is
// what makes this test able to fail.
$marks = ($head['title'] ?? '') . ($head['summary'] ?? '');
ok(strpos($marks, '*') === false && strpos($marks, '`') === false,
    'no markdown emphasis or code markers survive', $pass, $fail, $errors);
ok(strpos($marks, '](x.md)') === false && strpos($marks, 'the file') !== false,
    'a link keeps its text and loses its target', $pass, $fail, $errors);

// A heading with no blank line before it. Rare in a well-kept file, but it is
// the only case that reaches the heading guard -- with a blank line above, or a
// second bullet, one of the other two rules stops the summary first, which is
// why removing this guard broke no test until this fixture existed.
$tight = Update::changelogHead("# Changelog\n\n## First\n\nProse with no blank line after it.\n## Second\n\n- nope\n");
ok(strpos($tight['summary'] ?? '', 'Second') === false,
    'a heading with no blank line before it still ends the entry', $pass, $fail, $errors);

ok(Update::changelogHead("no heading here\n- just a bullet\n") === null,
    'a file with no ## heading is not an entry', $pass, $fail, $errors);
ok(Update::changelogHead('') === null, 'an empty file is not an entry', $pass, $fail, $errors);
$bare = Update::changelogHead("## Title only\n");
ok(($bare['title'] ?? null) === 'Title only' && ($bare['summary'] ?? 'x') === '',
    'an entry with no body still names the release', $pass, $fail, $errors);

// --- the WHOLE entry, for the expandable view -----------------------------
//
// The collapsed row needs one line; "What's new" opened needs the rest of the
// entry, which the old reader never even looked at. Both come out of one pass,
// so what you expand cannot disagree with what you clicked -- and the line
// between the two is exactly what these assertions pin down.
$entry = Update::changelogEntry($log);
ok(count($entry['items'] ?? array()) === 2,
    'the whole entry is two bullets, not just the one the summary used', $pass, $fail, $errors);
ok(($entry['items'][0]['lead'] ?? null) === 'Why.',
    'a bold lead-in is split off the bullet', $pass, $fail, $errors);
ok(strpos($entry['items'][0]['body'] ?? '', 'a wrapped line so the folding has to be undone') !== false,
    'the expanded body keeps a wrapped bullet as one item', $pass, $fail, $errors);
ok(strpos($entry['items'][1]['body'] ?? '', 'The second bullet') !== false,
    'the second bullet is present when expanded, though it is not the summary', $pass, $fail, $errors);
ok(strpos($entry['summary'] ?? '', 'The second bullet') === false,
    'the one-line summary still holds only the first bullet', $pass, $fail, $errors);
$flat = json_encode($entry['items'] ?? array());
ok(strpos((string) $flat, 'Second entry') === false,
    'expansion stops at the next entry', $pass, $fail, $errors);
ok(strpos((string) $flat, '*') === false && strpos((string) $flat, '`') === false,
    'every expanded line is plain text: no emphasis or code markers', $pass, $fail, $errors);
ok(strpos((string) $flat, '](x.md)') === false,
    'a link keeps its text and loses its target here too', $pass, $fail, $errors);
ok(($entry['truncated'] ?? null) === false,
    'a normal entry is not reported as truncated', $pass, $fail, $errors);

// Wrapped continuation vs. a new paragraph: a blank line ends the item above it,
// a wrapped line does not. Getting this backwards either glues every bullet into
// one paragraph or splits every wrapped line into its own row.
$prose = Update::changelogEntry("## P\n\nFirst para.\n\nSecond para.\n");
ok(count($prose['items'] ?? array()) === 2,
    'a blank line starts a new item', $pass, $fail, $errors);

// A sub-bullet is indented, and the view needs to know that.
$nested = Update::changelogEntry("## N\n\n- **Top.** One.\n  - **Sub.** Two.\n");
ok(($nested['items'][0]['depth'] ?? null) === 0 && ($nested['items'][1]['depth'] ?? null) === 1,
    'an indented bullet is marked as a sub-point', $pass, $fail, $errors);

// A bullet that is nothing but its bold lead-in: the split must not invent a body.
$leadOnly = Update::changelogEntry("## L\n\n- **Only the lead.**\n");
ok(($leadOnly['items'][0]['lead'] ?? null) === 'Only the lead.'
    && ($leadOnly['items'][0]['body'] ?? null) === '',
    'a bullet with no body keeps its lead and gets no invented text', $pass, $fail, $errors);

// Both caps, because the text arrives over the network: too many items and too
// many characters are separate ways for a long entry to become the panel's
// problem. Each sets `truncated`, which is how the view knows to say so.
$few = Update::changelogEntry($log, 140, 240, 1);
ok(count($few['items']) === 1 && $few['truncated'] === true,
    'the item cap stops the list and reports it', $pass, $fail, $errors);
$tiny = Update::changelogEntry($log, 140, 240, 60, 1);
ok(count($tiny['items']) === 0 && $tiny['truncated'] === true,
    'the character cap stops the list and reports it', $pass, $fail, $errors);
ok(Update::changelogEntry("## bad \xFF\xFE byte\n\n- x\n") === null,
    'the expanded reader refuses non-UTF-8 for the same reason the summary does', $pass, $fail, $errors);

// The old entry point still answers with EXACTLY the two keys it always did: the
// bell and the cached record were built against that shape.
ok(array_keys(Update::changelogHead($log) ?? array()) === array('title', 'summary'),
    'changelogHead keeps its two-key contract', $pass, $fail, $errors);
ok((Update::changelogHead($log)['summary'] ?? '') === ($entry['summary'] ?? 'x'),
    'the summary is identical from either entry point -- one pass, not two', $pass, $fail, $errors);

// A summary is capped so a notification cannot turn into a paragraph -- and the
// cut is counted in CHARACTERS. A byte slice through an em dash or an emoji
// yields text json_encode() refuses, which would take the whole check response
// down with it, not just the name.
//
// Three fixtures, because ONE cannot pin this down: an even-split fixture (all
// 2-byte or all 3-byte characters) lands on a character boundary whether the cut
// counts bytes or characters, so it passes either way and proves nothing.

// 1. A run of em dashes prefixed by a single ASCII byte, so a 240-BYTE cut lands
//    in the middle of a character.
$midChar = Update::changelogHead("## Short\n\n- x" . str_repeat("\u{2014}", 400));
ok(preg_match('//u', (string) $midChar['summary']) === 1,
    'a truncated summary is still valid UTF-8', $pass, $fail, $errors);
ok(json_encode($midChar) !== false,
    'the parsed entry survives json_encode, which is how the check comes back', $pass, $fail, $errors);

// 2. No spaces to break at, so the cut can only count: 240 CHARACTERS plus the
//    ellipsis, exactly. Counted in bytes it would come back 121.
$exact = Update::changelogHead("## Short\n\n- " . str_repeat("\u{00E9}", 400));
$exactChars = preg_match_all('/./us', (string) $exact['summary'], $m);
ok($exactChars === 241,
    'a summary is capped at its character budget (' . $exactChars . ', expected 241)', $pass, $fail, $errors);

// 3. With spaces, the break pulls back to a word boundary -- but still from a
//    CHARACTER budget, so it lands near 240 rather than near 160.
$wordy = Update::changelogHead("## Short\n\n- " . str_repeat("\u{00E9} ", 200));
$wordyChars = preg_match_all('/./us', (string) $wordy['summary'], $m);
ok($wordyChars >= 200,
    'a word-boundary break still spends most of the character budget (' . $wordyChars . ')', $pass, $fail, $errors);

// Not UTF-8 at all: refused, rather than half-mangled into the response. (This
// assertion failed silently at first: the invalid bytes were being dropped by a
// failing regex rather than by the guard, so the guard was never tested.)
ok(Update::changelogHead("## bad \xFF\xFE byte\n\n- x\n") === null,
    'text that is not UTF-8 is refused rather than smuggled into the JSON', $pass, $fail, $errors);

// --- the name survives the cache -----------------------------------------
$named = array(
    'checkedAt' => $now - 60,
    'remoteRelease' => array('label' => '346', 'source' => 'VERSION'),
    'remoteApp' => array('label' => '345', 'source' => 'APP_VERSION'),
    'remoteChange' => array('title' => 'Something shipped', 'summary' => 'And here is why.'),
    'error' => null,
);
ok((Update::applyCache($named, $local, $now)['remoteChange']['title'] ?? null) === 'Something shipped',
    'a cached check keeps the name of the release', $pass, $fail, $errors);
$noName = Update::applyCache($failedNow, $local, $now);
ok($noName['ok'] === false && empty($noName['remoteChange']),
    'a cached failure carries no release name', $pass, $fail, $errors);

// --- the shipped VERSION file ---------------------------------------------
//
// The guard that keeps the two signals honest. A release that bumps the
// cache-buster and forgets VERSION has made its own release invisible to the
// check, and this assertion is what says so now rather than months later.
$shipped = Update::versionFromText((string) @file_get_contents(Update::appDir() . '/VERSION'));
ok($shipped !== null, 'the app ships a readable VERSION file', $pass, $fail, $errors);
ok($shipped !== null && ctype_digit($shipped['label']),
    'the shipped VERSION is a plain integer', $pass, $fail, $errors);
$buster = Update::labelOf(Update::cacheBusterIn(Update::appDir()));
ok($shipped !== null && $buster !== null && (int) $shipped['label'] >= (int) $buster,
    'the release number is never behind the cache-buster (VERSION ' . ($shipped['label'] ?? '?')
    . ' vs APP_VERSION ' . ($buster ?? '?') . ')', $pass, $fail, $errors);

// ---------------------------------------------------------------- cleanup
$rm = function ($dir) use (&$rm) {
    if (!is_dir($dir)) return;
    foreach (array_diff(scandir($dir), array('.', '..')) as $e) {
        $p = $dir . '/' . $e;
        is_dir($p) ? $rm($p) : @unlink($p);
    }
    @rmdir($dir);
};
$rm($tmp);

echo str_repeat('-', 60) . "\n";
if ($fail) {
    echo implode("\n", $errors) . "\n";
    echo $fail . ' failed, ' . $pass . ' passed' . ($skips ? ', ' . $skips . ' skipped' : '') . "\n";
    exit(1);
}
echo $pass . ' passed' . ($skips ? ', ' . $skips . ' skipped' : '') . "\n";
