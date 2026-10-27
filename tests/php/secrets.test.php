<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Secrets test harness: what this app hands out, and who may ask.
 *
 * Usage: php tests/php/secrets.test.php
 *
 * storage/config.json holds the access token, every MCP client's Authorization
 * header and every friend token -- and the read routes used to answer with it
 * verbatim. Two things are asserted here, and they have to hold together:
 *
 *   * what LEAVES is masked (GET /config, GET /mcp/servers, GET
 *     /mcp-server/config), so one unauthenticated read cannot disclose the very
 *     values the other gates compare against;
 *   * what comes BACK is restored, because every panel in this app reads the
 *     config, changes one key and posts the whole thing -- so a masked value
 *     reaching disk would wipe a credential and the only symptom would be a
 *     server that answers 401.
 *
 * It also covers the second half of that finding: with NO access token set, the
 * gate can only be a request's ORIGIN, so a request from another machine is
 * refused while the MCP RPC route (whose whole purpose is friends elsewhere)
 * stays exempt.
 *
 * The route half starts `php -S 127.0.0.1:<free port> serve.php` with
 * ROUTER_CONFIG pointed at a throwaway config, so the REAL handlers run and the
 * operator's own storage/ is never read or written. Loopback only.
 *
 * Exits 0 on success, 1 on any failure.
 */

require_once __DIR__ . '/../../autoload.php';

use Src\Config;
use Src\Mcp;
use Src\McpServer;
use Src\Sandbox;

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

function same($got, $want, $name, $label = true)
{
    global $pass, $fail, $errors;
    if ($got === $want) {
        $pass++;
    } else {
        $fail++;
        $errors[] = 'FAIL: ' . ($label === true ? $name : $label)
            . ' (got ' . var_export($got, true) . ', want ' . var_export($want, true) . ')';
    }
}

/** Status code and body of one request; false when nothing answered. */
function http_json($url, $method = 'GET', $body = null)
{
    $headers = "Content-Type: application/json\r\n";
    $ctx = stream_context_create(['http' => [
        'method' => $method,
        'header' => $headers,
        'content' => $body === null ? null : json_encode($body),
        'ignore_errors' => true,     // a 403 must come back as 403, not false
        'timeout' => 5,
    ]]);
    $raw = (string)@file_get_contents($url, false, $ctx);
    $code = false;
    if (isset($http_response_header) && is_array($http_response_header)) {
        foreach ($http_response_header as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
                $code = (int)$m[1];
            }
        }
    }
    return [$code, $raw];
}

/** A port nobody is using right now. */
function free_port()
{
    $sock = @stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
    if (!$sock) {
        return 0;
    }
    $name = stream_socket_get_name($sock, false);
    fclose($sock);
    $pos = strrpos($name, ':');
    return $pos === false ? 0 : (int)substr($name, $pos + 1);
}

echo "Secrets test harness\n";
echo str_repeat('-', 60) . "\n";

// --- throwaway environment -------------------------------------------
$tmpDir = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-secrets-test-' . getmypid();
@mkdir($tmpDir, 0777, true);
$cfgPath = $tmpDir . '/config.json';
putenv('ROUTER_CONFIG=' . $cfgPath);

$accessToken = 'access-' . bin2hex(random_bytes(12));
$friendToken = 'friend-' . bin2hex(random_bytes(12));
$bearer = 'Bearer ' . bin2hex(random_bytes(8));
$envValue = bin2hex(random_bytes(8));
$plainProxy = 'http://proxy.local:3128';

