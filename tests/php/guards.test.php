<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * HTTP guard tests: the router must refuse /tests and /storage.
 *
 * Usage: php tests/php/guards.test.php
 *
 * Starts `php -S 127.0.0.1:<free port> serve.php` from the project root, makes
 * real requests against it, then stops it. Loopback only -- no internet, no curl
 * extension needed (plenty of machines that run the app have none), no access
 * token needed, and it never touches storage/.
 *
 * These are the paths a deploy leaks first: storage/ holds the token and keys
 * (and the session transcripts beside them), tests/ holds dev tooling that is
 * not runtime code, and dotfiles sit in every folder. All must be 403 **with a
 * body that carries nothing**, the refusal must hold for case variants (Windows
 * and macOS resolve /STORAGE/ and /TESTS/ to the real folders) and at any depth
 * (a copy of the app kept inside the web root has its own storage/ with the
 * same keys), and it must not overreach onto paths that merely look similar.
 *
 * Exits 0 on success, 1 on any failure.
 */

$root = dirname(__DIR__, 2);
$pass = 0;
$fail = 0;
$errors = array();

function ok($cond, $name, &$pass, &$fail, &$errors)
{
    if ($cond) {
        $pass++;
    } else {
        $fail++;
        $errors[] = 'FAIL: ' . $name;
    }
}

function same($got, $want, $name, &$pass, &$fail, &$errors)
{
    ok($got === $want, $name . ' (got ' . var_export($got, true) . ', want ' . var_export($want, true) . ')', $pass, $fail, $errors);
}

/**
 * A path that must be refused, and must carry no content when it is.
 *
 * The status alone is not enough: a handler can answer 403 *after* printing the
 * file, and a body of any real size means something leaked. The router's own
 * refusal is the nine-byte "Forbidden" line, so anything longer is a finding.
 */
function refused($base, $path, $label, &$pass, &$fail, &$errors)
{
    $body = '';
    $code = http_status($base . $path, $body);
    ok($code === 403, $label . ' is refused (got ' . var_export($code, true) . ', want 403)', $pass, $fail, $errors);
    ok(strlen($body) < 64 && stripos($body, 'Forbidden') !== false,
        $label . ' leaks no content (body was ' . strlen($body) . ' bytes)', $pass, $fail, $errors);
}

/** Status code of one request; false when nothing answered. */
function http_status($url, &$body = null)
{
    $ctx = stream_context_create(array('http' => array(
        'method' => 'GET',
        'ignore_errors' => true,   // a 403 must come back as 403, not as false
        'timeout' => 5,
    )));
    $body = (string) @file_get_contents($url, false, $ctx);
    if (!isset($http_response_header) || !$http_response_header) {
        return false;
    }
    foreach ($http_response_header as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
            return (int) $m[1];
        }
    }
    return 0;
}

/** Just the code, for the table of refused paths. */
function http_code($url)
{
    $unused = null;
    return http_status($url, $unused);
}

/** A port nobody is using right now. */
function free_port()
{
    $sock = @stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
    if (!$sock) {
        return 0;
    }
    $name = stream_socket_get_name($sock, false);
    fclose($sock);
    $pos = strrpos($name, ':');
    return $pos === false ? 0 : (int) substr($name, $pos + 1);
}

echo "HTTP guard tests\n";
echo str_repeat('-', 60) . "\n";

if (!function_exists('proc_open')) {
    echo "  SKIP: proc_open is disabled, cannot start a test server\n";
    echo "0 passed, 0 failed\n";
    exit(0);
}

$log = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'router-guards-' . getmypid() . '.log';
$proc = null;
$base = null;

$stop = function () use (&$proc, $log) {
    if (is_resource($proc)) {
        @proc_terminate($proc);
        @proc_close($proc);
        $proc = null;
    }
    if (is_file($log)) {
        @unlink($log);
    }
};
// A fatal error or an early exit must not leave a server on the port.
register_shutdown_function($stop);

