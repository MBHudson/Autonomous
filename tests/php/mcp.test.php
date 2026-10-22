<?php
/**
 * MCP client tests. Spawns tests/php/mcp-mock-server.php over stdio and
 * exercises the real handshake, tools/list and tools/call.
 *
 * Usage: php tests/php/mcp.test.php
 */

require_once __DIR__ . '/../../autoload.php';

use Src\Mcp;

$pass = 0;
$fail = 0;
$errors = [];

function ok($cond, $name) {
    global $pass, $fail, $errors;
    if ($cond) { $pass++; } else { $fail++; $errors[] = "FAIL: $name"; }
}

$tmp = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-mcp-test-' . getmypid();
@mkdir($tmp, 0777, true);
$cfg = $tmp . '/config.json';
$server = [
    'id' => 'mock',
    'transport' => 'stdio',
    'command' => PHP_BINARY,
    'args' => [str_replace('\\', '/', __DIR__ . '/mcp-mock-server.php')],
];
file_put_contents($cfg, json_encode([
    'sandbox' => ['require_token' => false, 'token' => ''],
    'mcp' => ['servers' => [$server]],
], JSON_PRETTY_PRINT));
putenv('ROUTER_CONFIG=' . $cfg);

echo "MCP client tests\n";
echo str_repeat('-', 60) . "\n";

$servers = Mcp::servers();
ok(count($servers) === 1 && $servers[0]['id'] === 'mock', 'servers() lists the configured server');

$tools = Mcp::listTools('mock');
ok(count($tools) === 1 && $tools[0]['name'] === 'echo', 'listTools returns the echo tool');
ok(isset($tools[0]['inputSchema']), 'tool carries its input schema');

$call = Mcp::callTool('mock', 'echo', ['text' => 'hi there']);
ok($call['text'] === 'echo: hi there', 'callTool returns the tool output');
ok($call['ok'] === true && $call['is_error'] === false, 'callTool reports success');

$bad = Mcp::callTool('mock', 'nope', []);
ok($bad['is_error'] === true, 'a tool error is surfaced as is_error');

$status = Mcp::statusAll();
ok($status[0]['ok'] === true && $status[0]['tools'] === 1, 'statusAll reports reachable + 1 tool');

try {
    Mcp::callTool('missing', 'x');
    ok(false, 'unknown server throws');
} catch (\Throwable $e) {
    ok(stripos($e->getMessage(), 'no server') !== false, 'unknown server throws');
}

// A server with no command is dropped rather than half-configured.
Mcp::saveServers([$server, ['id' => 'bad', 'transport' => 'stdio', 'command' => '']]);
$after = Mcp::servers();
ok(count($after) === 1 && $after[0]['id'] === 'mock', 'saveServers drops a server with no command');

putenv('ROUTER_CONFIG');
@unlink($cfg);
@rmdir($tmp);

echo str_repeat('-', 60) . "\n";
echo "$pass passed, $fail failed\n";
foreach ($errors as $e) { echo "  $e\n"; }
exit($fail ? 1 : 0);
