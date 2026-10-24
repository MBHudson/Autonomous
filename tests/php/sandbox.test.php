<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Sandbox unit-test harness.
 *
 * Usage: php tests/php/sandbox.test.php
 *
 * Creates a temporary sandbox root, writes a throwaway config, runs every
 * Sandbox method through the real jail/scope/security checking, then cleans up.
 * Exits 0 on success, 1 on any failure.
 *
 * Environment:
 *   ROUTER_CONFIG  — set by the harness to a temp config; Config.php reads it.
 */

// --- bootstrap --------------------------------------------------------
require_once __DIR__ . '/../../autoload.php';

use Src\Sandbox;
use Src\Config;

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
        ok(false, "$name (expected exception)");
    } catch (\Throwable $e) {
        if ($needle === '' || stripos($e->getMessage(), $needle) !== false) {
            ok(true, $name);
        } else {
            ok(false, "$name (bad message: {$e->getMessage()})");
        }
    }
}

// --- temp environment -------------------------------------------------
$pid = getmypid();
$tmpDir = rtrim(str_replace('\\','/',sys_get_temp_dir()),'/') . '/router-sandbox-test-' . $pid;
$readOnly = $tmpDir . '/r';
$writeDir = $tmpDir . '/w';
$outside  = $tmpDir . '/secret-outside';

@mkdir($readOnly, 0777, true);
@mkdir($writeDir,  0777, true);
@mkdir($outside,   0777, true);

$cfg = [
    'sandbox' => [
        'read_roots'  => [$readOnly, $writeDir],
        'write_roots' => [$writeDir],
        'require_token' => false,
        'token' => '',
        'code_enabled' => true,   // exercised by the run_code tests below
        'exec_enabled' => true,   // exercised by the exec tests below
        'exec_allow' => [],       // empty means the built-in defaults
        'exec_timeout' => 10,
    ],
];

$configPath = $tmpDir . '/config.json';
file_put_contents($configPath, json_encode($cfg, JSON_PRETTY_PRINT));
putenv('ROUTER_CONFIG=' . $configPath);

$fileInR = $readOnly . '/hello.txt';
file_put_contents($fileInR, 'world');
$nestedW = $writeDir . '/sub/deep.txt';
@mkdir(dirname($nestedW), 0777, true);
file_put_contents($nestedW, 'nested');

$secretFile = $outside . '/secret.txt';
file_put_contents($secretFile, 'forbidden');

// --- tests ------------------------------------------------------------
echo "Sandbox test harness\n";
echo str_repeat('-', 60) . "\n";

// 1. status
$s = Sandbox::status();
ok(!empty($s['ok']), 'status ok');
ok(in_array(rtrim(str_replace('\\','/',$readOnly),'/'), $s['read_roots']), 'status read_roots');
ok(in_array(rtrim(str_replace('\\','/',$writeDir),'/'), $s['write_roots']), 'status write_roots');

// 2. list writable root -> writable true
$ls = Sandbox::listDir('.', 200, $writeDir);
ok($ls['writable'] === true, 'list writable root writable');

// 3. list read-only root -> writable false
$lsR = Sandbox::listDir('.', 200, $readOnly);
ok($lsR['writable'] === false, 'list read-only root not writable');

// 4. list shows entries
ok(count($lsR['entries']) > 0, 'list has entries');

// 5. read file inside root
$r = Sandbox::readFile($fileInR, null, $readOnly);
ok(stripos($r['content'], 'world') !== false, 'read file');

// 6. read path escape refused
throws(function () use ($secretFile, $readOnly) {
    Sandbox::readFile($secretFile, null, $readOnly);
}, 'read outside root refused');

// 7. read ../ outside (path traversal via relative)
throws(function () use ($readOnly) {
    Sandbox::readFile('../secret-outside/secret.txt', null, $readOnly);
}, 'read ../ refused');

// 8. scope escape: scope not in any root
throws(function () use ($nestedW, $outside) {
    Sandbox::readFile($nestedW, null, $outside);
}, 'scope outside roots refused');

// 9. write file
$wFile = $writeDir . '/test.txt';
$wr = Sandbox::writeFile($wFile, 'hello write');
ok($wr['bytes_written'] > 0, 'write file');

// 10. list_dir on subdir
$lsSub = Sandbox::listDir('sub', 200, $writeDir);
ok(count($lsSub['entries']) > 0, 'list subdirectory');

// 11. write inside read-only scope refused
throws(function () use ($readOnly) {
    Sandbox::writeFile('write-test.txt', 'x', 'write', $readOnly);
}, 'write to read-only scope refused');