// Two attempts: the port picked above is free, but another process can take it
// in between, and a busy port is environmental, not a failure of the guards.
for ($attempt = 1; $attempt <= 2 && $base === null; $attempt++) {
    $port = free_port();
    if (!$port) {
        break;
    }
    $cmd = array(PHP_BINARY, '-S', '127.0.0.1:' . $port, $root . DIRECTORY_SEPARATOR . 'serve.php');
    $descriptors = array(1 => array('file', $log, 'a'), 2 => array('file', $log, 'a'));
    $proc = @proc_open($cmd, $descriptors, $pipes, $root);
    if (!is_resource($proc)) {
        continue;
    }
    $candidate = 'http://127.0.0.1:' . $port;
    $deadline = microtime(true) + 6.0;
    while (microtime(true) < $deadline) {
        $code = http_code($candidate . '/');
        if ($code !== false) {
            $base = $candidate;
            break;
        }
        usleep(100000);
    }
    if ($base === null) {
        $stop();
    }
}

if ($base === null) {
    echo "  SKIP: could not start serve.php on a loopback port\n";
    if (is_file($log)) {
        foreach (array_slice(explode("\n", (string) @file_get_contents($log)), 0, 4) as $line) {
            if (trim($line) !== '') {
                echo '        ' . trim($line) . "\n";
            }
        }
    }
    echo "0 passed, 0 failed\n";
    exit(0);
}

