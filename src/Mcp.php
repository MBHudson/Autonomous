<?php
// ============================================================
// Mcp — a small Model Context Protocol client
// ============================================================
//
// MCP lets an agent use tools it was never coded against: point this at any
// MCP server (filesystem, git, fetch, sqlite, memory, a company's own server)
// and its tools become callable. Two transports are supported:
//
//   * stdio — spawn the server command and speak newline-delimited JSON-RPC
//     over its stdin/stdout. This is how almost every reference MCP server
//     ships (npx @modelcontextprotocol/server-*).
//   * http  — POST JSON-RPC to a URL (the "streamable HTTP" transport).
//
// Servers are OPERATOR-configured in storage/config.json under
// "mcp": { "servers": [ … ] }. Nothing a model says can add or change one —
// the same rule as exec: a model may call what the operator set up, not
// define new capability for itself.
//
// Every call is stateless on purpose: the handshake runs, the request runs,
// the process exits. Simpler and safer than a long-lived daemon, at the cost
// of one spawn per call.

namespace Src;

class Mcp {
    /** Protocol version advertised to servers. */
    const PROTOCOL = '2024-11-05';
    const CLIENT = 'loop-studio';
    const VERSION = '1';

    /** The operator's configured servers, or []. */
    public static function servers() {
        $cfg = Config::loadConfig();
        $list = $cfg['mcp']['servers'] ?? null;
        if (!is_array($list)) { return []; }
        $out = [];
        foreach ($list as $s) {
            if (!is_array($s)) { continue; }
            $norm = self::normalise($s);
            if ($norm !== null) { $out[] = $norm; }
        }
        return $out;
    }

    private static function normalise(array $s) {
        $id = trim((string)($s['id'] ?? $s['name'] ?? ''));
        $transport = strtolower(trim((string)($s['transport'] ?? 'stdio')));
        if ($id === '') { return null; }
        if ($transport === 'http' || $transport === 'sse') {
            $url = trim((string)($s['url'] ?? ''));
            if ($url === '') { return null; }
            return [
                'id' => $id,
                'transport' => 'http',
                'url' => $url,
                'headers' => is_array($s['headers'] ?? null) ? $s['headers'] : [],
            ];
        }
        $command = trim((string)($s['command'] ?? ''));
        if ($command === '') { return null; }
        $args = array_values(array_filter(array_map('strval', (array)($s['args'] ?? [])), fn($a) => $a !== ''));
        return ['id' => $id, 'transport' => 'stdio', 'command' => $command, 'args' => $args];
    }

    public static function server($id) {
        foreach (self::servers() as $s) {
            if ($s['id'] === (string)$id) { return $s; }
        }
        return null;
    }

    /** Replace the whole server list. Operator action only. */
    public static function saveServers(array $servers) {
        $clean = [];
        foreach ($servers as $s) {
            if (!is_array($s)) { continue; }
            $norm = self::normalise($s);
            if ($norm !== null) { $clean[] = $norm; }
        }
        $cfg = Config::loadConfig();
        if (!is_array($cfg)) { $cfg = []; }
        $cfg['mcp'] = ['servers' => $clean];
        return Config::saveConfig($cfg);
    }

    /** Reachability + tool count for every configured server. */
    public static function statusAll() {
        $out = [];
        foreach (self::servers() as $s) {
            try {
                $tools = self::listTools($s['id']);
                $out[] = ['id' => $s['id'], 'transport' => $s['transport'], 'ok' => true,
                    'tools' => count($tools)];
            } catch (\Throwable $e) {
                $out[] = ['id' => $s['id'], 'transport' => $s['transport'], 'ok' => false,
                    'error' => $e->getMessage()];
            }
        }
        return $out;
    }

    /**
     * tools/list for one server. Returns [{name, description, inputSchema}].
     */
    public static function listTools($id) {
        $s = self::server($id);
        if (!$s) { throw new \RuntimeException("mcp: no server named \"$id\""); }
        $res = self::rpc($s, 'tools/list', []);
        $tools = $res['tools'] ?? [];
        return is_array($tools) ? $tools : [];
    }

    /**
     * tools/call. Returns the server's content blocks, flattened to text plus
     * the raw payload so a caller can show either.
     */
    public static function callTool($id, $tool, $args = []) {
        $s = self::server($id);
        if (!$s) { throw new \RuntimeException("mcp: no server named \"$id\""); }
        $tool = (string)$tool;
        if ($tool === '') { throw new \RuntimeException('mcp: tool name is required'); }
        $res = self::rpc($s, 'tools/call', ['name' => $tool, 'arguments' => is_array($args) ? $args : (object)[]]);
        $text = self::flatten($res['content'] ?? null);
        return [
            'ok' => empty($res['isError']),
            'is_error' => !empty($res['isError']),
            'text' => $text,
            'content' => $res['content'] ?? null,
        ];
    }

    /** Turn MCP content blocks into plain text for a model. */
    private static function flatten($content) {
        if (is_string($content)) { return $content; }
        if (!is_array($content)) { return ''; }
        $parts = [];
        foreach ($content as $block) {
            if (is_string($block)) { $parts[] = $block; continue; }
            if (!is_array($block)) { continue; }
            $type = $block['type'] ?? '';
            if ($type === 'text') { $parts[] = (string)($block['text'] ?? ''); }
            elseif ($type === 'resource' && isset($block['resource']['text'])) { $parts[] = (string)$block['resource']['text']; }
            else { $parts[] = json_encode($block); }
        }
        return implode("\n", $parts);
    }

