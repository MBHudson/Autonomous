<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Backup-in-parts test: what is backed up, and what a restore touches.
 *
 * Usage: php tests/php/backup.test.php
 *
 * The backup used to be all-or-nothing: GET /api/backup returned the whole
 * copy and POST /import replaced it, refusing anything that missed a section.
 * Sections are the unit now -- export writes only the chosen ones, import
 * touches only the chosen ones, and anything absent is left alone.
 *
 * What is asserted here:
 *
 *   * export writes only the requested sections (and labels the file with
 *     the requested name), including the models catalog the old backup never
 *     carried at all;
 *   * a partial or older file restores partially instead of 400ing, and the
 *     plan says which sections it skipped and why;
 *   * state merges per-slot (unselected slots survive), sessions are replaced
 *     only when the sessions section is restored, and a restore onto a copy
 *     with a different token keeps this copy's own gate, token and roots
 *     while saying the backup's token differed;
 *   * nothing here touches the operator's install: a throwaway directory plus
 *     the ROUTER_CONFIG / ROUTER_MODELS overrides, both unset afterwards. No
 *     server is started and no log is written, so parallel runs cannot collide.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

require_once __DIR__ . '/../../autoload.php';

use Src\Backup;
use Src\Config;

$pass = 0;
$fail = 0;
$errors = [];

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

function same($actual, $expected, $name)
{
    global $pass, $fail, $errors;
    if ($actual === $expected) {
        $pass++;
    } else {
        $fail++;
        $errors[] = 'FAIL: ' . $name . ' (got ' . json_encode($actual)
            . ', want ' . json_encode($expected) . ')';
    }
}

// --- throwaway install -------------------------------------------------------
$tmp = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'bktest-' . getmypid();
@mkdir($tmp, 0755, true);
@mkdir($tmp . DIRECTORY_SEPARATOR . 'sessions', 0755, true);
$cfg = $tmp . DIRECTORY_SEPARATOR . 'config.json';
$models = $tmp . DIRECTORY_SEPARATOR . 'models.json';

$localRoot = $tmp . DIRECTORY_SEPARATOR . 'work';
@mkdir($localRoot, 0755, true);
file_put_contents($cfg, json_encode([
    'sandbox' => [
        'require_token' => true,
        'token' => 'LOCAL-TOKEN',
        'read_roots' => [$localRoot],
        'write_roots' => [$localRoot],
        'allow' => ['echo'],
    ],
]));
file_put_contents($models, json_encode([['id' => 'm1', 'name' => 'One', 'api_key' => 'K1']]));
putenv('ROUTER_CONFIG=' . $cfg);
putenv('ROUTER_MODELS=' . $models);

$state = [
    'rev' => 7,
    'updated' => 111,
    'slots' => [
        'agents' => [['id' => 'a1']],
        'providers' => [['id' => 'p1', 'api_key' => 'P1']],
        'settings' => ['theme' => 'neon'],
        'memory' => ['entries' => []],
        'pipelines' => [],
        'conversations' => [['id' => 'c1']],
        'metrics' => ['runs' => 3],
    ],
];
file_put_contents($tmp . DIRECTORY_SEPARATOR . 'state.json', json_encode($state));
file_put_contents($tmp . DIRECTORY_SEPARATOR . 'sessions' . DIRECTORY_SEPARATOR . 'old.json',
    json_encode(['id' => 'old', 'title' => 'stale']));
file_put_contents($tmp . DIRECTORY_SEPARATOR . 'exec-approvals.json',
    json_encode(['grants' => ['echo']]));

// --- section list ------------------------------------------------------------
same(Backup::allSections(),
    ['agents', 'providers', 'models', 'settings', 'memory', 'pipelines', 'conversations', 'metrics', 'sessions', 'config', 'approvals'],
    'eleven sections in UI order');
$parsed = Backup::parseList(null);
same($parsed, ['sections' => Backup::allSections(), 'unknown' => []], 'null means everything');
$parsed = Backup::parseList('agents, providers,agents,, models');
same($parsed['sections'], ['agents', 'providers', 'models'], 'comma list deduped, blanks dropped');
same($parsed['unknown'], [], 'no unknowns in a good list');
$parsed = Backup::parseList(['sessions', 'nope', 'bogus', 'nope']);
same($parsed['sections'], ['sessions'], 'unknowns do not join the list');
same($parsed['unknown'], ['nope', 'bogus'], 'unknowns reported once each');

// --- filename ----------------------------------------------------------------
same(Backup::sanitizeName('My backup!'), 'My-backup', 'spaces and bangs become dashes');
same(Backup::sanitizeName('a.json'), 'a', 'a pasted extension is not doubled');
same(Backup::sanitizeName('..\..\x'), 'x', 'a pasted path keeps only the last part');
same(Backup::sanitizeName(''), 'router-backup', 'empty falls back');
same(Backup::sanitizeName('...'), 'router-backup', 'dots fall back');
same(strlen(Backup::sanitizeName(str_repeat('a', 200))), 80, 'long names capped at 80');

