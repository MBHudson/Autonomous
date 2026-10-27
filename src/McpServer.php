<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================================
// McpServer — this app AS an MCP server
// ============================================================
//
// The mirror of Src\Mcp (the client). Where Mcp lets this app CALL other MCP
// servers, McpServer lets another machine's MCP client — a friend's local
// model, Claude Desktop, Cursor — CALL tools that run HERE.
//
// Design rules, same as everywhere else in this app:
//
//   * Operator-configured, never model-configured. Tokens live in
//     storage/config.json under "mcp_server"; nothing an agent (or a friend's
//     model) says can add one, widen a scope, or change a root.
//   * One token per friend, each with its own scope: read / write / exec.
//     The scope is a CEILING — a read-only friend cannot reach write or exec
//     even if those are globally enabled. Revoke one without touching the rest.
//   * Calls run through the SAME Sandbox checks the operator already controls
//     (exec_enabled, exec_allow/exec_deny, interpreter levels, roots,
//     code_enabled, and the approval queue). This class only decides WHICH
//     tool a token may reach; Sandbox decides whether it may run.
//   * Friends work inside their own scratch root ("mcp_server.root"), never
//     the app tree by default.
//   * The 'protect' path list (storage/, keys, dotfiles) is enforced in
//     Sandbox::jail(), so even a docroot root cannot leak the access token.
//
// Transport: JSON-RPC 2.0 over HTTP ("streamable HTTP"), served by the same
// PHP front controller as the rest of the API. JSON in, JSON out.

namespace Src;

class McpServer {
    const PROTOCOL = '2024-11-05';
    const NAME = 'Loop Studio';
    const VERSION = '1';

    /** The config block, normalised. */
    public static function config() {
        $cfg = Config::loadConfig();
        $m = $cfg['mcp_server'] ?? null;
        if (!is_array($m)) { $m = []; }
        return [
            'enabled' => !empty($m['enabled']),
            'root' => trim((string)($m['root'] ?? '')),
            'protect' => array_key_exists('protect', $m) && is_array($m['protect'])
                ? array_values(array_filter(array_map('strval', $m['protect']), fn($p) => trim($p) !== ''))
                : null,
            'tokens' => self::normaliseTokens($m['tokens'] ?? []),
        ];
    }

    /** Default protect list, mirrored from Sandbox so the UI can pre-fill it. */
    public static function defaultProtect() {
        return ['storage', '.git', '.ssh', '.htpasswd', '.htaccess', '.env',
            '*.pem', '*.key', 'id_rsa*', '*.p12', '*.pfx'];
    }

    private static function normaliseTokens($list) {
        if (!is_array($list)) { return []; }
        $out = [];
        foreach ($list as $t) {
            if (!is_array($t)) { continue; }
            $token = trim((string)($t['token'] ?? ''));
            if ($token === '') { continue; }
            $scope = array_values(array_intersect(
                is_array($t['scope'] ?? null) ? $t['scope'] : [],
                ['read', 'write', 'exec']
            ));
            $out[] = [
                'id' => (string)($t['id'] ?? ('t_' . substr(md5($token), 0, 8))),
                'label' => trim((string)($t['label'] ?? 'friend')) ?: 'friend',
                'token' => $token,
                'scope' => $scope,
                'ips' => array_values(array_filter(array_map('strval', (array)($t['ips'] ?? [])), fn($i) => trim($i) !== '')),
            ];
        }
        return $out;
    }

    /**
     * GET shape for the Config UI.
     *
     * Friend tokens come back MASKED. A token is a credential a friend holds
     * and authenticates with (authenticate() compares it with hash_equals), so
     * serving it back turned the operator-only config route into a copy of the
     * keys themselves -- and that route is behind the web-token gate, which is
     * off on a copy running without one. A freshly issued token IS returned in
     * plaintext, exactly once, by saveConfig's `issued` map: that is the moment
     * it has to be handed to the friend, and the only one.
     */
    public static function uiConfig() {
        $c = self::config();
        $tokens = [];
        foreach ($c['tokens'] as $t) {
            $t['token'] = Config::SECRET_MASK;
            $tokens[] = $t;
        }
        return [
            'enabled' => $c['enabled'],
            'root' => $c['root'],
            'protect' => $c['protect'] === null ? self::defaultProtect() : $c['protect'],
            'tokens' => $tokens,
            'defaultProtect' => self::defaultProtect(),
        ];
    }

