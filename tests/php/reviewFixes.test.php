<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Regressions from the harness review.
 *
 * Usage: php tests/php/reviewFixes.test.php
 *
 * Each check names a bug that shipped:
 *   - insert and apply_patch rewrote a CRLF file with LF endings, so one edit
 *     turned every line into a diff on a Windows checkout;
 *   - the Claude models received the global 16384 output ceiling, which the
 *     older ones reject outright (400, and a 400 is not retryable);
 *   - a local runner on the LAN was paced at the generic 20 requests/minute,
 *     because only localhost and 127.0.0.1 were recognised as local;
 *   - an Anthropic reply split across several text blocks came back as the
 *     first block only.
 *
 * Exits 0 on success, 1 on any failure.
 */

$root = dirname(__DIR__, 2);
require $root . '/autoload.php';

use Src\Harness;
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

echo "reviewFixes tests\n";

// --- line endings survive an edit -------------------------------------------
$dir = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-review-' . getmypid() . '/w';
@mkdir($dir, 0775, true);

// Sandbox only writes inside a root it was told about, so this file declares
// one of its own the way sandbox.test.php does.
$configFile = dirname($dir) . '/config.json';
file_put_contents($configFile, json_encode(array('sandbox' => array(
    'read_roots' => array($dir),
    'write_roots' => array($dir),
    'require_token' => false,
    'token' => '',
    'code_enabled' => false,
    'exec_enabled' => false,
))));
putenv('ROUTER_CONFIG=' . $configFile);

file_put_contents($dir . '/crlf.txt', "alpha\r\nbeta\r\ngamma\r\n");
Sandbox::insertAt('crlf.txt', 2, 'inserted', $dir);
$afterInsert = file_get_contents($dir . '/crlf.txt');
ok(strpos($afterInsert, "\r\n") !== false, 'insert: a CRLF file keeps its CRLF endings');
eq($afterInsert, "alpha\r\nbeta\r\ninserted\r\ngamma\r\n", 'insert: the line lands after line 2, endings intact');

file_put_contents($dir . '/lf.txt', "alpha\nbeta\n");
Sandbox::insertAt('lf.txt', 1, 'ins', $dir);
eq(file_get_contents($dir . '/lf.txt'), "alpha\nins\nbeta\n", 'insert: an LF file stays LF');

file_put_contents($dir . '/patch.txt', "one\r\ntwo\r\nthree\r\n");
Sandbox::applyPatch(
    "*** Begin Patch\n*** Update File: patch.txt\n@@\n one\n-two\n+TWO\n three\n*** End Patch\n",
    $dir
);
eq(file_get_contents($dir . '/patch.txt'), "one\r\nTWO\r\nthree\r\n",
    'apply_patch: a CRLF file keeps its endings');

foreach (glob($dir . '/*') ?: array() as $f) { @unlink($f); }
@rmdir($dir);
@unlink($configFile);
@rmdir(dirname($dir));

// --- output ceilings per model ----------------------------------------------
eq(Harness::capMaxTokens('anthropic', 'claude-3-5-sonnet-20241022', 16384), 8192,
    'cap: claude-3-5-sonnet clamps to 8192');
eq(Harness::capMaxTokens('anthropic', 'claude-3-opus-20240229', 16384), 4096,
    'cap: claude-3-opus clamps to 4096');
eq(Harness::capMaxTokens('anthropic', 'claude-sonnet-4-5', 16384), 16384,
    'cap: a Claude 4 model keeps 16384');
eq(Harness::capMaxTokens('anthropic', 'claude-3-5-haiku-20241022', 100), 100,
    'cap: never raises a smaller request');

// --- local runners are not paced --------------------------------------------
eq(Harness::defaultRpmFor('http://192.168.1.50:1234/v1/chat/completions'), 0,
    'rpm: a LAN runner is unpaced');
eq(Harness::defaultRpmFor('http://workstation:8080/v1/chat/completions'), 0,
    'rpm: a single-label host is unpaced');
eq(Harness::defaultRpmFor('http://[::1]:11434/api/chat'), 0,
    'rpm: IPv6 loopback is unpaced');
eq(Harness::defaultRpmFor('https://api.groq.com/openai/v1/chat/completions'), 30,
    'rpm: a cloud host keeps its published ceiling');
ok(Harness::isLocalHost('10.0.0.4'), 'isLocalHost: 10.x is local');
ok(Harness::isLocalHost('172.20.1.1'), 'isLocalHost: 172.16/12 is local');
ok(!Harness::isLocalHost('172.32.1.1'), 'isLocalHost: 172.32 is not private');
ok(!Harness::isLocalHost('api.openai.com'), 'isLocalHost: a public host is not local');

// --- every Anthropic text block, not just the first -------------------------
eq(Harness::content(array('content' => array(
    array('type' => 'text', 'text' => 'part one '),
    array('type' => 'thinking', 'thinking' => 'working'),
    array('type' => 'text', 'text' => 'part two'),
)), 'anthropic'), 'part one part two', 'content: every text block is kept');

// --- detection still sees the Gemini URL the preset ships with --------------
eq(Harness::detect(array(
    'endpoint' => 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    'model' => 'gemini-2.0-flash',
)), 'google', 'detect: the Google preset endpoint is still the google family');

echo str_repeat('-', 60) . "\n";
foreach ($errors as $e) { echo $e . "\n"; }
echo "reviewFixes: {$pass} passed, {$fail} failed\n";
exit($fail ? 1 : 0);
