<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Installer harness: writes a release over a throwaway app tree.
 *
 * Usage: php tests/php/install.test.php
 *
 * The real installer replaces the files it is running from, which is exactly
 * why it is dangerous and exactly why it must not be tested against the repo.
 * Here it is pointed at a temporary tree that looks like the app (VERSION,
 * ui/js/store.js, index.html, src/, storage/config.json) and made to install,
 * roll back, refuse and self-heal. Exits 0 on success, 1 on any failure.
 */

// --- bootstrap --------------------------------------------------------
require_once __DIR__ . '/../../autoload.php';

use Src\Install;

$pass = 0;
$fail = 0;
$errors = [];

function ok($cond, $name)
{
    global $pass, $fail, $errors;
    if ($cond) { $pass++; }
    else { $fail++; $errors[] = "FAIL: $name"; }
}

function throws($fn, $name, $needle = '')
{
    try {
        $fn();
        ok(false, "$name (expected exception)");
    } catch (\Throwable $e) {
        if ($needle === '' || stripos($e->getMessage(), $needle) !== false) {
            ok(true, $name);
        } else {
            ok(false, "$name (bad message: {$e->getMessage()})");
        }
    }
}

function rmTree($dir)
{
    if (!is_dir($dir)) { return; }
    foreach ((array) scandir($dir) as $e) {
        if ($e === '.' || $e === '..') { continue; }
        $p = $dir . '/' . $e;
        is_dir($p) ? rmTree($p) : @unlink($p);
    }
    @rmdir($dir);
}

function put($path, $data)
{
    @mkdir(dirname($path), 0777, true);
    file_put_contents($path, $data);
}

/**
 * Build a fake app plus a fake staged release.
 *
 * $stagedVersion is what the archive SAYS it is, $targetVersion is what the
 * plan claims — they are separate on purpose so the post-install check can be
 * tested with a mismatch.
 */
function build($app, $targetVersion, $stagedVersion = null, $extraFiles = [])
{
    rmTree($app);
    $staged = $app . '/storage/updates/staging/Autonomous-master';

    put($app . '/VERSION', "353\n");
    put($app . '/ui/js/store.js', "const APP_VERSION = 351;\n");
    put($app . '/index.html', "<h1>old</h1>\n");
    put($app . '/src/Thing.php', "<?php // old\n");
    put($app . '/storage/config.json', '{"token":"SECRET-TOKEN","sandbox":{"exec_enabled":false}}');
    @mkdir($app . '/storage/updates', 0777, true);

    put($staged . '/VERSION', ($stagedVersion ?? $targetVersion) . "\n");
    put($staged . '/ui/js/store.js', "const APP_VERSION = 352;\n");
    put($staged . '/index.html', "<h1>new</h1>\n");
    put($staged . '/src/Thing.php', "<?php // new\n");
    put($staged . '/src/BrandNew.php', "<?php // added by the release\n");
    // The published repo ships a default storage/ folder. It must never land.
    put($staged . '/storage/config.json', '{"token":"PUBLISHED-DEFAULT"}');

    $files = [
        ['path' => 'index.html', 'status' => 'changed', 'from' => 15, 'to' => 15],
        ['path' => 'src/Thing.php', 'status' => 'changed', 'from' => 16, 'to' => 16],
        ['path' => 'src/BrandNew.php', 'status' => 'new', 'from' => null, 'to' => 30],
        ['path' => 'VERSION', 'status' => 'changed', 'from' => 4, 'to' => 4],
        ['path' => 'ui/js/store.js', 'status' => 'changed', 'from' => 27, 'to' => 27],
        ['path' => 'src/Unchanged.php', 'status' => 'same', 'from' => 5, 'to' => 5],
        // A hand-written plan is untrusted input: this entry is the attack.
        ['path' => 'storage/config.json', 'status' => 'changed', 'from' => 50, 'to' => 20],
    ];
    foreach ($extraFiles as $f) { $files[] = $f; }

    put($app . '/storage/updates/plan.json', json_encode([
        'ok' => true,
        'stagedRoot' => 'storage/updates/staging/Autonomous-master',
        'targetVersion' => ['label' => (string) $targetVersion],
        'currentVersion' => ['label' => '353'],
        'counts' => ['new' => 1, 'changed' => 4, 'same' => 1, 'removed' => 0],
        'files' => $files,
    ], JSON_PRETTY_PRINT));
}

// --- temp environment -------------------------------------------------
$pid = getmypid();
$tmp = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-install-test-' . $pid;
$app = $tmp . '/app';
rmTree($tmp);
@mkdir($tmp, 0777, true);

Install::useRoot($app);

echo "Installer test\n";
echo str_repeat('-', 50) . "\n";

// --- 1. preflight says no before anything is downloaded ---------------
build($app, '354');
@unlink($app . '/storage/updates/plan.json');
rmTree($app . '/storage/updates/staging');
$pre = Install::preflight();
ok($pre['ok'] === false, 'preflight fails with nothing staged');
ok(stripos(implode(' ', $pre['problems']), 'No update is downloaded') !== false,
    'preflight names the missing download');
throws(fn() => Install::apply(), 'apply refuses with nothing staged', 'No update is downloaded');

// --- 2. a normal install ----------------------------------------------
build($app, '354');
$pre = Install::preflight();
ok($pre['ok'] === true, 'preflight passes with a staged release');
ok($pre['targetVersion'] === '354', 'preflight reports the target version');
ok($pre['writable'] === true, 'preflight sees a writable app folder');

