<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Mesh phase-1 (discovery) tests. mesh_peers advertises this copy's flagged
 * outbound servers and merges transitive answers hop by hop. No HTTP, no live
 * peers: downstream queries go through an injected fake dialer, and the
 * requester's own config is a temp file honoured via ROUTER_CONFIG.
 *
 * Usage: php tests/php/mesh.test.php
 */

require_once __DIR__ . '/../../autoload.php';

use Src\McpServer;

$pass = 0;
$fail = 0;
$errors = [];
function ok($cond, $name) {
    global $pass, $fail, $errors;
    if ($cond) { $pass++; } else { $fail++; $errors[] = "FAIL: $name"; }
}

$pid = getmypid();
$tmp = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-mesh-' . $pid;
@mkdir($tmp, 0777, true);

function writeCfg($tmp, $discovery, $tokens) {
    $cfg = [
        'sandbox' => [
            'read_roots' => [$tmp], 'write_roots' => [$tmp],
            'require_token' => false, 'token' => '',
            'exec_enabled' => false, 'exec_approval' => false, 'exec_allow' => [],
        ],
        'mcp_server' => [
            'enabled' => true,
            'discovery' => $discovery,
            'studio' => 'st_bryce',
            'root' => $tmp . '/friends',
            'protect' => [],
            'tokens' => $tokens,
        ],
    ];
    file_put_contents($tmp . '/config.json', json_encode($cfg, JSON_PRETTY_PRINT));
}
writeCfg($tmp, true, [
    ['id' => 't_nofwd', 'label' => 'tim', 'token' => 'TIMTOKEN', 'scope' => ['read'], 'forward' => false],
    ['id' => 't_fwd', 'label' => 'amy', 'token' => 'AMYTOKEN', 'scope' => ['read', 'write'], 'forward' => true],
]);
putenv('ROUTER_CONFIG=' . $tmp . '/config.json');
putenv('ROUTER_STATE=' . $tmp . '/state.json');
@mkdir($tmp . '/friends', 0777, true);

/** Drive one JSON-RPC call. */
function mcp($token, $method, $params = []) {
    $server = $token === null ? [] : [
        'HTTP_AUTHORIZATION' => 'Bearer ' . $token,
        'REMOTE_ADDR' => '127.0.0.1',
    ];
    return McpServer::handle(['jsonrpc' => '2.0', 'id' => 1, 'method' => $method, 'params' => $params], $server);
}
function toolList($res) {
    $names = [];
    foreach ($res['json']['result']['tools'] ?? [] as $t) { $names[] = $t['name']; }
    return $names;
}
function textOf($res) {
    return $res['json']['result']['content'][0]['text'] ?? '';
}
function isErr($res) {
    return !empty($res['json']['result']['isError']);
}
function peersOf($text) {
    $d = json_decode($text, true);
    return is_array($d) ? $d : null;
}

$TIM = ['scope' => ['read'], 'forward' => false, 'label' => 'tim'];
$AMY = ['scope' => ['read', 'write'], 'forward' => true, 'label' => 'amy'];
$SERVERS = [
    ['id' => 'you', 'transport' => 'http', 'url' => 'https://you.example/api/mcp-server', 'advertise' => true, 'headers' => []],
    ['id' => 'quiet', 'transport' => 'http', 'url' => 'https://quiet.example/api/mcp-server', 'advertise' => false, 'headers' => []],
    ['id' => 'local-bin', 'transport' => 'stdio', 'command' => 'npx', 'advertise' => true],
];
$noDial = function ($sid, $a) { throw new RuntimeException('should not dial at hops=1'); };

echo "mesh discovery (phase 1) tests\n";
echo str_repeat('-', 60) . "\n";

// --- the tool is advertised on read scope ---
$readTools = toolList(mcp('TIMTOKEN', 'tools/list'));
ok(in_array('mesh_peers', $readTools, true), 'read token sees mesh_peers');

// --- discovery off refuses ---
writeCfg($tmp, false, [['id' => 't', 'label' => 'tim', 'token' => 'TIMTOKEN', 'scope' => ['read']]]);
$off = mcp('TIMTOKEN', 'tools/call', ['name' => 'mesh_peers', 'arguments' => new stdClass()]);
ok(isErr($off) && strpos(textOf($off), 'discovery is off') !== false, 'discovery off refuses');
writeCfg($tmp, true, [['id' => 't', 'label' => 'tim', 'token' => 'TIMTOKEN', 'scope' => ['read']]]);

// --- direct entries: advertised http only, hops=1, no dial ---
$direct = peersOf(McpServer::meshPeers($TIM, [], $noDial, $SERVERS, 'st_bryce'));
ok($direct['studio'] === 'st_bryce', 'response names this studio');
ok(count($direct['peers']) === 1, 'one advertised http server listed (quiet opted out, stdio skipped)');
ok($direct['peers'][0]['via'] === 'you' && $direct['peers'][0]['hops'] === 1, 'direct entry: via + hops=1');
ok($direct['peers'][0]['url'] === 'https://you.example/api/mcp-server', 'direct entry carries the url');
ok($direct['peers'][0]['forward'] === false, 'forward flag follows the requester token (tim: no)');

