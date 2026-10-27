<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// Programs — opening (and closing) real windows on this machine
// ============================================
//
// An agent could already start a GUI program the hard way: allowlist it for the
// shell and accept that exec WAITS for it, force-kills it at the timeout, and
// stalls the whole turn while the window is open. This is the sanctioned path
// instead, and three properties are the whole point of it:
//
//   * The agent NAMES a program; the operator's config owns the path and the
//     arguments. A name from config -- never a command line from a model -- is
//     what reaches the OS launcher, so `;`, `&`, `|`, quotes and `$(...)` have
//     nowhere to land. Same reason Sandbox::execCommand takes argv and refuses
//     a command string.
//
//   * DETACHED, so a window outlives the request. Windows uses `cmd /c start`,
//     the mechanism src/Browser.php already uses to open Chrome; POSIX
//     backgrounds the process. Nothing is waited on, so no timeout can kill
//     what the operator asked to open, and the agent's turn is not held open.
//
//   * Recorded as a start with NO end. storage/exec.log's two-phase format
//     exists for exactly this ("a GUI app stays open" is in Sandbox::audit's
//     own comment), so an opened window shows up as started-and-still-running
//     rather than leaving no trace at all.
//
// The operator's list IS the allowlist, and there is no second one: a program
// here is not checked against sandbox.exec_deny, because that list is a rule
// about COMMANDS a model invents. This is the operator naming an app, which is
// the same override `exec_interpreters` already makes. Those two lists are the
// only things standing between a model and this launcher.
//
// Config lives in storage/config.json:
//
//   "sandbox": {
//     "programs_enabled": true,
//     "programs": [
//       { "name": "notepad", "path": "C:\\Windows\\System32\\notepad.exe" },
//       { "name": "files",   "path": "/usr/bin/nautilus", "args": ["/home/me"] }
//     ]
//   }
//
// Absent means off, so an existing install gains nothing by updating.

namespace Src;

class Programs {
    /** Bounds, so a hand-edited config cannot make every list call expensive. */
    const MAX_APPS = 40;
    const MAX_NAME = 40;
    const MAX_ARGV = 12;

    /**
     * The cheap summary for /sandbox/status.
     *
     * Deliberately does NOT resolve paths or look for running processes: status
     * is polled by the UI and by every agent turn's environment header, and a
     * process listing per configured app does not belong in it. The full
     * picture is list(), which the Config card asks for on demand.
     */
    public static function status() {
        $c = self::config();
        return [
            'enabled'  => $c['enabled'],
            'platform' => self::platform(),
            'count'    => count($c['apps']),
            'names'    => array_values(array_map(fn($a) => $a['name'], $c['apps'])),
        ];
    }

    /** Dispatch for POST /sandbox/program. */
    public static function handle($body) {
        $body = is_array($body) ? $body : [];
        $action = strtolower(trim((string)($body['action'] ?? 'list')));
        if ($action === 'open')  { return self::open($body['name'] ?? '', $body); }
        if ($action === 'close') { return self::close($body['name'] ?? '', $body); }
        return self::list();
    }

    // ---------------------------------------------------------------
    // Policy
    // ---------------------------------------------------------------

    private static function config() {
        $cfg = Config::loadConfig();
        $sb = (isset($cfg['sandbox']) && is_array($cfg['sandbox'])) ? $cfg['sandbox'] : [];
        return [
            'enabled' => !empty($sb['programs_enabled']),
            'apps'    => self::apps($sb['programs'] ?? null),
        ];
    }

    /**
     * Normalise the operator's list. Anything unusable is dropped HERE rather
     * than at launch time, so the card can show the list the launcher will
     * actually honour and a typo cannot look configured but never match.
     */
    private static function apps($raw) {
        if (!is_array($raw)) { return []; }
        $out = [];
        $seen = [];
        foreach ($raw as $row) {
            // A bare string is a path whose file name is the name: the shorthand
            // someone types first, and it should work rather than be ignored.
            if (is_string($row)) {
                $row = ['name' => pathinfo(trim($row), PATHINFO_FILENAME), 'path' => $row];
            }
            if (!is_array($row)) { continue; }

            $name = trim((string)($row['name'] ?? ''));
            $path = trim((string)($row['path'] ?? ''));
            if ($name === '' || $path === '') { continue; }
            // A name the agent has to type back. Keep it to something that
            // survives JSON, a prompt and a case-insensitive match.
            if (strlen($name) > self::MAX_NAME
                || !preg_match('/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/', $name)) { continue; }
            $key = strtolower($name);
            // First wins: a duplicate name is ambiguous, and guessing which one
            // the operator meant is worse than ignoring the second.
            if (isset($seen[$key])) { continue; }
            $seen[$key] = true;

            $out[] = [
                'id'   => substr(sha1($key . '|' . $path), 0, 10),
                'name' => $name,
                'path' => $path,
                'args' => self::argv($row['args'] ?? null),
            ];
            if (count($out) >= self::MAX_APPS) { break; }
        }
        return $out;
    }

