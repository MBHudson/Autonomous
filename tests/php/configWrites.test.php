<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Config write test: what a save or a restore is allowed to change.
 *
 * Usage: php tests/php/configWrites.test.php
 *
 * Two doors write storage/config.json -- the Config panel (PUT /config) and a
 * backup restore (POST /import) -- and both used to write the payload verbatim.
 * That is how a LAN-reachable install lost its access token and its gate: an
 * import carrying a config from another machine simply did not mention
 * `require_token`, and the gate went off with no error anywhere. The same
 * import pointed `read_roots`/`write_roots` at /var/www/... on a Windows host,
 * so every file tool was scoped to a directory that does not exist.
 *
 * What is asserted here, and has to hold together:
 *
 *   * a payload that does not MENTION `require_token` or `token` keeps the ones
 *     on disk -- absent means "not changing this", never "clear it";
 *   * an explicit value is still obeyed, including `require_token: false` and an
 *     empty token: turning the gate off is a decision, and setup-token.sh --off
 *     still works;
 *   * an import cannot disarm a gate, install a token from another machine, or
 *     adopt absolute roots that do not exist here, while everything else in the
 *     archive is still restored verbatim;
 *   * an imported root that DOES exist here is kept, so this is a check on
 *     reality rather than a blanket refusal to restore roots.
 *
 * ROUTER_CONFIG points every write at a throwaway file, so the operator's own
 * storage/config.json is never read or written. No server is started: these are
 * the two functions both routes call.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

require_once __DIR__ . '/../../autoload.php';

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

function same($got, $want, $name)
{
    global $pass, $fail, $errors;
    if ($got === $want) {
        $pass++;
    } else {
        $fail++;
        $errors[] = 'FAIL: ' . $name
            . ' (got ' . var_export($got, true) . ', want ' . var_export($want, true) . ')';
    }
}

/** The config on disk, decoded. */
function onDisk($path)
{
    return json_decode((string)@file_get_contents($path), true);
}

$tmp = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'router-cfgwrites-' . getmypid() . '-' . bin2hex(random_bytes(4));
$cfg = $tmp . DIRECTORY_SEPARATOR . 'config.json';
$localRoot = $tmp . DIRECTORY_SEPARATOR . 'sandbox';
$otherRoot = $tmp . DIRECTORY_SEPARATOR . 'elsewhere';
if (!@mkdir($localRoot, 0777, true) || !@mkdir($otherRoot, 0777, true)) {
    fwrite(STDERR, "FAIL: could not create the temp tree at $tmp\n");
    exit(1);
}
// Set before the first call: Config::configPath() reads it live.
putenv('ROUTER_CONFIG=' . $cfg);

$gateOn = ['require_token' => true, 'token' => 'LOCAL-TOKEN'];

// --- 1. a payload with no gate keys keeps the gate ---------------------------------
same(
    Config::saveConfig(['theme' => 'neon', 'sandbox' => $gateOn + [
        'read_roots' => [$localRoot], 'write_roots' => [$localRoot],
    ]]),
    true,
    'a first save writes the config'
);
$disk = onDisk($cfg);
same($disk['sandbox']['require_token'] ?? null, true, 'the first save stores require_token true');
same($disk['sandbox']['token'] ?? null, 'LOCAL-TOKEN', 'the first save stores the token');

same(Config::saveConfig(['theme' => 'solar', 'sandbox' => ['exec_timeout' => 30]]), true, 'a second save writes');
$disk = onDisk($cfg);
same($disk['sandbox']['require_token'] ?? null, true, 'a save that omits require_token leaves the gate armed');
same($disk['sandbox']['token'] ?? null, 'LOCAL-TOKEN', 'a save that omits the token keeps it');
same($disk['theme'] ?? null, 'solar', 'everything else in the payload is still written');
same($disk['sandbox']['exec_timeout'] ?? null, 30, 'new keys in the payload still land');
same($disk['sandbox']['read_roots'] ?? null, [$localRoot], 'a save that omits the read roots keeps them');
same($disk['sandbox']['write_roots'] ?? null, [$localRoot], 'a save that omits the write roots keeps them');

// An explicit empty list is a decision: it still clears them.
Config::saveConfig(['sandbox' => ['read_roots' => [], 'write_roots' => [], 'require_token' => true, 'token' => 'LOCAL-TOKEN']]);
same(onDisk($cfg)['sandbox']['read_roots'] ?? null, [], 'an explicit empty root list still clears it');

// --- 2. an explicit decision is still obeyed ---------------------------------------
Config::saveConfig(['sandbox' => ['require_token' => false, 'token' => 'LOCAL-TOKEN']]);
same(onDisk($cfg)['sandbox']['require_token'] ?? null, false, 'an explicit require_token:false turns the gate off');

Config::saveConfig(['sandbox' => ['require_token' => true, 'token' => '']]);
same(onDisk($cfg)['sandbox']['token'] ?? null, '', 'an explicit empty token clears it');