// 12. mkdir
$md = Sandbox::makeDir('new-dir/nested', $writeDir);
ok(is_dir($writeDir . '/new-dir/nested'), 'mkdir nested');
ok($md['type'] === 'dir', 'mkdir returns entry');

// 13. copy file
$cp = Sandbox::copyMove($wFile, 'copied.txt', false, $writeDir);
ok(file_exists($writeDir . '/copied.txt'), 'copy file');

// 14. move file (rename within write root)
$mv = Sandbox::copyMove($writeDir . '/copied.txt', 'moved.txt', true, $writeDir);
ok(file_exists($writeDir . '/moved.txt'), 'move file');
ok(!file_exists($writeDir . '/copied.txt'), 'move removed source');

// 15. move from read-only root (source in read roots but not write) refused
$roFile = $readOnly . '/rofile.txt';
file_put_contents($roFile, 'read-only');
throws(function () use ($roFile, $writeDir) {
    Sandbox::copyMove($roFile, $writeDir . '/stolen.txt', true, null);
}, 'move from read-only refused');

// 16. binary write/read
$b64 = base64_encode('binary!');
$bw = Sandbox::writeBinary('binary.dat', $b64, $writeDir);
ok($bw['bytes_written'] === 7, 'binary write');
$br = Sandbox::readBinary($writeDir . '/binary.dat', $writeDir);
ok($br['data'] === $b64, 'binary read');

// 17. read text
$rt = Sandbox::readText($wFile, $writeDir);
ok(stripos($rt['content'], 'hello') !== false, 'read text');

// 18. read text of non-existent throws
throws(function () use ($writeDir) {
    Sandbox::readText('nonexistent.txt', null, $writeDir);
}, 'read text nonexistent throws');

// 19. stat
$st = Sandbox::statPath($wFile, $writeDir);
ok($st['name'] === 'test.txt', 'stat name');

// 20. set mode (call only; Windows ignores)
$ch = Sandbox::setMode($wFile, '644', $writeDir);
ok(!empty($ch['mode']), 'chmod returns mode');

// 21. globFiles escape
$g = Sandbox::globFiles('../*', null, $writeDir);
foreach ($g['matches'] as $m) {
    ok(strpos($m, rtrim(str_replace('\\','/',$writeDir),'/')) === 0, "glob match within root: $m");
}

// 22. globFiles pattern with ..
$g2 = Sandbox::globFiles('../secret-outside/*', null, $writeDir);
ok(count($g2['matches']) === 0, 'glob ../ outside yields zero matches');

// 23. grep (skip symlinks: create a symlink to outside secret; if fails skip)
$linkInR = $readOnly . '/evillink';
$linkOk = @symlink($secretFile, $linkInR);
if ($linkOk) {
    $gp = Sandbox::grepCode('forbidden', '*.txt', 20, $readOnly);
    $matched = array_filter($gp['matches'], function ($m) use ($secretFile) {
        return strpos($m['file'], $secretFile) !== false;
    });
    ok(count($matched) === 0, 'grep skips symlinks');
    @unlink($linkInR);
} else {
    echo "  SKIP: grep symlink (cannot create symlink on this platform)\n";
}

// 24. grep normal
$gp = Sandbox::grepCode('nested', '*.txt', 20, $writeDir);
ok($gp['count'] > 0, 'grep finds nested');

// 25. zip / unzip
$z = Sandbox::zipPaths([$wFile, $writeDir . '/binary.dat'], $writeDir . '/arch.zip', $writeDir);
ok($z['bytes'] > 0, 'zip created');
$uz = Sandbox::unzipArchive($writeDir . '/arch.zip', $writeDir . '/unz', $writeDir);
ok(file_exists($writeDir . '/unz/test.txt'), 'unzip extracted file');
ok(file_exists($writeDir . '/unz/binary.dat'), 'unzip binary');

// 26. unzip slip protection: internal method via reflection
$ref = new \ReflectionMethod(Sandbox::class, 'zipTarget');
$ref->setAccessible(true);
$dest = rtrim(str_replace('\\', '/', $writeDir), '/') . '/safe';
throws(function () use ($ref, $dest) {
    $ref->invoke(null, $dest, '../evil.txt');
}, 'zip-slip ../ rejected');
throws(function () use ($ref, $dest) {
    $ref->invoke(null, $dest, '/etc/passwd');
}, 'zip-slip absolute rejected');

// 27. remove
$rm = Sandbox::removePath($writeDir . '/new-dir/nested', $writeDir);
ok($rm['removed'] >= 1, 'remove file');
// cleanup removal path
Sandbox::removePath($writeDir . '/new-dir', $writeDir);

