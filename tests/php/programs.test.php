<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Programs (agent-opened desktop programs) unit-test harness.
 *
 * Usage: php tests/php/programs.test.php
 *
 * Writes a throwaway config, exercises the real normalisation, policy, process
 * lookup and audit path, opens and closes ONE harmless process it made itself,
 * then cleans up. Exits 0 on success, 1 on any failure.
 *
 * Three things are deliberate:
 *
 *   * It runs a COPY of a long-running program at a path unique to this test,
 *     so process lookup can only match something that is ours. Closing is by
 *     the BINARY's path (see Programs::pidsFor), and a test that could match
 *     the operator's own `ping`/`sleep` would be a test that kills their work.
 *
 *   * A second copy of the SAME file name is then started from another folder,
 *     because that is the mistake worth catching: matching by image name made
 *     two different programs into "the same program", so the configured entry
 *     must see nothing while the twin runs, and closing it must leave the twin
 *     alive. Both are asserted against real processes.
 *
 *   * On Windows this opens a real console window for a few seconds. That IS the
 *     feature: detached, visible, and closable by pid. Nothing interactive
 *     happens in it -- it is `ping` pointed at loopback.
 *
 *   * It truncates storage/exec.log back to its previous size. Auditing is part
 *     of the feature and has to be asserted, but those lines are test runs, and
 *     the trail is meant to read as history rather than as output.
 */

// --- bootstrap --------------------------------------------------------
require_once __DIR__ . '/../../autoload.php';

use Src\Programs;
use Src\Config;
use Src\Sandbox;

$pass = 0;
$fail = 0;
$errors = [];

function ok($cond, $name) {
    global $pass, $fail, $errors;
    if ($cond) { $pass++; }
    else { $fail++; $errors[] = "FAIL: $name"; }
}

function throws($fn, $name, $needle = '') {
    try {
        $fn();
        ok(false, "$name (expected an exception)");
    } catch (\Throwable $e) {
        if ($needle === '' || stripos($e->getMessage(), $needle) !== false) {
            ok(true, $name);
        } else {
            ok(false, "$name (bad message: {$e->getMessage()})");
        }
    }
}

/** Poll until a predicate holds, so a launch that takes a moment is not a flake. */
function until($fn, $seconds = 6) {
    $deadline = microtime(true) + $seconds;
    do {
        if ($fn()) { return true; }
        usleep(250000);
    } while (microtime(true) < $deadline);
    return (bool)$fn();
}

// --- temp environment -------------------------------------------------
$platform = Programs::platform();
$tmpDir = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-programs-test-' . getmypid();
$writeDir = $tmpDir . '/w';
$progDir = $tmpDir . '/progs';
@mkdir($writeDir, 0777, true);
@mkdir($progDir, 0777, true);

$configPath = $tmpDir . '/config.json';
putenv('ROUTER_CONFIG=' . $configPath);

// A private copy of something that stays alive on its own, so "is it running"
// can only ever match ours. Windows: ping (a console program with a pid and no
// interaction). POSIX: sleep.
$runner = '';
$runnerArgs = [];
if ($platform === 'windows') {
    $sysRoot = rtrim((string)(getenv('SystemRoot') ?: 'C:\\Windows'), '\\');
    $src = $sysRoot . '\\System32\\ping.exe';
    if (is_file($src)) {
        $runner = $progDir . '/sleeper-test-app.exe';
        if (@copy($src, $runner)) { $runnerArgs = ['-n', '25', '127.0.0.1']; }
        else { $runner = ''; }
    }
} else {
    foreach (['/bin/sleep', '/usr/bin/sleep'] as $candidate) {
        if (is_file($candidate) && is_executable($candidate)) {
            $runner = $progDir . '/sleeper-test-app';
            if (@copy($candidate, $runner)) { @chmod($runner, 0755); $runnerArgs = ['30']; }
            else { $runner = ''; }
            break;
        }
    }
}

// A file that exists but is not a launcher: .bat is a script on Windows, and a
// non-executable file on POSIX. Different refusal, same "the list says why".
$plain = $progDir . '/plain-note.txt';
file_put_contents($plain, 'not a program');
@chmod($plain, 0644);

$missing = $progDir . '/does-not-exist.exe';
$bareName = $platform === 'windows' ? 'notepad' : 'ls';

