<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Minimal MCP stdio server for the test suite. Speaks newline-delimited
 * JSON-RPC on stdin/stdout: initialize, tools/list, tools/call.
 * It exposes one tool, "echo", that returns "echo: <text>".
 */

function mcp_respond($id, $result, $isError = false) {
    $msg = $isError
        ? ['jsonrpc' => '2.0', 'id' => $id, 'error' => $result]
        : ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result];
    fwrite(STDOUT, json_encode($msg) . "\n");
    fflush(STDOUT);
}

while (($line = fgets(STDIN)) !== false) {
    $line = trim($line);
    if ($line === '') { continue; }
    $msg = json_decode($line, true);
    if (!is_array($msg)) { continue; }
    $id = $msg['id'] ?? null;
    if ($id === null) { continue; }   // a notification: nothing to answer
    $method = $msg['method'] ?? '';

    if ($method === 'initialize') {
        mcp_respond($id, [
            'protocolVersion' => '2024-11-05',
            'capabilities' => ['tools' => new stdClass()],
            'serverInfo' => ['name' => 'mock', 'version' => '1'],
        ]);
    } elseif ($method === 'tools/list') {
        mcp_respond($id, ['tools' => [[
            'name' => 'echo',
            'description' => 'Echo text back',
            'inputSchema' => [
                'type' => 'object',
                'properties' => ['text' => ['type' => 'string']],
                'required' => ['text'],
            ],
        ]]]);
    } elseif ($method === 'tools/call') {
        $name = $msg['params']['name'] ?? '';
        $args = $msg['params']['arguments'] ?? [];
        if ($name === 'echo') {
            mcp_respond($id, ['content' => [['type' => 'text', 'text' => 'echo: ' . ($args['text'] ?? '')]]]);
        } else {
            mcp_respond($id, ['content' => [['type' => 'text', 'text' => 'unknown tool']], 'isError' => true]);
        }
    } else {
        mcp_respond($id, ['code' => -32601, 'message' => 'method not found'], true);
    }
}
