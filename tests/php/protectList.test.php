<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * The protected-path deny list, enforced on every way into a file.
 *
 * Usage: php tests/php/protectList.test.php
 *
 * read_file and write_file always went through jail(), which refuses storage/,
 * .git, .env* and the key files. Two other doors into the same bytes did not:
 *
 *   - the shell's argument guard only compared an argument against the roots,
 *     so `cat storage/config.json` printed the access token and every provider
 *     key -- on a copy whose root is the whole app folder, which is the default
 *     once shell access is enabled;
 *   - grep walked the roots with a directory iterator and read each file
 *     directly, and glob filtered on the jail alone, so the grep tool could
 *     read the same file and the glob tool could name it.
 *
 * Exits 0 on success, 1 on any failure.
 */

$root = dirname(__DIR__, 2);
require $root . '/autoload.php';

use Src\Sandbox;

$pass = 0;
$fail = 0;
$errors = array();

function ok($cond, $name)
{
    global $pass, $fail, $errors;
    if ($cond) {
        $pass++;
        return true;
    }
    $fail++;
    $errors[] = 'FAIL: ' . $name;
    return false;
}

function eq($a, $b, $name)
{
    return ok($a === $b, $name . ' (got ' . var_export($a, true) . ', want ' . var_export($b, true) . ')');
}

echo "protect list tests\n";

// A stand-in for the app: one ordinary file, one src file, and the secrets the
// deny list exists to hide.
$base = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-protect-' . getmypid();
$app = $base . '/app';
foreach (array($app . '/storage', $app . '/src', $base . '/logs') as $d) {
    @mkdir($d, 0775, true);
}
file_put_contents($app . '/storage/config.json', json_encode(array('sandbox' => array('token' => 'MARKER'))) . "\n");
file_put_contents($app . '/src/app.js', "const MARKER = 'MARKER';\n");
file_put_contents($app . '/notes.txt', "MARKER in the open\n");
file_put_contents($app . '/.env', "SECRET=MARKER\n");

$configFile = $base . '/config.json';
file_put_contents($configFile, json_encode(array('sandbox' => array(
    'read_roots' => array($app),
    'write_roots' => array($app),
    'require_token' => false,
    'token' => '',
    'exec_enabled' => true,
    'code_enabled' => false,
))));
putenv('ROUTER_CONFIG=' . $configFile);
// Keep a refused command's audit line out of the real storage/ when this file
// is run by hand rather than through run.php.
putenv('ROUTER_LOG_DIR=' . $base . '/logs');

// --- the file tools still refuse it -----------------------------------------
$refused = '';
try {
    Sandbox::readFile('storage/config.json');
} catch (\RuntimeException $e) {
    $refused = $e->getMessage();
}
ok(strpos($refused, 'protected') !== false, 'read_file: storage/config.json stays on the protected list');

// --- grep does not read it ---------------------------------------------------
$g = Sandbox::grepCode('MARKER');
$rels = array();
foreach ($g['matches'] as $m) { $rels[] = $m['rel']; }
ok(!in_array('storage/config.json', $rels, true), 'grep: storage/config.json is never scanned');
ok(!in_array('.env', $rels, true), 'grep: .env is never scanned');
ok(in_array('src/app.js', $rels, true), 'grep: an ordinary file in the root is still scanned');
ok(in_array('notes.txt', $rels, true), 'grep: a top-level file is still scanned');

// --- glob does not name them -------------------------------------------------
$storage = Sandbox::globFiles('storage/*.json');
eq($storage['count'], 0, 'glob: storage/*.json matches nothing');
$src = Sandbox::globFiles('src/*.js');
ok($src['count'] === 1 && strpos($src['matches'][0], 'app.js') !== false,
    'glob: src/*.js still matches');

// --- the shell guard refuses the same paths ---------------------------------
$denied = Sandbox::execCommand(array('cat', 'storage/config.json'), array('cwd' => $app));
ok(empty($denied['ok']) && stripos((string)$denied['stderr'], 'protected') !== false,
    'exec: cat storage/config.json is refused by the protect list');

$absolute = Sandbox::execCommand(array('cat', $app . '/storage/config.json'), array('cwd' => $app));
ok(empty($absolute['ok']) && stripos((string)$absolute['stderr'], 'protected') !== false,
    'exec: an absolute protected path is refused too');

$dotenv = Sandbox::execCommand(array('cat', '.env'), array('cwd' => $app));
ok(empty($dotenv['ok']) && stripos((string)$dotenv['stderr'], 'protected') !== false,
    'exec: a dotfile on the protect list is refused');

// The point is the secrets, not the command: an ordinary file must still pass
// the path guard. Whether `cat` itself resolves on this host is not the subject.
$open = Sandbox::execCommand(array('cat', 'notes.txt'), array('cwd' => $app));
ok(stripos((string)$open['stderr'], 'protected') === false,
    'exec: an ordinary file is not refused by the protect list');

// --- cleanup ----------------------------------------------------------------
foreach (array($app . '/storage/config.json', $app . '/src/app.js',
    $app . '/notes.txt', $app . '/.env', $configFile) as $f) {
    @unlink($f);
}
foreach (array($app . '/storage', $app . '/src', $base . '/logs', $app, $base) as $d) {
    @rmdir($d);
}

echo str_repeat('-', 60) . "\n";
foreach ($errors as $e) { echo $e . "\n"; }
echo "protectList: {$pass} passed, {$fail} failed\n";
exit($fail ? 1 : 0);