// Re-arm and re-seed the roots the way a real install looks.
Config::saveConfig(['theme' => 'solar', 'sandbox' => $gateOn + [
    'read_roots' => [$localRoot], 'write_roots' => [$localRoot],
]]);
$current = Config::loadConfig();
same($current['sandbox']['require_token'] ?? null, true, 'the install is armed again for the import checks');

// --- 3. an import from another machine cannot change these -------------------------
$backupConfig = ['sandbox' => [
    'require_token'  => false,          // the machine it came from had the gate off
    'token'          => 'FOREIGN-TOKEN',
    'read_roots'     => ['/var/www/illegalwebsite.com/sandbox'],
    'write_roots'    => ['/var/www/illegalwebsite.com/sandbox'],
    'exec_timeout'   => 5,
    'exec_enabled'   => true,
]];
[$clean, $notes] = Config::sanitizeImportedConfig($backupConfig, $current);
same($clean['sandbox']['require_token'] ?? null, true, 'an import cannot disarm the access-token gate');
same($clean['sandbox']['token'] ?? null, 'LOCAL-TOKEN', 'an import cannot replace the token devices already hold');
same($clean['sandbox']['read_roots'] ?? null, [$localRoot], 'a read root from another OS is replaced by this machine\'s own');
same($clean['sandbox']['write_roots'] ?? null, [$localRoot], 'a write root from another OS is replaced by this machine\'s own');
same($clean['sandbox']['exec_timeout'] ?? null, 5, 'the rest of the backup config is still restored');
same($clean['sandbox']['exec_enabled'] ?? null, true, 'and its feature flags come back as they were');
ok(count($notes) >= 2, 'the import reports which settings it kept locally');

// The sanitised config has to survive the real writer too, not just the helper.
same(Config::saveConfig($clean), true, 'the sanitised config writes through saveConfig');
$disk = onDisk($cfg);
same($disk['sandbox']['require_token'] ?? null, true, 'and the gate is still armed on disk afterwards');
same($disk['sandbox']['read_roots'] ?? null, [$localRoot], 'and the roots on disk are this machine\'s');

// --- 4. roots are this machine's while it has any, even if the path exists ----------
[$mixed, ] = Config::sanitizeImportedConfig(
    ['sandbox' => ['read_roots' => [$otherRoot, '/var/www/illegalwebsite.com/sandbox']]],
    Config::loadConfig()
);
same($mixed['sandbox']['read_roots'] ?? null, [$localRoot], 'an import cannot retarget roots, even at a path that exists here');
[$mixed2, ] = Config::sanitizeImportedConfig(
    ['sandbox' => ['write_roots' => [$otherRoot . DIRECTORY_SEPARATOR . 'nope']]],
    Config::loadConfig()
);
same($mixed2['sandbox']['write_roots'] ?? null, [$localRoot], 'a write root from a backup does not replace this machine\'s');

// --- 4b. a fresh install with no roots of its own adopts the usable ones ------------
$absent = $tmp . DIRECTORY_SEPARATOR . 'does-not-exist';
[$adopt, $adoptNotes] = Config::sanitizeImportedConfig(
    ['sandbox' => ['read_roots' => [$otherRoot, $absent]]],
    []
);
same($adopt['sandbox']['read_roots'] ?? null, [$otherRoot], 'a fresh install adopts an imported root that exists here');
ok(
    (bool)array_filter($adoptNotes, fn($n) => strpos((string)$n, 'does-not-exist') !== false),
    'and reports the imported root it could not use'
);

// --- 5. a backup with no roots does not blank the local ones ------------------------
[$empty, ] = Config::sanitizeImportedConfig(['sandbox' => ['read_roots' => []]], Config::loadConfig());
same($empty['sandbox']['read_roots'] ?? null, [$localRoot], 'a backup with no roots keeps this machine\'s');

// --- 6. a fresh machine is not armed by somebody else's backup ----------------------
[$fresh, ] = Config::sanitizeImportedConfig(
    ['sandbox' => ['require_token' => true, 'token' => 'FOREIGN-TOKEN', 'read_roots' => [$localRoot]]],
    []
);
ok(!array_key_exists('require_token', $fresh['sandbox']), 'a backup cannot arm a gate this install never had');
ok(!array_key_exists('token', $fresh['sandbox']), 'nor install a token from another machine');
same($fresh['sandbox']['read_roots'] ?? null, [$localRoot], 'but a root that exists here still restores');

// --- cleanup -----------------------------------------------------------------------
putenv('ROUTER_CONFIG');
foreach ([$localRoot, $otherRoot] as $dir) {
    foreach ((array)@scandir($dir) as $entry) {
        if ($entry !== '.' && $entry !== '..') { @unlink($dir . DIRECTORY_SEPARATOR . $entry); }
    }
    @rmdir($dir);
}
@unlink($cfg);
@rmdir($tmp);

foreach ($errors as $line) {
    echo $line . "\n";
}
echo "configWrites: $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