// 28. remove root itself refused
throws(function () use ($writeDir) {
    Sandbox::removePath($writeDir, $writeDir);
}, 'remove root refused');

// 29. read range clamp (end<start)
$rr = Sandbox::readFile($fileInR, '1-1', $readOnly);
ok(!empty($rr['content']), 'read range clamp');

// 30. readText binary rejection (pixel)
$pixelB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
Sandbox::writeBinary('pixel.png', $pixelB64, $writeDir);
throws(function () use ($writeDir) {
    Sandbox::readText('pixel.png', $writeDir);
}, 'readText binary rejected');

// 31. listDir root argument listing
Sandbox::makeDir($writeDir . '/another-dir', $writeDir);
$lsA = Sandbox::listDir('.', 200, $writeDir);
$dirNames = array_column($lsA['entries'], 'name');
ok(in_array('another-dir', $dirNames), 'list subdir entry');
Sandbox::removePath($writeDir . '/another-dir', $writeDir);

// 32. str_replace: exact, unique replacement
Sandbox::writeFile('edit.txt', "alpha\nbeta\ngamma\n", 'write', $writeDir);
$sr = Sandbox::strReplace('edit.txt', 'beta', 'BETA', false, $writeDir);
ok($sr['replaced'] === 1, 'str_replace unique replaces once');
$after = Sandbox::readText('edit.txt', $writeDir)['content'];
ok(strpos($after, 'BETA') !== false && strpos($after, 'beta') === false, 'str_replace changed the text');

// 33. str_replace: missing old string is refused
throws(function () use ($writeDir) {
    Sandbox::strReplace('edit.txt', 'nope-not-here', 'x', false, $writeDir);
}, 'str_replace missing old refused', 'not found');

// 34. str_replace: ambiguous old string is refused unless replace_all
Sandbox::writeFile('dup.txt', "x\nx\n", 'write', $writeDir);
throws(function () use ($writeDir) {
    Sandbox::strReplace('dup.txt', 'x', 'y', false, $writeDir);
}, 'str_replace ambiguous refused', 'appears');
$all = Sandbox::strReplace('dup.txt', 'x', 'y', true, $writeDir);
ok($all['replaced'] === 2, 'str_replace replace_all replaces every match');

// 35. str_replace: cannot edit outside a writable root
throws(function () use ($readOnly) {
    Sandbox::strReplace('edit.txt', 'a', 'b', false, $readOnly);
}, 'str_replace outside write root refused');

// 36. insert_at: insert after line 1
Sandbox::writeFile('ins.txt', "one\ntwo", 'write', $writeDir);
$ins = Sandbox::insertAt('ins.txt', 1, 'ONE-AND-A-HALF', $writeDir);
ok($ins['lines'] === 3, 'insert adds a line');
$body = Sandbox::readText('ins.txt', $writeDir)['content'];
ok(strpos($body, "one\nONE-AND-A-HALF\ntwo") === 0, 'insert lands after the given line');

// 37. insert_at: out-of-range line is refused
throws(function () use ($writeDir) {
    Sandbox::insertAt('ins.txt', 999, 'x', $writeDir);
}, 'insert out-of-range refused', 'between');

// 38. git: a subcommand outside the allowlist is refused before anything runs
throws(function () use ($writeDir) {
    Sandbox::gitRun(['filter-branch'], $writeDir, $writeDir);
}, 'git disallowed subcommand refused', 'not an allowed');
// 39. git: retargeting flags are refused
throws(function () use ($writeDir) {
    Sandbox::gitRun(['log', '--work-tree=/etc'], $writeDir, $writeDir);
}, 'git --work-tree refused', 'refused');
throws(function () use ($writeDir) {
    Sandbox::gitRun(['log', '-c', 'core.pager=evil'], $writeDir, $writeDir);
}, 'git -c refused', 'refused');
// 40. git: a real read-only command works when git is installed
try {
    $st = Sandbox::gitRun(['status', '--short'], $writeDir, $writeDir);
    ok(isset($st['exit']) && array_key_exists('stdout', $st), 'git status runs');
} catch (\RuntimeException $e) {
    echo "  SKIP: git not installed\n";
}

// 38a. exec: an allowlisted builtin runs; no shell is involved
$ec = Sandbox::execCommand(['echo', 'hello', 'world'], ['cwd' => $writeDir]);
ok(($ec['exit'] === 0) && trim($ec['stdout']) === 'hello world', 'exec echo runs');
$ec2 = Sandbox::execCommand(['echo', 'a', ';', 'echo', 'b'], ['cwd' => $writeDir]);
ok(trim($ec2['stdout']) === 'a ; echo b', 'exec treats shell metacharacters as text');