    /** Arguments as an array, or one per line when the operator typed them. */
    private static function argv($raw) {
        if ($raw === null || $raw === '') { return []; }
        if (is_string($raw)) { $raw = preg_split('/\r\n|\r|\n/', $raw); }
        if (!is_array($raw)) { return []; }
        $out = [];
        foreach ($raw as $a) {
            if (!is_scalar($a)) { continue; }
            $a = (string)$a;
            if (trim($a) === '') { continue; }
            $out[] = $a;
            if (count($out) >= self::MAX_ARGV) { break; }
        }
        return $out;
    }

    /** Which launcher this host needs. */
    public static function platform() {
        if (PHP_OS_FAMILY === 'Windows') { return 'windows'; }
        if (PHP_OS_FAMILY === 'Darwin') { return 'macos'; }
        if (PHP_OS_FAMILY === 'Linux') { return 'linux'; }
        return 'posix';
    }

    /**
     * Environment truths the operator (and the model) need to know, because
     * both of the interesting failure modes are invisible from the UI:
     * a service session draws windows nowhere, and a headless host has no
     * desktop at all.
     */
    private static function notes() {
        $p = self::platform();
        if ($p === 'windows') {
            $note = 'Windows: a program opens in the session Apache runs in. '
                . 'Started as a console process (the bundled start.bat) it appears on your desktop; '
                . 'installed as a Windows SERVICE it lands in session 0 and no window is ever visible.';
            $missing = [];
            if (!function_exists('popen')) { $missing[] = 'popen is disabled in php.ini'; }
            if ($missing) { $note .= ' Unavailable here: ' . implode('; ', $missing) . '.'; }
            return $note;
        }
        $display = (string)(getenv('DISPLAY') ?? '');
        $wayland = (string)(getenv('WAYLAND_DISPLAY') ?? '');
        if ($display === '' && $wayland === '') {
            return 'No desktop session here (DISPLAY and WAYLAND_DISPLAY are both unset), so a window has '
                . 'nowhere to appear. Programs can still be started; nothing will be visible.';
        }
        return 'X11 session on ' . $display . ': programs open on the desktop this Apache runs under.';
    }

    // ---------------------------------------------------------------
    // List
    // ---------------------------------------------------------------

    /** Every configured program, resolved, checked, and whether it is running. */
    public static function list() {
        $c = self::config();
        // ONE process listing for the whole card, not one per row: the table is
        // a single expensive call on Windows, and every row is answered from it.
        $table = self::processTable();
        $apps = [];
        foreach ($c['apps'] as $a) {
            $exe = self::resolve($a['path']);
            $row = [
                'id' => $a['id'], 'name' => $a['name'], 'path' => $a['path'], 'args' => $a['args'],
                'resolved' => $exe === null ? '' : self::show($exe),
                'exists' => $exe !== null,
                'error' => '',
                'running' => [],
            ];
            if ($exe === null) {
                $row['error'] = self::whyMissing($a['path']);
            } else {
                $row['error'] = self::policyProblem($exe);
                if ($row['error'] === '') { $row['running'] = self::pidsFor($exe, $table); }
            }
            $apps[] = $row;
        }
        // Everything here came through apps(), so a row that the policy drops
        // simply is not in the list -- there is no "dropped" count to report,
        // and inventing one would suggest the launcher kept something it did not.
        $notes = self::notes();
        if (!is_array($table)) {
            // "not running" and "cannot tell" are different answers, and a card
            // that showed the first for the second would have the operator
            // closing something that was never open.
            $notes .= ' This host would not give up a process list, so "not running" below means '
                . 'NOT KNOWN, and closing would refuse rather than guess.';
        }
        return [
            'enabled'  => $c['enabled'],
            'platform' => self::platform(),
            'apps'     => $apps,
            'notes'    => $notes,
            'processes' => is_array($table) ? 'exact paths' : 'unavailable',
            'max'      => self::MAX_APPS,
        ];
    }

