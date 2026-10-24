<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// serve.php — run Loop Studio with no web server:  php -S 127.0.0.1:8080 serve.php
//
// Two jobs in one file, split by SAPI so they can never cross:
//   * CLI ("php serve.php --check ..."): first-run helpers for the launchers.
//     This branch ONLY runs under a real terminal (PHP_SAPI === 'cli'). Under
//     `php -S` the SAPI is 'cli-server', so none of this is reachable from the
//     web, which matters because one of the commands writes the access token.
//   * cli-server: the request router. Replicates what .htaccess does under
//     Apache, because there is no Apache here:
//       - /storage, /logs, /tmp, /sessions and dotfiles: refused (403), always.
//         storage/ holds the access token and API keys; Apache denies it via
//         storage/.htaccess, and this is the equivalent here. Do not relax this.
//       - /api/* (except direct .php): the api/index.php front controller.
//       - anywhere.php except /api/index.php: refused. Under php -S a requested
//         .php file would otherwise execute, including src/ classes.
//       - real files: served with a content type plus the .htaccess cache rules
//         (HTML never cached, JS/CSS revalidated).
//       - everything else: index.html. The single-page fallback (NOT
//         public/index.php, which is the legacy page).
//
// Deliberately PHP 7.0-compatible syntax throughout: the whole point is
// running on whatever PHP the machine already has (7.4+ required by the app
// itself, checked by --check).

// ---------------------------------------------------------------
if (PHP_SAPI === 'cli') {
    $cmd = isset($argv[1]) ? $argv[1] : '--check';

    if ($cmd === '--check') {
        // PHP version first: nothing else matters if this fails.
        if (PHP_VERSION_ID < 70400) {
            fwrite(STDERR, 'PHP 7.4 or newer is required (found ' . PHP_VERSION . ').' . "\n");
            fwrite(STDERR, 'Get it: https://www.php.net/downloads.php' . "\n");
            exit(2);
        }
        $storage = __DIR__ . '/storage';
        if (!is_dir($storage) || !is_writable($storage)) {
            fwrite(STDERR, 'storage/ is missing or not writable.' . "\n");
            exit(3);
        }
        $cfg = read_config();
        $hasToken = is_array($cfg) && isset($cfg['sandbox']['token'])
            && trim((string)$cfg['sandbox']['token']) !== '';
        echo 'PHP=' . PHP_VERSION . "\n";
        echo 'TOKEN=' . ($hasToken ? 'yes' : 'no') . "\n";
        if (!function_exists('curl_init')) {
            // Run after --setup with its -c ini, so this means setup failed.
            fwrite(STDERR, "PHP's curl extension is not enabled: the app could not reach any model.\n");
            fwrite(STDERR, "Run: php serve.php --setup   (it says what is missing)\n");
            exit(4);
        }
        echo "CURL=yes\n";
        echo "OK\n";
        exit(0);
    }

    if ($cmd === '--ensure-token') {
        $cfg = read_config();
        if (!is_array($cfg)) { $cfg = array(); }
        $existing = isset($cfg['sandbox']['token']) ? trim((string)$cfg['sandbox']['token']) : '';
        if ($existing !== '') {
            // Never print an existing token: it may already be pasted into a
            // browser somewhere, and terminal output gets screenshotted.
            echo "TOKEN=exists\n";
            exit(0);
        }
        if (!isset($cfg['sandbox']) || !is_array($cfg['sandbox'])) { $cfg['sandbox'] = array(); }
        try {
            $token = bin2hex(random_bytes(32));
        } catch (Exception $e) {
            fwrite(STDERR, 'Could not generate a token.' . "\n");
            exit(1);
        }
        $cfg['sandbox']['token'] = $token;
        if (file_put_contents(__DIR__ . '/storage/config.json', json_encode($cfg, JSON_PRETTY_PRINT) . "\n") === false) {
            fwrite(STDERR, 'Could not write storage/config.json.' . "\n");
            exit(1);
        }
        echo 'TOKEN=' . $token . "\n";
        exit(0);
    }

    if ($cmd === '--free-port') {
        $want = isset($argv[2]) ? (int)$argv[2] : 8080;
        if ($want < 1 || $want > 65535) { $want = 8080; }
        for ($p = $want; $p < $want + 20; $p++) {
            $fp = @fsockopen('127.0.0.1', $p, $errno, $errstr, 0.2);
            if (!$fp) { echo $p . "\n"; exit(0); }
            fclose($fp);
        }
        fwrite(STDERR, 'No free port near ' . $want . '.' . "\n");
        exit(1);
    }

    if ($cmd === '--setup') {
        exit(runtime_setup(in_array('--quiet', $argv, true)));
    }

    fwrite(STDERR, 'Usage: php serve.php [--check|--setup|--ensure-token|--free-port N]' . "\n");
    exit(1);
}

