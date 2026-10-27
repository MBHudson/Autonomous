<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * setup-token.sh test harness: the command you run *because* you are locked out.
 *
 * Usage: php tests/php/setupToken.test.php
 *
 * This script is the documented way to read the access token, rotate it, or turn
 * the gate off -- and it is the only support path for a browser that cannot get
 * in, because the field you would paste the token into sits behind the API that
 * the token protects. It used to need `python3` for every one of those jobs,
 * which is the one interpreter a copy of this app does not need: on Windows
 * `python3` is normally the Microsoft Store's execution alias, a stub that
 * prints "Python was not found..." and exits 49. `--show` printed its heading
 * and no token, and generating one failed the same way.
 *
 * So the thing under test is the CHOICE OF ENGINE, and it is tested the way it
 * failed. A stub `python3` AND `python` are planted at the FRONT of PATH, ahead
 * of any real python this machine happens to have, exactly as they sit on the
 * operator's own box -- a name on PATH is not an interpreter, and the fixture
 * assertion below proves the stub really is what PATH resolves to, so a passing
 * run cannot be one that quietly skipped the interesting case. The script has to
 * reject both, fall back to php, SAY so in its output, and still print the token.
 *
 * Every mode is driven against throwaway copies in the system temp dir. The
 * operator's own storage/config.json is only ever read -- and is asserted to be
 * byte-identical afterwards, because a recovery command that rewrites the file
 * holding the only credential is worse than the bug it fixes. (The one thing a
 * run in this checkout can create is storage/.htaccess, the guard the script is
 * supposed to re-create; it ships with the app, so that is a no-op here.)
 *
 * Skips (exit 0, printing SKIP) when there is no bash to run the script with:
 * the script IS bash, and a machine without one cannot run it at all. WSL's
 * bash.exe in system32 is passed over on purpose -- it is not the MSYS bash this
 * script is written for and it would fail on every path in it.
 *
 * Exits 0 on success, 1 on any failure.
 */

$root   = dirname(__DIR__, 2);
$script = $root . '/setup-token.sh';

$pass = 0;
$fail = 0;
$errors = [];
// Checks that need something this machine may not have: a bash, a real python,
// or the operator's own storage/config.json. Reported as ", N skipped" in the
// summary line the runner reads, so a fresh clone's smaller run says so.
$skips = 0;

function ok($cond, $name)
{
    global $pass, $fail, $errors;
    if ($cond) {
        $pass++;
    } else {
        $fail++;
        $errors[] = 'FAIL: ' . $name;
    }
}

/** Which PATH variable this process has, whatever its case on Windows. */
function env_path()
{
    foreach (getenv() as $k => $v) {
        if (strcasecmp($k, 'PATH') === 0) { return (string) $v; }
    }
    return '';
}

/**
 * A bash to run the script with, or null.
 *
 * PATH is searched first, because that is where the operator's own Git Bash
 * lives; system32 is skipped on Windows because `bash.exe` there is WSL's
 * launcher, a different world with different paths inside it.
 */
function find_bash()
{
    $exe = PHP_OS_FAMILY === 'Windows' ? 'bash.exe' : 'bash';
    $candidates = [];
    foreach (explode(PATH_SEPARATOR, env_path()) as $dir) {
        if ($dir === '') { continue; }
        if (PHP_OS_FAMILY === 'Windows' && stripos($dir, 'system32') !== false) { continue; }
        $candidates[] = rtrim($dir, '\\/') . DIRECTORY_SEPARATOR . $exe;
    }
    $fallbacks = PHP_OS_FAMILY === 'Windows'
        ? ['C:\Program Files\Git\bin\bash.exe', 'C:\Program Files\Git\usr\bin\bash.exe',
           'C:\Program Files (x86)\Git\bin\bash.exe']
        : ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'];
    foreach (array_merge($candidates, $fallbacks) as $path) {
        if (is_file($path)) { return $path; }
    }
    return null;
}

/**
 * Run ./setup-token.sh in $dir under $env, as the operator would.
 *
 * stderr is folded into stdout by the shell, so a message that only ever goes
 * to stderr (the failure paths) is still asserted on, and line ORDER survives --
 * "the token follows the heading" is part of what this prints. One pipe is read
 * for that reason: two would risk a fill-and-block deadlock for no gain.
 */
