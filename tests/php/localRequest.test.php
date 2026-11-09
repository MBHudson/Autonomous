<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * "Local requests only" when a reverse proxy sits in front.
 *
 * Usage: php tests/php/localRequest.test.php
 *
 * With the token gate off, the API answers only the machine it runs on -- but
 * that test was the socket peer address alone. Behind nginx or Apache on the
 * same host every request arrives from 127.0.0.1, so every internet visitor
 * counted as local: the exact posture the check was added to prevent.
 *
 * A forwarding header now marks a request as proxied. The client is read from
 * it only when the peer is a declared proxy (sandbox.trusted_proxies); an
 * undeclared proxy is refused, and a spoofed left-most X-Forwarded-For entry
 * cannot win because the list is read from the right.
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

echo "local request tests\n";

$base = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-local-' . getmypid();
@mkdir($base, 0775, true);

$setProxies = function (array $proxies) use ($base) {
    $file = $base . '/config.json';
    file_put_contents($file, json_encode(array('sandbox' => array(
        'read_roots' => array(),
        'write_roots' => array(),
        'require_token' => false,
        'token' => '',
        'trusted_proxies' => $proxies,
        'exec_enabled' => false,
        'code_enabled' => false,
    ))));
    putenv('ROUTER_CONFIG=' . $file);
};

$setProxies(array());

// --- direct requests keep working -------------------------------------------
ok(Sandbox::isLocalRequest(array('REMOTE_ADDR' => '127.0.0.1')), 'a loopback peer is local');
ok(Sandbox::isLocalRequest(array('REMOTE_ADDR' => '127.0.0.5')), 'the whole 127/8 range is local');
ok(Sandbox::isLocalRequest(array('REMOTE_ADDR' => '::1')), 'IPv6 loopback is local');
ok(Sandbox::isLocalRequest(array('REMOTE_ADDR' => '::ffff:127.0.0.1')), 'the mapped loopback spelling is local');
ok(!Sandbox::isLocalRequest(array('REMOTE_ADDR' => '192.168.1.5')), 'a LAN peer is not local');
ok(!Sandbox::isLocalRequest(array('REMOTE_ADDR' => '203.0.113.9')), 'a public peer is not local');
ok(Sandbox::isLocalRequest(array('REMOTE_ADDR' => '')), 'no peer address in the CLI is still local');

// --- the hole: a proxy on this host ----------------------------------------
ok(!Sandbox::isLocalRequest(array(
    'REMOTE_ADDR' => '127.0.0.1',
    'HTTP_X_FORWARDED_FOR' => '203.0.113.9',
)), 'an undeclared proxy is not treated as local');

// --- a declared proxy is believed ------------------------------------------
$setProxies(array('127.0.0.1', '::1', '10.0.0.0/8'));

ok(!Sandbox::isLocalRequest(array(
    'REMOTE_ADDR' => '127.0.0.1',
    'HTTP_X_FORWARDED_FOR' => '203.0.113.9',
)), 'a forwarded internet client is not local');
ok(Sandbox::isLocalRequest(array(
    'REMOTE_ADDR' => '127.0.0.1',
    'HTTP_X_FORWARDED_FOR' => '127.0.0.1',
)), 'a forwarded loopback client is local');
ok(Sandbox::isLocalRequest(array(
    'REMOTE_ADDR' => '127.0.0.1',
    'HTTP_X_FORWARDED_FOR' => '::1',
)), 'a forwarded IPv6 loopback client is local');

// The rightmost non-proxy entry is the client; anything to its left is
// whatever the caller chose to send.
ok(!Sandbox::isLocalRequest(array(
    'REMOTE_ADDR' => '127.0.0.1',
    'HTTP_X_FORWARDED_FOR' => '127.0.0.1, 203.0.113.9',
)), 'a spoofed left-most hop does not win');
ok(!Sandbox::isLocalRequest(array(
    'REMOTE_ADDR' => '127.0.0.1',
    'HTTP_X_FORWARDED_FOR' => '198.51.100.7, 10.4.4.4',
)), 'a trusted internal hop is skipped, and the public one decides');
ok(!Sandbox::isLocalRequest(array(
    'REMOTE_ADDR' => '127.0.0.1',
    'HTTP_X_FORWARDED_FOR' => '10.9.9.9',
)), 'a client inside a trusted range is not local by itself');

// A trusted proxy address is not itself a local visitor.
ok(!Sandbox::isLocalRequest(array('REMOTE_ADDR' => '10.1.2.3')), 'a declared proxy address alone is not local');

// --- other forwarding spellings --------------------------------------------
ok(!Sandbox::isLocalRequest(array(
    'REMOTE_ADDR' => '127.0.0.1',
    'HTTP_X_REAL_IP' => '203.0.113.9',
)), 'X-Real-IP is read from a declared proxy');
ok(Sandbox::isLocalRequest(array(
    'REMOTE_ADDR' => '127.0.0.1',
    'HTTP_X_REAL_IP' => '::1',
)), 'a loopback X-Real-IP is local');
ok(!Sandbox::isLocalRequest(array(
    'REMOTE_ADDR' => '127.0.0.1',
    'HTTP_FORWARDED' => 'for=203.0.113.9;proto=https',
)), 'the standard Forwarded header is read too');
ok(!Sandbox::isLocalRequest(array(
    'REMOTE_ADDR' => '127.0.0.1',
    'HTTP_X_FORWARDED_FOR' => 'not-an-ip',
)), 'an unparseable forward is not local');

// --- config spellings -------------------------------------------------------
// A comma-separated string is accepted, because that is what a config file
// hand-edited by an operator tends to contain.
$file = $base . '/config.json';
file_put_contents($file, json_encode(array('sandbox' => array(
    'trusted_proxies' => '127.0.0.1, 10.0.0.0/8',
    'read_roots' => array(),
    'write_roots' => array(),
))));
putenv('ROUTER_CONFIG=' . $file);
ok(!Sandbox::isLocalRequest(array(
    'REMOTE_ADDR' => '127.0.0.1',
    'HTTP_X_FORWARDED_FOR' => '203.0.113.9',
)), 'a comma-separated proxy list is honoured');

// --- cleanup ---------------------------------------------------------------
@unlink($base . '/config.json');
@rmdir($base);

echo str_repeat('-', 60) . "\n";
foreach ($errors as $e) { echo $e . "\n"; }
echo "localRequest: {$pass} passed, {$fail} failed\n";
exit($fail ? 1 : 0);