    /**
     * Replace the whole config. Returns the saved shape plus `issued`.
     *
     * `issued` maps a token id to the plaintext of a token that was generated
     * by THIS save (a new friend, or a ROTATE): the one and only time the value
     * can be handed over. Everything else comes back masked.
     */
    public static function saveConfig($incoming) {
        if (!is_array($incoming)) { return self::uiConfig(); }
        $cfg = Config::loadConfig();
        if (!is_array($cfg)) { $cfg = []; }
        $stored = isset($cfg['mcp_server']) && is_array($cfg['mcp_server']) ? $cfg['mcp_server'] : [];
        $storedTokens = self::normaliseTokens($stored['tokens'] ?? []);

        $tokens = [];
        $issued = [];
        foreach ((array)($incoming['tokens'] ?? []) as $i => $t) {
            if (!is_array($t)) { continue; }
            $label = trim((string)($t['label'] ?? '')) ?: 'friend';
            $token = trim((string)($t['token'] ?? ''));
            $isNew = false;
            if (Config::isMask($token)) {
                // The row came back through uiConfig(), so the mask means
                // "unchanged". Resolve it against what is stored -- by id, then
                // label, then position -- and only if it cannot be resolved
                // (a hand-edited config, a restore from another machine) issue a
                // new one rather than storing the mask and locking the friend
                // out with a token no client could ever match.
                $found = Config::matchStoredToken($storedTokens, $t, (int)$i);
                $token = $found !== null ? $found : bin2hex(random_bytes(32));
                $isNew = $found === null;
            } elseif ($token === '') {
                // A new row, or ROTATE: the operator asked for a new secret.
                $token = bin2hex(random_bytes(32));
                $isNew = true;
            }
            $scope = array_values(array_intersect(
                is_array($t['scope'] ?? null) ? $t['scope'] : [],
                ['read', 'write', 'exec']
            ));
            $id = trim((string)($t['id'] ?? '')) ?: ('t_' . substr(md5($label . $token), 0, 8));
            $tokens[] = [
                'id' => $id,
                'label' => $label,
                'token' => $token,
                'scope' => $scope,
                'ips' => array_values(array_filter(array_map(
                    fn($i2) => trim((string)$i2), (array)($t['ips'] ?? [])
                ), fn($i2) => $i2 !== '')),
            ];
            if ($isNew) { $issued[$id] = $token; }
        }

        $root = trim((string)($incoming['root'] ?? ''));
        if ($root !== '') { self::ensureRoot($root); }

        $protect = is_array($incoming['protect'] ?? null)
            ? array_values(array_filter(array_map('strval', $incoming['protect']), fn($p) => trim($p) !== ''))
            : self::defaultProtect();

        $cfg['mcp_server'] = [
            'enabled' => !empty($incoming['enabled']),
            'root' => $root,
            'protect' => $protect,
            'tokens' => $tokens,
        ];
        Config::saveConfig($cfg);
        return self::uiConfig() + ['issued' => $issued];
    }

    /**
     * Create the scratch root if it is missing and drop a deny-all .htaccess
     * in it, so files a friend writes there are never served over the web.
     */
    private static function ensureRoot($root) {
        if (!is_dir($root)) { @mkdir($root, 0775, true); }
        if (!is_dir($root)) { return; }
        $htaccess = rtrim($root, '/\\') . '/.htaccess';
        if (!file_exists($htaccess)) {
            @file_put_contents($htaccess, "# Written by Loop Studio: never serve the MCP scratch dir.\n"
                . "Require all denied\nDeny from all\n");
        }
    }

