<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// Tunnels — expose this copy's MCP server off-LAN over ngrok / Cloudflare
// ============================================
//
// A friend on another network cannot reach http://localhost:8080. A reverse
// proxy tunnel fixes that without touching the router: a small daemon opens
// an OUTBOUND connection to ngrok's or Cloudflare's edge, and the edge hands
// back a public https:// URL that forwards to this machine's port. The app
// itself sees ordinary local requests, so nothing here changes how it serves,
// gates, or audits -- the MCP server's friend tokens and the storage/
// refusals apply over a tunnel exactly as on LAN.
//
// Two providers, on purpose: ngrok's URL can be reserved (its free tier gives
// one static domain) while Cloudflare's quick tunnel needs no account at all,
// so the pair is one stable address plus one disposable fallback. Either or
// both can run; each is an independent entry in the status below.
//
// There is deliberately NO agent tool for this. Opening the machine to the
// internet is an operator decision made by clicking in Config -- a model can
// neither start a tunnel nor learn that one exists from any tool result. The
// route itself sits behind the same token gate as every other Config save.
//
// Design notes (why it looks like this):
//
//   * The daemons outlive the request that starts them (that is the point), so
//     the spawn hands off to the OS and returns: Start-Process with output
//     redirection on Windows (the mechanism is headless-safe -- no desktop
//     needed, unlike Programs), `>> log 2>&1 &` on POSIX. No shell ever sees
//     operator input: argv arrays on POSIX, an argument array on Windows.
//   * The public URL is read back from the daemon's own log, not guessed: the
//     start call polls the log for up to ~25s for the provider's URL line. A
//     tunnel that never prints one is killed again rather than left running
//     with an unknown address.
//   * Pids and URLs live in storage/tunnels.json (next to config.json, via
//     Config::runtimePath), never in config.json: they are ephemeral -- a
//     reboot orphans them -- and a backup/restore must not resurrect them.
//     Every status read re-checks that the pid is still alive, so a dead
//     daemon reads as down and never as a live URL.
//   * Binaries resolve in this order: the operator's configured absolute path
//     (a service install's PATH is not the desktop's), tools/bin/ (where the
//     installers put them), then the system PATH. The card shows what resolved
//     so "not installed" and "installed where the server cannot see" are
//     different answers with different fixes.

namespace Src;

class Tunnels {
    /** How long a start waits for the daemon to print its public URL. */
    const URL_WAIT = 25;
    /** Providers this backend knows how to launch. */
    const PROVIDERS = ['ngrok', 'cloudflare'];

    /**
     * Dispatch for POST /api/sandbox/tunnels (and GET, which is status).
     * $server is $_SERVER from the caller: the served port is the tunnel's
     * default target, because the tunnel forwards to THIS copy.
     */
    public static function handle($method, $body, $server = null) {
        $body = is_array($body) ? $body : [];
        $action = strtolower(trim((string)($body['action'] ?? 'status')));
        if (strtoupper((string)$method) === 'GET') { $action = 'status'; }
        if ($action === 'start') { return self::start($body, $server); }
        if ($action === 'stop') { return self::stop($body); }
        if ($action === 'save') {
            self::saveConfig(is_array($body['tunnels'] ?? null) ? $body['tunnels'] : $body);
            return self::status($server);
        }
        return self::status($server);
    }

    // ---------------------------------------------------------------
    // Config + state
    // ---------------------------------------------------------------

    /** Operator-owned settings. Absent section means off, like everything powerful here. */
    public static function config() {
        $cfg = Config::loadConfig();
        $t = (isset($cfg['tunnels']) && is_array($cfg['tunnels'])) ? $cfg['tunnels'] : [];
        $provider = strtolower(trim((string)($t['provider'] ?? 'both')));
        if ($provider === 'all' || $provider === 'cf') {
            $provider = $provider === 'cf' ? 'cloudflare' : 'both';
        }
        if (!in_array($provider, ['ngrok', 'cloudflare', 'both'], true)) { $provider = 'both'; }
        $port = (int)($t['port'] ?? 0);
        if ($port < 1 || $port > 65535) { $port = 0; }  // 0 = auto (the served port)
        $domain = trim((string)($t['ngrok_domain'] ?? ''));
        // A reserved ngrok domain is a hostname, never a URL or a flag.
        if ($domain !== '' && !preg_match('/^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/', $domain)) { $domain = ''; }
        return [
            'enabled' => !empty($t['enabled']),
            'provider' => $provider,
            'port' => $port,
            'ngrok_domain' => $domain,
            'ngrok_path' => trim((string)($t['ngrok_path'] ?? '')),
            'cloudflared_path' => trim((string)($t['cloudflared_path'] ?? '')),
        ];
    }

