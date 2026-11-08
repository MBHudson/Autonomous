<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * The update routes on a PHP that cannot reach the internet.
 *
 * Usage: php tests/php/curlMissing.test.php
 *
 * v422 made the POST routes answer 503 when curl is missing, and v423 did the
 * same for an uncached GET. Both were checked by hand against a PHP whose
 * php.ini simply had no curl -- which is not a condition a suite can assume the
 * machine it is running on is in, so nothing tested them.
 *
 * This file manufactures the condition instead. It starts the app with
 * `-d disable_functions=curl_init,curl_exec,...`, which removes those functions
 * from the function table exactly as a missing extension does, while leaving
 * every other extension in place. `function_exists('curl_init')` is then false,
 * every path that asks that question takes its "cannot reach the internet"
 * branch, and the status codes the last two releases argued about are asserted
 * rather than described.
 *
 * The four answers that must hold:
 *
 *   * POST /api/update/check -> 503 with code curl_missing
 *   * GET  /api/update/check -> 503 with code curl_missing, when there is no
 *                               cached answer to serve
 *   * GET  /api/update/check -> 200, cached: true, when there is one
 *   * POST /api/update/download -> 503, the same gate
 *
 * storage/updates/check.json is the operator's own cache, so it is read before
 * this file seeds its own and written back afterwards -- including when it was
 * not there at all. A copy that requires an access token SKIPs the HTTP half:
 * loopback is refused then, and a 401 counted as a pass is the exact failure
 * this file exists to prevent.
 *
 * Exits 0 on success, 1 on any failure.
 */

$root = dirname(__DIR__, 2);
$pass = 0;
$fail = 0;
$errors = array();

function ok($cond, $name, &$pass, &$fail, &$errors)
{
    if ($cond) {
        $pass++;
    } else {
        $fail++;
        $errors[] = 'FAIL: ' . $name;
    }
}

function same($got, $want, $name, &$pass, &$fail, &$errors)
{
    ok($got === $want, $name . ' (got ' . var_export($got, true) . ', want ' . var_export($want, true) . ')',
        $pass, $fail, $errors);
}

/**
 * One request. Returns [status code, decoded body].
 *
 * The body is decoded even on a refusal, because "503" alone does not say which
 * 503 it was -- the code field is the difference between the extension gate and
 * some other failure, and that is the whole subject here.
 */
function http_json($url, $method = 'GET', $payload = null)
{
    $opts = array('http' => array(
        'method' => $method,
        'ignore_errors' => true,   // a 503 must come back as 503, not as false
        'timeout' => 10,
        'header' => "Content-Type: application/json\r\n",
    ));
    if ($payload !== null) {
        $opts['http']['content'] = $payload;
    }
    $raw = (string) @file_get_contents($url, false, stream_context_create($opts));
    $code = false;
    if (isset($http_response_header) && $http_response_header) {
        foreach ($http_response_header as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
                $code = (int) $m[1];
                break;
            }
        }
    }
    return array($code, json_decode($raw, true));
}

echo "Update routes without curl\n";
echo str_repeat('-', 60) . "\n";

if (!function_exists('proc_open')) {
    echo "  SKIP: proc_open is disabled, cannot start a test server\n";
    echo "0 passed, 0 failed\n";
    exit(0);
}

require_once __DIR__ . '/free-port.php';

// The functions the app would reach for, spelled out: disabling only curl_init
// would leave curl_exec reachable and the "missing extension" branch would never
// be taken.
$disabled = 'curl_init,curl_exec,curl_multi_init,curl_multi_exec,curl_setopt,'
    . 'curl_setopt_array,curl_error,curl_errno,curl_close,curl_getinfo,curl_version,'
    . 'curl_reset,curl_pause,curl_escape,curl_unescape';

$log = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'router-curlmissing-' . getmypid() . '.log';
$proc = null;
$base = null;

$stop = function () use (&$proc, $log) {
    if (is_resource($proc)) {
        @proc_terminate($proc);
        @proc_close($proc);
        $proc = null;
    }
    if (is_file($log)) {
        @unlink($log);
    }
};
// A fatal error or an early exit must not leave a server on the port.
register_shutdown_function($stop);

// Two attempts: the port picked above is free, but another process can take it
// in between, and a busy port is environmental, not a failure of these routes.
for ($attempt = 1; $attempt <= 2 && $base === null; $attempt++) {
    $port = free_port();
    if (!$port) {
        break;
    }
    $cmd = array(
        PHP_BINARY,
        '-d', 'disable_functions=' . $disabled,
        '-S', '127.0.0.1:' . $port,
        $root . DIRECTORY_SEPARATOR . 'serve.php',
    );
    $proc = @proc_open($cmd, array(1 => array('file', $log, 'a'), 2 => array('file', $log, 'a')), $pipes, $root);
    if (!is_resource($proc)) {
        continue;
    }
    $candidate = 'http://127.0.0.1:' . $port;
    $deadline = microtime(true) + 8.0;
    while (microtime(true) < $deadline) {
        list($code) = http_json($candidate . '/');
        if ($code !== false) {
            $base = $candidate;
            break;
        }
        usleep(100000);
    }
    if ($base === null) {
        $stop();
    }
}

