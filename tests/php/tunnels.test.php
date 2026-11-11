<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tunnel backend tests. Covers URL parsing from daemon logs, provider/port
 * validation, binary resolution order, and the served-port/prefix helpers --
 * all without launching a real daemon (no ngrok/cloudflared needed).
 *
 * Usage: php tests/php/tunnels.test.php
 */

require_once __DIR__ . '/../../autoload.php';

use Src\Tunnels;

$pass = 0;
$fail = 0;
$errors = [];

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

// Isolate: config reads/writes and the tunnels.json runtime state land in a
// temp dir, never in the operator's storage/.
$tmp = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-tunnels-test-' . getmypid();
@mkdir($tmp, 0777, true);
$cfg = $tmp . '/config.json';
file_put_contents($cfg, json_encode(['sandbox' => ['require_token' => false, 'token' => '']]));
putenv('ROUTER_CONFIG=' . $cfg);

echo "Tunnel tests\n";
echo str_repeat('-', 60) . "\n";

// --- URL parsing ---------------------------------------------------------
$ngrokLog = "msg=\"started tunnel\" obj=tunnels name=command_line addr=http://localhost:8080\n"
    . "Forwarding  https://abc123.ngrok-free.dev -> http://localhost:8080\n";
ok(Tunnels::parseUrl('ngrok', $ngrokLog) === 'https://abc123.ngrok-free.dev', 'ngrok free-domain URL parsed');
ok(Tunnels::parseUrl('ngrok', 'Forwarding https://abc123.ngrok.io -> http://localhost:8080')
    === 'https://abc123.ngrok.io', 'ngrok classic-domain URL parsed');
ok(Tunnels::parseUrl('ngrok', 'Forwarding https://my-reserved.ngrok.app -> http://x')
    === 'https://my-reserved.ngrok.app', 'ngrok reserved-domain URL parsed');
ok(Tunnels::parseUrl('ngrok', 'starting web service...') === '', 'ngrok noise yields no URL');
ok(Tunnels::parseUrl('ngrok', '') === '', 'ngrok empty log yields no URL');

$cfLog = "2026-01-01 INF +--------------------------------------------------------------------------------------------+\n"
    . "2026-01-01 INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be online):      |\n"
    . "2026-01-01 INF |  https://some-words-here.trycloudflare.com                                                  |\n";
ok(Tunnels::parseUrl('cloudflare', $cfLog) === 'https://some-words-here.trycloudflare.com',
    'cloudflared quick-tunnel URL parsed');
ok(Tunnels::parseUrl('cloudflare', $ngrokLog) === '', 'cloudflared ignores an ngrok URL');
ok(Tunnels::parseUrl('ngrok', $cfLog) === '', 'ngrok ignores a cloudflared URL');
ok(Tunnels::parseUrl('bogus', $cfLog) === '', 'unknown provider yields no URL');

// --- argv + quoting --------------------------------------------------------
ok(Tunnels::ngrokArgs(8080, '') === ['http', '127.0.0.1:8080'], 'ngrok argv without a domain');
ok(Tunnels::ngrokArgs(8090, 'mine.ngrok-free.dev')
    === ['http', '--domain=mine.ngrok-free.dev', '127.0.0.1:8090'], 'ngrok argv with a reserved domain');
ok(Tunnels::psQuote("C:\\Program Files\\ngrok\\ngrok.exe") === "'C:\\Program Files\\ngrok\\ngrok.exe'",
    'psQuote wraps a spaced path in single quotes');
ok(Tunnels::psQuote("o'clock") === "'o''clock'", 'psQuote doubles an embedded quote');