    /** Find a configured program by name, or by its id (both case-insensitive). */
    private static function find(array $apps, $name) {
        $want = strtolower(trim((string)$name));
        if ($want === '') { return null; }
        foreach ($apps as $a) {
            if (strtolower($a['name']) === $want) { return $a; }
        }
        foreach ($apps as $a) {
            if ($a['id'] === $want) { return $a; }
        }
        return null;
    }

    // ---------------------------------------------------------------
    // Open
    // ---------------------------------------------------------------

    /**
     * Open one configured program, detached.
     *
     * Returns as soon as the launcher has handed off -- it never waits for the
     * window, which is why there is no timeout here to kill it afterwards.
     */
    public static function open($name, array $opts = []) {
        $c = self::config();
        if (!$c['enabled']) {
            throw new \RuntimeException('Opening programs is off. Turn on "Programs" in Config -> Shell access '
                . '(storage/config.json -> sandbox.programs_enabled) to let an agent open one.');
        }
        if (!$c['apps']) {
            throw new \RuntimeException('No programs are configured yet. Add one in Config -> Shell access -> '
                . 'Programs (storage/config.json -> sandbox.programs).');
        }
        $app = self::find($c['apps'], $name);
        if ($app === null) {
            throw new \RuntimeException('No program called "' . trim((string)$name) . '" is configured. '
                . 'Configured here: ' . implode(', ', array_column($c['apps'], 'name')) . '.');
        }
        $exe = self::resolve($app['path']);
        if ($exe === null) {
            throw new \RuntimeException('"' . $app['name'] . '" points at "' . $app['path'] . '", which '
                . 'nothing on this machine matches. Fix the path in Config -> Shell access -> Programs.');
        }
        $problem = self::policyProblem($exe);
        if ($problem !== '') { throw new \RuntimeException($problem); }

        $argv = array_merge([$exe], $app['args']);
        $runId = substr(bin2hex(random_bytes(6)), 0, 12);
        // Start line BEFORE the spawn, and deliberately no end line: the process
        // is meant to outlive this request, so "started, never finished" is the
        // correct record -- and it is what makes an opened window visible in
        // Config -> TRACE -> EXEC instead of invisible.
        Sandbox::audit(self::baseName($exe), $argv, Sandbox::appDir(), null, null, [
            'run' => $runId, 'phase' => 'start', 'kind' => 'program',
            'agent' => (string)($opts['agent'] ?? ''),
        ]);

        $line = self::detach($exe, $app['args']);
        $table = self::processTable();
        $running = self::pidsFor($exe, $table);

        return [
            'ok' => true,
            'name' => $app['name'],
            'path' => self::show($exe),
            'args' => $app['args'],
            'command' => $line,
            'run' => $runId,
            'running' => $running,
            'note' => 'Opened detached: it stays open after this reply. '
                . (!is_array($table)
                    ? 'This host would not give up a process list, so whether it is running '
                        . 'cannot be confirmed here.'
                    : ($running
                        ? 'Its process is running now.'
                        : 'It may take a moment to appear -- check with window_list before opening it again.')),
        ];
    }

    // ---------------------------------------------------------------
    // Close
    // ---------------------------------------------------------------