$apps = [
    ['name' => 'sleeper', 'path' => $runner, 'args' => $runnerArgs],
    ['name' => 'bare-name', 'path' => $bareName],
    ['name' => 'ghost', 'path' => $missing],
    ['name' => 'plain', 'path' => $plain],
    ['name' => 'bad/name', 'path' => $runner],     // unusable name -> dropped
    ['name' => 'Sleeper', 'path' => $runner],      // duplicate (case-insensitive) -> dropped
    $runner,                                       // bare string shorthand -> name from the file
];

/** Write the config the tests run against. */
function write_cfg($path, $enabled, array $programs) {
    $sb = [
        'read_roots'  => [$GLOBALS['writeDir'], $GLOBALS['progDir']],
        'write_roots' => [$GLOBALS['writeDir']],
        'exec_enabled' => false,          // Programs must not need shell access at all
    ];
    if ($enabled !== null) { $sb['programs_enabled'] = $enabled; }
    if ($programs !== null) { $sb['programs'] = $programs; }
    file_put_contents($path, json_encode(['sandbox' => $sb], JSON_PRETTY_PRINT));
}

echo "Programs test harness (" . $platform . ")\n";
echo str_repeat('-', 60) . "\n";

// --- 1. off by default, and its own switch ----------------------------
// An install that predates this feature has no key at all, which must read as
// OFF rather than as "no policy configured, allow everything".
write_cfg($configPath, null, $apps);
$stat = Programs::status();
ok($stat['enabled'] === false, 'unset switch reads as off');
ok($stat['count'] === count($apps) - 2, 'a bad name and a duplicate are dropped');
throws(function () {
    Programs::open('sleeper');
}, 'open refused while the switch is off', 'is off');

// Turning it on is the operator's separate decision, and does not need shell
// access (exec_enabled is false in this config).
write_cfg($configPath, true, $apps);
Config::loadConfig();
ok(Programs::status()['enabled'] === true, 'switch on reads as on');

// --- 2. the list the launcher will actually honour --------------------
$list = Programs::list();
ok(($list['platform'] ?? '') === $platform, 'platform is reported');
ok(isset($list['notes']) && $list['notes'] !== '', 'the list states the platform caveat');

$byName = [];
foreach ($list['apps'] as $a) { $byName[$a['name']] = $a; }
ok(!isset($byName['bad/name']), 'a name with a slash is dropped');
ok(!isset($byName['Sleeper']), 'a duplicate name is dropped');
ok(isset($byName[basename($runner) === '' ? 'sleeper' : pathinfo($runner, PATHINFO_FILENAME)]),
    'a bare path string becomes a named entry');

ok(($byName['ghost']['exists'] ?? true) === false, 'a path that does not exist is reported as missing');
ok(stripos((string)($byName['ghost']['error'] ?? ''), 'exist') !== false,
    'the missing path says nothing exists there');
ok(($byName['ghost']['running'] ?? null) === [], 'a missing program has no running processes');

// The right refusal per platform: a script host on Windows, a non-executable
// file elsewhere. Both must be visible in the list, not only at launch time.
if ($platform === 'windows') {
    ok(stripos((string)($byName['plain']['error'] ?? ''), 'Only .exe and .com') !== false,
        'a non-executable extension is refused, and says why');
} else {
    ok(stripos((string)($byName['plain']['error'] ?? ''), 'not executable') !== false,
        'a non-executable file is refused, and says why');
}

// A bare name resolves against the same directories the shell allowlist uses.
ok(($byName['bare-name']['exists'] ?? false) === true, 'a bare program name resolves on PATH');
ok(strpos(strtolower((string)($byName['bare-name']['resolved'] ?? '')), strtolower($bareName)) !== false,
    'the resolved path is shown');

// --- 3. refusals name the way out -------------------------------------
throws(function () {
    Programs::open('nope');
}, 'an unknown name is refused', 'is configured');
throws(function () {
    Programs::open('nope');
}, 'the refusal lists the configured names', 'sleeper');
throws(function () {
    Programs::open('ghost');
}, 'a configured program with a bad path is refused', 'nothing on this machine matches');
throws(function () {
    Programs::open('nope');
}, 'the refusal says where to fix the list', 'Config');
throws(function () {
    Programs::open('plain');
}, 'a program the policy refuses is refused at open() too', 'program');