// --- validation: start refuses without the switch or with a bad port ------
try {
    Tunnels::start(['provider' => 'ngrok', 'port' => 8080], ['SERVER_PORT' => 8080]);
    ok(false, 'start refuses while tunnels are disabled');
} catch (\Throwable $e) {
    ok(stripos($e->getMessage(), 'off') !== false, 'start refuses while tunnels are disabled');
}
file_put_contents($cfg, json_encode(['tunnels' => ['enabled' => true]]));
try {
    Tunnels::start(['provider' => 'ngrok', 'port' => 99999], ['SERVER_PORT' => 8080]);
    ok(false, 'start refuses an out-of-range port');
} catch (\Throwable $e) {
    ok(stripos($e->getMessage(), 'range') !== false, 'start refuses an out-of-range port');
}
try {
    Tunnels::start(['provider' => 'tor', 'port' => 8080], ['SERVER_PORT' => 8080]);
    ok(false, 'start refuses an unknown provider');
} catch (\Throwable $e) {
    ok(stripos($e->getMessage(), 'Unknown provider') !== false, 'start refuses an unknown provider');
}
try {
    Tunnels::stop(['provider' => 'tor']);
    ok(false, 'stop refuses an unknown provider');
} catch (\Throwable $e) {
    ok(stripos($e->getMessage(), 'Unknown provider') !== false, 'stop refuses an unknown provider');
}

// --- config: a hostile ngrok domain is dropped, not passed through --------
file_put_contents($cfg, json_encode(['tunnels' => [
    'enabled' => true, 'ngrok_domain' => 'evil"; rm -rf ~; "',
]]));
$ref = new \ReflectionMethod(Tunnels::class, 'config');
$ref->setAccessible(true);
$c = $ref->invoke(null);
ok($c['ngrok_domain'] === '', 'a hostile ngrok domain is dropped');
ok($c['enabled'] === true && $c['provider'] === 'both', 'config defaults survive a hostile domain');

// --- served port + prefix helpers ------------------------------------------
ok(Tunnels::servedPort(['SERVER_PORT' => '8090']) === 8090, 'served port comes from the request');
ok(Tunnels::servedPort([]) === 8080, 'served port falls back to 8080');
ok(Tunnels::urlPrefix(['SCRIPT_NAME' => '/router/api/index.php']) === '/router',
    'Apache mount yields the /router prefix');
ok(Tunnels::urlPrefix(['SCRIPT_NAME' => '/api/index.php']) === '',
    'php -S mount yields no prefix');

// --- status with nothing installed and nothing running ----------------------
file_put_contents($cfg, json_encode(['tunnels' => ['enabled' => true]]));
$st = Tunnels::status(['SERVER_PORT' => 8080, 'SCRIPT_NAME' => '/router/api/index.php']);
ok($st['enabled'] === true && $st['port'] === 8080 && $st['prefix'] === '/router',
    'status reports the enabled flag, port and prefix');
ok($st['tunnels']['ngrok']['up'] === false && $st['tunnels']['cloudflare']['up'] === false,
    'status reports both tunnels down when nothing runs');
ok(empty($st['tunnels']['ngrok']['url']) && empty($st['tunnels']['cloudflare']['url']),
    'status exposes no URL when nothing runs');
ok(!isset($st['tunnels']['ngrok']['rpc']), 'status exposes no RPC URL when nothing runs');

// --- pid checks never claim a nonsense pid ----------------------------------
ok(Tunnels::pidAlive(0) === false, 'pid 0 is never alive');
ok(Tunnels::pidAlive(-5) === false, 'a negative pid is never alive');
ok(Tunnels::pidAlive(2147483647) === false, 'a wild pid is not alive');

// --- stopping what is not running is a calm no-op ---------------------------
$stopped = Tunnels::stop(['provider' => 'all']);
ok($stopped['ok'] === true, 'stopping idle tunnels reports ok');

// --- launching without a binary explains itself -----------------------------
try {
    Tunnels::start(['provider' => 'cloudflare', 'port' => 1], ['SERVER_PORT' => 1]);
    ok(false, 'start without a binary throws');
} catch (\Throwable $e) {
    $msg = $e->getMessage();
    ok(stripos($msg, 'not installed') !== false || stripos($msg, 'Nothing is listening') !== false,
        'start without a binary (or listener) explains itself, got: ' . substr($msg, 0, 60));
}

putenv('ROUTER_CONFIG');
@unlink($cfg);
@unlink($tmp . '/tunnels.json');
@rmdir($tmp);

echo str_repeat('-', 60) . "\n";
echo "$pass passed, $fail failed\n";
foreach ($errors as $e) {
    echo "  $e\n";
}
exit($fail ? 1 : 0);