function write_cfg($path, array $extra)
{
    $cfg = array_merge([
        'theme' => 'neon',
        'sandbox' => [
            'token' => $GLOBALS['accessToken'],
            'proxy_active' => 'http://user:pw@proxy.local:8080',
        ],
        'mcp' => ['servers' => [
            ['id' => 'remote', 'transport' => 'http', 'url' => 'https://mcp.example/v1',
                'headers' => ['Authorization' => $GLOBALS['bearer']]],
            ['id' => 'toolchain', 'transport' => 'stdio', 'command' => 'node',
                'args' => ['tool.js'], 'env' => ['GITHUB_TOKEN' => $GLOBALS['envValue']]],
        ]],
        'mcp_server' => ['enabled' => true, 'root' => '', 'protect' => [], 'tokens' => [
            ['id' => 't_ana', 'label' => 'ana', 'token' => $GLOBALS['friendToken'],
                'scope' => ['read'], 'ips' => []],
        ]],
    ], $extra);
    file_put_contents($path, json_encode($cfg, JSON_PRETTY_PRINT));
    return $cfg;
}

write_cfg($cfgPath, []);

// --- 1. what leaves is masked ----------------------------------------
$out = Config::maskSecrets(Config::loadConfig());
ok($out['sandbox']['token'] === Config::SECRET_MASK, 'the access token is masked on the way out');
ok($out['sandbox']['proxy_active'] === Config::SECRET_MASK, 'a proxy URL with a password is masked');
ok($out['mcp']['servers'][0]['headers']['Authorization'] === Config::SECRET_MASK,
    "an MCP server's Authorization header is masked");
ok($out['mcp']['servers'][1]['env']['GITHUB_TOKEN'] === Config::SECRET_MASK,
    'a stdio server env secret is masked');
ok($out['mcp_server']['tokens'][0]['token'] === Config::SECRET_MASK, 'a friend token is masked');
same($out['theme'], 'neon', 'everything that is not a secret is untouched');

// Empty stays empty: "no token configured" and "a token you may not see" are
// different states, and the UI has to be able to tell them apart.
$empty = Config::maskSecrets(['sandbox' => ['token' => ''], 'mcp' => ['servers' => [
    ['id' => 'x', 'transport' => 'http', 'headers' => ['X-Key' => '']]]]]);
ok($empty['sandbox']['token'] === '', 'an unset token stays unset, not masked');
ok($empty['mcp']['servers'][0]['headers']['X-Key'] === '', 'an empty header value stays empty');

// A proxy with no credentials is a setting, not a secret: the UI names it.
$noCreds = Config::maskSecrets(['sandbox' => ['proxy_active' => $plainProxy]]);
same($noCreds['sandbox']['proxy_active'], $plainProxy, 'a plain proxy URL stays readable');

// --- 2. what comes back is restored ----------------------------------
[$back, $restored, $dropped] = Config::restoreSecrets(Config::maskSecrets(Config::loadConfig()),
    Config::loadConfig());
same($back['sandbox']['token'], $accessToken, 'the masked access token is restored');
same($back['sandbox']['proxy_active'], 'http://user:pw@proxy.local:8080', 'the masked proxy URL is restored');
same($back['mcp']['servers'][0]['headers']['Authorization'], $bearer, 'the masked header is restored');
same($back['mcp']['servers'][1]['env']['GITHUB_TOKEN'], $envValue, 'the masked env value is restored');
same($back['mcp_server']['tokens'][0]['token'], $friendToken, 'the masked friend token is restored');
ok($restored >= 5, 'the reply can say how many credentials were put back');
same($dropped, [], 'a clean round-trip drops nothing');

// A renamed server keeps its credential: the id changes, the URL does not.
$renamed = Config::maskSecrets(Config::loadConfig());
$renamed['mcp']['servers'][0]['id'] = 'renamed-server';
[$r2] = Config::restoreSecrets($renamed, Config::loadConfig());
same($r2['mcp']['servers'][0]['headers']['Authorization'], $bearer,
    'a renamed server is matched by URL and keeps its header');

// A mask with nothing behind it is DROPPED, never stored: writing asterisks
// into a header would be a live credential that no server accepts.
$orphan = ['mcp' => ['servers' => [['id' => 'brand-new', 'transport' => 'http',
    'headers' => ['Authorization' => Config::SECRET_MASK]]]]];
