<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Recursive exec readers and the protect list.
 *
 * Usage: php tests/php/recursiveRead.test.php
 *
 * The argument guard sees the directory a command is handed, not the files the
 * command opens for itself. `grep -rn token .` therefore passed every filename
 * check and read storage/config.json anyway. A known walker is now refused when
 * the directory it was pointed at contains a protected entry; narrowing the
 * argument is the fix the message names. Non-recursive commands are untouched.
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

function rmTree($path)
{
    if (is_link($path) || is_file($path)) { @unlink($path); return; }
    if (!is_dir($path)) { return; }
    foreach (array_diff(@scandir($path) ?: array(), array('.', '..')) as $name) {
        rmTree($path . '/' . $name);
    }
    @rmdir($path);
}

echo "recursive read tests\n";

$base = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-recursive-' . getmypid();
$app = $base . '/app';
foreach (array($app . '/storage', $app . '/src', $base . '/logs') as $d) {
    @mkdir($d, 0775, true);
}
file_put_contents($app . '/storage/config.json', "{\"token\":\"MARKER\"}\n");
file_put_contents($app . '/src/ok.txt', "MARKER in the open\n");
file_put_contents($app . '/notes.txt', "plain notes\n");

$configFile = $base . '/config.json';
file_put_contents($configFile, json_encode(array('sandbox' => array(
    'read_roots' => array($app),
    'write_roots' => array($app),
    'require_token' => false,
    'token' => '',
    'exec_enabled' => true,
    'exec_allow' => array('grep', 'du', 'cat', 'ls', 'git'),
    'exec_approval' => false,
    'code_enabled' => false,
))));
putenv('ROUTER_CONFIG=' . $configFile);
putenv('ROUTER_LOG_DIR=' . $base . '/logs');

// --- a walker over a tree that holds a protected entry ----------------------
$grep = Sandbox::execCommand(array('grep', '-r', 'MARKER', '.'), array('cwd' => $app));
ok(empty($grep['ok']), 'grep -r over the app root is refused');
ok(stripos((string)$grep['stderr'], 'walks directories') !== false,
    'the refusal says the command walks directories');
ok(stripos((string)$grep['stderr'], 'protected') !== false,
    'the refusal names the protected list');
ok(stripos((string)$grep['stderr'], 'storage') !== false,
    'the refusal names the entry it found');
ok(stripos((string)$grep['stderr'], 'Arguments that are paths must stay') === false,
    'a recursive refusal does not carry the unrelated jail sentence');

// --- the same walker, narrowed ---------------------------------------------
$narrow = Sandbox::execCommand(array('grep', '-r', 'MARKER', 'src'), array('cwd' => $app));
ok(stripos((string)$narrow['stderr'], 'walks directories') === false,
    'grep -r over a clean subdirectory is not refused for walking');
ok(stripos((string)$narrow['stderr'], 'protected') === false,
    'grep -r over a clean subdirectory is not refused as protected');

// --- another walker, with a different argv shape ----------------------------
// `find` would be the natural second case but cannot be the vehicle: the
// default denylist refuses it before the path guard runs, because it can carry
// -exec. du takes its directory in the same leading position and is allowed.
$du = Sandbox::execCommand(array('du', '-a', '.'), array('cwd' => $app));
ok(empty($du['ok']) && stripos((string)$du['stderr'], 'walks directories') !== false,
    'du over the app root is refused');

// --- a non-recursive command is untouched -----------------------------------
$cat = Sandbox::execCommand(array('cat', 'notes.txt'), array('cwd' => $app));
ok(stripos((string)$cat['stderr'], 'walks directories') === false,
    'cat on an ordinary file is not treated as a walker');
ok(stripos((string)$cat['stderr'], 'protected') === false,
    'cat on an ordinary file is not refused');

// --- the protected path itself is still refused directly ---------------------
$direct = Sandbox::execCommand(array('grep', 'MARKER', 'storage/config.json'), array('cwd' => $app));
ok(empty($direct['ok']) && stripos((string)$direct['stderr'], 'protected') !== false,
    'a protected file named outright is still refused');

// --- git grep names no path and still walks the checkout --------------------
$git = Sandbox::execCommand(array('git', 'grep', 'MARKER'), array('cwd' => $app));
ok(empty($git['ok']) && stripos((string)$git['stderr'], 'walks directories') !== false,
    'git grep with no path is refused over the app root');

$gitNarrow = Sandbox::execCommand(array('git', 'grep', 'MARKER', 'src'), array('cwd' => $app));
ok(stripos((string)$gitNarrow['stderr'], 'walks directories') === false,
    'git grep narrowed to a clean subdirectory is not refused');

// --- a tree too large to finish checking is refused, not waved through -------
$big = $app . '/big';
@mkdir($big, 0775, true);
for ($i = 0; $i < 2100; $i++) { file_put_contents($big . '/f' . $i . '.txt', 'x'); }
$large = Sandbox::execCommand(array('du', '-a', 'big'), array('cwd' => $app));
ok(empty($large['ok']) && stripos((string)$large['stderr'], 'too large') !== false,
    'a walker over a tree past the scan limit is refused rather than passed');

// --- cleanup ----------------------------------------------------------------
rmTree($base);

echo str_repeat('-', 60) . "\n";
foreach ($errors as $e) { echo $e . "\n"; }
echo "recursiveRead: $pass passed, $fail failed\n";
exit($fail ? 1 : 0);