    // ---------------------------------------------------------------
    // Auth
    // ---------------------------------------------------------------

    /**
     * Validate the Bearer token. Returns the token record, or
     * ['error'=>msg, 'http'=>code].
     */
    public static function authenticate($server) {
        $c = self::config();
        if (!$c['enabled']) {
            return ['error' => 'the MCP server is disabled', 'http' => 403];
        }
        $hdr = (string)($server['HTTP_AUTHORIZATION'] ?? ($server['REDIRECT_HTTP_AUTHORIZATION'] ?? ''));
        if (!preg_match('/^Bearer\s+(.+)$/i', trim($hdr), $m)) {
            return ['error' => 'missing bearer token', 'http' => 401];
        }
        $supplied = trim($m[1]);
        $ip = (string)($server['REMOTE_ADDR'] ?? '');
        foreach ($c['tokens'] as $t) {
            if (!hash_equals($t['token'], $supplied)) { continue; }
            if (!empty($t['ips']) && !in_array($ip, $t['ips'], true)) {
                return ['error' => "token not allowed from $ip", 'http' => 403];
            }
            return $t;
        }
        return ['error' => 'invalid token', 'http' => 401];
    }

    // ---------------------------------------------------------------
    // JSON-RPC
    // ---------------------------------------------------------------

    /** @return array{http:int,json:mixed} */
    public static function handle($body, $server) {
        $c = self::config();
        if (!$c['enabled']) {
            return self::out(403, self::rpcError(null, -32000, 'MCP server is disabled'));
        }
        $auth = self::authenticate($server);
        if (isset($auth['error'])) {
            return self::out($auth['http'], self::rpcError(null, -32001, $auth['error']));
        }
        $token = $auth;

        $method = (string)($body['method'] ?? '');
        $id = $body['id'] ?? null;
        $params = is_array($body['params'] ?? null) ? $body['params'] : [];
        if ($method === '') { return self::out(400, self::rpcError($id, -32600, 'Invalid Request')); }
        if ($id === null) { return self::out(202, null); }   // a notification needs no reply

        if ($method === 'initialize') {
            return self::out(200, self::rpcResult($id, [
                'protocolVersion' => self::PROTOCOL,
                'capabilities' => ['tools' => new \stdClass()],
                'serverInfo' => ['name' => self::NAME, 'version' => self::VERSION],
            ]));
        }
        if ($method === 'ping') {
            return self::out(200, self::rpcResult($id, new \stdClass()));
        }
        if ($method === 'tools/list') {
            $tools = [];
            foreach (self::tools() as $t) {
                if (!self::allowed($t['scope'], $token)) { continue; }
                $tools[] = ['name' => $t['name'], 'description' => $t['description'], 'inputSchema' => $t['schema']];
            }
            return self::out(200, self::rpcResult($id, ['tools' => $tools]));
        }
        if ($method === 'tools/call') {
            $name = (string)($params['name'] ?? '');
            $args = is_array($params['arguments'] ?? null) ? $params['arguments'] : [];
            try {
                $def = self::toolByName($name);
                if ($def === null) { throw new \RuntimeException("unknown tool \"$name\""); }
                if (!self::allowed($def['scope'], $token)) {
                    throw new \RuntimeException("\"$name\" needs the \"{$def['scope']}\" scope, which this token does not have");
                }
                $text = self::runTool($name, $args, $token);
                self::audit($token, $name, $args, true, '', is_string($text) ? $text : '');
                return self::out(200, self::rpcResult($id, ['content' => [['type' => 'text', 'text' => $text]]]));
            } catch (\Throwable $e) {
                self::audit($token, $name, $args, false, $e->getMessage());
                return self::out(200, self::rpcResult($id, [
                    'content' => [['type' => 'text', 'text' => 'error: ' . $e->getMessage()]],
                    'isError' => true,
                ]));
            }
        }
        return self::out(200, self::rpcError($id, -32601, "Method not found: $method"));
    }