    /**
     * Close the running processes of one configured program.
     *
     * Windows gets `taskkill /PID` WITHOUT /F by default, which posts WM_CLOSE
     * to the program's top-level window: a graceful close, so an editor can
     * still ask about unsaved work. `force` (and every POSIX path) is a signal
     * the program does not get to refuse.
     */
    public static function close($name, array $opts = []) {
        $c = self::config();
        if (!$c['enabled']) {
            throw new \RuntimeException('Opening programs is off, so nothing was opened from here to close '
                . '(storage/config.json -> sandbox.programs_enabled).');
        }
        $app = self::find($c['apps'], $name);
        if ($app === null) {
            throw new \RuntimeException('No program called "' . trim((string)$name) . '" is configured. '
                . 'Configured here: ' . implode(', ', array_column($c['apps'], 'name')) . '.');
        }
        $exe = self::resolve($app['path']);
        if ($exe === null) {
            // Same stance as "nothing was running" below: a path that resolves
            // to nothing cannot be running, and reporting that as a failed close
            // would send a model round the loop for an answer it already has.
            return [
                'ok' => true, 'name' => $app['name'], 'closed' => 0, 'pids' => [],
                'note' => 'Nothing of "' . $app['name'] . '" is running -- its path "' . $app['path']
                    . '" matches nothing on this machine.',
            ];
        }

        $table = self::processTable();
        if (!is_array($table)) {
            // Refusing is the honest answer, not a bug. On a host that will not
            // hand over its process list the only fallback left is matching on
            // the file NAME, and that is how a close ends a different program
            // that happens to share it. A refusal costs one retry; the other
            // costs whatever that process was holding.
            throw new \RuntimeException('Cannot tell which processes are "' . $app['name']
                . '" on this host (no process list available), and closing by name alone could end a '
                . 'different program that shares its file name. Nothing was closed.');
        }
        $pids = self::pidsFor($exe, $table);
        if (!$pids) {
            // Not an error: "it was already closed" is an answer, and reporting
            // it as a failure would send a model round the loop for nothing.
            return [
                'ok' => true, 'name' => $app['name'], 'closed' => 0, 'pids' => [],
                'note' => 'Nothing of "' . $app['name'] . '" was running.',
            ];
        }

        $force = !empty($opts['force']);
        $runId = substr(bin2hex(random_bytes(6)), 0, 12);
        Sandbox::audit(self::baseName($exe), [$exe], Sandbox::appDir(), null, null, [
            'run' => $runId, 'phase' => 'start', 'kind' => 'program',
            'agent' => (string)($opts['agent'] ?? ''),
        ]);
        $t0 = microtime(true);

        // Why each one refused, not just that one did: "access denied" and "it
        // had already exited" need opposite next steps from whoever is reading
        // this, and a bare count sends them to try the same thing again.
        $reasons = [];
        foreach ($pids as $pid) {
            $res = self::terminate($pid, $force);
            if (empty($res['ok'])) { $reasons[$pid] = $res['error'] ?: 'the signal was refused'; }
        }
        // Re-read rather than trusting the signal: a graceful close can be
        // cancelled by the program itself (an unsaved-changes prompt), and
        // reporting it as closed would be a lie the operator then acts on. The
        // re-read is also the only VERDICT -- a killer can succeed and report
        // nothing, or refuse after the process was already gone.
        $after = self::processTable();
        if (is_array($after)) {
            $still = self::pidsFor($exe, $after);
        } else {
            // The second read failed, so there is no verdict to be had. Fall
            // back to what each killer said, and word the reply as unconfirmed
            // rather than as a count that was never checked.
            $still = array_values(array_filter($pids, fn($pid) => isset($reasons[$pid])));
        }
        $closed = count(array_diff($pids, $still));
        $why = [];
        foreach ($still as $pid) {
            $why[] = 'pid ' . $pid . ': ' . ($reasons[$pid] ?? 'it did not answer');
        }
        $reasonsText = implode('; ', $why);

        Sandbox::audit(self::baseName($exe), [$exe], Sandbox::appDir(), $still ? 1 : 0,
            (int)round((microtime(true) - $t0) * 1000), [
                'run' => $runId, 'phase' => 'end', 'kind' => 'program',
                'agent' => (string)($opts['agent'] ?? ''),
            ]);

        return [
            // ok means the app is gone, which is the only thing the caller
            // wanted to know. Whether taskkill liked the pid is a detail that
            // belongs in the reason, not in the verdict.
            'ok' => !$still,
            'name' => $app['name'],
            'closed' => $closed,
            'pids' => $pids,
            'still_running' => $still,
            'force' => $force,
            'error' => $still ? $reasonsText : '',
            'note' => $closed === 0
                ? 'It did not close. A graceful close asks the program to shut itself, so it can refuse '
                    . '(unsaved work, a modal dialog) -- and a program with no window at all, such as a '
                    . 'console tool, has nothing to receive the request. Try again with "force": true to '
                    . 'end the process outright.' . ($reasonsText !== '' ? ' Reported: ' . $reasonsText . '.' : '')
                : ($still
                    ? $closed . ' of ' . count($pids) . ' process(es) closed; the rest are still running - '
                        . $reasonsText . '.'
                    : 'Closed ' . $closed . ' process(es)' . ($force ? ' forcefully.' : '.')),
        ];
    }

    // ---------------------------------------------------------------
    // Paths
    // ---------------------------------------------------------------

    /**
     * An operator path -> the file it names, or null.
     *
     * A path with a separator is taken literally (this is the ONLY place in the
     * app that accepts an absolute executable path, and it comes from config,
     * never from a model). A bare name is resolved against the same program
     * directories the shell allowlist uses, so `notepad` works as written.
     */
    private static function resolve($path) {
        $path = trim((string)$path);
        if ($path === '') { return null; }
        if (strpbrk($path, '/\\') !== false) {
            $real = @realpath($path);
            return ($real !== false && is_file($real)) ? $real : null;
        }
        $found = Sandbox::resolveProgram($path);
        return ($found !== null && is_file($found)) ? $found : null;
    }

