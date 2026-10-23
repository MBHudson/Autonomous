<?php
/**
 * MCP stdio environment/command-resolution tests.
 *
 * Usage: php tests/php/mcpStdio.test.php
 *
 * These are pure helpers; no server is spawned.
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

$envM = new ReflectionMethod(Mcp::class, 'stdioEnv');
$envM->setAccessible(true);
$execM = new ReflectionMethod(Mcp::class, 'stdioExec');
$execM->setAccessible(true);
$resolveM = new ReflectionMethod(Mcp::class, 'resolveWindowsCommand');
$resolveM->setAccessible(true);

$server = [
    'id' => 'test', 'transport' => 'stdio', 'command' => 'npx', 'args' => ['--version'],
    'env' => ['ROUTER_TEST_ENV' => 'ok'],
];
$env = $envM->invoke(null, $server);
ok(($env['ROUTER_TEST_ENV'] ?? '') === 'ok', 'operator env override is applied');
ok(trim((string)($env['PATH'] ?? '')) !== '', 'PATH is inherited');
ok(($env['ComSpec'] ?? '') !== '' || DIRECTORY_SEPARATOR !== '\\', 'ComSpec exists on Windows');

if (DIRECTORY_SEPARATOR === '\\') {
    $tmp = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-mcp-stdio-' . getmypid();
    @mkdir($tmp, 0777, true);
    file_put_contents($tmp . '/fake-server', "not an executable\n");
    file_put_contents($tmp . '/fake-server.cmd', "@echo off\r\n");

    $env['PATH'] = $tmp . ';' . $env['PATH'];
    $resolved = str_replace('\\', '/', (string)$resolveM->invoke(null, 'fake-server', $env));
    ok(strtolower($resolved) === strtolower($tmp . '/fake-server.cmd'),
        'bare name prefers .cmd over an extensionless shim');

    $argv = $execM->invoke(null, ['command' => $tmp . '/fake-server.cmd', 'args' => ['x']], $env);
    ok(strcasecmp($argv[0], (string)($env['ComSpec'] ?: 'cmd.exe')) === 0,
        'batch files run through cmd.exe');
    ok(in_array('/c', $argv, true), 'cmd.exe gets /c');
    ok(end($argv) === 'x', 'arguments survive the cmd wrapper');

    @unlink($tmp . '/fake-server');
    @unlink($tmp . '/fake-server.cmd');
    @rmdir($tmp);
} else {
    ok(true, 'Windows command-resolution checks skipped');
}

// Env survives the config round-trip (the UI sends it for stdio servers).
$tmpCfg = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-mcp-env-' . getmypid();
@mkdir($tmpCfg, 0777, true);
$cfgPath = $tmpCfg . '/config.json';
file_put_contents($cfgPath, json_encode(['mcp' => ['servers' => []]]));
putenv('ROUTER_CONFIG=' . $cfgPath);
Mcp::saveServers([[
    'id' => 'envtest', 'transport' => 'stdio', 'command' => 'node', 'args' => [],
    'env' => ['ROUTER_TEST_ENV' => 'kept'],
]]);
$saved = Mcp::servers();
ok(count($saved) === 1 && ($saved[0]['env']['ROUTER_TEST_ENV'] ?? '') === 'kept',
    'env survives saveServers/servers');
putenv('ROUTER_CONFIG');
@unlink($cfgPath);
@rmdir($tmpCfg);

echo "MCP stdio tests\n";
echo str_repeat('-', 60), "\n";
if ($fail) {
    echo implode("\n", $errors), "\n";
    echo "$fail failed, $pass passed\n";
    exit(1);
}
echo "$pass passed, 0 failed\n";
