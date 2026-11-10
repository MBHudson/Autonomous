<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * remote_chat (borrow-the-runner) tests. Drives Src\McpServer directly with
 * hand-built requests — no HTTP, no live provider. A remote turn would POST
 * to a real model endpoint, so every path covered here stops BEFORE the
 * network: scope gating, argument/agent validation, and the pure payload
 * builder (caps, key precedence, endpoint templating, no tools attached).
 *
 * Usage: php tests/php/remoteChat.test.php
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
$tmp = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-remotechat-' . $pid;
@mkdir($tmp, 0777, true);

$statePath = $tmp . '/state.json';
$seed = [
    'version' => 1,
    'rev' => 3,
    'updated' => time(),
    'slots' => [
        'providers' => [[
            'id' => 'openrouter',
            'name' => 'OpenRouter',
            'endpoint' => 'https://openrouter.ai/api/v1/chat/completions',
            'apiKey' => 'sk-test-provider-key',
            'models' => ['openai/gpt-4o-mini'],
            'active' => true,
        ], [
            'id' => 'ollama',
            'name' => 'Ollama',
            'endpoint' => 'http://192.168.1.9:11434/api/chat',
            'apiKey' => '',
            'models' => ['llama3'],
            'active' => true,
        ]],
        'agents' => [[
            'id' => 'commander',
            'code' => '#RS2FNH',
            'name' => 'Commander',
            'role' => 'coordinator',
            'provider' => 'openrouter',
            'model' => 'openai/gpt-4o-mini',
            'color' => '#00e5ff',
            'active' => true,
            'systemPrompt' => 'You coordinate the fleet.',
            'temperature' => 0.8,
            'maxTokens' => 500,
        ], [
            'id' => 'overridden',
            'code' => '#OVERRIDE',
            'name' => 'Overridden',
            'provider' => 'openrouter',
            'model' => 'openai/gpt-4o-mini',
            'active' => true,
            'keyOverride' => 'sk-agent-pin-wins',
            'systemPrompt' => 'Pinned key agent.',
        ], [
            'id' => 'sleepy',
            'code' => '#SLEEPY1',
            'name' => 'Sleepy',
            'provider' => 'openrouter',
            'model' => 'openai/gpt-4o-mini',
            'active' => false,
            'systemPrompt' => 'Switched off.',
        ], [
            'id' => 'templated',
            'code' => '#TMPLT1',
            'name' => 'Templated',
            'provider' => 'openrouter',
            'model' => 'openai/gpt-4o-mini',
            'active' => true,
            'curlTemplate' => 'curl $ENDPOINT-VARIABLE ...',
            'systemPrompt' => 'Runs in a browser.',
        ], [
            'id' => 'keyless',
            'code' => '#KEYLS1',
            'name' => 'Keyless',
            'provider' => 'ollama',
            'model' => 'llama3',
            'active' => true,
            'systemPrompt' => 'Local runner, no key.',
        ], [
            'id' => 'orphan',
            'code' => '#ORPHN1',
            'name' => 'Orphan',
            'provider' => 'deleted-provider',
            'model' => 'something/gone',
            'active' => true,
            'systemPrompt' => 'Provider is gone.',
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
        'root' => $tmp . '/friends',
        'protect' => [],
        'tokens' => [
            ['id' => 't_read', 'label' => 'mike', 'token' => 'READTOKEN', 'scope' => ['read']],
            ['id' => 't_write', 'label' => 'bryce', 'token' => 'WRITETOKEN', 'scope' => ['read', 'write']],
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
function isErr($res) {
    return !empty($res['json']['result']['isError']);
}
function remoteCall($token, $args) {
    return mcp($token, 'tools/call', ['name' => 'remote_chat', 'arguments' => $args]);
}

echo "remote_chat (borrow the runner) tests\n";
echo str_repeat('-', 60) . "\n";

// --- advertised on write scope only ---
$writeTools = toolList(mcp('WRITETOKEN', 'tools/list'));
ok(in_array('remote_chat', $writeTools, true), 'write token sees remote_chat');
$readTools = toolList(mcp('READTOKEN', 'tools/list'));
ok(!in_array('remote_chat', $readTools, true), 'read token does NOT see remote_chat');

// --- read token is refused even when naming it directly ---
$denied = remoteCall('READTOKEN', ['id' => 'commander', 'message' => 'hi']);
ok(isErr($denied) && strpos(textOf($denied), 'write') !== false, 'read token refused, told it needs write');

// --- validation stops before any network ---
$missing = remoteCall('WRITETOKEN', ['id' => 'nope', 'message' => 'hi']);
ok(isErr($missing) && strpos(textOf($missing), 'no agent') !== false, 'unknown agent refused');
$empty = remoteCall('WRITETOKEN', ['id' => 'commander', 'message' => '   ']);
ok(isErr($empty) && strpos(textOf($empty), 'message') !== false, 'empty message refused');
$off = remoteCall('WRITETOKEN', ['id' => 'sleepy', 'message' => 'wake up']);
ok(isErr($off) && strpos(textOf($off), 'switched off') !== false, 'inactive agent stays off remotely');
$tpl = remoteCall('WRITETOKEN', ['id' => 'templated', 'message' => 'hi']);
ok(isErr($tpl) && strpos(textOf($tpl), 'install it instead') !== false, 'curl-template agent refused with install hint');
$nokey = remoteCall('WRITETOKEN', ['id' => 'keyless', 'message' => 'hi']);
ok(isErr($nokey) && strpos(textOf($nokey), 'API key') !== false, 'keyless agent names the fix');
$noprov = remoteCall('WRITETOKEN', ['id' => 'orphan', 'message' => 'hi']);
ok(isErr($noprov) && strpos(textOf($noprov), 'provider is missing') !== false, 'deleted provider refused');

// --- payload builder: key precedence, endpoint, caps (no network) ---
$agent = ['model' => 'openai/gpt-4o-mini', 'systemPrompt' => 'Be brief.', 'temperature' => 0.8, 'maxTokens' => 500];
$prov = ['id' => 'openrouter', 'name' => 'OpenRouter', 'endpoint' => 'https://openrouter.ai/api/v1/chat/completions', 'apiKey' => 'sk-provider'];
$built = McpServer::remoteChatPayload($agent, $prov, 'hello', []);
ok($built['family'] === 'openrouter', 'family detected from endpoint');
ok($built['endpoint'] === 'https://openrouter.ai/api/v1/chat/completions', 'endpoint passes through');
ok(in_array('Authorization: Bearer sk-provider', $built['headers'], true), 'provider key used when no override');
ok(!isset($built['payload']['tools']), 'no tools attached: one inference turn');
ok($built['payload']['messages'][0] === ['role' => 'system', 'content' => 'Be brief.'], 'system prompt leads');
ok(end($built['payload']['messages']) === ['role' => 'user', 'content' => 'hello'], 'message closes');
ok($built['payload']['temperature'] === 0.8 && $built['payload']['max_tokens'] === 500, 'agent temperature/maxTokens honoured');

$pinned = McpServer::remoteChatPayload(
    ['model' => 'm', 'keyOverride' => 'sk-pin', 'systemPrompt' => 'x'],
    ['endpoint' => 'https://x.example/v1/chat/completions', 'apiKey' => 'sk-provider'], 'hi', []);
ok(in_array('Authorization: Bearer sk-pin', $pinned['headers'], true), 'agent key override wins over provider key');

$tmpl = McpServer::remoteChatPayload(
    ['model' => 'llama3', 'systemPrompt' => 'x'],
    ['endpoint' => 'http://h:11434/v1/chat/{model}', 'apiKey' => 'k'], 'hi', []);
ok(strpos($tmpl['endpoint'], '{model}') === false && strpos($tmpl['endpoint'], 'llama3') !== false, '{model} substituted in endpoint');
ok($tmpl['family'] === 'openrouter', 'openai-compatible shim detected as openrouter, not ollama');

// --- history sanitising ---
$hist = [];
for ($i = 0; $i < 30; $i++) { $hist[] = ['role' => 'user', 'content' => "q$i"]; }
$hist[] = ['role' => 'agent', 'content' => 'mapped'];
$hist[] = ['role' => 'system', 'content' => 'smuggled system'];
$hist[] = ['role' => 'user', 'content' => ''];
$hist[] = ['role' => 'user', 'content' => str_repeat('z', 9000)];
$with = McpServer::remoteChatPayload(['model' => 'm', 'systemPrompt' => 'S'], $prov, 'now', $hist);
$msgs = $with['payload']['messages'];
$roles = array_column($msgs, 'role');
ok(!in_array('system', array_slice($roles, 1), true), 'history cannot smuggle a second system prompt');
ok(in_array('assistant', $roles, true), 'agent role mapped to assistant');
ok(count(array_filter($msgs, function ($m) { return $m['role'] !== 'system'; })) <= 21, 'history capped at 20 + the new message');
$longest = 0;
foreach ($msgs as $m) { $longest = max($longest, strlen($m['content'])); }
ok($longest <= 4000, 'history entries clipped to 4000 chars');
$lastUser = null;
foreach (array_reverse($msgs) as $m) { if ($m['role'] === 'user') { $lastUser = $m['content']; break; } }
ok($lastUser === 'now', 'the new message still closes after a long history');

$big = McpServer::remoteChatPayload(['model' => 'm', 'systemPrompt' => str_repeat('s', 30000)], $prov, str_repeat('m', 9000), []);
ok(strlen($big['payload']['messages'][0]['content']) === 20000, 'system prompt clipped to 20000');
ok(strlen(end($big['payload']['messages'])['content']) === 8000, 'message clipped to 8000');

echo str_repeat('-', 60) . "\n";
echo "$pass passed, $fail failed\n";
foreach ($errors as $e) { echo "  $e\n"; }
exit($fail ? 1 : 0);
