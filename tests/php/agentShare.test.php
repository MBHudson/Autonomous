<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent-mesh tests. Drives Src\McpServer directly with hand-built requests —
 * no HTTP, no network — covering the three mesh tools: list_agents and
 * get_agent (read scope) browse and fetch shareable defs, and install_agent
 * (write scope) installs one as a NEW inactive agent with secrets stripped.
 *
 * Usage: php tests/php/agentShare.test.php
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
$tmp = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-agentshare-' . $pid;
@mkdir($tmp, 0777, true);
$scratch = $tmp . '/friends';
@mkdir($scratch, 0777, true);

// A state.json with one key-holding agent.
$statePath = $tmp . '/state.json';
$seed = [
    'version' => 1,
    'rev' => 7,
    'updated' => time(),
    'slots' => [
        'agents' => [[
            'id' => 'commander',
            'code' => '#RS2FNH',
            'name' => 'Commander',
            'role' => 'coordinator',
            'provider' => 'openrouter',
            'model' => 'openai/gpt-4o-mini',
            'color' => '#00e5ff',
            'active' => true,
            'memory' => true,
            'systemPrompt' => 'You coordinate the fleet.',
            'temperature' => 1.0,
            'maxTokens' => 16384,
            'tools' => ['read_file', 'mcp_call'],
            'endpoint' => 'http://192.168.1.9:11434/api/chat',
            'keyOverride' => 'sk-live-should-never-travel',
            'curlTemplate' => 'curl $ENDPOINT-VARIABLE ...',
            'alwaysOn' => true,
            'alwaysOnGoal' => 'Watch the fleet.',
        ]],
    ],
];
file_put_contents($statePath, json_encode($seed, JSON_PRETTY_PRINT));

$cfgPath = $tmp . '/config.json';
$cfg = [
    'sandbox' => [
        'read_roots' => [$tmp], 'write_roots' => [$tmp],
        'require_token' => false, 'token' => '',
        'exec_enabled' => false,
        'exec_approval' => false,
        'exec_allow' => [],
    ],
    'mcp_server' => [
        'enabled' => true,
        'root' => $scratch,
        'protect' => [],
        'tokens' => [
            ['id' => 't_read', 'label' => 'dave', 'token' => 'READTOKEN', 'scope' => ['read']],
            ['id' => 't_write', 'label' => 'boss', 'token' => 'WRITETOKEN', 'scope' => ['read', 'write']],
        ],
    ],
];
file_put_contents($cfgPath, json_encode($cfg, JSON_PRETTY_PRINT));
putenv('ROUTER_CONFIG=' . $cfgPath);
putenv('ROUTER_STATE=' . $statePath);

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

echo "Agent share (mesh) tests\n";
echo str_repeat('-', 60) . "\n";

// --- the tools are advertised by scope ---
$readTools = toolList(mcp('READTOKEN', 'tools/list'));
ok(in_array('list_agents', $readTools, true), 'read token sees list_agents');
ok(in_array('get_agent', $readTools, true), 'read token sees get_agent');
ok(!in_array('install_agent', $readTools, true), 'read token does NOT see install_agent');
$writeTools = toolList(mcp('WRITETOKEN', 'tools/list'));
ok(in_array('install_agent', $writeTools, true), 'write token sees install_agent');

// --- list_agents: cards only, no prompts or keys ---
$listed = mcp('READTOKEN', 'tools/call', ['name' => 'list_agents', 'arguments' => new stdClass()]);
$cards = json_decode(textOf($listed), true);
ok(is_array($cards) && count($cards) === 1, 'list_agents returns one card');
ok(($cards[0]['id'] ?? '') === 'commander', 'card carries the id');
ok(!isset($cards[0]['systemPrompt']), 'card carries no system prompt');
ok(strpos(textOf($listed), 'sk-live-should-never-travel') === false, 'card carries no keys');

// --- get_agent: by id and by #code, sanitised ---
$got = mcp('READTOKEN', 'tools/call', ['name' => 'get_agent', 'arguments' => ['id' => 'commander']]);
$def = json_decode(textOf($got), true);
ok(($def['name'] ?? '') === 'Commander', 'get_agent returns the def');
ok(($def['systemPrompt'] ?? '') === 'You coordinate the fleet.', 'def carries the prompt');
ok(!isset($def['keyOverride']) && !isset($def['endpoint']) && !isset($def['curlTemplate']), 'def strips secrets and network');
$byCode = mcp('READTOKEN', 'tools/call', ['name' => 'get_agent', 'arguments' => ['id' => '#RS2FNH']]);
ok(strpos(textOf($byCode), 'Commander') !== false, 'get_agent works by #code');
$missing = mcp('READTOKEN', 'tools/call', ['name' => 'get_agent', 'arguments' => ['id' => 'nope']]);
ok(!empty($missing['json']['result']['isError']), 'unknown agent is an error, not an empty def');

// --- install_agent: read scope is refused ---
$refused = mcp('READTOKEN', 'tools/call', ['name' => 'install_agent', 'arguments' => ['agent' => $def]]);
ok(!empty($refused['json']['result']['isError']), 'read token cannot install (scope refused)');

// --- install_agent: write scope installs a NEW inactive agent ---
$evil = $def;
$evil['keyOverride'] = 'sk-smuggled';
$evil['endpoint'] = 'http://evil.example/';
$evil['active'] = true;
$evil['alwaysOn'] = true;
$done = mcp('WRITETOKEN', 'tools/call', ['name' => 'install_agent', 'arguments' => ['agent' => $evil]]);
ok(empty($done['json']['result']['isError']), 'write token installs: ' . textOf($done));
$after = json_decode(file_get_contents($statePath), true);
$agents = $after['slots']['agents'] ?? [];
ok(count($agents) === 2, 'state.json gains exactly one agent');
$new = $agents[1] ?? [];
ok(($new['id'] ?? '') !== 'commander' && ($new['code'] ?? '') !== '#RS2FNH', 'id and code are minted fresh');
ok(empty($new['active']) && empty($new['alwaysOn']), 'install lands inactive with no standing goal');
ok(!isset($new['keyOverride']) && !isset($new['endpoint']) && !isset($new['curlTemplate']), 'smuggled secrets are stripped on install');
ok(($new['systemPrompt'] ?? '') === 'You coordinate the fleet.', 'prompt survives the trip');
ok(($after['rev'] ?? 0) === 8, 'rev bumps so other devices adopt it');

// --- validation: nameless payloads are refused, state untouched ---
$before = count(json_decode(file_get_contents($statePath), true)['slots']['agents']);
$bad = mcp('WRITETOKEN', 'tools/call', ['name' => 'install_agent', 'arguments' => ['agent' => ['role' => 'x']]]);
ok(!empty($bad['json']['result']['isError']), 'nameless agent is refused');
ok(count(json_decode(file_get_contents($statePath), true)['slots']['agents']) === $before, 'refused install writes nothing');

putenv('ROUTER_CONFIG');
putenv('ROUTER_STATE');
@unlink($statePath);
@unlink($cfgPath);
@rmdir($scratch);
@rmdir($tmp);

echo str_repeat('-', 60) . "\n";
echo "$pass passed, $fail failed\n";
foreach ($errors as $e) { echo "  $e\n"; }
exit($fail ? 1 : 0);