/**
 * Make THIS php able to run the app, without touching the system php.ini.
 *
 * The usual failure: a PHP with no php.ini (the winget package, a bare zip,
 * Arch's default) has curl switched off, so every model call dies inside the
 * server and the browser can only say "empty response". This works out what
 * is missing and, when anything is, writes storage/php-runtime.ini: the
 * machine's own php.ini (if it has one) plus the extension_dir, the missing
 * extensions and a CA bundle. The launchers then run `php -c` with it and set
 * PHPRC, so child php processes (sandbox code runs) get the same setup.
 *
 * stdout, last line:  PHPINI=<path>   (empty path = this PHP needs nothing)
 * exit 0 ready · 5 curl cannot be enabled (not installed for this PHP)
 */
function runtime_setup($quiet) {
    $say = function ($m) use ($quiet) { if (!$quiet) { fwrite(STDERR, $m . "\n"); } };
    $required = array('curl');
    $optional = array('openssl', 'mbstring', 'fileinfo', 'zip');
    $win = DIRECTORY_SEPARATOR === '\\';
    $iniPath = __DIR__ . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'php-runtime.ini';
    $caFile = __DIR__ . DIRECTORY_SEPARATOR . 'tools' . DIRECTORY_SEPARATOR . 'cacert.pem';

    // Where the extension binaries live. With no php.ini the compiled-in
    // default (C:\php\ext on Windows) is usually wrong, so prefer the folder
    // beside the php binary when it actually holds the modules.
    $modFile = function ($dir, $ext) use ($win) {
        return $dir . DIRECTORY_SEPARATOR . ($win ? 'php_' . $ext . '.dll' : $ext . '.so');
    };
    $extDir = (string)ini_get('extension_dir');
    $besideBinary = dirname(PHP_BINARY) . DIRECTORY_SEPARATOR . 'ext';
    $dirOverride = null;
    if (!is_file($modFile($extDir, 'curl')) && is_dir($besideBinary)) {
        $extDir = $besideBinary;
        $dirOverride = $besideBinary;
    }

    $add = array();
    $missingRequired = array();
    foreach (array_merge($required, $optional) as $ext) {
        if (extension_loaded($ext)) { continue; }
        if (is_file($modFile($extDir, $ext))) {
            $add[] = $ext;
        } elseif (in_array($ext, $required, true)) {
            $missingRequired[] = $ext;
        } else {
            $say("  note: optional PHP extension '$ext' is not installed (some sandbox tools degrade).");
        }
    }

    // A CA bundle, so HTTPS certificate checks pass (search, fetch, MCP...).
    $needCa = trim((string)ini_get('curl.cainfo')) === '' && trim((string)ini_get('openssl.cafile')) === '';
    if ($needCa && !is_file($caFile)) {
        $say('  note: tools/cacert.pem is missing; HTTPS certificate checks may fail.');
        $needCa = false;
    }

    if ($missingRequired) {
        $say('');
        $say('  PHP extension(s) needed but not installed: ' . implode(', ', $missingRequired));
        if ($win) {
            $say('  This PHP has no ' . $modFile($extDir, $missingRequired[0]) . '.');
            $say('  Reinstall PHP (winget install PHP.PHP.8.3) or use setup-xampp.bat.');
        } else {
            $say('  Install them, for example:');
            $say('    Debian/Ubuntu: sudo apt install php-curl');
            $say('    Fedora/RHEL:   sudo dnf install php-common');
            $say('    Arch:          sudo pacman -S php   (then re-run start.sh)');
            $say('    macOS:         brew install php');
        }
        echo "PHPINI=\n";
        return 5;
    }

    if (!$add && !$needCa && !$dirOverride) {
        @unlink($iniPath);
        echo "PHPINI=\n";
        return 0;
    }

    // Start from the machine's own php.ini so nothing it sets is lost (-c
    // replaces the lookup entirely), then layer our additions on top.
    $lines = array('; Generated by serve.php --setup. Safe to delete; it is rebuilt on start.');
    $loaded = php_ini_loaded_file();
    if ($loaded && is_readable($loaded)) {
        $lines[] = '; --- copied from ' . $loaded;
        $lines[] = (string)file_get_contents($loaded);
        $lines[] = '; --- Loop Studio additions';
    }
    if ($dirOverride) { $lines[] = 'extension_dir = "' . $dirOverride . '"'; }
    foreach ($add as $ext) { $lines[] = 'extension=' . $ext; }
    if ($needCa) {
        $lines[] = 'curl.cainfo = "' . $caFile . '"';
        $lines[] = 'openssl.cafile = "' . $caFile . '"';
    }
    if (@file_put_contents($iniPath, implode("\n", $lines) . "\n") === false) {
        $say('  Could not write ' . $iniPath . '.');
        echo "PHPINI=\n";
        return 5;
    }

    // Prove it: a fresh php with the new ini must have curl.
    $probe = escapeshellarg(PHP_BINARY) . ' -c ' . escapeshellarg($iniPath)
        . ' -r ' . escapeshellarg("exit(function_exists('curl_init') ? 0 : 1);");
    $out = array();
    $rc = 1;
    @exec($probe . ($win ? ' 2>NUL' : ' 2>/dev/null'), $out, $rc);
    if ($rc !== 0) {
        $say('  Enabled curl in ' . $iniPath . ' but PHP still cannot load it.');
        $say('  On Windows this usually means the Visual C++ runtime is missing:');
        $say('    winget install Microsoft.VCRedist.2015+.x64');
        echo "PHPINI=\n";
        return 5;
    }
    if ($add) { $say('  Enabled PHP extensions: ' . implode(', ', $add)); }
    if ($needCa) { $say('  Using bundled CA certificates (tools/cacert.pem).'); }
    echo 'PHPINI=' . $iniPath . "\n";
    return 0;
}