// --- export ------------------------------------------------------------------
$part = Backup::exportBundle($tmp, ['agents', 'providers'], ['name' => 'just-us']);
same($part['app'], 'router-studio', 'bundle is ours');
same($part['backupVersion'], 2, 'bundle is the sectioned format');
same($part['name'], 'just-us', 'bundle carries the requested name');
same($part['sections'], ['agents', 'providers'], 'bundle lists what it holds');
same(array_keys($part['state']['slots']), ['agents', 'providers'], 'only the requested slots exported');
ok(!isset($part['sessions']) && !isset($part['models']) && !isset($part['config']) && !isset($part['approvals']),
    'unrequested files are absent, not empty');
ok($part['exportedAt'] > 0, 'bundle is stamped');

$full = Backup::exportBundle($tmp, Backup::allSections());
same($full['sections'], Backup::allSections(), 'a full export lists everything');
same(count($full['state']['slots']), 7, 'all seven slots exported');
same(count($full['sessions']), 1, 'the session file exported');
same($full['models'], [['id' => 'm1', 'name' => 'One', 'api_key' => 'K1']], 'the models catalog exports');
same($full['config']['sandbox']['token'], 'LOCAL-TOKEN', 'the token exports with the config');
same($full['approvals'], ['grants' => ['echo']], 'approval grants export');

// --- plan: partial and older files -------------------------------------------
$v1 = [
    'app' => 'router-studio',
    'backupVersion' => 1,
    'exportedAt' => 111,
    'state' => ['slots' => ['agents' => [['id' => 'a9']]], 'rev' => 1],
    'sessions' => [['id' => 's9']],
    'config' => ['sandbox' => ['require_token' => true, 'token' => 'FOREIGN-TOKEN']],
];
$plan = Backup::planRestore($v1);
ok(!isset($plan['error']), 'an older full backup still plans');
same($plan['restore'], ['agents', 'sessions', 'config'], 'older files restore what they carry');
$skippedIds = array_column($plan['skipped'], 'section');
ok(in_array('providers', $skippedIds, true) && in_array('models', $skippedIds, true),
    'sections the file never heard of are skipped, not blanked');
same(Backup::planRestore(['app' => 'nope']), ['error' => 'Not an Autonomous Loop Studio backup file'], 'foreign files refused');
same(Backup::planRestore($v1, ['agents', 'bogus']),
    ['error' => 'Unknown backup section(s): bogus'], 'unknown wanted sections refused by name');
$only = Backup::planRestore($full, ['providers', 'metrics']);
same($only['restore'], ['providers', 'metrics'], 'only restores only the chosen');
same($only['skipped'], [], 'nothing skipped when the file carries the choice');

// --- merge: per-slot, tokens never roam ---------------------------------------
$merged = Backup::mergeState(
    ['rev' => 7, 'slots' => ['agents' => [['id' => 'a1']], 'providers' => [['id' => 'p1']]]],
    ['slots' => ['agents' => [['id' => 'a2']], 'settings' => ['theme' => 'x', 'routerToken' => 'LEAK', 'sandboxToken' => 'LEAK']]],
    ['agents', 'settings']
);
same($merged['slots']['agents'], [['id' => 'a2']], 'a restored slot replaces');
same($merged['slots']['providers'], [['id' => 'p1']], 'an unlisted slot survives');
same($merged['rev'], 8, 'the revision bumps so other devices adopt it');
ok(!isset($merged['slots']['settings']['routerToken']) && !isset($merged['slots']['settings']['sandboxToken']),
    'device credentials never roam, not even in a restore');

// --- import: a different token, a different copy --------------------------------
// The backup below came from another copy: its agents differ, its sessions
// differ, its token differs, its roots point at another OS. The restore must
// take the contents and keep this copy's gate, token and roots -- and say so.
$foreign = [
    'app' => 'router-studio',
    'backupVersion' => 2,
    'sections' => ['agents', 'sessions', 'config', 'models'],
    'state' => ['slots' => ['agents' => [['id' => 'remote-agent']]], 'rev' => 41],
    'sessions' => [['id' => 'new', 'title' => 'fresh'], ['id' => '../../evil', 'title' => 'x']],
    'models' => [['id' => 'm2', 'name' => 'Two']],
    'config' => ['sandbox' => [
        'require_token' => true,
        'token' => 'FOREIGN-TOKEN',
        'allow' => ['dir'],
        'read_roots' => ['C:\nope'],
        'write_roots' => ['C:\nope'],
    ]],
];
$res = Backup::importBundle($tmp, $foreign);
ok($res['success'], 'a foreign backup restores');
same($res['restored'], ['agents', 'sessions', 'models', 'config'], 'restored names every section it touched');
ok($res['token_differs'], 'a different embedded token is reported, not obeyed');
ok(!in_array('providers', $res['restored'], true), 'an unchosen section is not restored');