function run_script($bash, $dir, array $env, $args = '')
{
    if (!function_exists('proc_open')) { return ['out' => '', 'code' => 127]; }
    $line = './setup-token.sh' . ($args === '' ? '' : ' ' . $args) . ' 2>&1';
    $spec = [1 => ['pipe', 'w']];
    $proc = @proc_open([$bash, '-c', $line], $spec, $pipes, $dir, $env);
    if (!is_resource($proc)) { return ['out' => '', 'code' => 127]; }
    $out = (string) stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    return ['out' => $out, 'code' => proc_close($proc)];
}

/** A throwaway copy of the script plus a config holding what the case needs. */
function make_copy($dir, $src, $token, $require, $source = null)
{
    rrmdir($dir);
    @mkdir($dir . '/storage', 0777, true);
    $text = $source === null ? (string) file_get_contents($src) : $source;
    file_put_contents($dir . '/setup-token.sh', $text);
    @chmod($dir . '/setup-token.sh', 0755);

    $cfg = [
        'theme' => 'neon',
        'sandbox' => ['read_roots' => ['/srv']],
        'mcp_server' => ['enabled' => true, 'tokens' => [[
            'id' => 't_keep', 'label' => 'ana', 'token' => str_repeat('c', 64), 'scope' => ['read'],
        ]]],
        'mcp' => ['servers' => [[
            'id' => 'remote', 'transport' => 'http', 'url' => 'https://example.invalid',
            'headers' => ['Authorization' => 'Bearer keepme'],
        ]]],
    ];
    if ($token !== null) { $cfg['sandbox']['token'] = $token; }
    if ($require !== null) { $cfg['sandbox']['require_token'] = $require; }
    file_put_contents($dir . '/storage/config.json', json_encode($cfg, JSON_PRETTY_PRINT));
    return $dir . '/storage/config.json';
}

function read_cfg($path)
{
    return json_decode((string) @file_get_contents($path), true);
}

function rrmdir($dir)
{
    if (!is_dir($dir)) { return; }
    $items = @scandir($dir);
    foreach ((array) $items as $item) {
        if ($item === '.' || $item === '..') { continue; }
        $path = $dir . '/' . $item;
        if (is_dir($path)) { rrmdir($path); } else { @unlink($path); }
    }
    @rmdir($dir);
}

echo "setup-token.sh harness\n";
echo str_repeat('-', 60) . "\n";

$bash = find_bash();
if (!$bash) {
    echo "  SKIP: no bash found (PATH, then the usual Git/bin locations)\n";
    echo "0 passed, 0 failed, 1 skipped\n";
    exit(0);
}
if (!function_exists('proc_open')) {
    echo "  SKIP: proc_open is disabled, cannot run the script\n";
    echo "0 passed, 0 failed, 1 skipped\n";
    exit(0);
}

$tmp     = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-setuptoken-test-' . getmypid();
$stubDir = $tmp . '/stubs';
$work    = $tmp . '/work';
rrmdir($tmp);
@mkdir($stubDir, 0777, true);
@mkdir($work, 0777, true);

// The Windows symptom, made portable: the Store alias answers in English and
// exits 49. Extensionless and executable, so MSYS' `command -v` resolves it.
$stubBody = "#!/bin/sh\necho \"Python was not found; run without arguments to install from the Microsoft Store\" >&2\nexit 49\n";
foreach (['python3', 'python'] as $name) {
    file_put_contents($stubDir . '/' . $name, $stubBody);
    @chmod($stubDir . '/' . $name, 0755);
}

$stubbed  = getenv();
$plain    = getenv();
// No PHP_BIN in either: the whole point is which engine the script finds for
// itself. A copy that needs to prove the no-engine message gets this unset too.
unset($stubbed['PHP_BIN'], $plain['PHP_BIN']);
foreach (array_keys($stubbed) as $k) {
    if (strcasecmp($k, 'PATH') === 0) {
        $stubbed[$k] = $stubDir . PATH_SEPARATOR . $stubbed[$k];
    }
}

$TOKEN = str_repeat('a', 64);