    /** Why a path did not resolve, in terms the operator can act on. */
    private static function whyMissing($path) {
        $path = trim((string)$path);
        if ($path === '') { return 'No path set.'; }
        $looksAbsolute = (bool)preg_match('#^([A-Za-z]:[\\\\/]|/|\\\\\\\\)#', $path);
        if ($looksAbsolute && !file_exists($path)) {
            return 'Nothing exists at that path on this machine.';
        }
        if (!$looksAbsolute) {
            return 'Not found in the program directories on this host. Give the full path instead, '
                . 'e.g. C:\\Program Files\\App\\app.exe.';
        }
        if (is_dir($path)) { return 'That is a folder, not a program.'; }
        return 'Not a file this process can see (permissions?).';
    }

    /**
     * Anything that makes this program unusable as a launch target.
     *
     * Windows refuses everything but .exe/.com on purpose: a .bat, .cmd, .ps1 or
     * .vbs is a script, and starting one means handing back the command shell or
     * script host this whole design exists to keep away from a model. The
     * operator can still put one behind exec_interpreters, where the script file
     * is jailed and inline code is refused.
     */
    private static function policyProblem($exe) {
        $p = self::platform();
        if ($p === 'windows') {
            $ext = strtolower((string)pathinfo($exe, PATHINFO_EXTENSION));
            if (!in_array($ext, ['exe', 'com'], true)) {
                return 'Only .exe and .com programs can be opened here. A .' . $ext . ' is a script, and '
                    . 'starting one needs a command shell this deliberately does not hand to a model.';
            }
            return '';
        }
        if (!is_executable($exe)) { return 'That file is not executable on this host.'; }
        return '';
    }

    // ---------------------------------------------------------------
    // Detached launch
    // ---------------------------------------------------------------

    /**
     * Hand the program to the OS and return at once.
     *
     * Windows mirrors src/Browser.php exactly, including the nested `cmd /c`
     * (popen already runs one): that form is known-good in this codebase for
     * Chrome/Edge, and `start` is what makes it detached. `start ""` is not a
     * typo -- the first quoted token is the window TITLE, and without it a
     * quoted exe path would be read as the title and never launched.
     */
    private static function detach($exe, array $args) {
        if (self::platform() === 'windows') {
            $parts = [];
            foreach (array_merge([$exe], $args) as $p) {
                $q = self::quoteForCmd($p);
                if ($q === null) {
                    throw new \RuntimeException('"' . $p . '" contains a character a Windows command line '
                        . 'cannot quote safely (% ! or a quote). Move the program to a simpler path, or pass '
                        . 'the value through a file it reads itself.');
                }
                $parts[] = $q;
            }
            $line = 'cmd /c start "" ' . implode(' ', $parts);
            if (!function_exists('popen')) {
                throw new \RuntimeException('popen() is disabled in php.ini, so Windows programs cannot be '
                    . 'detached. Enable it (or use start.bat, which ships a php.ini that allows it).');
            }
            @pclose(@popen($line, 'r'));
            return $line;
        }

        // POSIX: background it and stop watching. The child is not reaped, so
        // nothing here can kill it later -- which is the point (pid tracking and
        // closing are by process lookup, see runningPids()).
        $line = implode(' ', array_map('escapeshellarg', array_merge([$exe], $args)));
        @exec($line . ' > /dev/null 2>&1 &');
        return $line;
    }

    /**
     * Quote one token for a cmd.exe command line, or null when it cannot be
     * done safely.
     *
     * `%` expands a variable, `!` expands under delayed expansion, and an
     * embedded quote has no spelling that survives both cmd and the program's
     * own argv parsing. Refusing is honest; escaping-and-hoping is how a path
     * turns into a different command.
     *
     * A trailing backslash is doubled. Inside a quoted argument, `\"` is read
     * by the program as an escaped quote, so `"C:\dir\"` hands over a path
     * ending in a quote rather than in a backslash -- doubling is the standard
     * spelling (`"C:\dir\\"`) and the only one both sides agree on.
     */
    private static function quoteForCmd($s) {
        $s = (string)$s;
        if (preg_match('/[%!"\r\n]/', $s)) { return null; }
        return '"' . preg_replace('/\\\\+$/', '$0$0', $s) . '"';
    }

