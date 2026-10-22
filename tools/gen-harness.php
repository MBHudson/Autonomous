<?php
/**
 * gen-harness.php — generate the browser harness table from src/Harness.php.
 *
 * The provider aliases, host matchers, tool-dialect patterns, context limits
 * and default RPM ceilings live in ONE place (src/Harness.php). This writes
 * the browser copy so ui/js never drifts from it.
 *
 *   php tools/gen-harness.php            write ui/js/harness.data.js
 *   php tools/gen-harness.php --check    fail (exit 1) if it is out of date
 *
 * Wire the --check mode into a pre-commit hook to keep the two in step:
 *   php tools/gen-harness.php --check || { echo "run: php tools/gen-harness.php"; exit 1; }
 */

require_once __DIR__ . '/../autoload.php';

use Src\Harness;

$out = __DIR__ . '/../ui/js/harness.data.js';

/** PHP harness id -> browser family id (the browser calls the OpenAI shape "openai"). */
$norm = function ($f) {
    return $f === 'openrouter' ? 'openai' : $f;
};

function js($v) {
    return json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

$lines = [];
$lines[] = '// ============================================================';
$lines[] = '// HARNESS.DATA.JS - GENERATED FILE. DO NOT EDIT BY HAND.';
$lines[] = '//';
$lines[] = '// Source of truth: src/Harness.php';
$lines[] = '// Regenerate:      php tools/gen-harness.php';
$lines[] = '// ============================================================';
$lines[] = '';

// families
$fam = [];
foreach (Harness::families() as $id => $d) {
    $fam[$norm($id)] = [
        'label' => $d['label'],
        'auth' => $d['auth'],
        'toolProtocol' => $d['toolProtocol'],
        'images' => (bool)$d['images'],
    ];
}
$lines[] = 'export const API_FAMILIES = ' . js($fam) . ';';
$lines[] = '';

// provider aliases
$alias = [];
foreach (Harness::aliases() as $p => $f) {
    $alias[$p] = $norm($f);
}
$lines[] = 'export const PROVIDER_ALIASES = ' . js($alias) . ';';
$lines[] = '';

// host matchers
$hosts = [];
foreach (Harness::hostMatchers() as $pair) {
    $hosts[] = [$pair[0], $norm($pair[1])];
}
$lines[] = 'export const HOST_MATCHERS = ' . js($hosts) . ';';
$lines[] = '';

// tool-dialect model patterns
$lines[] = 'export const TOOL_PATTERNS = ' . js(Harness::toolPatterns()) . ';';
$lines[] = '';

// context windows
$lines[] = 'export const CONTEXT_LIMITS = ' . js(Harness::contextLimits()) . ';';
$lines[] = '';

// default rpm, as ordered [host, rpm] pairs
$rpms = [];
foreach (Harness::defaultRpm() as $h => $rpm) {
    $rpms[] = [$h, (int)$rpm];
}
$lines[] = 'export const DEFAULT_RPM = ' . js($rpms) . ';';
$lines[] = '';

$generated = implode("\n", $lines);

if (in_array('--check', $argv ?? [], true)) {
    $existing = is_file($out) ? file_get_contents($out) : '';
    if ($existing !== $generated) {
        fwrite(STDERR, "harness.data.js is OUT OF DATE. Run: php tools/gen-harness.php\n");
        exit(1);
    }
    echo "harness.data.js is up to date\n";
    exit(0);
}

if (file_put_contents($out, $generated) === false) {
    fwrite(STDERR, "Could not write $out\n");
    exit(1);
}
echo "wrote $out\n";