function read_config() {
    $raw = @file_get_contents(__DIR__ . '/storage/config.json');
    if (!is_string($raw)) { return null; }
    $d = json_decode($raw, true);
    return is_array($d) ? $d : null;
}

// ---------------------------------------------------------------
// Request router (php -S only; unreachable from the CLI branch above).
$ROOT = __DIR__;
$uri = parse_url(isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/', PHP_URL_PATH);
if (!is_string($uri) || $uri === '') { $uri = '/'; }

// 1. Never serve these, ever.
foreach (array('/storage', '/logs', '/tmp', '/sessions') as $prefix) {
    if ($uri === $prefix || strpos($uri, $prefix . '/') === 0) {
        http_response_code(403);
        header('Content-Type: text/plain');
        echo "Forbidden\n";
        return true;
    }
}
foreach (explode('/', $uri) as $part) {
    if ($part !== '' && $part[0] === '.') {
        http_response_code(403);
        header('Content-Type: text/plain');
        echo "Forbidden\n";
        return true;
    }
}
$lowerUri = strtolower($uri);
if (substr($lowerUri, -4) === '.php' && $uri !== '/api/index.php') {
    http_response_code(403);
    header('Content-Type: text/plain');
    echo "Forbidden\n";
    return true;
}

// 2. API front controller (mirrors api/.htaccess).
if ($uri === '/api' || strpos($uri, '/api/') === 0) {
    require $ROOT . '/api/index.php';
    return true;
}

// 3. Real files, with content type + the .htaccess cache policy.
$disk = $ROOT . $uri;
if (is_dir($disk)) { $disk = rtrim($disk, '/') . '/index.html'; }
// realpath containment: /.. above the root falls through to the app, never
// to the disk outside it.
$real = realpath($disk);
if ($real !== false && is_file($real) && strpos($real, $ROOT) === 0) {
    $ext = strtolower(pathinfo($real, PATHINFO_EXTENSION));
    $types = array(
        'html' => 'text/html; charset=utf-8',
        'js'   => 'text/javascript; charset=utf-8',
        'mjs'  => 'text/javascript; charset=utf-8',
        'css'  => 'text/css; charset=utf-8',
        'json' => 'application/json; charset=utf-8',
        'map'  => 'application/json; charset=utf-8',
        'png'  => 'image/png',
        'jpg'  => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'gif'  => 'image/gif',
        'webp' => 'image/webp',
        'svg'  => 'image/svg+xml',
        'ico'  => 'image/x-icon',
        'txt'  => 'text/plain; charset=utf-8',
        'md'   => 'text/plain; charset=utf-8',
        'woff' => 'font/woff',
        'woff2'=> 'font/woff2',
        'ttf'  => 'font/ttf',
        'otf'  => 'font/otf',
        'eot'  => 'application/vnd.ms-fontobject',
        'mp3'  => 'audio/mpeg',
        'wav'  => 'audio/wav',
        'ogg'  => 'audio/ogg',
    );
    header('Content-Type: ' . (isset($types[$ext]) ? $types[$ext] : 'application/octet-stream'));
    header('X-Content-Type-Options: nosniff');
    if ($ext === 'html' || $ext === 'htm') {
        header('Cache-Control: no-store, no-cache, must-revalidate');
    } elseif ($ext === 'js' || $ext === 'css') {
        header('Cache-Control: no-cache, must-revalidate');
    }
    readfile($real);
    return true;
}

// 4. Single-page fallback: the app entry.
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('X-Content-Type-Options: nosniff');
readfile($ROOT . '/index.html');
return true;