    private static function allowed($scope, $token) {
        return in_array($scope, $token['scope'] ?? [], true);
    }

    private static function out($http, $json) {
        return ['http' => $http, 'json' => $json];
    }
    private static function rpcResult($id, $result) {
        return ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result];
    }
    private static function rpcError($id, $code, $message) {
        return ['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => $code, 'message' => $message]];
    }

    // ---------------------------------------------------------------
    // Tool registry
    // ---------------------------------------------------------------

    private static function str($desc) {
        return ['type' => 'string', 'description' => $desc];
    }

    /** name => {name, scope, description, schema, call} */
    public static function tools() {
        $rootArg = self::str('Path relative to your scratch folder (or absolute inside it).');
        return [
            // ---- read ----
            ['name' => 'read_file', 'scope' => 'read',
                'description' => 'Read a text file (numbered lines). Optionally a line range.',
                'schema' => ['type' => 'object', 'properties' => [
                    'path' => $rootArg, 'range' => self::str('e.g. "20-80", optional')], 'required' => ['path']]],
            ['name' => 'list_dir', 'scope' => 'read',
                'description' => 'List a directory. Omit path to list your roots.',
                'schema' => ['type' => 'object', 'properties' => ['path' => $rootArg]]],
            ['name' => 'glob_files', 'scope' => 'read',
                'description' => 'Find files by name pattern, e.g. "*.py" or "src/**/*.js".',
                'schema' => ['type' => 'object', 'properties' => ['pattern' => self::str('glob pattern')], 'required' => ['pattern']]],
            ['name' => 'grep_code', 'scope' => 'read',
                'description' => 'Search file contents by regular expression.',
                'schema' => ['type' => 'object', 'properties' => [
                    'pattern' => self::str('regular expression'),
                    'glob' => self::str('filename filter, optional')], 'required' => ['pattern']]],
            ['name' => 'stat', 'scope' => 'read',
                'description' => 'Size, mode and mtime for one path.',
                'schema' => ['type' => 'object', 'properties' => ['path' => $rootArg], 'required' => ['path']]],
            ['name' => 'fetch_url', 'scope' => 'read',
                'description' => 'Fetch a web page and get back its text (public URLs only).',
                'schema' => ['type' => 'object', 'properties' => ['url' => self::str('http(s) URL')], 'required' => ['url']]],
            ['name' => 'web_search', 'scope' => 'read',
                'description' => 'Search the web (no API key).',
                'schema' => ['type' => 'object', 'properties' => ['query' => self::str('search query')], 'required' => ['query']]],
            ['name' => 'git_read', 'scope' => 'read',
                'description' => 'Run a read-only git command: status, diff, log, show, branch, blame.',
                'schema' => ['type' => 'object', 'properties' => [
                    'args' => ['type' => 'array', 'items' => ['type' => 'string'],
                        'description' => 'e.g. ["status","--short"]']], 'required' => ['args']]],

            // ---- write ----
            ['name' => 'write_file', 'scope' => 'write',
                'description' => 'Create or overwrite a file. mode "append" to append.',
                'schema' => ['type' => 'object', 'properties' => [
                    'path' => $rootArg, 'content' => self::str('file contents'),
                    'mode' => self::str('"write" (default) or "append"')], 'required' => ['path', 'content']]],
            ['name' => 'edit_file', 'scope' => 'write',
                'description' => 'Replace an exact string in a file (must match exactly once unless replace_all).',
                'schema' => ['type' => 'object', 'properties' => [
                    'path' => $rootArg, 'old_string' => self::str('exact text to find'),
                    'new_string' => self::str('replacement'), 'replace_all' => ['type' => 'boolean']],
                    'required' => ['path', 'old_string', 'new_string']]],
            ['name' => 'insert', 'scope' => 'write',
                'description' => 'Insert text after a given 1-based line (0 = top).',
                'schema' => ['type' => 'object', 'properties' => [
                    'path' => $rootArg, 'line' => ['type' => 'integer'], 'text' => self::str('text to insert')],
                    'required' => ['path', 'line', 'text']]],
            ['name' => 'apply_patch', 'scope' => 'write',
                'description' => 'Apply a V4A patch (*** Begin Patch ... *** End Patch).',
                'schema' => ['type' => 'object', 'properties' => ['patch' => self::str('the patch text')], 'required' => ['patch']]],
            ['name' => 'multi_edit', 'scope' => 'write',
                'description' => 'Several search/replace edits in one call, all-or-nothing.',
                'schema' => ['type' => 'object', 'properties' => [
                    'edits' => ['type' => 'array', 'items' => ['type' => 'object']]], 'required' => ['edits']]],

            // ---- exec ----
            ['name' => 'exec', 'scope' => 'exec',
                'description' => 'Run one command as an argv array (no shell). May wait for the operator to approve.',
                'schema' => ['type' => 'object', 'properties' => [
                    'argv' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'e.g. ["ls","-la"]'],
                    'cwd' => self::str('working directory, optional')], 'required' => ['argv']]],
            ['name' => 'run_code', 'scope' => 'exec',
                'description' => 'Run a Python/Node/bash snippet (if the operator enabled it).',
                'schema' => ['type' => 'object', 'properties' => [
                    'language' => self::str('python | node | bash'), 'code' => self::str('the snippet')],
                    'required' => ['code']]],
            ['name' => 'git_commit', 'scope' => 'exec',
                'description' => 'Stage the given paths (or everything) and commit.',
                'schema' => ['type' => 'object', 'properties' => [
                    'message' => self::str('commit message'),
                    'paths' => ['type' => 'array', 'items' => ['type' => 'string']]], 'required' => ['message']]],
        ];
    }

    private static function toolByName($name) {
        foreach (self::tools() as $t) { if ($t['name'] === $name) { return $t; } }
        return null;
    }

    // ---------------------------------------------------------------
    // Dispatch to Sandbox (which applies every operator control)
    // ---------------------------------------------------------------

    private static function runTool($name, $args, $token) {
        $root = self::config()['root'];
        $scope = $root !== '' ? $root : null;
        $a = is_array($args) ? $args : [];
        $s = fn($k, $d = '') => is_scalar($a[$k] ?? null) ? (string)$a[$k] : ($a[$k] ?? $d);

        switch ($name) {
            case 'read_file': {
                $res = Sandbox::readFile($s('path'), $s('range') ?: null, $scope);
                return $res['path'] . ' — ' . $res['bytes'] . " bytes\n\n" . $res['content'];
            }
            case 'list_dir': {
                $path = trim($s('path'));
                $res = Sandbox::listDir($path !== '' ? $path : null, 500, $scope);
                if (isset($res['dirs'])) { return "Allowed directories:\n" . implode("\n", $res['dirs']); }
                return implode("\n", array_map(
                    fn($e) => $e['type'] === 'dir' ? $e['name'] . '/' : $e['name'] . '  (' . ($e['size'] ?? '?') . ' bytes)',
                    $res['entries'] ?? []
                )) ?: '(empty)';
            }
            case 'glob_files': {
                $res = Sandbox::globFiles($s('pattern'), null, $scope);
                return ($res['count'] ?? 0) ? implode("\n", $res['matches']) : 'no matches';
            }
            case 'grep_code': {
                $res = Sandbox::grepCode($s('pattern'), $s('glob') ?: null ?: '*.{php,js,css,html,json,md,ts,py,sh,yml,yaml,txt}', 60, $scope);
                if (empty($res['count'])) { return 'no matches in ' . ($res['files_scanned'] ?? 0) . ' files'; }
                return implode("\n", array_map(fn($m) => $m['rel'] . ':' . $m['line'] . ': ' . $m['text'], $res['matches']));
            }
            case 'stat': {
                $res = Sandbox::statPath($s('path'), $scope);
                unset($res['path']);
                return json_encode($res);
            }
            case 'fetch_url': {
                $res = Sandbox::fetchUrl($s('url'), 20000);
                return 'URL: ' . ($res['url'] ?? '') . ' (HTTP ' . ($res['status'] ?? '?') . ")\n\n" . ($res['text'] ?? '');
            }
            case 'web_search': {
                $res = Sandbox::webSearch($s('query'), 8);
                $lines = [];
                foreach (($res['results'] ?? []) as $i => $r) {
                    $lines[] = ($i + 1) . '. ' . ($r['title'] ?? '') . "\n   " . ($r['url'] ?? '') . "\n   " . ($r['snippet'] ?? '');
                }
                return $lines ? implode("\n", $lines) : 'no results';
            }
            case 'git_read':
            case 'git_commit': {
                if ($name === 'git_read') {
                    $args2 = is_array($a['args'] ?? null) ? array_map('strval', $a['args']) : preg_split('/\s+/', $s('args'));
                    $sub = strtolower((string)($args2[0] ?? ''));
                    if (!in_array($sub, ['status', 'diff', 'log', 'show', 'branch', 'blame', 'rev-parse', 'ls-files'], true)) {
                        throw new \RuntimeException("git_read only runs read-only subcommands (got \"$sub\")");
                    }
                    $res = Sandbox::gitRun($args2, $scope, $scope);
                } else {
                    $paths = is_array($a['paths'] ?? null) ? $a['paths'] : [];
                    $res = Sandbox::gitCommit($s('message'), $paths, $scope, $scope);
                }
                $out = trim(($res['stdout'] ?? '') . "\n" . ($res['stderr'] ?? ''));
                if (isset($res['exit']) && !$res['ok'] && !($res['nothing_to_commit'] ?? false)) {
                    throw new \RuntimeException($out !== '' ? $out : 'git failed');
                }
                return $out !== '' ? $out : (($res['nothing_to_commit'] ?? false) ? 'nothing to commit' : 'ok');
            }
            case 'write_file': {
                $res = Sandbox::writeFile($s('path'), $s('content'), $s('mode') ?: 'write', $scope);
                return 'wrote ' . $res['bytes_written'] . ' bytes to ' . $res['path'];
            }
            case 'edit_file': {
                $res = Sandbox::strReplace($s('path'), $s('old_string'), $s('new_string'), !empty($a['replace_all']), $scope);
                return 'edited ' . $res['path'] . ' (' . $res['replaced'] . ' replacement' . ($res['replaced'] === 1 ? '' : 's') . ')';
            }
            case 'insert': {
                $res = Sandbox::insertAt($s('path'), (int)($a['line'] ?? 0), $s('text'), $scope);
                return 'inserted after line ' . $res['inserted_after'] . ' (' . $res['lines'] . ' lines)';
            }
            case 'apply_patch': {
                $res = Sandbox::applyPatch($s('patch'), $scope);
                return 'applied ' . $res['count'] . ' change(s)';
            }
            case 'multi_edit': {
                $res = Sandbox::multiEdit(is_array($a['edits'] ?? null) ? $a['edits'] : [], $scope);
                return 'applied ' . $res['count'] . ' edit(s)';
            }
            case 'exec': {
                $argv = is_array($a['argv'] ?? null) ? $a['argv'] : preg_split('/\s+/', $s('argv'));
                $argv = array_values(array_filter(array_map(fn($x) => (string)$x, (array)$argv), fn($x) => $x !== ''));
                if (!$argv) { throw new \RuntimeException('exec needs an argv array'); }
                $res = Sandbox::execCommand($argv, [
                    'cwd' => $s('cwd') ?: $scope,
                    'agent' => 'mcp:' . ($token['label'] ?? 'friend'),
                ]);
                if (!empty($res['pending'])) {
                    return "waiting for the operator to approve this command (id {$res['pending']}). "
                        . 'It is in their Config → Pending approvals list; retry shortly.';
                }
                $parts = [];
                if (!empty($res['stdout'])) { $parts[] = rtrim($res['stdout']); }
                if (!empty($res['stderr'])) { $parts[] = '[stderr] ' . trim($res['stderr']); }
                if (!$parts) { $parts[] = '(no output)'; }
                if (!empty($res['truncated'])) { $parts[] = '[output truncated]'; }
                $parts[] = '[exit ' . ($res['exit'] ?? '?') . ', ' . ($res['ms'] ?? '?') . 'ms]';
                return implode("\n", $parts);
            }
            case 'run_code': {
                $res = Sandbox::runCode($s('language') ?: 'python', $s('code'), ['cwd' => $scope, 'root' => $scope]);
                $parts = [];
                if (!empty($res['stdout'])) { $parts[] = rtrim($res['stdout']); }
                if (!empty($res['stderr'])) { $parts[] = '[stderr] ' . trim($res['stderr']); }
                if (!$parts) { $parts[] = '(no output)'; }
                if (!empty($res['timed_out'])) { $parts[] = '[timed out]'; }
                $parts[] = '[exit ' . ($res['exit'] ?? '?') . ', ' . ($res['ms'] ?? '?') . 'ms]';
                return implode("\n", $parts);
            }
        }
        throw new \RuntimeException("tool \"$name\" is not implemented");
    }

    /**
     * One JSON line per call in storage/mcp.log. Best-effort.
     *
     * JSON, not prose: the topology reads these back to draw a friend's
     * traffic and fill its card, and free text (with spaces in an error or an
     * argument) was unparseable. Every field is length-capped so one huge
     * output cannot bloat the log.
     */
    private static function audit($token, $tool, $args, $ok, $err = '', $result = '') {
        try {
            $dir = self::appDirSafe() . '/storage';
            if (!is_dir($dir)) { return; }
            $entry = [
                'at' => date('c'),
                'mcp' => (string)($token['label'] ?? '?'),
                'scope' => array_values($token['scope'] ?? []),
                'tool' => (string)$tool,
                'ok' => (bool)$ok,
                'err' => $err !== '' ? self::clip($err, 300) : '',
                'args' => self::brief($args),
                'result' => $result !== '' ? self::clip($result, 400) : '',
            ];
            @file_put_contents(
                $dir . '/mcp.log',
                json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n",
                FILE_APPEND | LOCK_EX
            );
        } catch (\Throwable $e) { /* never fail a call over logging */ }
    }

    private static function clip($s, $n) {
        $s = str_replace(["\r", "\n"], ' ', (string)$s);
        return strlen($s) > $n ? substr($s, 0, $n) . '…' : $s;
    }

    private static function brief($v) {
        if (is_string($v)) { return self::clip($v, 300); }
        try {
            return self::clip(json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 300);
        } catch (\Throwable $e) { return ''; }
    }

    /**
     * Recent calls friends have made, newest last, for the topology's cards.
     * Each entry keeps its absolute line number as `seq` so a poller can tell
     * which are new. Unparseable (older-format) lines are skipped.
     */
    public static function activity($limit = 80) {
        try {
            $path = self::appDirSafe() . '/storage/mcp.log';
            if (!is_file($path)) { return []; }
            $lines = @file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
            if (!is_array($lines)) { return []; }
            $out = [];
            foreach (array_slice($lines, -$limit, null, true) as $seq => $line) {
                $e = json_decode($line, true);
                if (!is_array($e)) { continue; }
                $e['seq'] = (int)$seq;
                $out[] = $e;
            }
            return $out;
        } catch (\Throwable $e) { return []; }
    }

    private static function appDirSafe() {
        $dir = realpath(__DIR__ . '/..');
        return $dir === false ? '' : rtrim(str_replace('\\', '/', $dir), '/');
    }
}
