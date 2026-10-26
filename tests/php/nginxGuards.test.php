<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * nginx guard tests: the regexes shipped in nginx.example.conf must refuse
 * runtime data, secrets and dev tooling at ANY depth -- and nothing else.
 *
 * Usage: php tests/php/nginxGuards.test.php
 *
 * No nginx needed and none started: nginx matches `location ~` with PCRE, and
 * PHP's preg_* is the same engine, so the rules are read out of the shipped file
 * and run against sample request URIs exactly as nginx would test them. That is
 * the whole point -- nginx ignores .htaccess, so this config IS the guard on
 * that host, and an anchored regex quietly stopped covering a copy of the app
 * kept inside the web root (`/router/<copy>/storage/config.json`, 200).
 *
 * The two directions matter equally:
 *   - every nested / case-variant spelling of storage, logs, tmp, sessions and
 *     tests is refused, along with dotfiles and loose data files;
 *   - real assets are still served, including `ui/js/storage.js` and
 *     `ui/js/tests.js` (names that merely CONTAIN a guarded word) and
 *     `/.well-known/` (the ACME exception in the dotfile rule).
 *
 * Exits 0 on success, 1 on any failure.
 */

$root = dirname(__DIR__, 2);
$confPath = $root . '/nginx.example.conf';

$pass = 0;
$fail = 0;
$skips = 0;
$errors = array();

function ok($cond, $name, &$pass, &$fail, &$errors)
{
    if ($cond) {
        $pass++;
        return true;
    }
    $fail++;
    $errors[] = 'FAIL: ' . $name;
    return false;
}

/**
 * Every regex `location` in the file, in order, as nginx reads them.
 *
 * A prefix location (`location /router/ {`) has different precedence, so one
 * appearing here would mean this test no longer describes the shipped guard;
 * that is reported instead of ignored.
 */
function read_locations($conf)
{
    $out = array();
    $lines = preg_split('/\R/', $conf);
    foreach ($lines as $line) {
        $trim = ltrim($line);
        if ($trim === '' || $trim[0] === '#') continue;
        if (!preg_match('/^location\s+(~\*?)\s+(\S+)\s*\{/', $trim, $m)) continue;
        $out[] = array('regex' => $m[2], 'ci' => $m[1] === '~*');
    }
    return $out;
}

/** nginx: the first matching regex location wins; all of ours answer the same. */
function denied(array $locations, $uri)
{
    foreach ($locations as $loc) {
        $pattern = '#' . $loc['regex'] . '#' . ($loc['ci'] ? 'i' : '');
        if (@preg_match($pattern, $uri) === 1) return true;
    }
    return false;
}

echo "nginx guard tests\n";
echo str_repeat('-', 60) . "\n";

if (!is_file($confPath)) {
    echo "FAIL: nginx.example.conf is missing from the project root\n";
    echo "0 failed, 0 passed\n";
    exit(1);
}

$conf = (string) file_get_contents($confPath);
$locations = read_locations($conf);

ok(count($locations) > 0, 'nginx.example.conf ships at least one regex location rule', $pass, $fail, $errors);

// A prefix location would outrank the regexes in nginx; there are none today,
// and one added later would make this test describe something other than what
// the server does.
$prefix = array();
foreach (preg_split('/\R/', $conf) as $line) {
    $trim = ltrim($line);
    if ($trim === '' || $trim[0] === '#') continue;
    if (preg_match('/^location\s+(?!~)[^\s{]+\s*\{/', $trim)) $prefix[] = trim($line);
}
ok(count($prefix) === 0,
    'no prefix location outranks the regexes' . ($prefix ? ': ' . implode(' | ', array_slice($prefix, 0, 2)) : ''),
    $pass, $fail, $errors);

