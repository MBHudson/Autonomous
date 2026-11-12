<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fresh-config test: a copy with no storage/config.json, and a copy whose
 * storage/ cannot be written.
 *
 * Usage: php tests/php/freshConfig.test.php
 *
 * storage/config.json is git-ignored, so NO clone, zip or release archive
 * contains it -- every install starts without one and the first request is
 * meant to write it. That write was unchecked: on a copy where the web server
 * could not write storage/ (files uploaded by root, or by a hosting account
 * other than the one PHP runs as) it failed silently, the read that followed
 * warned "No such file or directory", and the caller got null instead of a
 * config. The install looked broken; only a folder's owner was wrong.
 *
 * Asserted here:
 *
 *   * a missing config is created, and what is returned is what was written;
 *   * a config that cannot be created still answers with the defaults, so the
 *     app boots read-only instead of collapsing;
 *   * that refusal prints nothing into the response (a warning would corrupt
 *     JSON) and creates nothing under a path that cannot exist.
 *
 * ROUTER_CONFIG points at throwaway paths, so the operator's own
 * storage/config.json is never read or written. No server is started.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

require_once __DIR__ . '/../../autoload.php';

use Src\Config;

$pass = 0;
$fail = 0;
$errors = [];

function ok($cond, $name)
{
    global $pass, $fail, $errors;
    if ($cond) {
        $pass++;
    } else {
        $fail++;
        $errors[] = 'FAIL: ' . $name;
    }
}

$tmp = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'router-freshcfg-' . getmypid() . '-' . bin2hex(random_bytes(4));
if (!@mkdir($tmp, 0777, true)) {
    fwrite(STDERR, "FAIL: could not create the temp tree at $tmp\n");
    exit(1);
}

// --- 1. a copy with no config.json -----------------------------------------
$fresh = $tmp . DIRECTORY_SEPARATOR . 'fresh' . DIRECTORY_SEPARATOR . 'config.json';
putenv('ROUTER_CONFIG=' . $fresh);

ok(!file_exists($fresh), 'the copy starts with no config.json');
$cfg = Config::loadConfig();
ok(is_array($cfg), 'a missing config answers with an array, never null');
ok(($cfg['theme'] ?? '') === 'neon', 'and it carries the defaults the app expects');
ok(($cfg['tls']['verify'] ?? '') === 'auto', 'including the certificate policy, which is not optional');
ok(is_file($fresh), 'the file is written, so the next request reads it instead of rebuilding it');

$written = json_decode((string) @file_get_contents($fresh), true);
ok(is_array($written) && $written == $cfg, 'what was written is exactly what was returned');

// A second read comes off disk, unchanged.
$again = Config::loadConfig();
ok(is_array($again) && $again == $cfg, 'a second read returns the same config from disk');

// --- 2. a storage folder that cannot be written ----------------------------
// The parent is a FILE, so the config path can never exist -- the portable
// stand-in for a folder the web server has no permission to write into.
$blocker = $tmp . DIRECTORY_SEPARATOR . 'blocker';
file_put_contents($blocker, 'not a directory');
$impossible = $blocker . DIRECTORY_SEPARATOR . 'config.json';
putenv('ROUTER_CONFIG=' . $impossible);

ob_start();
$readonly = Config::loadConfig();
$leaked = (string) ob_get_clean();

ok(is_array($readonly), 'an unwritable folder still answers with an array');
ok(($readonly['theme'] ?? '') === 'neon', 'and those are the defaults, so the app boots read-only');
ok(strpos($leaked, 'No such file') === false && strpos($leaked, 'Warning') === false,
    'and no PHP warning leaks into the response that would break a JSON body');
ok(!file_exists($impossible), 'nothing is created under a path that cannot exist');

// --- 3. the operator's own storage is untouched ----------------------------
$own = __DIR__ . '/../../storage/config.json';
$before = is_file($own) ? md5_file($own) : null;
putenv('ROUTER_CONFIG');
Config::loadConfig();
$after = is_file($own) ? md5_file($own) : null;
ok($before === $after, "this checkout's storage/config.json is unchanged by these calls");

// Cleanup.
@unlink($blocker);
@unlink($fresh);
@rmdir(dirname($fresh));
@rmdir($tmp);

if ($fail > 0) {
    foreach ($errors as $e) {
        fwrite(STDERR, $e . "\n");
    }
}
echo "Fresh-config test\n";
echo "--------------------------------------------------\n";
echo "$pass passed, $fail failed\n";
exit($fail > 0 ? 1 : 0);
