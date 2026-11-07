<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * TLS policy unit tests.
 *
 * Usage: php tests/php/tls.test.php
 *
 * One temp config file, no network. The decision itself is pure, so it is
 * asserted here even where the CLI has no curl extension; the curl option
 * array and handles are skipped with a reason on such a build, because the
 * web SAPI that actually makes the calls does load curl.
 *
 * Exits 0 on success, 1 on any failure. Mirrors tests/php/harness.test.php.
 */

require_once __DIR__ . '/../../autoload.php';

use Src\Tls;

$pass = 0;
$fail = 0;
$errors = [];
$skips = [];

function ok($cond, $name) {
    global $pass, $fail, $errors;
    if ($cond) { $pass++; }
    else { $fail++; $errors[] = "FAIL: $name"; }
}

echo "TLS policy tests\n";
echo str_repeat('-', 60) . "\n";

// --- a config file of our own, so the operator's install is not read --------
$cfgPath = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'tls-test-' . getmypid() . '.json';
$bundle = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'tls-test-' . getmypid() . '.pem';
$write = function (array $cfg) use ($cfgPath) {
    file_put_contents($cfgPath, json_encode($cfg));
};
$had = getenv('ROUTER_CONFIG');
putenv('ROUTER_CONFIG=' . $cfgPath);
$write([]);

// --- normalise: only 'on' and 'off' are commands, everything else is auto ---
ok(Tls::normalise('on') === 'on', "normalise('on') -> on");
ok(Tls::normalise('OFF') === 'off', "normalise('OFF') -> off (case folded)");
ok(Tls::normalise(' off ') === 'off', 'normalise trims');
ok(Tls::normalise('') === 'auto', "normalise('') -> auto");
ok(Tls::normalise('maybe') === 'auto', 'an unknown value falls back to auto, never to off');
ok(Tls::normalise(null) === 'auto', 'a missing value -> auto');

// --- mode(): read from config, safe defaults -------------------------------
ok(Tls::mode() === 'auto', 'no tls key -> auto');
$write(['tls' => ['verify' => 'off']]);
ok(Tls::mode() === 'off', 'tls.verify off is honoured');
$write(['tls' => ['verify' => 'on']]);
ok(Tls::mode() === 'on', 'tls.verify on is honoured');
$write(['tls' => ['verify' => 'sometimes']]);
ok(Tls::mode() === 'auto', 'an unrecognised stored value -> auto');
$write(['tls' => 'nonsense']);
ok(Tls::mode() === 'auto', 'a non-array tls key does not warn and -> auto');

// --- host() ----------------------------------------------------------------
ok(Tls::host('https://LocalHost:1234/v1') === 'localhost', 'host() lowercases and drops the port');
ok(Tls::host('https://[::1]:11434/api') === '::1', 'host() unwraps an IPv6 literal');
ok(Tls::host('workstation:11434/api/chat') === 'workstation', 'host() handles a scheme-less endpoint');
ok(Tls::host('') === '', 'host() of nothing is nothing');

// --- what counts as local --------------------------------------------------
$local = [
    'http://localhost:1234/v1/chat/completions',
    'https://localhost/v1/messages',
    'https://127.0.0.1:8443/v1',
    'https://127.9.9.9/v1',
    'https://[::1]:11434/api/chat',
    'https://0.0.0.0:8080/v1',
    'https://192.168.1.50:1234/v1',
    'https://10.0.0.7/v1',
    'https://172.20.5.4/v1',
    'https://169.254.10.20/v1',
    'https://100.100.1.1/v1',
    'https://workstation:11434/api/chat',
    'https://gpubox.local/v1',
    'https://nas.lan/v1',
    'https://ollama.internal/v1',
    'https://host.docker.internal:11434/api/chat',
];
foreach ($local as $url) {
    ok(Tls::isLocalUrl($url) === true, "local: $url");
}

$public = [
    'https://api.openai.com/v1/chat/completions',
    'https://openrouter.ai/api/v1/chat/completions',
    'https://api.anthropic.com/v1/messages',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    'https://8.8.8.8/v1',
    'https://172.32.0.1/v1',            // just outside 172.16/12
    'https://mybox.example.com/v1',
];
foreach ($public as $url) {
    ok(Tls::isLocalUrl($url) === false, "not local: $url");
}

// --- policy(): the three modes, and http is never TLS ----------------------
$autoPublic = Tls::policy('https://api.openai.com/v1/chat/completions', 'auto');
ok($autoPublic['tls'] === true && $autoPublic['verify'] === true,
    'auto verifies a public host');

$autoLan = Tls::policy('https://192.168.1.50:1234/v1', 'auto');
ok($autoLan['tls'] === true && $autoLan['verify'] === false,
    'auto skips a LAN address so a self-signed runner keeps working');