/** One command's stdout, run with a given environment. For the probes only. */
function probe($bash, $dir, array $env, $line)
{
    if (!function_exists('proc_open')) { return ''; }
    $p = @proc_open([$bash, '-c', $line], [1 => ['pipe', 'w']], $pipes, $dir, $env);
    if (!is_resource($p)) { return ''; }
    $out = (string) stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    proc_close($p);
    return trim($out);
}

// --- 0. the fixture ---------------------------------------------------
// Without this, every assertion below could pass on a machine where the stub was
// never on PATH -- which is the interesting case, and it would be missing.
$resolved = probe($bash, $tmp, $stubbed, 'command -v python3; command -v python');
ok($resolved !== '' && stripos($resolved, 'stubs') !== false,
    'the stub python3 is what PATH resolves to (fixture check, got ' . var_export($resolved, true) . ')');

$isMsys = (bool) preg_match('/^(MINGW|MSYS|CYGWIN)/i', probe($bash, $tmp, $stubbed, 'uname -s'));

// --- 1. --show falls back to php and still prints the token -----------
$cfg = make_copy($work . '/show', $script, $TOKEN, true);
$before = md5_file($cfg);
$r = run_script($bash, $work . '/show', $stubbed, '--show');
ok($r['code'] === 0, '--show exits 0 with a stub python ahead of a real one (got ' . $r['code'] . ')');
ok(strpos($r['out'], $TOKEN) !== false, 'the stored token is printed');
ok(strpos($r['out'], 'require_token = true') !== false, 'it reports the gate is on');
$engineLine = '';
foreach (explode("\n", $r['out']) as $line) {
    if (strpos($line, 'Read with:') === 0) { $engineLine = trim(substr($line, strlen('Read with:'))); }
}
ok(strpos($r['out'], 'no working python3 or python') !== false,
    'the engine line names the fallback (got ' . var_export($engineLine, true) . ')');
ok(strpos($r['out'], 'Read with: python') === false, 'and does not claim python was used');
ok(md5_file($cfg) === $before, '--show left storage/config.json byte-identical');
if ($isMsys) {
    ok(strpos($r['out'], 'start.bat -Token') !== false,
        'on MSYS it also points at the interpreter-free route');
} else {
    ok(strpos($r['out'], 'start.bat -Token') === false, 'the Windows hint is not printed off Windows');
}

// --- 2. --show on a copy with no token invents nothing ----------------
$cfg = make_copy($work . '/none', $script, null, true);
$r = run_script($bash, $work . '/none', $stubbed, '--show');
ok($r['code'] === 0, '--show exits 0 with no token stored');
ok(strpos($r['out'], '(none set') !== false, 'it says there is no token rather than printing a blank one');
ok(!preg_match('/\b[0-9a-f]{64}\b/', $r['out']), 'and no 64-char token appears from nowhere');
ok(strpos($r['out'], 'require_token = true') !== false, 'the gate state is still reported');

// --- 3. a plain run refuses and shows what it found -------------------
$cfg = make_copy($work . '/plain', $script, $TOKEN, true);
$r = run_script($bash, $work . '/plain', $stubbed, '');
ok($r['code'] === 1, 'a plain run with a token already set refuses (exit ' . $r['code'] . ')');
ok(strpos($r['out'], 'already set') !== false, 'it says a token is already set');
ok(strpos($r['out'], $TOKEN) !== false, 'and prints the current one, which is the way back in');
ok((read_cfg($cfg)['sandbox']['token'] ?? '') === $TOKEN, 'the stored token was not touched');

// --- 4. --force rotates, and touches nothing else ---------------------
$r = run_script($bash, $work . '/plain', $stubbed, '--force');
ok($r['code'] === 0, '--force exits 0 (got ' . $r['code'] . ')');
$stored = read_cfg($cfg);
$rotated = (string) ($stored['sandbox']['token'] ?? '');
ok((bool) preg_match('/^[0-9a-f]{64}$/', $rotated), 'the new token is 64 hex chars');
ok($rotated !== $TOKEN, 'and it really is new');
ok(($stored['sandbox']['require_token'] ?? null) === true, 'the gate is on');
ok(($stored['sandbox']['read_roots'][0] ?? '') === '/srv', 'other sandbox keys survive');
ok(($stored['theme'] ?? '') === 'neon', 'top-level keys survive');
ok(($stored['mcp_server']['tokens'][0]['token'] ?? '') === str_repeat('c', 64), "a friend's token survives");
ok(($stored['mcp']['servers'][0]['headers']['Authorization'] ?? '') === 'Bearer keepme',
    "an MCP client's Authorization header survives");