[$r3, $n3, $d3] = Config::restoreSecrets($orphan, Config::loadConfig());
ok(!isset($r3['mcp']['servers'][0]['headers']['Authorization']),
    'an unresolvable mask is dropped rather than saved as a credential');
same(count($d3), 1, 'and the drop is reported');

// A real value typed over the mask is kept as typed.
$typed = ['mcp' => ['servers' => [['id' => 'remote', 'transport' => 'http',
    'url' => 'https://mcp.example/v1', 'headers' => ['Authorization' => 'Bearer new-real-value']]]]];
[$r4] = Config::restoreSecrets($typed, Config::loadConfig());
same($r4['mcp']['servers'][0]['headers']['Authorization'], 'Bearer new-real-value',
    'a value typed over the mask is saved as typed');

// --- 3. the friend list, through its own route ------------------------
$shown = McpServer::uiConfig();
same($shown['tokens'][0]['token'], Config::SECRET_MASK, 'the friend list is masked too');

// Saving what was just read must not change the stored token.
$save = McpServer::saveConfig($shown);
same($save['tokens'][0]['token'], Config::SECRET_MASK, 'a save answers with the mask, not the token');
same($save['issued'] ?? [], [], 'nothing is "issued" when nothing new was asked for');
same(McpServer::config()['tokens'][0]['token'], $friendToken, 'and the stored token is unchanged');

// A new friend: the token is generated and handed over ONCE.
$incoming = $shown;
$incoming['tokens'][] = ['label' => 'bob', 'token' => '', 'scope' => ['read', 'write'], 'ips' => []];
$saved = McpServer::saveConfig($incoming);
$issued = array_values($saved['issued'] ?? []);
same(count($issued), 1, 'a new friend gets exactly one issued token');
ok(strlen((string)($issued[0] ?? '')) === 64, 'the issued token is a real 64-char secret');
same($saved['tokens'][1]['token'] ?? '', Config::SECRET_MASK, 'and it is not echoed again in the list');
same(McpServer::config()['tokens'][1]['token'], $issued[0], 'the token the reply shows is the token stored');
same(McpServer::config()['tokens'][0]['token'], $friendToken, 'the existing friend keeps their token');

// ROTATE: an empty token is the signal for "issue a new one".
$rotate = McpServer::uiConfig();
$rotate['tokens'][0]['token'] = '';
$rotated = McpServer::saveConfig($rotate);
$newToken = array_values($rotated['issued'] ?? [])[0] ?? '';
ok($newToken !== '' && $newToken !== $friendToken, 'ROTATE issues a different token');
same(McpServer::config()['tokens'][0]['token'], $newToken, 'and the rotated token is what is stored');

// A masked row that cannot be resolved is reissued, not saved as asterisks.
$unknown = McpServer::uiConfig();
$unknown['tokens'][] = ['id' => 't_ghost', 'label' => 'ghost', 'token' => Config::SECRET_MASK, 'scope' => ['read']];
$ghost = McpServer::saveConfig($unknown);
ok(strlen((string)(array_values($ghost['issued'] ?? [])[0] ?? '')) === 64,
    'an unresolvable masked friend row is reissued');
foreach (McpServer::config()['tokens'] as $t) {
    ok($t['token'] !== Config::SECRET_MASK, 'no friend token is ever stored as the mask');
}

// --- 4. the MCP client list, through its own route --------------------
write_cfg($cfgPath, []);
$listed = Mcp::uiServers();
same($listed[0]['headers']['Authorization'], Config::SECRET_MASK, 'GET /mcp/servers masks the header');
same($listed[1]['env']['GITHUB_TOKEN'], Config::SECRET_MASK, 'GET /mcp/servers masks the env');
// Round-trip the whole list, exactly as both editors do.
$report = Mcp::saveServers($listed);
ok(!empty($report['ok']), 'the list saves');
ok($report['restored'] >= 2, 'and reports the credentials it put back');
$after = Mcp::servers();
same($after[0]['headers']['Authorization'], $bearer, 'the header survived the round-trip');
same($after[1]['env']['GITHUB_TOKEN'], $envValue, 'the env value survived the round-trip');