$after = json_decode(file_get_contents($tmp . DIRECTORY_SEPARATOR . 'state.json'), true);
same($after['slots']['agents'], [['id' => 'remote-agent']], 'restored slots land');
same($after['slots']['providers'], [['id' => 'p1', 'api_key' => 'P1']], 'unrestored slots survive');
same($after['rev'], 8, 'restore bumps the revision from the live state');
ok(!is_file($tmp . DIRECTORY_SEPARATOR . 'sessions' . DIRECTORY_SEPARATOR . 'old.json'),
    'a sessions restore drops the current files first');
ok(is_file($tmp . DIRECTORY_SEPARATOR . 'sessions' . DIRECTORY_SEPARATOR . 'new.json'),
    'and writes the backup files');
same(json_decode(file_get_contents($tmp . DIRECTORY_SEPARATOR . 'sessions' . DIRECTORY_SEPARATOR . 'evil.json'), true)['id'],
    'evil', 'a traversal id is flattened to a safe basename');
ok(!is_file($tmp . DIRECTORY_SEPARATOR . 'evil.json'),
    'and the flattened file cannot escape the sessions directory');
same($res['sessions'], 2, 'both safe sessions counted');

$cfgAfter = json_decode(file_get_contents($cfg), true);
same($cfgAfter['sandbox']['token'], 'LOCAL-TOKEN', 'this copy keeps its own token');
same($cfgAfter['sandbox']['require_token'], true, 'and its own gate');
same($cfgAfter['sandbox']['read_roots'], [$localRoot], 'and its own roots');
same($cfgAfter['sandbox']['allow'], ['dir'], 'while the contents still restore');
same(json_decode(file_get_contents($models), true), [['id' => 'm2', 'name' => 'Two']],
    'the models catalog restores');
ok($res['config_saved'], 'the config write reported');

// --- import: partial choice leaves the rest alone -------------------------------
file_put_contents($tmp . DIRECTORY_SEPARATOR . 'sessions' . DIRECTORY_SEPARATOR . 'keep.json',
    json_encode(['id' => 'keep']));
$res2 = Backup::importBundle($tmp, $foreign, ['providers']);
ok($res2['success'], 'a choice the file does not carry still succeeds');
same($res2['restored'], [], 'nothing restored when the file lacks the choice');
same(array_column($res2['skipped'], 'section'), ['providers'], 'the missing choice is skipped by name');
ok(is_file($tmp . DIRECTORY_SEPARATOR . 'sessions' . DIRECTORY_SEPARATOR . 'keep.json'),
    'sessions untouched when sessions is not restored');
ok(!isset($res2['sessions']), 'no session count when sessions is not restored');
$after2 = json_decode(file_get_contents($tmp . DIRECTORY_SEPARATOR . 'state.json'), true);
same($after2['slots']['agents'], [['id' => 'remote-agent']], 'state untouched when no slot chosen');

// An empty sessions section is still a choice: it means "no sessions".
$res3 = Backup::importBundle($tmp, array_merge($foreign, ['sessions' => []]), ['sessions']);
same($res3['sessions'], 0, 'an empty sessions list restores empty');
ok(!is_file($tmp . DIRECTORY_SEPARATOR . 'sessions' . DIRECTORY_SEPARATOR . 'keep.json'),
    'and the current files go with it');

// --- cleanup -----------------------------------------------------------------------
putenv('ROUTER_CONFIG');
putenv('ROUTER_MODELS');
foreach ((array)@scandir($tmp . DIRECTORY_SEPARATOR . 'sessions') as $entry) {
    if ($entry !== '.' && $entry !== '..') {
        @unlink($tmp . DIRECTORY_SEPARATOR . 'sessions' . DIRECTORY_SEPARATOR . $entry);
    }
}
@rmdir($tmp . DIRECTORY_SEPARATOR . 'sessions');
foreach ((array)@scandir($tmp) as $entry) {
    if ($entry === '.' || $entry === '..') continue;
    $p = $tmp . DIRECTORY_SEPARATOR . $entry;
    if (is_dir($p)) {
        foreach ((array)@scandir($p) as $sub) {
            if ($sub !== '.' && $sub !== '..') @unlink($p . DIRECTORY_SEPARATOR . $sub);
        }
        @rmdir($p);
    } else {
        @unlink($p);
    }
}
@rmdir($tmp);

foreach ($errors as $line) {
    echo $line . "\n";
}
echo "backup: $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