    // ---------------------------------------------------------------
    // Process lookup
    // ---------------------------------------------------------------

    /**
     * Every running process on this host: pid => the executable's path.
     *
     * Built ONCE per request and matched in PHP, because the question being
     * asked is "which of these is the file the operator configured" -- and the
     * answer has to be the BINARY, not its name. A pid is not recorded at
     * launch either: `cmd /c start` hands off and the child it spawns reparents
     * at once, so the pid `start` produces is not the app's.
     *
     * Matching on the image name (tasklist /FI "IMAGENAME eq notepad.exe")
     * cannot tell the configured program from any other copy of that file on
     * the machine, so a close could end a process the operator never opened:
     * their other notepad, a vendor's helper.exe, someone else's node.exe. The
     * path is the identity, and the path is what the config owns.
     *
     * Where the paths come from is the host's business, and each is read the
     * way that is exact on that host: /proc/<pid>/exe on Linux (the kernel's
     * own answer, immune to a doctored argv[0]); one Get-CimInstance query on
     * Windows (the same mechanism Browser::reap() uses -- wmic is deliberately
     * not used, it is removed from current Windows builds); `ps` elsewhere,
     * which is best effort and compared as an absolute path only.
     *
     * @return array<int,string>|null  null when this host will not say
     */
    private static function processTable() {
        $p = self::platform();

        if ($p === 'linux') {
            $self = (int)getmypid();
            $table = [];
            foreach ((array)@glob('/proc/[0-9]*/exe') as $link) {
                $pid = (int)basename(dirname($link));
                if ($pid === $self) { continue; }
                $target = @readlink($link);
                if (is_string($target) && $target !== '') {
                    $table[$pid] = self::show($target);
                    continue;
                }
                // Unreadable: another user's process, or a kernel thread. argv[0]
                // is the only other source, and an ABSOLUTE argv[0] is used -- a
                // bare name is skipped, because that is the name-matching bug
                // back again ("node" does not say WHICH node).
                $raw = @file_get_contents('/proc/' . $pid . '/cmdline');
                if (!is_string($raw) || $raw === '') { continue; }
                $argv0 = self::show((string)(explode("\0", $raw)[0] ?? ''));
                if ($argv0 !== '' && $argv0[0] === '/') { $table[$pid] = $argv0; }
            }
            return $table;
        }

        if ($p === 'windows') {
            // Written to a temp .ps1 rather than passed to -Command, and that is
            // for the COMMAND LINE's sake: the script needs `|`, `{`, `$` and
            // quotes, and on Windows proc_open hands a command line to cmd.exe,
            // which would read the `|` as ITS OWN pipe. A file name carries none
            // of it -- exactly how Browser::reap() does this. (The shell is not
            // bypassed: bypass_shell with `-File` wedges this PowerShell, whose
            // stdout then never closes, and there is nothing left to bypass
            // once the script is in a file.)
            $ps1 = rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . 'router-process-table.ps1';
            $script = "Get-CimInstance Win32_Process | Where-Object { \$_.ExecutablePath } | "
                . "ForEach-Object { \$_.ProcessId.ToString() + [char]9 + \$_.ExecutablePath }\n";
            if (@file_put_contents($ps1, $script) === false) { return null; }
            $res = self::run(['powershell', '-NoProfile', '-NonInteractive',
                '-ExecutionPolicy', 'Bypass', '-File', $ps1], 30);
            @unlink($ps1);
            if ($res['timed_out'] || ($res['out'] === '' && $res['code'] === null)) { return null; }
            $table = [];
            foreach (preg_split('/\r\n|\r|\n/', (string)$res['out']) as $row) {
                if (strpos($row, "\t") === false) { continue; }
                $parts = explode("\t", trim($row), 2);
                $pid = (int)trim($parts[0]);
                $path = trim((string)($parts[1] ?? ''));
                if ($pid > 0 && $path !== '') { $table[$pid] = self::show($path); }
            }
            // A query that returned nothing at all did not work; it is not the
            // same answer as "this machine has no processes".
            return $table ?: null;
        }

        // macOS and the rest of POSIX, without /proc: `ps -o command=` carries
        // the argv[0] the process was started with, and only an absolute one is
        // trusted, for the reason above. Weaker than Linux -- a program that
        // re-execs itself under a bare name is invisible here -- and it fails
        // towards "not running" rather than towards ending the wrong process.
        $self = (int)getmypid();
        $res = self::run(['ps', '-A', '-o', 'pid=,command=']);
        if ($res['timed_out'] || ($res['out'] === '' && $res['code'] === null)) { return null; }
        $table = [];
        foreach (preg_split('/\r\n|\r|\n/', (string)$res['out']) as $row) {
            if (!preg_match('/^\s*(\d+)\s+(.+)$/', trim($row), $m)) { continue; }
            $pid = (int)$m[1];
            if ($pid === $self) { continue; }
            $first = self::show((string)(preg_split('/\s+/', trim($m[2]))[0] ?? ''));
            if ($first !== '' && $first[0] === '/') { $table[$pid] = $first; }
        }
        return $table ?: null;
    }