// A genuinely new server with a real value keeps it.
$listed2 = Mcp::uiServers();
$listed2[] = ['id' => 'fresh', 'transport' => 'http', 'url' => 'https://fresh.example/v1',
    'headers' => ['Authorization' => 'Bearer fresh-real-token']];
Mcp::saveServers($listed2);
$ids = array_column(Mcp::servers(), 'id');
ok(in_array('fresh', $ids, true), 'a new server is added');
foreach (Mcp::servers() as $s) {
    if ($s['id'] !== 'fresh') { continue; }
    same($s['headers']['Authorization'], 'Bearer fresh-real-token', 'a real new header is kept as typed');
}

// --- 5. who may ask, when there is no token to check -------------------
same(Sandbox::isLocalRequest(['REMOTE_ADDR' => '127.0.0.1']), true, 'loopback is local');
same(Sandbox::isLocalRequest(['REMOTE_ADDR' => '::1']), true, 'IPv6 loopback is local');
same(Sandbox::isLocalRequest(['REMOTE_ADDR' => '::ffff:127.0.0.1']), true, 'the mapped loopback spelling is local');
same(Sandbox::isLocalRequest(['REMOTE_ADDR' => '192.168.1.5']), false, 'a LAN address is not local');
same(Sandbox::isLocalRequest(['REMOTE_ADDR' => '10.0.0.2']), false, 'another private address is not local');
same(Sandbox::isLocalRequest(['REMOTE_ADDR' => '8.8.8.8']), false, 'a public address is not local');
same(Sandbox::isLocalRequest(['REMOTE_ADDR' => '']), true, 'no peer address (the CLI) is not refused');