$res = Install::apply();
ok($res['ok'] === true, 'install returns ok');
ok($res['installed'] === 5, 'install wrote five files (the "same" entry skipped)');
ok(trim((string) file_get_contents($app . '/index.html')) === '<h1>new</h1>', 'index.html was replaced');
ok(trim((string) file_get_contents($app . '/VERSION')) === '354', 'VERSION now says 354');
ok(is_file($app . '/src/BrandNew.php'), 'a file the release added landed');
ok(trim((string) file_get_contents($app . '/src/Thing.php')) === '<?php // new', 'an existing file was replaced');

// The rule the whole feature rests on.
$cfg = (string) file_get_contents($app . '/storage/config.json');
ok(strpos($cfg, 'SECRET-TOKEN') !== false, 'storage/config.json still holds the real token');
ok(strpos($cfg, 'PUBLISHED-DEFAULT') === false, 'the published default config never landed');

// No half-written siblings left behind.
$left = glob($app . '/**/.router-new-*');
$deep = [];
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($app, FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) {
    if (strpos($f->getFilename(), '.router-new-') === 0) { $deep[] = (string) $f; }
}
ok(count($deep) === 0, 'no .router-new- scratch files survive a successful install');

// The rollback copy and the journal.
ok(is_dir($app . '/storage/backups'), 'storage/backups was created');
$snaps = Install::snapshots();
ok(count($snaps) === 1, 'exactly one rollback copy exists');
ok(is_file($snaps[0]['dir'] . '/manifest.json'), 'the rollback copy has a manifest');
ok(is_file($snaps[0]['dir'] . '/storage/config.json') === false,
    'the rollback copy does not contain storage/');
$log = (string) file_get_contents($app . '/storage/updates/install.log');
ok(strpos($log, 'install start') !== false, 'the journal records the start');
ok(strpos($log, 'install done') !== false, 'the journal records the finish');

// The download is spent: staging and plan are gone, the log is not.
ok(!is_dir($app . '/storage/updates/staging'), 'staging was cleaned up after the install');
ok(!is_file($app . '/storage/updates/plan.json'), 'the plan was cleaned up after the install');
ok(is_file($app . '/storage/updates/install.log'), 'the journal survived the cleanup');
ok(!is_file($app . '/storage/updates/install.lock'), 'the lock was released');

// --- 3. rollback -------------------------------------------------------
$res = Install::rollback($snaps[0]['dir']);
ok($res['ok'] === true, 'rollback returns ok');
ok(trim((string) file_get_contents($app . '/index.html')) === '<h1>old</h1>', 'rollback restored index.html');
ok(trim((string) file_get_contents($app . '/VERSION')) === '353', 'rollback restored VERSION 353');
ok(trim((string) file_get_contents($app . '/src/Thing.php')) === '<?php // old', 'rollback restored an existing file');
ok(strpos((string) file_get_contents($app . '/storage/config.json'), 'SECRET-TOKEN') !== false,
    'rollback did not touch storage/');
ok(is_file($app . '/src/BrandNew.php'), 'rollback deletes nothing (new files stay, inert)');

// --- 4. rollback refuses a folder outside storage/backups --------------
$rogue = $tmp . '/rogue';
put($rogue . '/manifest.json', json_encode(['files' => ['index.html' => ['size' => 3, 'sha256' => 'x']]]));
put($rogue . '/index.html', 'evil');
throws(fn() => Install::rollback($rogue), 'rollback refuses a folder outside storage/backups', 'Refused');

// --- 5. a plan that writes storage/ is refused file by file -----------
build($app, '355');
$res = Install::apply();
$cfg = (string) file_get_contents($app . '/storage/config.json');
ok(strpos($cfg, 'SECRET-TOKEN') !== false, 'a hand-written plan cannot reach storage/');
ok(strpos((string) file_get_contents($app . '/storage/updates/install.log'), 'REFUSED') !== false,
    'the refusal is written to the journal');

// --- 6. a release that lies about its version is rolled back ----------
build($app, '356', '999');
throws(fn() => Install::apply(), 'a version mismatch aborts the install', 'Rolled back');
ok(trim((string) file_get_contents($app . '/VERSION')) === '353',
    'the mismatch left the previous version in place');
ok(trim((string) file_get_contents($app . '/index.html')) === '<h1>old</h1>',
    'the mismatch restored the old files');
$marker = json_decode((string) file_get_contents($app . '/storage/updates/install.json'), true);
ok(is_array($marker) && ($marker['phase'] ?? '') === 'rolled-back',
    'the marker records that the tree was rolled back');

// --- 7. a stale lock does not wedge the installer ---------------------
build($app, '357');
// The lock ages by its mtime, not by what it contains — writing an old
// timestamp into the file makes it look brand new. Backdate the file itself.
$stale = $app . '/storage/updates/install.lock';
file_put_contents($stale, '99999 ' . (time() - 5000));
@touch($stale, time() - 5000);
$pre = Install::preflight();
ok($pre['busy'] === false, 'a lock older than the TTL is not treated as running');
$res = Install::apply();
ok($res['ok'] === true, 'install proceeds past a stale lock');

// A fresh lock does stop it.
build($app, '358');
file_put_contents($app . '/storage/updates/install.lock', (string) getmypid() . ' ' . time());
$pre = Install::preflight();
ok($pre['busy'] === true, 'a fresh lock reads as busy');
throws(fn() => Install::apply(), 'apply refuses while another install holds the lock', 'already running');

// --- 8. snapshots are pruned -----------------------------------------
build($app, '359');
for ($i = 0; $i < 4; $i++) {
    Install::snapshot();
    sleep(1);
}
ok(count(Install::snapshots()) <= Install::BACKUP_KEEP, 'old rollback copies are pruned');

// --- report -----------------------------------------------------------
rmTree($tmp);
Install::useRoot(null);

echo "\n{$pass} passed, {$fail} failed\n";
if ($fail) {
    foreach ($errors as $e) { echo $e . "\n"; }
    exit(1);
}
exit(0);