// --- 5. --show reads back what --force wrote --------------------------
$r = run_script($bash, $work . '/plain', $stubbed, '--show');
ok(strpos($r['out'], $rotated) !== false, '--show prints the rotated token');

// --- 6. --off clears the gate, printing what that means ---------------
$r = run_script($bash, $work . '/plain', $stubbed, '--off');
ok($r['code'] === 0, '--off exits 0 (got ' . $r['code'] . ')');
$stored = read_cfg($cfg);
ok(($stored['sandbox']['token'] ?? null) === '', 'the stored token was cleared');
ok(($stored['sandbox']['require_token'] ?? null) === false, 'the gate is off');
ok(($stored['mcp_server']['tokens'][0]['token'] ?? '') === str_repeat('c', 64),
    "the friend's token is untouched by --off");
ok(strpos($r['out'], '403') !== false, 'it says other machines now get 403');

$r = run_script($bash, $work . '/plain', $stubbed, '--show');
ok(strpos($r['out'], 'require_token = false') !== false, '--show reports the gate is off');
ok(strpos($r['out'], 'only requests from this machine') !== false, 'and says what that means');

// Re-arming after --off must mint a NEW token: the old one is gone from the
// config, so a device still holding it has to be given the new one by hand.
$r = run_script($bash, $work . '/plain', $stubbed, '');
ok($r['code'] === 0, 're-arming after --off exits 0');
$rearmed = (string) (read_cfg($cfg)['sandbox']['token'] ?? '');
ok((bool) preg_match('/^[0-9a-f]{64}$/', $rearmed) && $rearmed !== $rotated,
    're-arming mints a new token, as the --off message warns');

// --- 7. a fresh install generates one with no usable python -----------
$cfg = make_copy($work . '/fresh', $script, null, null);
$r = run_script($bash, $work . '/fresh', $stubbed, '');
ok($r['code'] === 0, 'a fresh copy generates a token and exits 0 (got ' . $r['code'] . ')');
ok((bool) preg_match('/^[0-9a-f]{64}$/', (string) (read_cfg($cfg)['sandbox']['token'] ?? '')),
    'the generated token is 64 hex chars');
ok((read_cfg($cfg)['sandbox']['require_token'] ?? null) === true, 'and the gate is armed');
$r = run_script($bash, $work . '/fresh', $stubbed, '--show');
ok(strpos($r['out'], (string) read_cfg($cfg)['sandbox']['token']) !== false,
    '--show prints the token it just generated');

// --- 8. the guard against web-serving storage/ is re-created ----------
// README promises this ("re-creates the storage one if a deploy lost it"), and
// a rewrite of this script shipped it defined-but-never-called once.
$cfg = make_copy($work . '/guard', $script, $TOKEN, true);
@unlink($work . '/guard/storage/.htaccess');
$r = run_script($bash, $work . '/guard', $stubbed, '--force');
$guardFile = $work . '/guard/storage/.htaccess';
ok(is_file($guardFile), 'a missing storage/.htaccess is re-created by a run');
$guardText = is_file($guardFile) ? (string) file_get_contents($guardFile) : '';
ok(strpos($guardText, 'Require all denied') !== false, 'and it denies all web access');
ok(strpos($r['out'], 'Re-created storage/.htaccess') !== false, 'the operator is told it happened');

// --- 9. a PHP_BIN that is not a php is refused up front ---------------
$r = run_script($bash, $work . '/fresh', array_merge($stubbed, ['PHP_BIN' => '/nope/php']), '--show');
ok($r['code'] === 1, 'PHP_BIN pointing at nothing exits 1 (got ' . $r['code'] . ')');
ok(strpos($r['out'], 'did not answer') !== false, 'and says it did not answer');