// --- 6. the routes themselves ----------------------------------------
if (!function_exists('proc_open')) {
    echo "  SKIP: proc_open is disabled, cannot start a test server\n";
} else {
    $root = dirname(__DIR__, 2);
    $log = $tmpDir . '/server.log';
    $proc = null;
    $base = null;
    $stop = function () use (&$proc) {
        if (is_resource($proc)) {
            @proc_terminate($proc);
            @proc_close($proc);
            $proc = null;
        }
    };
    register_shutdown_function($stop);

    for ($attempt = 1; $attempt <= 2 && $base === null; $attempt++) {
        $port = free_port();
        if (!$port) { break; }
        $env = getenv();
        $env['ROUTER_CONFIG'] = $cfgPath;
        $proc = @proc_open(
            [PHP_BINARY, '-S', '127.0.0.1:' . $port, $root . DIRECTORY_SEPARATOR . 'serve.php'],
            [1 => ['file', $log, 'a'], 2 => ['file', $log, 'a']],
            $pipes, $root, $env
        );
        if (!is_resource($proc)) { continue; }
        $candidate = 'http://127.0.0.1:' . $port;
        $deadline = microtime(true) + 6.0;
        while (microtime(true) < $deadline) {
            [$code] = http_json($candidate . '/api/status');
            if ($code !== false) { $base = $candidate; break; }
            usleep(100000);
        }
        if ($base === null) { $stop(); }
    }

    if ($base === null) {
        echo "  SKIP: could not start serve.php on a loopback port\n";
    } else {
        // A local request must still be answered (the guard only refuses other
        // machines), and its body must not contain a single stored secret.
        [$code, $body] = http_json($base . '/api/config');
        same($code, 200, 'GET /api/config is answered for a local request');
        foreach (['access token' => $accessToken, 'friend token' => $friendToken,
                  'Authorization header' => $bearer, 'env value' => $envValue,
                  'proxy password' => 'user:pw'] as $what => $secret) {
            ok(strpos($body, $secret) === false, "GET /api/config does not disclose the $what");
        }
        ok(strpos($body, Config::SECRET_MASK) !== false, 'GET /api/config shows the mask instead');

        // /api/mcp/servers sits behind the "curl is enabled" guard (the whole
        // mcp prefix does, because those routes can leave the machine), and a
        // PHP with no curl extension answers 503 before the handler runs. The
        // unit assertions above still cover the masking; say so rather than
        // reporting a pass for a route that was never reached.
        $body2 = null;
        if (!function_exists('curl_init')) {
            echo "  SKIP: /api/mcp/servers over HTTP (this PHP has no curl extension)\n";
        } else {
            [$code2, $body2] = http_json($base . '/api/mcp/servers');
            same($code2, 200, 'GET /api/mcp/servers is answered');
            ok(strpos($body2, $bearer) === false && strpos($body2, $envValue) === false,
                'GET /api/mcp/servers does not disclose a credential');
            ok(strpos($body2, Config::SECRET_MASK) !== false, 'GET /api/mcp/servers shows the mask instead');
            ok(strpos($body2, 'https://mcp.example/v1') !== false, 'and still returns what the editor needs');
        }

        [$code3, $body3] = http_json($base . '/api/mcp-server/config');
        same($code3, 200, 'GET /api/mcp-server/config is answered');
        ok(strpos($body3, $friendToken) === false, 'GET /api/mcp-server/config does not disclose a friend token');

        // The editor's own round-trip, over the real route: read, change one
        // unrelated setting, post the lot back. Every credential must survive.
        $masked = json_decode($body, true);
        ok(is_array($masked), 'the masked config is JSON');
        if (is_array($masked)) {
            $masked['theme'] = 'posted-theme';
            [$code4, $body4] = http_json($base . '/api/config', 'POST', $masked);
            same($code4, 200, 'POST /api/config is answered');
            $stored = json_decode((string)@file_get_contents($cfgPath), true);
            same($stored['theme'] ?? '', 'posted-theme', 'the edit that was posted is stored');
            same($stored['sandbox']['token'] ?? '', $accessToken, 'the access token survived a save of the mask');
            same($stored['sandbox']['proxy_active'] ?? '', 'http://user:pw@proxy.local:8080',
                'the proxy URL survived a save of the mask');
            same($stored['mcp']['servers'][0]['headers']['Authorization'] ?? '', $bearer,
                'the MCP header survived a save of the mask');
            same($stored['mcp_server']['tokens'][0]['token'] ?? '', $friendToken,
                'the friend token survived a save of the mask');
        }

        $servers = is_string($body2) ? (json_decode($body2, true)['servers'] ?? null) : null;
        if (is_array($servers)) {
            [$code5] = http_json($base . '/api/mcp/servers', 'POST', ['servers' => $servers]);
            same($code5, 200, 'POST /api/mcp/servers is answered');
            $stored = json_decode((string)@file_get_contents($cfgPath), true);
            same($stored['mcp']['servers'][0]['headers']['Authorization'] ?? '', $bearer,
                'the header survived the MCP client route round-trip');
            same($stored['mcp']['servers'][1]['env']['GITHUB_TOKEN'] ?? '', $envValue,
                'the env value survived the MCP client route round-trip');
        }
    }
    $stop();
}

// --- cleanup ----------------------------------------------------------
putenv('ROUTER_CONFIG');
foreach ((array)@glob($tmpDir . '/*') as $f) { @unlink($f); }
@rmdir($tmpDir);

// --- results ----------------------------------------------------------
echo str_repeat('-', 60) . "\n";
echo "$pass passed, $fail failed\n";
foreach ($errors as $e) { echo "  $e\n"; }
exit($fail ? 1 : 0);