    /**
     * The pids running exactly this file, from a table processTable() built.
     *
     * Compared as resolved paths, case-folded on Windows (where the same file
     * is spelled C:\X and c:\x and the short name is a third spelling). There is
     * deliberately NO basename fallback: that is what made two different
     * programs that share a file name into "the same program".
     *
     * @return int[]
     */
    private static function pidsFor($exe, $table) {
        if (!is_array($table)) { return []; }
        $want = self::key($exe);
        if ($want === '') { return []; }
        $pids = [];
        foreach ($table as $pid => $path) {
            if (self::key($path) === $want) { $pids[] = (int)$pid; }
        }
        sort($pids);
        return $pids;
    }

    /** One spelling of a path, for comparing two of them. */
    private static function key($path) {
        $p = self::show($path);
        // A symlink, a short (8.3) name and a relative path are all the same
        // file as what they resolve to, so both sides are resolved before they
        // are compared. A path that no longer resolves keeps its literal
        // spelling -- a process that has just exited cannot be resolved, and
        // dropping it would lose a match that is still real.
        $real = @realpath($path);
        if ($real !== false) { $p = self::show($real); }
        return self::platform() === 'windows' ? strtolower($p) : $p;
    }

    /**
     * End one process. Graceful unless $force.
     *
     * Returns a real verdict: this used to report ok:true for everything,
     * including a kill that never happened and a pid that was already gone, so
     * "closed" could be said about a program that was still open.
     */
    private static function terminate($pid, $force) {
        $pid = (int)$pid;
        if ($pid <= 0) { return ['ok' => false, 'error' => 'bad pid']; }
        if (self::platform() === 'windows') {
            $argv = $force ? ['taskkill', '/PID', (string)$pid, '/T', '/F']
                           : ['taskkill', '/PID', (string)$pid];
        } else {
            $argv = ['kill', ($force ? '-KILL' : '-TERM'), (string)$pid];
        }
        $res = self::run($argv);
        $out = trim((string)preg_replace('/\s+/', ' ', (string)$res['out']));
        if ($res['timed_out']) {
            return ['ok' => false, 'out' => $out,
                'error' => self::baseName($argv[0]) . ' did not answer within ' . $res['timeout'] . 's'];
        }
        if ($res['code'] === 0) { return ['ok' => true, 'out' => $out]; }
        if ($res['code'] === null) {
            // No status at all: not a refusal, and not a success either. Saying
            // which is the honest answer -- the caller re-reads the process list
            // and that is what decides whether the program is gone.
            return ['ok' => false, 'out' => $out, 'error' => 'the outcome could not be read (no exit status)'];
        }
        // The exit STATUS decides and the wording only explains: taskkill's
        // message is localised, so matching on its text would work only on an
        // English Windows. ('not found' means something a model can act on;
        // 'access denied' means it has to ask the operator.)
        return ['ok' => false, 'out' => $out,
            'error' => self::killReason($res['code']) . ($out !== '' ? ' - ' . self::clip($out, 120) : '')];
    }

    /** What a failed kill actually means, from its exit code. */
    private static function killReason($code) {
        $code = (int)$code;
        if (self::platform() !== 'windows') {
            return $code === 1 ? 'not permitted, or already gone' : 'the signal was refused (exit ' . $code . ')';
        }
        // 128 is ERROR_WAIT_NO_CHILDREN: the pid was already gone.
        if ($code === 128) { return 'it had already exited'; }
        if ($code === 1) { return 'access denied (it runs as another user, or elevated)'; }
        return 'Windows refused it (exit ' . $code . ')';
    }

    /** Shorten a command's own message for one line of a reply. */
    private static function clip($s, $n) {
        $s = trim((string)$s);
        return strlen($s) > $n ? substr($s, 0, $n) . '...' : $s;
    }

