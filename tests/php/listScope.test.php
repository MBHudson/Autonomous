<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * list_dir and a refused per-agent root.
 *
 * Usage: php tests/php/listScope.test.php
 *
 * An agent bound to a directory outside the allowlist used to get the scope
 * refusal from list_dir("") before the call could return the allowed roots --
 * the one answer that would let it recover. The refusal now names the roots it
 * was checked against, and an empty path returns them with the refusal attached
 * instead of throwing. A real path under a bad scope still throws.
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

echo "list scope tests\n";

$base = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-listscope-' . getmypid();
$app = $base . '/app';
$outside = $base . '/outside';
@mkdir($app . '/storage', 0775, true);
@mkdir($outside, 0775, true);
file_put_contents($app . '/notes.txt', "notes\n");

$configFile = $base . '/config.json';
file_put_contents($configFile, json_encode(array('sandbox' => array(
    'read_roots' => array($app),
    'write_roots' => array($app),
    'require_token' => false,
    'token' => '',
    'exec_enabled' => false,
    'code_enabled' => false,
))));
putenv('ROUTER_CONFIG=' . $configFile);

// --- an empty path with a refused scope still orients the caller ------------
$dirs = Sandbox::listDir(null, 200, $outside);
ok(isset($dirs['dirs']) && $dirs['dirs'] === array($app),
    'an empty path returns the allowed roots even when the scope is refused');
ok(stripos((string)($dirs['warning'] ?? ''), 'outside the allowed roots') !== false,
    'the refusal is reported alongside the roots');
ok(stripos((string)($dirs['warning'] ?? ''), $app) !== false,
    'the refusal names the allowed root it was checked against');
ok(stripos((string)($dirs['hint'] ?? ''), 'sandbox root') !== false,
    'the hint says the agent root is what needs fixing');

// --- a normal orientation call is unchanged --------------------------------
$plain = Sandbox::listDir('', 200, null);
ok(($plain['dirs'] ?? null) === array($app), 'an empty path with no scope lists the roots');
ok(!isset($plain['warning']), 'a healthy scope carries no warning');

// --- a valid scope narrows to itself ---------------------------------------
$narrow = Sandbox::listDir('', 200, $app);
ok(($narrow['dirs'] ?? null) === array($app), 'a valid scope narrows the returned roots');

// --- a real path under a refused scope still throws, with the roots named ---
$threw = null;
try {
    Sandbox::listDir('notes.txt', 200, $outside);
} catch (\RuntimeException $e) {
    $threw = $e->getMessage();
}
ok($threw !== null, 'a path call with a refused scope still throws');
ok(stripos((string)$threw, 'Allowed:') !== false, 'that refusal names the allowed roots');
ok(stripos((string)$threw, $app) !== false, 'that refusal names the root itself');

// --- cleanup ----------------------------------------------------------------
rmTree($base);

echo str_repeat('-', 60) . "\n";
foreach ($errors as $e) { echo $e . "\n"; }
echo "listScope: $pass passed, $fail failed\n";
exit($fail ? 1 : 0);
