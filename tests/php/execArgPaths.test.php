<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Path arguments spelled `--option=value`.
 *
 * Usage: php tests/php/execArgPaths.test.php
 *
 * The exec path guard skipped every argument containing an `=` as an option
 * value, on the reasoning that such an argument is not a path. GNU tools accept
 * the joined spelling, so `curl --output=/etc/cron.d/x` and
 * `tar --directory=/etc` carried paths the guard never looked at -- while the
 * space-separated spelling of the same option was refused. The value after the
 * `=` is now checked exactly like a standalone argument, and the protect list
 * applies to it too.
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

echo "exec argument path tests\n";

$base = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-args-' . getmypid();
$app = $base . '/app';
$outside = $base . '/outside';
foreach (array($app . '/storage', $outside, $base . '/logs') as $d) {
    @mkdir($d, 0775, true);
}
file_put_contents($app . '/storage/config.json', "{\"token\":\"MARKER\"}\n");
file_put_contents($app . '/notes.txt', "notes\n");
file_put_contents($outside . '/escape.php', "<?php // reached\n");

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
putenv('ROUTER_LOG_DIR=' . $base . '/logs');

// --- a path in the joined spelling is checked -------------------------------
$out = Sandbox::execCommand(
    array('curl', '--output=' . $outside . '/escape.php', 'http://127.0.0.1:1/'),
    array('cwd' => $app)
);
ok(empty($out['ok']) && stripos((string)$out['stderr'], 'outside') !== false,
    'curl --output=<outside> is refused');

$tar = Sandbox::execCommand(
    array('tar', '-xf', 'a.tar', '--directory=' . $outside),
    array('cwd' => $app)
);
ok(empty($tar['ok']) && stripos((string)$tar['stderr'], 'outside') !== false,
    'tar --directory=<outside> is refused');

// A value inside the jail must still pass, or the guard would break the tools
// it exists to protect. `curl` with no URL exits on its own; whether it runs is
// not the subject, only whether the path guard turned it away.
$in = Sandbox::execCommand(array('curl', '--cacert=' . $app . '/notes.txt'), array('cwd' => $app));
ok(stripos((string)$in['stderr'], 'outside') === false,
    'a --option=<value> inside the jail is not refused');

// The protect list applies to the value as well.
$prot = Sandbox::execCommand(
    array('curl', '--output=' . $app . '/storage/x.txt', 'http://127.0.0.1:1/'),
    array('cwd' => $app)
);
ok(empty($prot['ok']) && stripos((string)$prot['stderr'], 'protected') !== false,
    'a --output= into a protected path is refused');

// --- the cases that were already skipped still are --------------------------
$kv = Sandbox::execCommand(array('echo', 'A=/etc/passwd'), array('cwd' => $app));
ok(stripos((string)$kv['stderr'], 'outside') === false,
    'a bare key=value argument is not treated as a path');

$flag = Sandbox::execCommand(array('ls', '-la'), array('cwd' => $app));
ok(stripos((string)$flag['stderr'], 'outside') === false,
    'a plain flag carrying no value is still skipped');

// An empty value is a flag, not the root of the filesystem.
$empty = Sandbox::execCommand(array('ls', '--color='), array('cwd' => $app));
ok(stripos((string)$empty['stderr'], 'outside') === false,
    'an option with an empty value is not resolved as a path');

// --- cleanup ----------------------------------------------------------------
foreach (array($app . '/storage/config.json', $app . '/notes.txt',
    $outside . '/escape.php', $configFile) as $f) {
    @unlink($f);
}
foreach (array($app . '/storage', $outside, $base . '/logs', $app, $base) as $d) {
    @rmdir($d);
}

echo str_repeat('-', 60) . "\n";
foreach ($errors as $e) { echo $e . "\n"; }
echo "execArgPaths: {$pass} passed, {$fail} failed\n";
exit($fail ? 1 : 0);