// 38b. exec: pwd reports a working directory and exits cleanly
$pw = Sandbox::execCommand(['pwd'], ['cwd' => $writeDir]);
ok(($pw['exit'] === 0) && trim($pw['stdout']) !== '', 'exec pwd reports cwd');

// 38c. exec: type resolves an executable without a shell on Windows
if (DIRECTORY_SEPARATOR === '\\') {
    $wh = Sandbox::execCommand(['type', 'cmd'], ['cwd' => $writeDir]);
    ok(($wh['exit'] === 0) && stripos($wh['stdout'], 'cmd') !== false,
        'exec type resolves cmd on Windows');
}

// 38d. exec: dir/type work on Windows without cmd.exe
$dr = Sandbox::execCommand(['dir'], ['cwd' => $writeDir]);
ok(($dr['exit'] === 0) && strpos($dr['stdout'], 'test.txt') !== false, 'exec dir lists cwd');
$tp = Sandbox::execCommand(['type', 'test.txt'], ['cwd' => $writeDir]);
ok(($tp['exit'] === 0) && trim($tp['stdout']) === 'hello write', 'exec type reads a file');

// 38e. exec without an explicit cwd defaults to an allowed root, not appDir
$norm = fn($p) => rtrim(str_replace('\\', '/', (string)$p), '/');
$pc = Sandbox::execCommand(['pwd']);
$pcOut = $norm(trim($pc['stdout'] ?? ''));
ok(($pc['exit'] === 0) && ($pcOut === $norm($readOnly) || $pcOut === $norm($writeDir)),
    'exec defaults cwd to an allowed root');

// 38f. list_dir on a file path answers with that entry, not "not a directory"
$lf = Sandbox::listDir('test.txt', 200, $writeDir);
ok(isset($lf['entries'][0]) && $lf['entries'][0]['name'] === 'test.txt'
    && $lf['entries'][0]['type'] === 'file', 'list_dir reports a file path');

// 41. apply_patch: add + update in one envelope
$patch = "*** Begin Patch\n"
    . "*** Add File: patched.txt\n"
    . "+alpha\n+beta\n"
    . "*** Update File: patched.txt\n"
    . "@@\n alpha\n-beta\n+BETA\n"
    . "*** End Patch\n";
$ap = Sandbox::applyPatch($patch, $writeDir);
ok($ap['count'] === 2, 'apply_patch applied add + update');
$pbody = Sandbox::readText('patched.txt', $writeDir)['content'];
ok($pbody === "alpha\nBETA\n", 'apply_patch produced the expected content');

// 42. apply_patch: move
$mv = Sandbox::applyPatch("*** Begin Patch\n*** Update File: patched.txt\n*** Move to: patched-moved.txt\n*** End Patch\n", $writeDir);
ok(file_exists($writeDir . '/patched-moved.txt') && !file_exists($writeDir . '/patched.txt'), 'apply_patch move relocates the file');

// 43. apply_patch: delete
Sandbox::applyPatch("*** Begin Patch\n*** Delete File: patched-moved.txt\n*** End Patch\n", $writeDir);
ok(!file_exists($writeDir . '/patched-moved.txt'), 'apply_patch delete removes the file');

// 44. apply_patch: ambiguous hunk refused
Sandbox::writeFile('amb.txt', "x\nx\n", 'write', $writeDir);
throws(function () use ($writeDir) {
    Sandbox::applyPatch("*** Begin Patch\n*** Update File: amb.txt\n@@\n-x\n+y\n*** End Patch\n", $writeDir);
}, 'apply_patch ambiguous hunk refused', 'places');

// 45. apply_patch: context not found refused
throws(function () use ($writeDir) {
    Sandbox::applyPatch("*** Begin Patch\n*** Update File: amb.txt\n@@\n zzz\n-x\n*** End Patch\n", $writeDir);
}, 'apply_patch missing context refused', 'not found');

// 46. apply_patch: cannot touch a file outside the writable root
throws(function () use ($readOnly) {
    Sandbox::applyPatch("*** Begin Patch\n*** Add File: nope.txt\n+x\n*** End Patch\n", $readOnly);
}, 'apply_patch outside write root refused');