// --- forward flag follows the token ---
$fwd = peersOf(McpServer::meshPeers($AMY, [], $noDial, $SERVERS, 'st_bryce'));
ok($fwd['peers'][0]['forward'] === true, 'forward flag follows the requester token (amy: yes)');

// --- hops clamp + visited cap ---
$clamped = peersOf(McpServer::meshPeers($TIM, ['hops' => 99, 'visited' => array_fill(0, 100, 'x')], $noDial, [], 'st_bryce'));
ok($clamped['peers'] === [], 'no servers, no peers; huge visited list accepted');

// --- transitive merge: C answers through B ---
$cAnswer = function ($sid, $a) {
    ok($a['hops'] === 1, 'child queried with hops-1');
    ok(in_array('st_bryce', $a['visited'], true) && in_array('st_tim', $a['visited'], true), 'visited accumulates down the path');
    return ['ok' => true, 'is_error' => false,
        'text' => json_encode(['studio' => 'st_you', 'peers' => [
            ['studio' => 'st_dana', 'url' => 'https://dana.example/x', 'hops' => 1, 'via' => 'dana-link', 'forward' => false],
            ['studio' => 'st_you', 'url' => 'https://you.example/dup', 'hops' => 5, 'via' => 'x', 'forward' => false],
        ]])];
};
$merged = peersOf(McpServer::meshPeers($TIM, ['hops' => 2, 'visited' => ['st_tim']], $cAnswer, $SERVERS, 'st_bryce'));
ok(count($merged['peers']) === 2, 'two merged entries (you + dana)');
$byStudio = [];
foreach ($merged['peers'] as $p) { $byStudio[$p['studio'] ?? '?'] = $p; }
ok(($byStudio['st_you']['hops'] ?? 99) === 1 && ($byStudio['st_you']['via'] ?? '') === 'you', 'direct hop wins over transitive duplicate');
ok(($byStudio['st_dana']['hops'] ?? 0) === 2 && ($byStudio['st_dana']['via'] ?? '') === 'you', 'transitive hop bumped, via the next hop');
ok($merged['peers'][0]['hops'] <= ($merged['peers'][1]['hops'] ?? 99), 'peers sorted by hops');

// --- a loop back to self is filtered ---
$loopDial = function ($sid, $a) {
    return ['ok' => true, 'is_error' => false,
        'text' => json_encode(['studio' => 'st_you', 'peers' => [
            ['studio' => 'st_bryce', 'url' => 'https://bryce.example/x', 'hops' => 1, 'via' => 'back', 'forward' => false],
        ]])];
};
$looped = peersOf(McpServer::meshPeers($TIM, ['hops' => 2], $loopDial, $SERVERS, 'st_bryce'));
$studios = array_column($looped['peers'], 'studio');
ok(!in_array('st_bryce', $studios, true), 'visited studios filtered out (loop cut)');

// --- dead downstream degrades to a noted direct entry ---
$deadDial = function ($sid, $a) { throw new RuntimeException('connection refused'); };
$dead = peersOf(McpServer::meshPeers($TIM, ['hops' => 2], $deadDial, $SERVERS, 'st_bryce'));
ok(count($dead['peers']) === 1 && strpos($dead['peers'][0]['note'] ?? '', 'connection refused') !== false, 'dead hop noted, not fatal');
$errDial = function ($sid, $a) { return ['ok' => false, 'is_error' => true, 'text' => 'error: mesh discovery is off on this copy']; };
$errd = peersOf(McpServer::meshPeers($TIM, ['hops' => 2], $errDial, $SERVERS, 'st_bryce'));
ok(count($errd['peers']) === 1 && strpos($errd['peers'][0]['note'] ?? '', 'discovery is off') !== false, 'downstream refusal noted, not fatal');

// --- hops=1 never dials ---
$once = peersOf(McpServer::meshPeers($TIM, ['hops' => 1], $noDial, $SERVERS, 'st_bryce'));
ok(count($once['peers']) === 1, 'hops=1 lists direct only');

// --- end to end over the wire shape (handle) with the fake reachable path untestable live; scope is enforced ---
$denied = mcp('TIMTOKEN', 'tools/call', ['name' => 'mesh_peers', 'arguments' => ['hops' => 1]]);
$d = peersOf(textOf($denied));
ok(!isErr($denied) && is_array($d) && array_key_exists('studio', $d), 'handle() runs mesh_peers for a read token');

echo str_repeat('-', 60) . "\n";
echo "$pass passed, $fail failed\n";
foreach ($errors as $e) { echo "  $e\n"; }
exit($fail ? 1 : 0);