    // ---------------------------------------------------------------
    // JSON-RPC transports
    // ---------------------------------------------------------------

    private static function rpc(array $server, $method, $params) {
        if (($server['transport'] ?? '') === 'http') {
            return self::rpcHttp($server, $method, $params);
        }
        return self::rpcStdio($server, $method, $params);
    }

    private static function rpcStdio(array $server, $method, $params) {
        $cmd = $server['command'];
        $exec = array_merge([$cmd], $server['args'] ?? []);
        $env = [
            'PATH' => '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'HOME' => getenv('HOME') ?: sys_get_temp_dir(),
            'LANG' => 'C.UTF-8',
        ];
        $descriptors = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        $proc = @proc_open($exec, $descriptors, $pipes, null, $env);
        if (!is_resource($proc)) {
            throw new \RuntimeException('mcp: could not start "' . $cmd . '" (is it installed and on PATH?)');
        }
        // Never let a stuck server hang the web request.
        stream_set_blocking($pipes[1], true);
        stream_set_timeout($pipes[1], 25);
        stream_set_timeout($pipes[2], 1);

        $send = function ($msg) use ($pipes) {
            @fwrite($pipes[0], json_encode($msg) . "\n");
            @fflush($pipes[0]);
        };

        try {
            $send([
                'jsonrpc' => '2.0', 'id' => 1, 'method' => 'initialize',
                'params' => [
                    'protocolVersion' => self::PROTOCOL,
                    'capabilities' => new \stdClass(),
                    'clientInfo' => ['name' => self::CLIENT, 'version' => self::VERSION],
                ],
            ]);
            $init = self::readFor($pipes[1], 1);
            if ($init === null) {
                throw new \RuntimeException('mcp: server did not answer initialize. ' . self::stderrTail($pipes[2]));
            }
            $send(['jsonrpc' => '2.0', 'method' => 'notifications/initialized', 'params' => new \stdClass()]);
            $send(['jsonrpc' => '2.0', 'id' => 2, 'method' => $method, 'params' => $params ?: new \stdClass()]);
            $resp = self::readFor($pipes[1], 2);
            if ($resp === null) {
                throw new \RuntimeException('mcp: server did not answer ' . $method . '. ' . self::stderrTail($pipes[2]));
            }
        } finally {
            @fclose($pipes[0]);
            @fclose($pipes[1]);
            @fclose($pipes[2]);
            @proc_terminate($proc);
            @proc_close($proc);
        }

        if (isset($resp['error'])) {
            throw new \RuntimeException('mcp: ' . self::errText($resp['error']));
        }
        return is_array($resp['result'] ?? null) ? $resp['result'] : [];
    }

    /** Read stdin lines until a JSON-RPC response with the given id appears. */
    private static function readFor($pipe, $wantId) {
        $deadline = microtime(true) + 25;
        while (microtime(true) < $deadline) {
            $line = fgets($pipe, 1048576);
            if ($line === false) {
                $meta = stream_get_meta_data($pipe);
                if (!empty($meta['timed_out'])) { return null; }
                return null;
            }
            $line = trim($line);
            if ($line === '' || $line[0] !== '{') { continue; }   // ignore non-JSON noise
            $msg = json_decode($line, true);
            if (!is_array($msg)) { continue; }
            if (($msg['id'] ?? null) === $wantId) { return $msg; }
        }
        return null;
    }

    private static function rpcHttp(array $server, $method, $params) {
        $url = $server['url'];
        if (!preg_match('#^https?://#i', $url)) { throw new \RuntimeException('mcp: url must be http(s)'); }
        $headers = ['Content-Type: application/json', 'Accept: application/json, text/event-stream'];
        foreach (($server['headers'] ?? []) as $k => $v) {
            $k = trim((string)$k);
            if ($k === '' || strpos($k, "\n") !== false) { continue; }
            $headers[] = $k . ': ' . str_replace(["\r", "\n"], '', (string)$v);
        }
        $body = json_encode([
            'jsonrpc' => '2.0', 'id' => 1, 'method' => $method, 'params' => $params ?: new \stdClass(),
        ]);
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 30);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        $raw = curl_exec($ch);
        $err = curl_error($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($raw === false) { throw new \RuntimeException('mcp: ' . ($err ?: 'request failed')); }
        $data = json_decode($raw, true);
        // The streamable transport may answer with SSE; pull the first data: JSON line.
        if (!is_array($data) && strpos($raw, 'data:') !== false) {
            foreach (explode("\n", $raw) as $line) {
                if (strpos(trim($line), 'data:') === 0) {
                    $d = json_decode(trim(substr(trim($line), 5)), true);
                    if (is_array($d)) { $data = $d; break; }
                }
            }
        }
        if (!is_array($data)) {
            throw new \RuntimeException('mcp: server returned no JSON-RPC (HTTP ' . $code . ')');
        }
        if (isset($data['error'])) { throw new \RuntimeException('mcp: ' . self::errText($data['error'])); }
        return is_array($data['result'] ?? null) ? $data['result'] : [];
    }

    private static function errText($e) {
        if (is_string($e)) { return $e; }
        if (is_array($e)) { return (string)($e['message'] ?? json_encode($e)); }
        return 'unknown error';
    }

    private static function stderrTail($pipe) {
        $err = '';
        while (($line = fgets($pipe, 4096)) !== false) { $err .= $line; if (strlen($err) > 500) break; }
        $err = trim($err);
        return $err !== '' ? 'stderr: ' . substr($err, 0, 400) : '';
    }
}