    /**
     * Everything readable on a command's output pipes right now.
     *
     * The pipes are non-blocking, so an empty read means "nothing yet" (or the
     * process has closed that end) and never waits: that is what keeps a slow
     * or wedged command from becoming a slow or wedged request.
     */
    private static function slurp(array $pipes) {
        $out = '';
        foreach ([1, 2] as $i) {
            if (!isset($pipes[$i]) || !is_resource($pipes[$i])) { continue; }
            while (true) {
                $chunk = @fread($pipes[$i], 8192);
                if (!is_string($chunk) || $chunk === '') { break; }
                $out .= $chunk;
            }
        }
        return $out;
    }

    /**
     * Run a fixed argv and return its combined output AND its exit status.
     *
     * No shell, no waiting games: these are the app's own commands (PowerShell,
     * ps, taskkill, kill), never text a model supplied, so there is nothing here
     * to inject into. The status matters because it is the only answer a killer
     * gives that does not depend on a language: an empty output from taskkill
     * means success on one build and failure on the next, while exit 0 means
     * success everywhere.
     *
     * @return array{out:string,code:?int,timed_out:bool,timeout:int}
     */
    private static function run(array $argv, $timeout = 10) {
        $timeout = max(1, (int)$timeout);
        $none = ['out' => '', 'code' => null, 'timed_out' => false, 'timeout' => $timeout];
        if (!function_exists('proc_open')) { return $none; }
        $desc = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        // Every caller passes a literal argv of arguments that contain no shell
        // metacharacters (the one metacharacter-heavy script in this class is
        // written to a temp file for exactly that reason), so the shell this
        // goes through on Windows has nothing to interpret. On POSIX the array
        // form never involves a shell at all.
        $proc = @proc_open($argv, $desc, $pipes);
        if (!is_resource($proc)) { return $none; }
        @fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $out = '';
        $deadline = microtime(true) + $timeout;
        $exited = false;
        // A poll loop, NOT stream_select: on Windows stream_select() on a pipe
        // inherited from proc_open ignores its own timeout and waits on the
        // handle, which is how a script that answers in half a second turned
        // into a request that never came back. fread() on a non-blocking pipe
        // returns '' when there is nothing there, so this loop always reaches
        // its deadline.
        while (microtime(true) < $deadline) {
            $out .= self::slurp($pipes);
            $status = proc_get_status($proc);
            if (empty($status['running'])) { $exited = true; break; }
            usleep(15000);
        }
        // Whatever was still in the pipe when it exited (the last write can land
        // between the read above and the status check), read for at most a
        // second so a handle held open by a child of the child cannot stall the
        // answer once the command itself is done.
        if ($exited) {
            $until = microtime(true) + 1.0;
            do {
                $chunk = self::slurp($pipes);
                $out .= $chunk;
            } while ($chunk !== '' && microtime(true) < $until);
        }
        foreach ([1, 2] as $i) {
            if (isset($pipes[$i]) && is_resource($pipes[$i])) { fclose($pipes[$i]); }
        }
        // The exit code has to be read from proc_get_status while the process
        // is still open: PHP has already reaped it by the time proc_close()
        // returns, and then reports -1. So it is captured here, once, and the
        // absence of it (a timeout, or a stream that would not close) is
        // reported as no code rather than as success.
        $status = proc_get_status($proc);
        $code = null;
        if (!empty($status['running'])) {
            $timedOut = true;
            @proc_terminate($proc);
            // Deliberately NOT proc_close()d: proc_close WAITS for the process,
            // and a command that ignored the signal would then hang the whole
            // request inside its own timeout -- a web request that never answers
            // is worse than a leaked handle that dies with the request. This is
            // the case that wedged a process table read for minutes.
            @fclose($pipes[1]);
            @fclose($pipes[2]);
            return ['out' => $out, 'code' => null, 'timed_out' => true, 'timeout' => $timeout];
        }
        if (isset($status['exitcode']) && (int)$status['exitcode'] !== -1) {
            $code = (int)$status['exitcode'];
        }
        @proc_close($proc);
        return ['out' => $out, 'code' => $code, 'timed_out' => false, 'timeout' => $timeout];
    }

    /** The file name, for the audit line and process filters. */
    private static function baseName($path) {
        $n = basename(str_replace('\\', '/', (string)$path));
        return (string)preg_replace('/[^A-Za-z0-9._-]/', '', $n);
    }

    /** One spelling of a path everywhere it is shown or compared. */
    private static function show($path) {
        return str_replace('\\', '/', (string)$path);
    }
}