    /** Save the operator's settings (paths are validated on read, not here). */
    public static function saveConfig(array $incoming) {
        $cfg = Config::loadConfig();
        if (!is_array($cfg)) { $cfg = []; }
        $t = (isset($cfg['tunnels']) && is_array($cfg['tunnels'])) ? $cfg['tunnels'] : [];
        foreach (['enabled', 'provider', 'port', 'ngrok_domain', 'ngrok_path', 'cloudflared_path'] as $k) {
            if (array_key_exists($k, $incoming)) { $t[$k] = $incoming[$k]; }
        }
        $cfg['tunnels'] = $t;
        return Config::saveConfig($cfg);
    }

    /** Ephemeral runtime state: pid + public URL per provider. */
    private static function statePath() {
        return Config::runtimePath('tunnels.json');
    }

    private static function state() {
        $raw = @file_get_contents(self::statePath());
        $d = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($d)) { $d = []; }
        $out = [];
        foreach (self::PROVIDERS as $p) {
            $row = (isset($d[$p]) && is_array($d[$p])) ? $d[$p] : [];
            $out[$p] = [
                'pid' => (int)($row['pid'] ?? 0),
                'url' => (string)($row['url'] ?? ''),
                'port' => (int)($row['port'] ?? 0),
                'started' => (string)($row['started'] ?? ''),
            ];
        }
        return $out;
    }

    private static function saveState(array $state) {
        $dir = dirname(self::statePath());
        if (!is_dir($dir)) { @mkdir($dir, 0777, true); }
        return @file_put_contents(self::statePath(), json_encode($state, JSON_PRETTY_PRINT)) !== false;
    }

    // ---------------------------------------------------------------
    // Environment
    // ---------------------------------------------------------------

    public static function platform() {
        if (PHP_OS_FAMILY === 'Windows') { return 'windows'; }
        return 'posix';
    }

    /** The port this copy is served on: the tunnel's default forward target. */
    public static function servedPort($server = null) {
        if (!is_array($server)) { $server = $_SERVER; }
        $p = (int)(is_array($server) ? ($server['SERVER_PORT'] ?? 0) : 0);
        if ($p >= 1 && $p <= 65535) { return $p; }
        return 8080;
    }

    /** The URL prefix the app is mounted at (/router under Apache, root for php -S). */
    public static function urlPrefix($server = null) {
        if (!is_array($server)) { $server = $_SERVER; }
        $script = (string)(is_array($server) ? ($server['SCRIPT_NAME'] ?? '') : '');
        $script = str_replace('\\', '/', $script);
        // /router/api/index.php -> /router ; /api/index.php -> ''.
        if (preg_match('#^(.*)/api/[^/]*$#', $script, $m)) {
            $prefix = rtrim($m[1], '/');
            if ($prefix !== '' && strpos($prefix, '/router') !== false) { return '/router'; }
            return $prefix;
        }
        return '';
    }

    /**
     * Where the daemon binary resolves, or '' when it does not.
     *
     * Order: the operator's configured absolute path (a service's PATH is not
     * the desktop's, so a full path is the fix when "installed but not found"),
     * tools/bin/ (where the installers put them), then the system PATH.
     */
    public static function binary($provider) {
        $c = self::config();
        $key = $provider === 'ngrok' ? 'ngrok_path' : 'cloudflared_path';
        $configured = $c[$key];
        if ($configured !== '') {
            $hit = self::isRunnable($configured);
            if ($hit !== null) { return $hit; }
            return '';
        }
        $bin = $provider === 'ngrok' ? 'ngrok' : 'cloudflared';
        $root = dirname(__DIR__);
        foreach ([$bin . '.exe', $bin] as $name) {
            $hit = self::isRunnable($root . DIRECTORY_SEPARATOR . 'tools'
                . DIRECTORY_SEPARATOR . 'bin' . DIRECTORY_SEPARATOR . $name);
            if ($hit !== null) { return $hit; }
        }
        if (self::platform() === 'windows') {
            $res = self::run(['where', $bin], 10);
        } else {
            $res = self::run(['sh', '-c', 'command -v ' . escapeshellarg($bin)], 10);
        }
        $first = trim((string)preg_split('/\r\n|\r|\n/', (string)$res['out'])[0] ?? '');
        if ($first !== '') {
            $hit = self::isRunnable($first);
            if ($hit !== null) { return $hit; }
        }
        return '';
    }

    private static function isRunnable($path) {
        if (!is_string($path) || trim($path) === '') { return null; }
        if (!is_file($path)) { return null; }
        if (self::platform() !== 'windows' && !is_executable($path)) { return null; }
        return $path;
    }

    /** Is this pid still alive? Answered per platform, never by name. */
    public static function pidAlive($pid) {
        $pid = (int)$pid;
        if ($pid <= 0) { return false; }
        if (self::platform() === 'windows') {
            $res = self::run(['tasklist', '/FI', 'PID eq ' . $pid, '/NH', '/FO', 'CSV'], 10);
            return strpos((string)$res['out'], '"' . $pid . '"') !== false;
        }
        if (function_exists('posix_kill')) {
            // Signal 0 performs error checking without sending anything.
            try { return @posix_kill($pid, 0); } catch (\Throwable $e) { return false; }
        }
        return is_dir('/proc/' . $pid);
    }

    // ---------------------------------------------------------------
    // Status
    // ---------------------------------------------------------------

    /** The whole picture the Config card renders, with nothing secret in it. */
    public static function status($server = null) {
        $c = self::config();
        $state = self::state();
        $port = $c['port'] > 0 ? $c['port'] : self::servedPort($server);
        $prefix = self::urlPrefix($server);
        $running = [];
        foreach (self::PROVIDERS as $p) {
            $alive = self::pidAlive($state[$p]['pid']);
            // A stored URL for a dead pid is a stale address, not a tunnel:
            // report it as down and forget it, so a restart starts clean.
            if (!$alive && ($state[$p]['pid'] || $state[$p]['url'])) {
                $state[$p] = ['pid' => 0, 'url' => '', 'port' => 0, 'started' => ''];
            }
            $bin = self::binary($p);
            $running[$p] = [
                'up' => $alive,
                'pid' => $alive ? $state[$p]['pid'] : 0,
                'url' => $alive ? $state[$p]['url'] : '',
                'port' => $alive ? $state[$p]['port'] : 0,
                'started' => $alive ? $state[$p]['started'] : '',
                'binary' => $bin !== '' ? self::show($bin) : '',
                'installed' => $bin !== '',
            ];
            if ($alive && $running[$p]['url'] !== '') {
                $running[$p]['rpc'] = rtrim($running[$p]['url'], '/') . $prefix . '/api/mcp-server';
            }
        }
        self::saveState($state);
        return [
            'enabled' => $c['enabled'],
            'provider' => $c['provider'],
            'port' => $port,
            'prefix' => $prefix,
            'platform' => self::platform(),
            'tunnels' => $running,
            'ngrok_domain' => $c['ngrok_domain'],
            'note' => 'A tunnel makes the MCP server reachable off-LAN under its friend tokens. '
                . 'Only start one deliberately -- every provider below is a public door into this machine.',
        ];
    }

    // ---------------------------------------------------------------
    // Start / stop
    // ---------------------------------------------------------------

    public static function start($body, $server = null) {
        $body = is_array($body) ? $body : [];
        $c = self::config();
        if (!$c['enabled']) {
            throw new \RuntimeException('Tunnels are off. Turn on "Tunnels" first -- a public door '
                . 'into this machine is never opened by a default, and starting one from a '
                . 'default-off state would silently skip the decision to open it.');
        }
        $want = strtolower(trim((string)($body['provider'] ?? $c['provider'])));
        if ($want === 'all' || $want === 'cf') { $want = $want === 'cf' ? 'cloudflare' : 'both'; }
        if ($want === 'both') { $providers = self::PROVIDERS; }
        elseif (in_array($want, self::PROVIDERS, true)) { $providers = [$want]; }
        else { throw new \RuntimeException('Unknown provider "' . $want . '". Use ngrok, cloudflare, or both.'); }

        $port = (int)($body['port'] ?? 0);
        if ($port < 0 || $port > 65535) {
            throw new \RuntimeException('Port "' . (string)($body['port'] ?? '') . '" is out of range (1-65535).');
        }
        if ($port === 0) { $port = $c['port'] > 0 ? $c['port'] : self::servedPort($server); }

        // The tunnel is useless if nothing answers the forward target, and the
        // failure then looks like the tunnel's fault. Refuse up front instead.
        if (!self::localListening($port)) {
            throw new \RuntimeException('Nothing is listening on 127.0.0.1:' . $port . '. Start the app '
                . 'first, or pass the port it actually runs on.');
        }

        $state = self::state();
        $out = [];
        foreach ($providers as $p) {
            if (self::pidAlive($state[$p]['pid'])) {
                $out[$p] = ['ok' => true, 'already' => true, 'pid' => $state[$p]['pid'],
                    'url' => $state[$p]['url']];
                continue;
            }
            $out[$p] = self::launch($p, $port, $c);
            $state[$p] = ['pid' => $out[$p]['pid'], 'url' => $out[$p]['url'],
                'port' => $port, 'started' => gmdate('c')];
        }
        self::saveState($state);
        return ['ok' => true, 'port' => $port, 'tunnels' => $out];
    }

    public static function stop($body) {
        $body = is_array($body) ? $body : [];
        $want = strtolower(trim((string)($body['provider'] ?? 'all')));
        if (in_array($want, ['all', 'both'], true)) { $providers = self::PROVIDERS; }
        elseif (in_array($want, self::PROVIDERS, true)) { $providers = [$want]; }
        else { throw new \RuntimeException('Unknown provider "' . $want . '". Use ngrok, cloudflare, or all.'); }
        $state = self::state();
        $out = [];
        foreach ($providers as $p) {
            $pid = $state[$p]['pid'];
            if (!self::pidAlive($pid)) {
                $out[$p] = ['ok' => true, 'already' => false, 'note' => 'It was not running.'];
            } else {
                $res = self::terminate($pid);
                $out[$p] = ['ok' => !$res['still'], 'pid' => $pid,
                    'error' => $res['still'] ? $res['error'] : ''];
            }
            $state[$p] = ['pid' => 0, 'url' => '', 'port' => 0, 'started' => ''];
        }
        self::saveState($state);
        return ['ok' => true, 'tunnels' => $out];
    }

    /**
     * Spawn one daemon with its output captured to a log, wait for its public
     * URL line, and hand back pid + url.
     *
     * A tunnel that never prints a URL is killed again: a running daemon with
     * an unknown address is worse than a failed start, because the operator
     * cannot tell anyone how to reach it and cannot tell it is theirs.
     */
    private static function launch($provider, $port, array $c) {
        $bin = self::binary($provider);
        if ($bin === '') {
            $hint = $provider === 'ngrok'
                ? 'Install it (winget install ngrok.ngrok, or the installer option), then: ngrok config add-authtoken <token>.'
                : 'Install it (winget install cloudflare.cloudflared, or the installer option). No account is needed.';
            throw new \RuntimeException('"' . $provider . '" is not installed where this server can see it. ' . $hint);
        }
        $args = $provider === 'ngrok'
            ? self::ngrokArgs($port, $c['ngrok_domain'])
            : ['tunnel', '--url', 'http://127.0.0.1:' . $port];

        Sandbox::audit(self::baseName($bin), array_merge([$bin], $args),
            Sandbox::appDir(), null, null, ['run' => self::runId(), 'phase' => 'start', 'kind' => 'tunnel']);

        $log = rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR
            . 'router-tunnel-' . $provider . '-' . getmypid() . '.log';
        @unlink($log);
        $pid = self::spawn($bin, $args, $log);
        if ($pid <= 0) {
            throw new \RuntimeException('"' . $provider . '" would not start (no process id came back). '
                . 'Check that the binary runs by hand on this machine.');
        }
        $url = '';
        $until = microtime(true) + self::URL_WAIT;
        while (microtime(true) < $until) {
            $text = @file_get_contents($log);
            if (is_string($text)) { $url = self::parseUrl($provider, $text); }
            if ($url !== '') { break; }
            if (!self::pidAlive($pid)) { break; }
            usleep(500000);
        }
        if ($url === '') {
            self::terminate($pid);
            $tail = '';
            $text = @file_get_contents($log);
            if (is_string($text) && trim($text) !== '') {
                $lines = preg_split('/\r\n|\r|\n/', trim($text));
                $tail = ' It said: ' . substr(trim((string)end($lines)), 0, 200);
            }
            @unlink($log);
            throw new \RuntimeException('"' . $provider . '" started (pid ' . $pid . ') but printed no public URL '
                . 'within ' . self::URL_WAIT . 's, so it was stopped again.' . $tail
                . ($provider === 'ngrok' ? ' A missing authtoken is the usual cause: ngrok config add-authtoken <token>.' : ''));
        }
        return ['ok' => true, 'pid' => $pid, 'url' => $url, 'log' => $log];
    }

    /** ngrok's argv. The domain is validated in config(), so this is exact, not escaped-and-hoped. */
    public static function ngrokArgs($port, $domain) {
        $args = ['http', '127.0.0.1:' . (int)$port];
        if (is_string($domain) && $domain !== '') { $args = ['http', '--domain=' . $domain, '127.0.0.1:' . (int)$port]; }
        return $args;
    }

    /**
     * The public URL back out of a daemon's own log text.
     *
     * ngrok prints `Forwarding  https://xxx.ngrok-free.dev -> http://...`;
     * cloudflared prints its `https://xxx.trycloudflare.com` route line.
     * First match wins; anything else on the line is ignored.
     */
    public static function parseUrl($provider, $text) {
        $text = (string)$text;
        if ($provider === 'ngrok') {
            if (preg_match('#https://[A-Za-z0-9.-]+\.ngrok(?:-free)?\.(?:io|dev|app)\b#', $text, $m)) {
                return $m[0];
            }
            return '';
        }
        if ($provider === 'cloudflare') {
            if (preg_match('#https://[A-Za-z0-9.-]+\.trycloudflare\.com\b#', $text, $m)) {
                return $m[0];
            }
            return '';
        }
        return '';
    }

    // ---------------------------------------------------------------
    // Process plumbing
    // ---------------------------------------------------------------

    private static function localListening($port) {
        $fp = @fsockopen('127.0.0.1', (int)$port, $errno, $errstr, 2);
        if (is_resource($fp)) { @fclose($fp); return true; }
        return false;
    }

    /**
     * Start the daemon detached with stdout+stderr captured to $log.
     *
     * Windows goes through Start-Process with output redirection -- the same
     * file-over-command-line trick Programs uses for its process table, and
     * headless-safe (a service install has no desktop for a window). POSIX
     * backgrounds the command with its output appended to the log. Returns the
     * pid, or 0 when no id came back.
     *
     * @return int
     */
    private static function spawn($bin, array $args, $log) {
        if (self::platform() === 'windows') {
            $ps1 = rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . 'router-tunnel-spawn.ps1';
            $script = '$p = Start-Process'
                . ' -FilePath ' . self::psQuote($bin)
                . ' -ArgumentList ' . implode(', ', array_map([self::class, 'psQuote'], $args))
                . ' -RedirectStandardOutput ' . self::psQuote($log)
                . ' -RedirectStandardError ' . self::psQuote($log . '.err')
                . ' -WindowStyle Hidden -PassThru' . "\n"
                . 'Write-Output $p.Id' . "\n";
            if (@file_put_contents($ps1, $script) === false) { return 0; }
            $res = self::run(['powershell', '-NoProfile', '-NonInteractive',
                '-ExecutionPolicy', 'Bypass', '-File', $ps1], 30);
            @unlink($ps1);
            return (int)trim((string)$res['out']);
        }
        $line = implode(' ', array_map('escapeshellarg', array_merge([$bin], $args)))
            . ' >> ' . escapeshellarg($log) . ' 2>&1 & echo $!';
        $res = self::run(['sh', '-c', $line], 15);
        return (int)trim((string)$res['out']);
    }

    /** One single-quoted PowerShell literal. The caller never builds a command line by hand. */
    public static function psQuote($s) {
        return "'" . str_replace("'", "''", (string)$s) . "'";
    }

    /** End one daemon. Returns whether it is actually gone (re-read, not trusted). */
    private static function terminate($pid) {
        $pid = (int)$pid;
        if ($pid <= 0) { return ['still' => false, 'error' => '']; }
        if (self::platform() === 'windows') {
            $res = self::run(['taskkill', '/PID', (string)$pid, '/T', '/F'], 15);
        } else {
            $res = self::run(['kill', '-KILL', (string)$pid], 15);
        }
        usleep(500000);
        $still = self::pidAlive($pid);
        return ['still' => $still, 'error' => $still ? 'the process did not end (it may run elevated)' : ''];
    }

    /**
     * Run a fixed argv and return combined output, exit code and timeout flag.
     * The argv is always built by this file (binary + fixed words), never from
     * operator text or a model -- there is nothing here to inject into.
     */
    private static function run(array $argv, $timeout = 15) {
        $exe = $argv[0];
        if (!is_string($exe) || $exe === '') {
            return ['out' => '', 'code' => null, 'timed_out' => false, 'timeout' => (int)$timeout];
        }
        $descriptors = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        $proc = @proc_open($argv, $descriptors, $pipes, null, null);
        if (!is_resource($proc)) {
            return ['out' => '', 'code' => null, 'timed_out' => false, 'timeout' => (int)$timeout];
        }
        @fclose($pipes[0]);
        foreach ([1, 2] as $i) {
            if (isset($pipes[$i]) && is_resource($pipes[$i])) { @stream_set_blocking($pipes[$i], false); }
        }
        $out = '';
        $t0 = microtime(true);
        $code = null;
        $timedOut = false;
        while (true) {
            foreach ([1, 2] as $i) {
                if (!isset($pipes[$i]) || !is_resource($pipes[$i])) { continue; }
                $chunk = @fread($pipes[$i], 8192);
                if (is_string($chunk) && $chunk !== '') { $out .= $chunk; }
            }
            $st = @proc_get_status($proc);
            if (!is_array($st) || !$st['running']) {
                if (is_array($st)) { $code = $st['exitcode']; }
                break;
            }
            if ((microtime(true) - $t0) > $timeout) { $timedOut = true; break; }
            usleep(100000);
        }
        foreach ([1, 2] as $i) {
            if (isset($pipes[$i]) && is_resource($pipes[$i])) {
                while (true) {
                    $chunk = @fread($pipes[$i], 8192);
                    if (!is_string($chunk) || $chunk === '') { break; }
                    $out .= $chunk;
                }
                @fclose($pipes[$i]);
            }
        }
        if ($timedOut) { @proc_terminate($proc); }
        $rc = @proc_close($proc);
        if ($code === null || $code === -1) { $code = is_int($rc) ? $rc : null; }
        return ['out' => $out, 'code' => $code, 'timed_out' => $timedOut, 'timeout' => (int)$timeout];
    }

    private static function runId() {
        try { return substr(bin2hex(random_bytes(6)), 0, 12); }
        catch (\Throwable $e) { return (string)mt_rand(100000, 999999); }
    }

    private static function baseName($p) {
        return basename(str_replace(['/', '\\'], DIRECTORY_SEPARATOR, (string)$p));
    }

    /** A display spelling of a path (forward slashes, like the rest of the UI). */
    private static function show($p) {
        return str_replace('\\', '/', (string)$p);
    }
}