// ---------------------------------------------------------------- refused
// Everything a deploy leaks first, in the spellings that matter: the real folder,
// the bare folder with and without a slash, case variants (the rule is ~*), a
// copy of the app one or more folders down, dotfiles, and loose data files.
$refused = array(
    // the app's own runtime folders
    '/router/storage/config.json' => 'the config (token + keys)',
    '/router/storage/state.json' => 'the state bundle',
    '/router/storage' => 'the bare storage folder',
    '/router/storage/' => 'the storage folder',
    '/router/storage/sessions/nope.json' => 'a missing session transcript',
    '/router/storage/sessions/' => 'the sessions folder',
    '/router/tests/js/run.mjs' => 'the JS runner',
    '/router/tests/php/guards.test.php' => 'a PHP test',
    '/router/tests' => 'the bare tests folder',
    '/router/tests/' => 'the tests folder',
    '/router/logs/app.log' => 'a log file',
    '/router/tmp/' => 'the tmp folder',
    '/router/sessions/xyz.json' => 'a session file at the root',

    // case variants: Windows/macOS disks resolve these, and the rule is ~*
    '/router/STORAGE/config.json' => 'an upper-case storage folder',
    '/router/TESTS/js/run.mjs' => 'an upper-case tests folder',
    '/router/Docs/TESTS/php/run.php' => 'a mixed-case nested tests folder',

    // a second copy of the app kept inside the web root -- the regression that
    // made this file necessary
    '/router/the-copy-before-the-huge-ui-change/storage/config.json' => 'keys in a nested copy',
    '/router/the-copy-before-the-huge-ui-change/storage' => 'the nested storage folder',
    '/router/old-copy/storage/state.json' => 'a nested state bundle',
    '/router/old-copy/storage/sessions/abc.json' => 'a nested transcript',
    '/router/backup/2026/storage/config.json' => 'keys two folders down',
    '/router/docs/backup/tests/js/run.mjs' => 'nested dev tooling',
    '/router/a/b/c/logs/app.log' => 'a log file three folders down',
    '/router/a/b/c/tmp/' => 'a tmp folder three folders down',

    // dotfiles, which are everywhere
    '/router/.htaccess' => 'a root dotfile',
    '/router/.env' => 'an env file',
    '/router/.git/config' => 'the git folder',
    '/router/storage/.htaccess' => 'the storage deny file',
    '/router/sub/dir/.htpasswd' => 'a nested dotfile',
    '/router/old-copy/tests/js/.hidden.mjs' => 'a dotfile in a nested refused folder',

    // loose data files, at any depth
    '/router/export.json' => 'an export',
    '/router/notes/old.log' => 'a nested log',
    '/router/tools/php.ini' => 'a php.ini',
    '/router/config.json.bak' => 'a backup',
    '/router/db/backup.sql' => 'a database dump',
    '/router/keys/private.pem' => 'a private key',
    '/router/old-copy/secrets/keys.json' => 'a renamed copy\'s key file',
);
foreach ($refused as $uri => $label) {
    ok(denied($locations, $uri), $label . ' is refused (' . $uri . ')', $pass, $fail, $errors);
}

// A real session transcript by its real name: the strongest form of the rule.
$transcripts = glob($root . '/storage/sessions/*.json');
if ($transcripts) {
    $uri = '/router/storage/sessions/' . basename($transcripts[0]);
    ok(denied($locations, $uri), 'a real session transcript is refused', $pass, $fail, $errors);
} else {
    $skips++;
    echo "  SKIP: no storage/sessions/*.json to name\n";
}

// ---------------------------------------------------------------- served
// The other direction, which is just as important: an over-eager pattern that
// caught `storage.js` or `tests.js` would break the app it is meant to protect.
$served = array(
    '/router/' => 'the app itself',
    '/router/index.html' => 'the entry page',
    '/router/ui/js/app.js' => 'a module',
    '/router/ui/js/storage.js' => 'a module whose NAME contains "storage"',
    '/router/ui/js/tests.js' => 'a module whose NAME contains "tests"',
    '/router/ui/js/sessionstore.js' => 'a module whose NAME starts with "session"',
    '/router/ui/css/desktop2026.css' => 'the skin stylesheet',
    '/router/ui/js/components/sidebar.js' => 'a nested module',
    '/router/api' => 'the API root',
    '/router/api/index.php' => 'the API front controller',
    // API routes are endpoints, not files: the UI lists sessions through this
    // one, and matching "sessions" here broke the sidebar.
    '/router/api/sessions' => 'the session list route',
    '/router/api/config' => 'the config route',
    '/router/api/state' => 'the state route',
    '/router/mytests/run.mjs' => 'a folder ending in "tests"',
    '/router/storagelike/config' => 'a folder starting with "storage"',
    '/router/storagex' => 'a path starting with "storage"',
    '/router/old-copy/index.html' => 'a nested copy\'s entry page',
    '/router/.well-known/acme-challenge/token' => 'the ACME exception',
);
foreach ($served as $uri => $label) {
    ok(!denied($locations, $uri), $label . ' is still served (' . $uri . ')', $pass, $fail, $errors);
}

echo str_repeat('-', 60) . "\n";
if ($fail) {
    echo implode("\n", $errors) . "\n";
    echo $fail . ' failed, ' . $pass . ' passed' . ($skips ? ', ' . $skips . ' skipped' : '') . "\n";
    exit(1);
}
echo $pass . ' passed' . ($skips ? ', ' . $skips . ' skipped' : '') . "\n";
