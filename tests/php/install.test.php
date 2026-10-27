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

// Never let an install in this file start a detached finisher: the tests below
// run the generated script themselves, and a background child would race them
// for the same temporary tree.
define('INSTALL_NO_SPAWN', true);

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

// --- 6b. a file that cannot be swapped is deferred, never destroyed ----
//
// This is the bug the first real run found on Windows: api/index.php cannot be
// renamed over while the request that is executing it holds the handle, and the
// old fallback (unlink the target, try again) left the entry point simply gone.
// A directory standing where the target should be makes the rename fail on any
// platform, which is the same code path.
build($app, '360');
@unlink($app . '/ui/js/store.js');
@mkdir($app . '/ui/js/store.js', 0777, true);
$res = Install::apply();
ok(in_array('ui/js/store.js', $res['deferred']), 'an unswappable file is deferred rather than fatal');
ok(is_dir($app . '/ui/js/store.js'), 'the target that could not be replaced is still there');
ok($res['finishing'] === true, 'the install reports itself as still finishing');
ok(is_file($app . '/ui/js/.router-new-store.js'), 'the new copy is waiting beside it');
ok(in_array('ui/js/store.js', Install::pendingSwaps()), 'the waiting swap is discoverable');
ok(strpos((string) file_get_contents($app . '/storage/updates/install.log'), 'deferred') !== false,
    'the deferral is written to the journal');
$marker = json_decode((string) file_get_contents($app . '/storage/updates/install.json'), true);
ok(($marker['phase'] ?? '') === 'finishing', 'the marker says finishing, not done');
ok(trim((string) file_get_contents($app . '/VERSION')) === '360', 'the files that could be written were');
ok(trim((string) file_get_contents($app . '/index.html')) === '<h1>new</h1>', 'other files still installed');

// Once nothing holds it, finish() puts it in place and closes the marker.
rmTree($app . '/ui/js/store.js');
$fin = Install::finish(1);
ok(in_array('ui/js/store.js', $fin['swapped']), 'finish swaps the deferred file in');
ok(is_file($app . '/ui/js/store.js'), 'the swap produced the real file');
ok(strpos((string) file_get_contents($app . '/ui/js/store.js'), '352') !== false,
    'the swapped file is the release copy, not the old one');
ok(Install::pendingSwaps() === [], 'nothing is left pending');
$marker = json_decode((string) file_get_contents($app . '/storage/updates/install.json'), true);
ok(($marker['phase'] ?? '') === 'done', 'the marker moves to done once the last file lands');
ok(($fin['ok'] ?? false) === true, 'finish reports success');

// --- 6c. the generated finisher stands alone --------------------------
//
// It has to: the release replaces src/ and install-update.php, so a finisher
// that called back into either would be running code that no longer exists.
// This runs it by hand, as its own process, and checks it does the swap, keeps
// the journal and deletes itself.
// The waiting swap is set up by hand rather than by running an install: an
// install also SPAWNS the finisher, and a test that races a real child process
// for the same file proves nothing about either of them.
build($app, '361');
put($app . '/ui/js/.router-new-store.js', "const APP_VERSION = 999;\n");

$writer = new ReflectionMethod('Src\Install', 'writeFinisher');
$writer->setAccessible(true);
$script = $writer->invoke(null, Install::pendingSwaps());
ok(is_string($script) && is_file($script), 'a standalone finisher script is generated');
$body = (string) file_get_contents($script);
ok(strpos($body, '.router-new-store.js') !== false && strpos($body, 'ui/js/store.js') !== false,
    'the script carries its own list of swaps');
ok(strpos($body, 'autoload.php') === false && strpos($body, 'require ') === false,
    'it loads nothing from the app the update replaces');

$out = [];
$code = 0;
exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($script) . ' 2>&1', $out, $code);
ok($code === 0, 'the finisher runs clean as its own process (' . implode(' ', $out) . ')');
ok(is_file($app . '/ui/js/store.js'), 'it swapped the deferred file in');
ok(strpos((string) file_get_contents($app . '/ui/js/store.js'), '999') !== false,
    'the swapped file is the waiting copy, not the old one');
ok(Install::pendingSwaps() === [], 'nothing is left waiting');
ok(!is_file($script), 'it deleted itself when it was done');
ok(strpos((string) file_get_contents($app . '/storage/updates/install.log'), 'finish:') !== false,
    'it wrote to the same journal');

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