$autoLoop = Tls::policy('https://localhost:8443/v1', 'auto');
ok($autoLoop['verify'] === false, 'auto skips loopback');

$onLan = Tls::policy('https://192.168.1.50:1234/v1', 'on');
ok($onLan['verify'] === true, 'on verifies even a LAN address');

$offPub = Tls::policy('https://api.openai.com/v1', 'off');
ok($offPub['verify'] === false, 'off verifies nothing, public host included');

$onLocal = Tls::policy('https://localhost/v1', 'on');
ok($onLocal['verify'] === true, 'a self-signed local host is refused when the operator asked for on');

$http = Tls::policy('http://localhost:1234/v1', 'on');
ok($http['tls'] === false && $http['verify'] === false,
    'plain http is not TLS at all: no certificate, nothing to verify, whatever the mode');
$httpOff = Tls::policy('http://api.openai.com/v1', 'off');
ok($httpOff['tls'] === false, 'plain http stays plain http');

ok(Tls::shouldVerify('https://api.openai.com/v1', 'auto') === true,
    'shouldVerify agrees with policy()');

// --- ca_bundle: used only when it is a readable file, and only if verifying -
file_put_contents($bundle, "-----BEGIN CERTIFICATE-----\nnot-a-real-cert\n-----END CERTIFICATE-----\n");
$write(['tls' => ['verify' => 'on', 'ca_bundle' => $bundle]]);
ok(Tls::caBundle() === $bundle, 'caBundle() reports a configured, readable file');
ok(Tls::policy('https://lan.example.com/v1')['ca'] === $bundle,
    'a verifying call carries the CA bundle');

$write(['tls' => ['verify' => 'on', 'ca_bundle' => $bundle . '.missing']]);
ok(Tls::caBundle() === '', 'a missing ca_bundle is ignored, not passed to curl');
ok(Tls::policy('https://lan.example.com/v1')['ca'] === '',
    'a missing ca_bundle leaves the call on the system store');

$write(['tls' => ['verify' => 'off', 'ca_bundle' => $bundle]]);
ok(Tls::policy('https://api.openai.com/v1')['ca'] === '',
    'off does not attach a CA bundle it would never consult');

$write(['tls' => ['verify' => 'auto']]);
ok(Tls::policy('https://192.168.1.50/v1')['ca'] === '',
    'auto on a LAN host does not attach the bundle either');

// --- curl options, where the extension exists ------------------------------
if (!function_exists('curl_setopt_array')) {
    $skips[] = 'curl extension not loaded in this CLI: curl option arrays and handles not exercised';
} else {
    ok(Tls::optionsFor('http://localhost:1234/v1', 'on') === [],
        'plain http sets no TLS options at all, whatever the mode');

    $pub = Tls::optionsFor('https://api.openai.com/v1/chat/completions', 'auto');
    ok(($pub[CURLOPT_SSL_VERIFYPEER] ?? null) === true, 'public https -> VERIFYPEER true');
    ok(($pub[CURLOPT_SSL_VERIFYHOST] ?? null) === 2, 'public https -> VERIFYHOST 2');

    $lan = Tls::optionsFor('https://192.168.1.50:1234/v1', 'auto');
    ok(($lan[CURLOPT_SSL_VERIFYPEER] ?? null) === false, 'LAN https -> VERIFYPEER false');
    ok(($lan[CURLOPT_SSL_VERIFYHOST] ?? null) === 0, 'LAN https -> VERIFYHOST 0 (hostname unchecked too)');
    ok(!isset($lan[CURLOPT_CAINFO]), 'no CA bundle configured -> no CAINFO');

    $write(['tls' => ['verify' => 'on', 'ca_bundle' => $bundle]]);
    $withCa = Tls::optionsFor('https://lan.example.com/v1');
    ok(($withCa[CURLOPT_CAINFO] ?? '') === $bundle, 'a readable ca_bundle is handed to curl');

    $write([]);
    $ch = curl_init('https://example.com/');
    ok(Tls::apply($ch, 'http://localhost:1234/v1') === [], 'apply() is a no-op for http');
    ok(Tls::apply($ch, 'https://api.openai.com/v1') !== [], 'apply() sets options for https');
    curl_close($ch);
}

// --- cleanup ---------------------------------------------------------------
@unlink($cfgPath);
@unlink($bundle);
if ($had === false) { putenv('ROUTER_CONFIG'); } else { putenv('ROUTER_CONFIG=' . $had); }

echo str_repeat('-', 60) . "\n";
foreach ($skips as $s) { echo 'SKIP: ' . $s . "\n"; }
foreach ($errors as $e) { echo $e . "\n"; }
echo "TLS: {$pass} passed, {$fail} failed\n";
exit($fail === 0 ? 0 : 1);
