<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * MCP server tests. Drives Src\McpServer directly with hand-built requests —
 * no HTTP, no network — covering the handshake, per-token scope filtering, the
 * protected path list, file read/write, and the exec approval queue.
 *
 * Usage: php tests/php/mcpServer.test.php
 */

require_once __DIR__ . '/../../autoload.php';

use Src\McpServer;
use Src\Sandbox;

$pass = 0;
$fail = 0;
$errors = [];
function ok($cond, $name) {
    global $pass, $fail, $errors;
    if ($cond) { $pass++; } else { $fail++; $errors[] = "FAIL: $name"; }
}

$pid = getmypid();
$tmp = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-mcpsrv-' . $pid;
$root = $tmp . '/root';
$scratch = $tmp . '/friends';
@mkdir($root, 0777, true);
@mkdir($scratch, 0777, true);
@mkdir($tmp, 0777, true);

$cfgPath = $tmp . '/config.json';
$cfg = [
    'sandbox' => [
        'read_roots' => [$root], 'write_roots' => [$root],
        'require_token' => false, 'token' => '',
        'exec_enabled' => true,
        'exec_approval' => false,
        'exec_allow' => ['ls', 'pwd', 'echo'],
    ],
    'mcp_server' => [
        'enabled' => true,
        'root' => $scratch,
        'protect' => ['storage', '.env', '*.pem'],
        'tokens' => [
            ['id' => 't_read', 'label' => 'dave', 'token' => 'READTOKEN', 'scope' => ['read']],
            ['id' => 't_admin', 'label' => 'boss', 'token' => 'ADMINTOKEN', 'scope' => ['read', 'write', 'exec']],
        ],
    ],
];
file_put_contents($cfgPath, json_encode($cfg, JSON_PRETTY_PRINT));
putenv('ROUTER_CONFIG=' . $cfgPath);
file_put_contents($scratch . '/note.txt', "hello world\n");

// Back up the real approvals file so the exec-queue test leaves no trace.
$repo = str_replace('\\', '/', realpath(__DIR__ . '/../..'));
$approvals = $repo . '/storage/exec-approvals.json';
$approvalsBak = file_exists($approvals) ? file_get_contents($approvals) : null;

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

echo "MCP server tests\n";
echo str_repeat('-', 60) . "\n";

// The mcp root is merged into the sandbox allowlist.
$status = Sandbox::status();
ok(in_array(rtrim(str_replace('\\', '/', realpath($scratch)), '/'), $status['read_roots'], true),
    'mcp root merged into read roots');

// --- auth ---
ok(mcp(null, 'initialize')['http'] === 401, 'no token -> 401');
ok(mcp('WRONG', 'tools/list')['http'] === 401, 'bad token -> 401');
$init = mcp('READTOKEN', 'initialize');
ok($init['http'] === 200 && ($init['json']['result']['protocolVersion'] ?? '') !== '',
    'initialize returns a protocol version');

// --- scope filtering ---
$readTools = toolList(mcp('READTOKEN', 'tools/list'));
ok(in_array('read_file', $readTools, true), 'read token sees read_file');
ok(!in_array('write_file', $readTools, true), 'read token does NOT see write_file');
ok(!in_array('exec', $readTools, true), 'read token does NOT see exec');
$adminTools = toolList(mcp('ADMINTOKEN', 'tools/list'));
ok(in_array('write_file', $adminTools, true) && in_array('exec', $adminTools, true)
    && in_array('git_commit', $adminTools, true), 'admin token sees write + exec + git_commit');

// --- read + write ---
$read = mcp('READTOKEN', 'tools/call', ['name' => 'read_file', 'arguments' => ['path' => 'note.txt']]);
ok(strpos(textOf($read), 'hello world') !== false, 'read_file returns the file contents');

$blocked = mcp('READTOKEN', 'tools/call', ['name' => 'write_file', 'arguments' => ['path' => 'x.txt', 'content' => 'nope']]);
ok(!empty($blocked['json']['result']['isError']), 'read token cannot write (scope refused)');

$wrote = mcp('ADMINTOKEN', 'tools/call', ['name' => 'write_file', 'arguments' => ['path' => 'made.txt', 'content' => 'made']]);
ok(strpos(textOf($wrote), 'wrote') === 0, 'admin token writes a file');
ok(file_exists($scratch . '/made.txt'), 'the file is on disk');

// --- protected list ---
file_put_contents($scratch . '/secret.pem', 'PRIVATE');
$prot = mcp('READTOKEN', 'tools/call', ['name' => 'read_file', 'arguments' => ['path' => 'secret.pem']]);
ok(!empty($prot['json']['result']['isError']), 'protected *.pem is refused');
$protW = mcp('ADMINTOKEN', 'tools/call', ['name' => 'write_file', 'arguments' => ['path' => '.env', 'content' => 'x']]);
ok(!empty($protW['json']['result']['isError']), 'protected .env write is refused');

// --- exec: disallowed + approval off -> refusal text ---
$ex = mcp('ADMINTOKEN', 'tools/call', ['name' => 'exec', 'arguments' => ['argv' => ['whoami']]]);
ok(stripos(textOf($ex), 'not allowed') !== false, 'unallowlisted exec is refused when approval is off');

// --- exec: approval ON -> queued for the operator ---
$cfg['sandbox']['exec_approval'] = true;
file_put_contents($cfgPath, json_encode($cfg, JSON_PRETTY_PRINT));
$exq = mcp('ADMINTOKEN', 'tools/call', ['name' => 'exec', 'arguments' => ['argv' => ['whoami']]]);
ok(stripos(textOf($exq), 'waiting for the operator') !== false, 'exec queues for approval when enabled');

// restore approval state
if ($approvalsBak === null) { @unlink($approvals); } else { file_put_contents($approvals, $approvalsBak); }

// --- operator config round-trip ---
$saved = McpServer::saveConfig([
    'enabled' => true,
    'root' => $scratch,
    'protect' => [],
    'tokens' => [['label' => 'newfriend', 'scope' => ['read']]],
]);
ok(count($saved['tokens']) === 1 && $saved['tokens'][0]['token'] !== '', 'saveConfig generates a token');
ok($saved['protect'] === [], 'an empty protect list is saved (protection off is expressible)');

putenv('ROUTER_CONFIG');
@unlink($cfgPath);
@rmdir($scratch);
@rmdir($root);
@rmdir($tmp);

echo str_repeat('-', 60) . "\n";
echo "$pass passed, $fail failed\n";
foreach ($errors as $e) { echo "  $e\n"; }
exit($fail ? 1 : 0);
