<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Apache guard tests: the shipped .htaccess files must deny /tests and /storage.
 *
 * Usage: php tests/php/apacheGuards.test.php
 *
 * guards.test.php proves serve.php's own router refuses those folders. This one
 * proves the OTHER serving mode: it boots the local Apache on a free loopback
 * port with this project as DocumentRoot and `AllowOverride All`, so the real
 * tests/.htaccess and storage/.htaccess are the things under test.
 *
 * Skips (exit 0, printing SKIP) when there is no Apache to boot -- nginx and
 * serve.php deployments are covered elsewhere, and a machine without XAMPP is
 * not a failure. Set ROUTER_HTTPD to the binary to point it at a specific one.
 *
 * Loopback only, no token needed, nothing written outside the system temp dir.
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

/** Status code of one request, plus its body. false when nothing answered. */
function http_status($url, &$body = null)
{
    $ctx = stream_context_create(array('http' => array(
        'method' => 'GET',
        'ignore_errors' => true,
        'timeout' => 8,
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

/**
 * A path Apache must deny, carrying none of the file it was asked for.
 *
 * Apache answers with its own HTML error page, so the body check is "does not
 * contain this file's content", not "is tiny" as in guards.test.php.
 */
function denied($base, $path, $label, $leak, &$pass, &$fail, &$errors)
{
    $body = '';
    $code = http_status($base . $path, $body);
    ok($code === 403, $label . ' is denied (got ' . var_export($code, true) . ', want 403)', $pass, $fail, $errors);
    ok(stripos($body, $leak) === false, $label . ' leaks no content', $pass, $fail, $errors);
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

/**
 * The Apache binary: ROUTER_HTTPD, the usual XAMPP spots, then PATH.
 *
 * ROUTER_HTTPD is authoritative when set: pointing it at a missing binary skips
 * the test rather than quietly testing whatever Apache happens to be installed,
 * so "I pointed it at MY Apache" can never mean "it checked a different one".
 */
function find_httpd()
{
    $env = getenv('ROUTER_HTTPD');
    if ($env !== false && trim($env) !== '') {
        return (is_file($env) && is_executable($env)) ? $env : null;
    }
    $candidates = array(
        'C:/xampp/apache/bin/httpd.exe',
        'C:/Apache24/bin/httpd.exe',
        '/opt/lampp/bin/httpd',
        '/usr/sbin/apache2',
        '/usr/sbin/httpd',
        '/usr/local/apache2/bin/httpd',
        '/usr/local/bin/httpd',
    );
    foreach ($candidates as $path) {
        if (is_file($path) && is_executable($path)) {
            return $path;
        }
    }
    $which = @shell_exec('command -v httpd 2>/dev/null');
    if ($which && trim($which) !== '') {
        return trim(explode("\n", trim($which))[0]);
    }
    return null;
}

echo "Apache guard tests\n";
echo str_repeat('-', 60) . "\n";

$httpd = find_httpd();
if (!$httpd) {
    echo "  SKIP: no Apache binary found (set ROUTER_HTTPD to one)\n";
    echo "0 passed, 0 failed\n";
    exit(0);
}
if (!function_exists('proc_open')) {
    echo "  SKIP: proc_open is disabled, cannot start Apache\n";
    echo "0 passed, 0 failed\n";
    exit(0);
}

// XAMPP layout: <serverroot>/bin/httpd[.exe]. Modules live in <serverroot>/modules.
$serverRoot = dirname(dirname($httpd));
$modulesDir = $serverRoot . '/modules';

$tmp = sys_get_temp_dir();
$stamp = getmypid() . '-' . substr(md5(uniqid('', true)), 0, 6);
$conf = $tmp . DIRECTORY_SEPARATOR . 'router-apache-' . $stamp . '.conf';
$errorLog = $tmp . DIRECTORY_SEPARATOR . 'router-apache-' . $stamp . '-error.log';
$accessLog = $tmp . DIRECTORY_SEPARATOR . 'router-apache-' . $stamp . '-access.log';

// Only what the shipped .htaccess files need. A module that is compiled into the
// binary instead of shipped as a .so must NOT be loaded again ("module already
// loaded" is fatal), so each one is added only when its file exists.
$modules = array(
    'authz_core_module' => 'mod_authz_core.so',
    'authz_host_module' => 'mod_authz_host.so',
    'alias_module' => 'mod_alias.so',
    'dir_module' => 'mod_dir.so',
    'mime_module' => 'mod_mime.so',
    'rewrite_module' => 'mod_rewrite.so',
    'headers_module' => 'mod_headers.so',
);
$loadLines = '';
foreach ($modules as $name => $file) {
    if (is_file($modulesDir . '/' . $file)) {
        $loadLines .= 'LoadModule ' . $name . ' modules/' . $file . "\n";
    }
}

$docRoot = str_replace('\\', '/', $root);
$serverRootConf = str_replace('\\', '/', $serverRoot);

// Apache reads .htaccess files ABOVE DocumentRoot as well as below it. That is
// harmless for a normal install, but this app is sometimes copied INTO another
// copy of itself (a clean distributable sitting inside the live app), and then
// the enclosing app's .htaccess is parsed in this server's context -- where its
// server-only directives are illegal. Every request in the document root then
// answers 500 ("<IfModule not allowed here") and says nothing at all about the
// files under test. Pin each ancestor to AllowOverride None so only the shipped
// .htaccess files -- root, storage/ and tests/ below -- are in play.
$ancestors = '';
$parent = dirname($docRoot);
while (strlen($parent) > 3 && $parent !== '.' && $parent !== '/') {
    $ancestors .= '<Directory "' . $parent . '">' . "\n"
        . '    AllowOverride None' . "\n"
        . '</Directory>' . "\n";
    $next = dirname($parent);
    if ($next === $parent) { break; }
    $parent = $next;
}
$config = 'ServerRoot "' . $serverRootConf . "\"\n"
    . 'Listen 127.0.0.1:__PORT__' . "\n"
    . 'ServerName 127.0.0.1:__PORT__' . "\n"
    . 'PidFile "' . str_replace('\\', '/', $tmp) . '/router-apache-' . $stamp . '.pid"' . "\n"
    . 'ErrorLog "' . str_replace('\\', '/', $errorLog) . '"' . "\n"
    . $loadLines
    . 'DocumentRoot "' . $docRoot . '"' . "\n"
    . $ancestors
    . '<Directory "' . $docRoot . '">' . "\n"
    . '    Options FollowSymLinks' . "\n"
    . '    AllowOverride All' . "\n"
    . '    Require all granted' . "\n"
    . '</Directory>' . "\n";

$proc = null;
$base = null;
$confPath = null;
$pidPath = $tmp . DIRECTORY_SEPARATOR . 'router-apache-' . $stamp . '.pid';

$stop = function () use (&$proc, $conf, $errorLog, $accessLog, $pidPath) {
    if (is_resource($proc)) {
        @proc_terminate($proc);
        @proc_close($proc);
        $proc = null;
    }
    foreach (array($conf, $errorLog, $accessLog, $pidPath) as $file) {
        if (is_file($file)) {
            @unlink($file);
        }
    }
};
register_shutdown_function($stop);

// Two attempts at a free port, same as guards.test.php: a port taken in the
// moment between asking and binding is environmental, not a failure.
for ($attempt = 1; $attempt <= 2 && $base === null; $attempt++) {
    $port = free_port();
    if (!$port) {
        break;
    }
    $confPath = $conf;
    if (@file_put_contents($confPath, str_replace('__PORT__', (string) $port, $config)) === false) {
        $confPath = null;
        break;
    }
    $descriptors = array(1 => array('file', $accessLog, 'a'), 2 => array('file', $errorLog, 'a'));
    $proc = @proc_open(array($httpd, '-f', $confPath), $descriptors, $pipes, $serverRoot);
    if (!is_resource($proc)) {
        continue;
    }
    $candidate = 'http://127.0.0.1:' . $port;
    $deadline = microtime(true) + 10.0;
    while (microtime(true) < $deadline) {
        if (http_status($candidate . '/') !== false) {
            $base = $candidate;
            break;
        }
        if (!is_resource($proc) || proc_get_status($proc)['running'] === false) {
            break;
        }
        usleep(150000);
    }
    if ($base === null) {
        $stop();
    }
}

if ($base === null) {
    echo "  SKIP: Apache would not start with a generated config\n";
    foreach (array_slice(explode("\n", (string) @file_get_contents($errorLog)), 0, 4) as $line) {
        if (trim($line) !== '') {
            echo '        ' . trim($line) . "\n";
        }
    }
    $stop();
    echo "0 passed, 0 failed\n";
    exit(0);
}

try {
    // --- the dev-tooling folder -------------------------------------------
    denied($base, '/tests/js/run.mjs', 'the JS runner', 'stripToolCall', $pass, $fail, $errors);
    denied($base, '/tests/js/stripToolCall.test.mjs', 'a JS test', 'import {', $pass, $fail, $errors);
    denied($base, '/tests/php/run.php', 'the PHP runner', '<?php', $pass, $fail, $errors);
    denied($base, '/tests/php/apacheGuards.test.php', 'this test itself', 'proc_open', $pass, $fail, $errors);
    denied($base, '/tests/.htaccess', 'the tests deny file', 'Require all denied', $pass, $fail, $errors);

    foreach (array('/tests', '/tests/') as $path) {
        $code = http_status($base . $path);
        ok($code === 403, $path . ' is denied (got ' . var_export($code, true) . ', want 403)', $pass, $fail, $errors);
    }

    // Case variants resolve to the same folder on Windows and macOS. Where the
    // filesystem is case-sensitive (Linux) Apache answers 404 instead, which is
    // also a refusal -- so accept either.
    foreach (array('/Tests/js/run.mjs', '/TESTS/') as $path) {
        $code = http_status($base . $path);
        ok($code === 403 || $code === 404,
            $path . ' is refused (got ' . var_export($code, true) . ', want 403 or 404)', $pass, $fail, $errors);
    }

    // --- storage ----------------------------------------------------------
    denied($base, '/storage/state.json', 'the state bundle', '"agents"', $pass, $fail, $errors);
    denied($base, '/storage/config.json', 'the config (token + keys)', 'apiKey', $pass, $fail, $errors);
    denied($base, '/storage/.htaccess', 'the storage deny file', 'Require all denied', $pass, $fail, $errors);
    foreach (array('/storage', '/storage/', '/storage/sessions/') as $path) {
        $code = http_status($base . $path);
        ok($code === 403, $path . ' is denied (got ' . var_export($code, true) . ', want 403)', $pass, $fail, $errors);
    }

    // --- the repository itself -------------------------------------------
    //
    // The app root IS the checkout now, so .git/ sits in the web root and Apache
    // serves any file in it it can read: `.git/config` can carry a credentialed
    // remote URL, and `.git/objects` reconstructs every file ever committed --
    // including one removed later for holding a secret. serve.php and nginx have
    // always refused dotfiles; Apache did not, and this file is the only place
    // that would have noticed. Measured before the rule existed: 200, with the
    // real `[core]` section as the body.
    denied($base, '/.git/config', 'the repository config', '[core]', $pass, $fail, $errors);
    denied($base, '/.git/HEAD', 'the repository HEAD', 'ref:', $pass, $fail, $errors);
    denied($base, '/.gitignore', 'the ignore file', 'storage/config.json', $pass, $fail, $errors);
    foreach (array('/.git', '/.git/', '/.git/objects/', '/.git/objects/pack/') as $path) {
        $code = http_status($base . $path);
        ok($code === 403, $path . ' is denied (got ' . var_export($code, true) . ', want 403)', $pass, $fail, $errors);
    }
    // The dot rule is on the SEGMENT, at any depth -- a clone made inside a copy
    // of the app would otherwise sit behind the same door.
    $code = http_status($base . '/any-copy/.git/config');
    ok($code === 403, 'a nested .git is denied (got ' . var_export($code, true) . ', want 403)', $pass, $fail, $errors);
    // ...but not on a dot that is merely part of a filename, or on the ACME
    // folder, which is the one dot-directory that has to stay reachable or
    // certificate renewal breaks. 404 is expected: the file does not exist.
    $code = http_status($base . '/.well-known/acme-challenge/token');
    ok($code !== 403, 'the ACME folder is not refused (got ' . var_export($code, true) . ')', $pass, $fail, $errors);

    // --- a second copy of the app kept inside the web root ----------------
    //
    // The archive at the repo root is reference material, and it carries its own
    // storage/.htaccess -- but its tests/ predates tests/.htaccess, so it has
    // none. A rule that only denied the app's own folders left that copy's
    // tooling (and every other nested copy's) readable. Skipped on a checkout
    // that does not have the archive.
    $copyName = 'the-copy-before-the-huge-ui-change';
    if (is_dir($root . '/' . $copyName . '/storage')) {
        denied($base, '/' . $copyName . '/storage/config.json',
            'the nested config (token + keys)', 'apiKey', $pass, $fail, $errors);
        denied($base, '/' . $copyName . '/storage/state.json',
            'the nested state bundle', '"agents"', $pass, $fail, $errors);
        foreach (array('/' . $copyName . '/storage', '/' . $copyName . '/storage/') as $path) {
            $code = http_status($base . $path);
            ok($code === 403, $path . ' is denied (got ' . var_export($code, true) . ', want 403)', $pass, $fail, $errors);
        }
        // Real files from that copy: it predates tests/run.mjs and tests/.htaccess,
        // which is exactly why a root-only rule left it readable.
        denied($base, '/' . $copyName . '/tests/php/sandbox.test.php',
            'nested PHP tooling', '<?php', $pass, $fail, $errors);
        denied($base, '/' . $copyName . '/tests/js/context.test.mjs',
            'nested JS tooling', 'import', $pass, $fail, $errors);
        foreach (array('/' . $copyName . '/tests', '/' . $copyName . '/tests/') as $path) {
            $code = http_status($base . $path);
            ok($code === 403, $path . ' is denied (got ' . var_export($code, true) . ', want 403)', $pass, $fail, $errors);
        }

        // The guard is case-insensitive: on Windows/macOS these resolve to the
        // real folder, and on Linux Apache answers 404, which is also a refusal.
        $code = http_status($base . '/' . strtoupper($copyName) . '/tests/php/sandbox.test.php');
        ok($code === 403 || $code === 404,
            'an upper-case nested tooling path is refused (got ' . var_export($code, true) . ')', $pass, $fail, $errors);

        // The cookie jar under browser-profile/ has no extension, so nothing but
        // the folder rule protects it.
        if (is_dir($root . '/' . $copyName . '/storage/browser-profile')) {
            $code = http_status($base . '/' . $copyName . '/storage/browser-profile/Cookies');
            ok($code === 403 || $code === 404,
                'a nested cookie jar is refused (got ' . var_export($code, true) . ')', $pass, $fail, $errors);
        }
    } else {
        echo "  SKIP: no nested copy of the app at " . $copyName . "\n";
    }

    // --- what must keep working -------------------------------------------
    $body = '';
    $code = http_status($base . '/', $body);
    ok($code === 200, 'the app entry still serves (got ' . var_export($code, true) . ')', $pass, $fail, $errors);
    ok(strpos($body, 'Autonomous Loop Studio') !== false, 'the entry is the real index.html', $pass, $fail, $errors);

    $body = '';
    $code = http_status($base . '/ui/js/store.js', $body);
    ok($code === 200, 'a UI module still serves (got ' . var_export($code, true) . ')', $pass, $fail, $errors);
    ok(strpos($body, 'APP_VERSION') !== false, 'the module is the real store.js', $pass, $fail, $errors);

    // API routes are endpoints, not files: /api/sessions lists sessions, and a
    // rule that read that as the storage folder answered 403 to the sidebar.
    foreach (array('/api/index.php', '/api/sessions', '/api/config') as $path) {
        $code = http_status($base . $path);
        ok($code !== 403, 'the API route ' . $path . ' is not refused (got ' . var_export($code, true) . ')',
            $pass, $fail, $errors);
    }

    // The .htaccess must not become a blunt filter on names that merely start
    // with (or contain) a guarded word. (Without a PHP handler this Apache may
    // answer the app rewrite with 200, 404 or 500 -- anything but 403 is fine.)
    foreach (array('/testsuite/missing', '/ui/js/tests.js', '/ui/js/storage.js',
                   '/ui/js/sessionstore.js', '/storagelike/missing') as $path) {
        $code = http_status($base . $path);
        ok($code !== 403, $path . ' is not blocked (got ' . var_export($code, true) . ')', $pass, $fail, $errors);
    }

    // And a real asset inside a nested copy still loads, so the rule is about the
    // data folders, not about the copy as a whole.
    if (is_dir($root . '/' . $copyName . '/ui')) {
        $code = http_status($base . '/' . $copyName . '/ui/js/store.js');
        ok($code === 200,
            'a nested copy\'s UI module still serves (got ' . var_export($code, true) . ')', $pass, $fail, $errors);
    }
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