// 47. multi_edit: several edits across files, applied together
Sandbox::writeFile('m1.txt', "aaa\nbbb\n", 'write', $writeDir);
Sandbox::writeFile('m2.txt', "ccc\n", 'write', $writeDir);
$me = Sandbox::multiEdit([
    ['path' => 'm1.txt', 'old_string' => 'bbb', 'new_string' => 'BBB'],
    ['path' => 'm2.txt', 'old_string' => 'ccc', 'new_string' => 'CCC'],
], $writeDir);
ok($me['count'] === 2, 'multi_edit applies edits across files');
ok(strpos(Sandbox::readText('m1.txt', $writeDir)['content'], 'BBB') !== false
    && strpos(Sandbox::readText('m2.txt', $writeDir)['content'], 'CCC') !== false,
    'multi_edit wrote both files');

// 48. multi_edit is all-or-nothing: one bad edit writes nothing
Sandbox::writeFile('m3.txt', "keep me\n", 'write', $writeDir);
throws(function () use ($writeDir) {
    Sandbox::multiEdit([
        ['path' => 'm3.txt', 'old_string' => 'keep me', 'new_string' => 'CHANGED'],
        ['path' => 'm3.txt', 'old_string' => 'not-there', 'new_string' => 'x'],
    ], $writeDir);
}, 'multi_edit bad edit refused', 'not found');
ok(strpos(Sandbox::readText('m3.txt', $writeDir)['content'], 'keep me') !== false,
    'multi_edit wrote nothing when one edit failed');

// 49. run_code: unsupported language is refused
throws(function () use ($writeDir) {
    Sandbox::runCode('cobol', 'DISPLAY "x".', ['cwd' => $writeDir]);
}, 'run_code unsupported language', 'unsupported');

// 50. run_code: runs python when it is installed
try {
    $rc = Sandbox::runCode('python', 'print(6*7)', ['cwd' => $writeDir]);
    ok(trim($rc['stdout']) === '42', 'run_code ran python');
} catch (\RuntimeException $e) {
    echo "  SKIP: python not installed\n";
}

// 51. run_code: disabled unless the operator turns it on
file_put_contents($configPath, json_encode(['sandbox' => [
    'read_roots' => [$readOnly, $writeDir], 'write_roots' => [$writeDir],
    'require_token' => false, 'token' => '',
]], JSON_PRETTY_PRINT));
throws(function () use ($writeDir) {
    Sandbox::runCode('python', 'print(1)', ['cwd' => $writeDir]);
}, 'run_code disabled by default', 'disabled');
file_put_contents($configPath, json_encode($cfg, JSON_PRETTY_PRINT));   // restore

// 52. git_commit: stages and commits when git is available
try {
    Sandbox::gitRun(['init'], $writeDir, $writeDir);
    $gc = Sandbox::gitCommit('sandbox test commit', [], $writeDir, $writeDir);
    ok(!empty($gc['ok']), 'git_commit runs');
    ok($gc['nothing_to_commit'] === false, 'git_commit committed a change');
    Sandbox::removePath($writeDir . '/.git', $writeDir);
} catch (\RuntimeException $e) {
    echo "  SKIP: git not available (" . substr($e->getMessage(), 0, 60) . ")\n";
}

// --- cleanup ----------------------------------------------------------
Sandbox::removePath($writeDir . '/m1.txt', $writeDir);
Sandbox::removePath($writeDir . '/m2.txt', $writeDir);
Sandbox::removePath($writeDir . '/m3.txt', $writeDir);
Sandbox::removePath($writeDir . '/edit.txt', $writeDir);
Sandbox::removePath($writeDir . '/dup.txt', $writeDir);
Sandbox::removePath($writeDir . '/ins.txt', $writeDir);
Sandbox::removePath($writeDir . '/amb.txt', $writeDir);
Sandbox::removePath($writeDir . '/unz', $writeDir);
Sandbox::removePath($writeDir . '/arch.zip', $writeDir);
Sandbox::removePath($writeDir . '/test.txt', $writeDir);
Sandbox::removePath($writeDir . '/moved.txt', $writeDir);
Sandbox::removePath($writeDir . '/binary.dat', $writeDir);
Sandbox::removePath($writeDir . '/pixel.png', $writeDir);
@rmdir($writeDir . '/sub');
@rmdir($writeDir);
@rmdir($readOnly . '/sub');
@rmdir($readOnly);
@rmdir($outside);
@unlink($configPath);
@rmdir($tmpDir);
putenv('ROUTER_CONFIG');
Config::loadConfig(); // reset path cache? not cached.

// --- results ----------------------------------------------------------
echo str_repeat('-', 60) . "\n";
echo "$pass passed, $fail failed\n";
foreach ($errors as $e) echo "  $e\n";
exit($fail ? 1 : 0);