// --- 10. no engine at all is a clear failure, never silence ----------
// The candidate list has to be emptied to reach this branch on a machine that
// HAS php (this one): PHP_BIN and `php` on PATH are the two ways in, and the
// hard-coded XAMPP path is exactly what an operator's box has. The patch is
// asserted below, so a rename in the script turns into a failure, not a pass.
$src = (string) file_get_contents($script);
$emptyList = 'for candidate in php /c/xampp/php/php.exe /usr/bin/php /usr/local/bin/php; do';
$patched = str_replace($emptyList, 'for candidate in; do', $src);
ok($patched !== $src, 'the no-engine case can be staged (candidate list found in the script)');
$cfg = make_copy($work . '/none', $script, $TOKEN, true, $patched);
$envNoPhp = $stubbed;
unset($envNoPhp['PHP_BIN']);
$noneBefore = md5_file($cfg);
$r = run_script($bash, $work . '/none', $envNoPhp, '--show');
ok($r['code'] === 1, 'with no interpreter at all it exits 1 (got ' . $r['code'] . ')');
ok(strpos($r['out'], 'Cannot read storage/config.json') !== false, 'it says what it could not do');
ok(strpos($r['out'], 'PHP_BIN=') !== false, 'it names the override that would fix it');
ok(strpos($r['out'], 'start.bat -Token') !== false, 'and points at the route that needs no interpreter');
ok(md5_file($cfg) === $noneBefore, 'nothing was written when it could not read the config');

// --- 11. a machine that DOES have python still uses it ----------------
// The fallback must not become the only path: someone with a working python
// gets the same output, and the engine line says so.
$realPython = '';
foreach (['python3', 'python'] as $name) {
    $probeSpec = [1 => ['pipe', 'w']];
    // stderr discarded: the Store stub answers in English on its way out, and
    // that paragraph is the symptom, not this test's output.
    $p = @proc_open([$bash, '-c', $name . ' -c "print(1)" 2>/dev/null'], $probeSpec, $probePipes, $tmp, $plain);
    if (is_resource($p)) {
        $answer = trim((string) stream_get_contents($probePipes[1]));
        fclose($probePipes[1]);
        proc_close($p);
        if ($answer === '1') { $realPython = $name; break; }
    }
}
if ($realPython === '') {
    echo "  SKIP: no real python here, so the python path cannot be driven\n";
    $skips++;
} else {
    $cfg = make_copy($work . '/pyshow', $script, $TOKEN, true);
    $r = run_script($bash, $work . '/pyshow', $plain, '--show');
    ok($r['code'] === 0, "with a real $realPython it still exits 0");
    ok(strpos($r['out'], $TOKEN) !== false, 'and still prints the token');
    ok(strpos($r['out'], 'Read with: ' . $realPython) !== false,
        'and names ' . $realPython . ' as the engine it used');
}

// --- 12. this install: --show is read-only, whatever the config says --
$live = $root . '/storage/config.json';
if (!is_file($live)) {
    echo "  SKIP: no storage/config.json in this checkout to read\n";
    $skips++;
} else {
    $liveBefore = md5_file($live);
    $r = run_script($bash, $root, $plain, '--show');
    ok($r['code'] === 0, '--show exits 0 on this checkout (got ' . $r['code'] . ')');
    ok(strpos($r['out'], 'require_token = ') !== false, 'it reports this copy\'s gate state');
    $liveToken = (string) (read_cfg($live)['sandbox']['token'] ?? '');
    if ($liveToken !== '') {
        ok(strpos($r['out'], $liveToken) !== false, 'it prints this copy\'s stored token');
    } else {
        ok(strpos($r['out'], '(none set') !== false, 'with no token stored it says so');
    }
    ok(md5_file($live) === $liveBefore, 'this checkout\'s storage/config.json is unchanged');
}

// --- cleanup ----------------------------------------------------------
rrmdir($tmp);

// --- results ----------------------------------------------------------
echo str_repeat('-', 60) . "\n";
echo "$pass passed, $fail failed" . ($skips ? ", $skips skipped" : '') . "\n";
foreach ($errors as $e) { echo "  $e\n"; }
exit($fail ? 1 : 0);