if ($base === null) {
    echo "  SKIP: could not start serve.php on a loopback port\n";
    if (is_file($log)) {
        foreach (array_slice(explode("\n", (string) @file_get_contents($log)), 0, 4) as $line) {
            if (trim($line) !== '') {
                echo '        ' . trim($line) . "\n";
            }
        }
    }
    echo "0 passed, 0 failed\n";
    exit(0);
}

$cacheDir = $root . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'updates';
$cacheFile = $cacheDir . DIRECTORY_SEPARATOR . 'check.json';
$hadCache = is_file($cacheFile);
$savedCache = $hadCache ? (string) @file_get_contents($cacheFile) : null;

try {
    list($vcode) = http_json($base . '/api/version');
    if ($vcode === 401 || $vcode === 403) {
        // The gate is on and this peer is loopback: the answers below would all
        // be 401, which says nothing about the extension.
        echo "  SKIP: this copy requires an access token, so /api refuses even loopback\n";
    } else {
        same($vcode, 200, 'the app answers before the extension is involved', $pass, $fail, $errors);

        // --- the uncached GET ------------------------------------------------
        @unlink($cacheFile);
        list($code, $body) = http_json($base . '/api/update/check');
        same($code, 503, 'an uncached GET without curl is a 503, not a 200 that admits failure',
            $pass, $fail, $errors);
        ok(($body['code'] ?? null) === 'curl_missing',
            'the GET names the missing extension in its code field', $pass, $fail, $errors);
        ok(($body['ok'] ?? null) === false, 'the GET still says the check did not pass',
            $pass, $fail, $errors);
        ok(empty($body['warnings']),
            'the GET does not carry curl_init warnings as its reason', $pass, $fail, $errors);
        $version = trim((string) @file_get_contents($root . DIRECTORY_SEPARATOR . 'VERSION'));
        same((string) ($body['localVersion']['label'] ?? ''), $version,
            'the GET still names the copy it is', $pass, $fail, $errors);

        // --- the POST ----------------------------------------------------------
        list($pcode, $pbody) = http_json($base . '/api/update/check', 'POST', '{}');
        same($pcode, 503, 'a forced POST without curl is a 503', $pass, $fail, $errors);
        ok(($pbody['code'] ?? null) === 'curl_missing',
            'the POST names the missing extension in its code field', $pass, $fail, $errors);

        // --- the same gate, on a route that would download ----------------------
        list($dcode, $dbody) = http_json($base . '/api/update/download', 'POST', '{}');
        same($dcode, 503, 'the download route is refused by the same gate', $pass, $fail, $errors);
        ok(($dbody['code'] ?? null) === 'curl_missing',
            'the download refusal is the extension, not a bad request', $pass, $fail, $errors);

        // --- a cached answer is still served -----------------------------------
        if (!is_dir($cacheDir)) {
            @mkdir($cacheDir, 0775, true);
        }
        $seeded = @file_put_contents($cacheFile, json_encode(array(
            'checkedAt' => time(),
            'remoteRelease' => array('label' => '999', 'source' => 'VERSION'),
            'remoteApp' => array('label' => '999', 'source' => 'APP_VERSION'),
            'remoteChange' => null,
            'error' => null,
            'warnings' => array(),
        )));
        same($seeded === false, false, 'a check cache can be seeded for the cached case', $pass, $fail, $errors);
        list($ccode, $cbody) = http_json($base . '/api/update/check');
        same($ccode, 200, 'a cached GET is still answered without curl', $pass, $fail, $errors);
        ok(!empty($cbody['cached']), 'the cached answer says it came from the cache', $pass, $fail, $errors);
        ok(!array_key_exists('code', $cbody),
            'the cached answer is not a curl_missing refusal', $pass, $fail, $errors);
    }
} finally {
    // Put the operator's cache back exactly as it was found.
    if ($hadCache) {
        @file_put_contents($cacheFile, $savedCache);
    } else {
        @unlink($cacheFile);
    }
    $stop();
}

echo str_repeat('-', 60) . "\n";
if ($fail) {
    echo implode("\n", $errors) . "\n";
    echo "{$fail} failed, {$pass} passed\n";
    exit(1);
}
echo "{$pass} passed, 0 failed\n";