// close() on something with no path is an answer, not a failure: nothing there
// can be running, and a thrown error would send a model round the loop.
$closedIdle = Programs::close('ghost');
ok(!empty($closedIdle['ok']) && (int)$closedIdle['closed'] === 0, 'close on a missing path reports zero');
ok(stripos((string)($closedIdle['note'] ?? ''), 'nothing') !== false, 'and says nothing is running');

// --- 4. dispatch through handle() -------------------------------------
ok(isset(Programs::handle(['action' => 'list'])['apps']), 'handle(list) returns the list');
ok(isset(Programs::handle([])['apps']), 'handle() defaults to list');

// --- 5. launch, look, close -------------------------------------------
if ($runner === '') {
    echo "  SKIP: no long-running program to copy on this host\n";
} else {
    $execLogPath = dirname(__DIR__, 2) . '/storage/exec.log';
    $logBefore = is_file($execLogPath) ? (int)@filesize($execLogPath) : 0;

    $opened = Programs::open('sleeper', ['agent' => 'agent_progs_probe']);
    ok(!empty($opened['ok']), 'open() reports success');
    ok(strpos((string)($opened['path'] ?? ''), pathinfo($runner, PATHINFO_FILENAME)) !== false,
        'open() reports what it opened');
    ok(strpos((string)($opened['command'] ?? ''), 'test-app') !== false,
        'open() reports the command line it used');

    // Process lookup finds it by the program it is running from -- the only
    // thing that can be trusted, since `start` hands off and never tells us a pid.
    $found = until(function () {
        foreach (Programs::list()['apps'] as $a) {
            if ($a['name'] === 'sleeper' && !empty($a['running'])) { return true; }
        }
        return false;
    });
    ok($found, 'the launched process is found by looking for the program');
    $launched = [];
    foreach (Programs::list()['apps'] as $a) {
        if ($a['name'] === 'sleeper') { $launched = $a['running']; }
    }
    ok(count($launched) === 1, 'exactly the process this test started is found');

    // The window outliving the request is the whole feature: nothing here
    // waited, so the process still being alive proves the detach worked.
    $alive = $platform === 'windows'
        ? strpos((string)@shell_exec('tasklist /FI "PID eq ' . (int)$launched[0] . '" /FO CSV /NH 2>NUL'),
            '"' . (int)$launched[0] . '"') !== false
        : is_file('/proc/' . (int)$launched[0]);
    ok($alive, 'the process is still running after open() returned');

    // Audited as a launch: a start with NO end, which is the record that shows
    // an agent opened something and it is still out there.
    clearstatcache(true, $execLogPath);
    $tail = (string)@file_get_contents($execLogPath, false, null, $logBefore);
    ok(strpos($tail, 'kind=program') !== false, 'the launch is audited as kind=program');
    ok(strpos($tail, 'agent=agent_progs_probe') !== false, 'the launch is attributed to the agent');
    ok(strpos($tail, 'phase=start') !== false, 'the launch writes a start line');
    $unfinished = array_filter(Sandbox::readExecLog(20, 'agent_progs_probe')['entries'],
        fn($e) => empty($e['finished']));
    ok(count($unfinished) >= 1, 'the launch reads back as started and never finished');

    // Graceful first -- a program gets to refuse, which is what lets an editor
    // ask about unsaved work. This one has no such objection.
    $graceful = Programs::close('sleeper', ['agent' => 'agent_progs_probe']);
    // The reply has to agree with itself. `ok` is defined as "nothing of this
    // program is running any more", so a reply claiming success while listing
    // something still running is exactly the old bug's shape: terminate()
    // returned ok:true for every kill, including the ones that never happened.
    ok(empty($graceful['ok']) === !empty($graceful['still_running']),
        'close() says ok only when nothing is still running');
    ok((int)($graceful['closed'] ?? -1) + count($graceful['still_running'] ?? [])
        === count($graceful['pids'] ?? []),
        'the closed count and the survivors account for every pid it saw');
    if ((int)($graceful['closed'] ?? 0) === 0) {
        ok(stripos((string)($graceful['note'] ?? ''), 'did not close') !== false,
            'a close that ended nothing says so rather than claiming success');
        ok(stripos((string)($graceful['note'] ?? ''), 'force') !== false,
            'and names force as the way through');
        echo "  NOTE: graceful close did not end it; the force path is doing so\n";
    }
    $closed = (int)($graceful['closed'] ?? 0) === 0
        ? Programs::close('sleeper', ['force' => true, 'agent' => 'agent_progs_probe'])
        : $graceful;
    ok(!empty($closed['ok']), 'close() reports success');
    ok((int)($closed['closed'] ?? 0) === 1, 'close() reports one process closed');
    $gone = until(function () use ($launched) {
        foreach (Programs::list()['apps'] as $a) {
            if ($a['name'] === 'sleeper' && !empty($a['running'])) { return false; }
        }
        return true;
    });
    ok($gone, 'the process is actually gone');

    clearstatcache(true, $execLogPath);
    $tail2 = (string)@file_get_contents($execLogPath, false, null, $logBefore);
    ok(strpos($tail2, 'phase=end') !== false, 'the close writes an end line');
    $finished = array_filter(Sandbox::readExecLog(20, 'agent_progs_probe')['entries'],
        fn($e) => !empty($e['finished']));
    ok(count($finished) >= 1, 'the close pairs start and end into one finished run');

    // Closing again is an answer, not an error: it was already gone.
    $again = Programs::close('sleeper');
    ok((int)($again['closed'] ?? -1) === 0, 'closing an already-closed program reports zero closed');
    ok(stripos((string)($again['note'] ?? ''), 'nothing') !== false, 'and says so plainly');
}