try {
    // --- dev tooling, in every spelling -----------------------------------
    $blocked = array(
        '/tests/js/run.mjs' => 'the JS runner',
        '/tests/js/stripToolCall.test.mjs' => 'a JS test',
        '/tests/php/run.php' => 'the PHP runner',
        '/tests/php/guards.test.php' => 'this test itself',
        '/tests' => 'the bare tests folder',
        '/tests/' => 'the tests folder',
        '/TESTS/js/run.mjs' => 'a case variant of the tests folder',
        '/Tests/php/run.php' => 'a mixed-case tests folder',

        // --- storage and its neighbours -----------------------------------
        '/storage/state.json' => 'the state bundle',
        '/storage/config.json' => 'the config (token + keys)',
        '/storage' => 'the bare storage folder',
        '/storage/' => 'the storage folder',
        '/storage/sessions/' => 'the sessions folder',
        '/storage/sessions/nope.json' => 'a missing session transcript',
        '/storage/config.json.bak' => 'a backup left in storage',
        '/STORAGE/state.json' => 'a case variant of storage',

        // The update feature's own working folder. Every one of these is a
        // REAL file on a machine that has checked for a release or staged a
        // download: plan.json lists the operator's whole file tree, check.json
        // their version, and staging/ is a full copy of the app. Being one
        // directory deeper than the storage rule's usual examples, they are
        // exactly the sort of path a narrowed rule would start serving.
        '/storage/updates/check.json' => 'the update check cache',
        '/storage/updates/plan.json' => 'a staged update plan',
        '/storage/updates/pending.zip' => 'a downloaded release archive',
        '/storage/updates/staging/index.html' => 'a staged copy of the app',
        '/storage/updates/' => 'the update folder itself',

        // --- the same names at any depth ----------------------------------
        // Dropping a copy of the app inside the web root (an archive of an
        // older version, a backup taken before a redesign) brings its own
        // storage/ with the same config, token and sessions in it. A rule that
        // only looked at the ROOT path served those files happily, so each of
        // these must be refused too -- the check is on the path, not on what
        // happens to exist on disk.
        '/a-copy-of-the-app/storage/config.json' => 'keys in a nested copy of the app',
        '/A-COPY-OF-THE-APP/STORAGE/config.json' => 'a nested case variant',
        '/backup/2026/storage/sessions/nope.json' => 'a nested session transcript',
        '/docs/backup/tests/js/run.mjs' => 'nested dev tooling',

        // --- the other runtime dirs the router refuses --------------------
        '/logs/' => 'the logs folder',
        '/logs/app.log' => 'a log file',
        '/tmp/' => 'the tmp folder',
        '/sessions/' => 'the sessions folder at the root',
        '/sessions/xyz.json' => 'a session file at the root',
    );
    foreach ($blocked as $path => $label) {
        refused($base, $path, $label, $pass, $fail, $errors);
    }

    // A real session transcript, by its real name: the strongest version of the
    // rule, skipped cleanly on a checkout that has no sessions yet.
    $transcripts = glob($root . '/storage/sessions/*.json');
    if ($transcripts) {
        refused($base, '/storage/sessions/' . basename($transcripts[0]),
            'a real session transcript', $pass, $fail, $errors);
    } else {
        echo "  SKIP: no storage/sessions/*.json to request\n";
    }

    // --- dotfiles: the rule that covers .htaccess, .env, .git, .htpasswd ---
    $dotfiles = array(
        '/.htaccess' => 'the root .htaccess',
        '/.htpasswd' => 'the password file',
        '/.gitattributes' => 'a root dotfile',
        '/.env' => 'an env file (missing on disk, still refused)',
        '/.git/config' => 'a .git directory',
        '/storage/.htaccess' => 'the storage deny file',
        '/tests/.htaccess' => 'the tests deny file',
        '/api/.htaccess' => 'the api deny file',
        '/tests/js/.hidden.mjs' => 'a dotfile inside a refused folder',
    );
    foreach ($dotfiles as $path => $label) {
        refused($base, $path, $label, $pass, $fail, $errors);
    }

    // --- what must keep working -------------------------------------------
    // Content, not just 200: the router answers unknown paths with the app
    // entry, so a code alone would still pass if a real file stopped serving.
    $body = '';
    same(http_status($base . '/', $body), 200, 'the app entry still serves', $pass, $fail, $errors);
    ok(strpos($body, 'Autonomous Loop Studio') !== false, 'the entry is the real index.html', $pass, $fail, $errors);

    $body = '';
    same(http_status($base . '/ui/js/store.js', $body), 200, 'a UI module still serves', $pass, $fail, $errors);
    ok(strpos($body, 'APP_VERSION') !== false, 'the module is the real store.js', $pass, $fail, $errors);

    $body = '';
    same(http_status($base . '/ui/css/base.css', $body), 200, 'a stylesheet still serves', $pass, $fail, $errors);
    ok(strpos($body, '{') !== false && strpos($body, 'Autonomous Loop Studio') === false,
        'the stylesheet is the real base.css, not the HTML fallback', $pass, $fail, $errors);

    // API routes are endpoints, not files. /api/sessions is the session LIST, and
    // refusing it because "sessions" looks like the storage folder made the sidebar
    // report "API 403: the server sent a web page instead of JSON".
    foreach (array('/api', '/api/sessions', '/api/config', '/api/state') as $path) {
        $body = '';
        $code = http_status($base . $path, $body);
        ok($code !== 403, 'the API route ' . $path . ' is not refused (got ' . var_export($code, true) . ')',
            $pass, $fail, $errors);
        // The guard's page is exactly "Forbidden\n". Searching for the word
        // anywhere would fail on real data: session transcripts contain agent
        // output that talks about HTTP 403s.
        ok(trim($body) !== 'Forbidden',
            'the API route ' . $path . ' is not answered with the guard page', $pass, $fail, $errors);
    }

    // Prefix matching must not become a blunt "starts with tests" filter.
    same(http_code($base . '/testsuite/missing'), 200,
        'a path that only starts with "tests" is not blocked', $pass, $fail, $errors);
    // Nor may the dotfile rule fire on a dot that is merely part of a filename.
    same(http_code($base . '/ui/index.html'), 200,
        'a dot inside a filename is not a dotfile', $pass, $fail, $errors);
} finally {
    $stop();
}

echo str_repeat('-', 60) . "\n";
if ($fail) {
    echo implode("\n", $errors) . "\n";
    echo "{$fail} failed, {$pass} passed\n";
    exit(1);
}
echo "{$pass} passed, 0 failed\n";