// --- 5b. the same file name in another folder is a DIFFERENT program ---
// This is the finding the path match exists for. Matching on the image name
// (tasklist /FI "IMAGENAME eq ...") cannot tell the configured copy from any
// other copy of that file on the machine, so a window_close could end a process
// the operator never opened.
if ($runner !== '') {
    $twinDir = $tmpDir . '/twin';
    @mkdir($twinDir, 0777, true);
    $twin = $twinDir . '/' . basename($runner);   // same name, different path
    ok(@copy($runner, $twin) && is_file($twin), 'a second copy of the same file name exists elsewhere');

    $twinApps = $apps;
    $twinApps[] = ['name' => 'twin', 'path' => $twin, 'args' => $runnerArgs];
    write_cfg($configPath, true, $twinApps);

    $openedTwin = Programs::open('twin', ['agent' => 'agent_progs_probe']);
    ok(!empty($openedTwin['ok']), 'the twin copy opens through its own entry');

    $rows = [];
    $twinSeen = until(function () use (&$rows) {
        $rows = [];
        foreach (Programs::list()['apps'] as $a) { $rows[$a['name']] = $a; }
        return !empty($rows['twin']['running']);
    });
    ok($twinSeen, 'the twin is found through the entry that points at it');
    ok(($rows['sleeper']['running'] ?? null) === [],
        'the OTHER copy of the same file name is not reported as this program');

    // ...and closing the configured entry must not touch the twin. With the old
    // name match this close was the thing that ended it.
    $noClose = Programs::close('sleeper');
    ok((int)($noClose['closed'] ?? -1) === 0, 'closing this program finds nothing of its own');
    $twinPids = [];
    foreach (Programs::list()['apps'] as $a) { if ($a['name'] === 'twin') { $twinPids = $a['running']; } }
    ok(count($twinPids) === 1, 'the twin elsewhere on disk was not touched by that close');

    $closedTwin = Programs::close('twin', ['force' => true, 'agent' => 'agent_progs_probe']);
    ok(!empty($closedTwin['ok']) && (int)($closedTwin['closed'] ?? 0) === 1,
        'the twin closes through its own entry');
}

// --- 5c. what a Windows argument becomes on the command line -----------
if ($platform === 'windows' && $runner !== '') {
    // Inside a quoted argument, `\"` is read by the program as an escaped
    // QUOTE, so a path ending in a backslash would arrive corrupted -- doubled
    // is the one spelling cmd and the program agree on.
    $argApps = $apps;
    // Built from DIRECTORY_SEPARATOR rather than typed as a literal: this test
    // then needs no escaping, and it exercises exactly what the launcher is
    // given, which is a path ending in a separator.
    $sep = DIRECTORY_SEPARATOR;
    $trailingArg = 'C:' . $sep . 'temp' . $sep;
    $argApps[] = ['name' => 'trailing', 'path' => $runner, 'args' => ['-n', '1', $trailingArg]];
    write_cfg($configPath, true, $argApps);
    $trailing = Programs::open('trailing');
    // What the command line must carry: the argument with its trailing
    // separator DOUBLED, then the closing quote.
    $needle = $trailingArg . chr(92) . '"';
    ok(strpos((string)($trailing['command'] ?? ''), $needle) !== false,
        'a trailing backslash is doubled so it cannot escape the closing quote');
    ok(strpos((string)($trailing['command'] ?? ''), $trailingArg . '"') === false,
        'and the undoubled spelling is not on the command line at all');

    $badApps = $apps;
    $badApps[] = ['name' => 'percent', 'path' => $runner, 'args' => ['-n', '1', '100%']];
    write_cfg($configPath, true, $badApps);
    throws(function () {
        Programs::open('percent');
    }, 'an argument cmd cannot quote safely is refused, not guessed', 'cannot quote safely');
    write_cfg($configPath, true, $apps);
}

// --- 5d. the trace cannot be written by the thing it records -----------
// audit() builds ONE line per record, so a newline in a logged field is a
// forged record: the agent name arrives in the tool call, and an argv element
// can be anything a model sent.
if (isset($execLogPath) && is_file($execLogPath)) {
    $probeRun = 'auditprobe' . getmypid();
    $before = (int)@filesize($execLogPath);
    Sandbox::audit('probe.exe', ["/tmp/arg\nwith a break"], '/tmp', 0, 5, [
        'run' => $probeRun, 'phase' => 'end', 'kind' => 'program',
        'agent' => "evil\n" . gmdate('Y-m-d\TH:i:sZ')
            . ' run=forged-inject phase=start kind=program agent=evil exit=0 ms=0 timeout=0 cwd=/ :: forged.exe',
    ]);
    clearstatcache(true, $execLogPath);
    $added = (string)@file_get_contents($execLogPath, false, null, $before);
    ok(substr_count($added, "\n") === 1,
        'a newline in a logged field cannot add a second audit line');
    $ids = array_column(Sandbox::readExecLog(500)['entries'], 'id');
    ok(in_array($probeRun, $ids, true), 'the real run is still recorded, in one piece');
    ok(!in_array('forged-inject', $ids, true), 'the forged run id never becomes an entry of its own');
}

// --- 6. status carries the summary the UI and prompts read ------------
$sbStatus = Sandbox::status();
ok(isset($sbStatus['programs']['enabled']), 'sandbox status exposes the programs switch');
ok(($sbStatus['programs']['count'] ?? -1) === count($apps) - 2, 'sandbox status counts them');
ok(in_array('sleeper', $sbStatus['programs']['names'] ?? [], true), 'sandbox status names them');

// --- cleanup ----------------------------------------------------------
// Put the operator's trace back the way it was FIRST: every line written from
// here on is test output, and the trail is meant to read as history.
if (isset($execLogPath) && isset($logBefore) && is_file($execLogPath)) {
    $fh = @fopen($execLogPath, 'r+');
    if ($fh !== false) { @ftruncate($fh, $logBefore); @fclose($fh); }
}
foreach (array_merge($launched ?? [], $twinPids ?? []) as $pid) {
    if ((int)$pid <= 0) { continue; }
    if ($platform === 'windows') {
        @shell_exec('taskkill /PID ' . (int)$pid . ' /F 2>NUL');
    } else {
        @exec('kill -KILL ' . (int)$pid . ' 2>/dev/null');
    }
}
foreach ([$runner, $plain, $twin ?? ''] as $f) { if ($f !== '') { @unlink($f); } }
@rmdir($progDir);
@rmdir($writeDir);
if (isset($twinDir)) { @rmdir($twinDir); }
@unlink($configPath);
@rmdir($tmpDir);
putenv('ROUTER_CONFIG');

// --- results ----------------------------------------------------------
echo str_repeat('-', 60) . "\n";
echo "$pass passed, $fail failed\n";
foreach ($errors as $e) { echo "  $e\n"; }
exit($fail ? 1 : 0);
