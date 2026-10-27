<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Layer audit: no app surface may tie or outrank a dialog.
 *
 * Usage: php tests/php/layers.test.php
 *
 * The bug this exists to prevent is quiet. Dialogs sat at z-index 1000 while
 * `.browser-screen` (1250) and `.lab-drawer` (1200) sat above them, and an
 * agent's ⋮ menu was floated onto <body> at 3000. Opening Config while the
 * Browser pane was up drew the dialog *underneath* it, so the click read as
 * dead rather than covered -- nothing errored and no test noticed. The ladder
 * is now written down in `ui/css/modals.css`; this file reads the stylesheets
 * (and the two places z-index is set from JS/HTML) and fails when the code
 * stops matching it.
 *
 * What "notice" means here, and why the list is explicit: a fatal banner, the
 * boot splash, a toast or the approval prompt SHOULD be visible over a dialog.
 * Everything else -- panels, drawers, panes, menus -- must sit below. Each
 * exemption below is a decision, with a reason, not a blanket threshold, so a
 * new surface cannot quietly join the pile by picking a big number.
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
        return true;
    }
    $fail++;
    $errors[] = 'FAIL: ' . $name;
    return false;
}

/** Blank out comments but keep their newlines, so line numbers stay honest. */
function strip_comments($css)
{
    return preg_replace_callback('~/\*.*?\*/~s', function ($m) {
        return preg_replace('/[^\n]/', '', $m[0]);
    }, $css);
}

/**
 * Every `prop: value` declaration, with the selector and line it belongs to.
 *
 * Hand-rolled rather than regex-per-rule because selectors here are grouped
 * across lines (`.modal-overlay,\n.modal-bg {`) and rules are nested inside
 * @media blocks -- both of which a "matches up to the brace" regex gets wrong,
 * and getting them wrong is how an audit silently passes.
 */
function read_declarations($path)
{
    $css = @file_get_contents($path);
    if ($css === false) {
        return array();
    }
    $css = strip_comments($css);
    $out = array();
    $stack = array();
    $buf = '';
    $line = 1;
    $len = strlen($css);

    for ($i = 0; $i < $len; $i++) {
        $ch = $css[$i];
        if ($ch === "\n") {
            $line++;
            $buf .= $ch;
            continue;
        }
        if ($ch === '{') {
            $stack[] = array('sel' => trim($buf), 'line' => $line);
            $buf = '';
            continue;
        }
        if ($ch === '}') {
            array_pop($stack);
            $buf = '';
            continue;
        }
        if ($ch !== ';') {
            $buf .= $ch;
            continue;
        }
        $decl = trim($buf);
        $buf = '';
        if ($decl === '' || !$stack) {
            continue;
        }
        $colon = strpos($decl, ':');
        if ($colon === false) {
            continue;
        }
        $prop = strtolower(trim(substr($decl, 0, $colon)));
        if ($prop !== 'z-index') {
            continue;
        }
        $value = trim(substr($decl, $colon + 1));
        $selector = '';
        $media = '';
        foreach ($stack as $entry) {
            if ($entry['sel'] === '') {
                continue;
            }
            if ($entry['sel'][0] === '@') {
                $media = $entry['sel'];
            } else {
                $selector = $entry['sel'];
            }
        }
        $z = preg_match('/^(-?\d+)/', $value, $m) ? (int) $m[1] : null;
        $out[] = array(
            'file' => basename($path),
            'line' => $line,
            'selector' => preg_replace('/\s+/', ' ', $selector),
            'media' => $media,
            'value' => $value,
            'z' => $z,
        );
    }
    return $out;
}

/** Is this selector one of the declared notices? */
function notice_reason($selector, $notices)
{
    foreach ($notices as $needle => $reason) {
        if (strpos($selector, $needle) !== false) {
            return $reason;
        }
    }
    return null;
}

// --------------------------------------------------------------- the source
$cssFiles = glob($root . '/ui/css/*.css');
sort($cssFiles);
ok((bool) $cssFiles, 'the stylesheets are where the audit expects them', $pass, $fail, $errors);

$decls = array();
foreach ($cssFiles as $file) {
    $decls = array_merge($decls, read_declarations($file));
}
ok(count($decls) > 0, 'found z-index declarations to audit', $pass, $fail, $errors);

// A z-index that is not a literal (var(--x), calc()) cannot be compared, and
// silently skipping it is exactly the drift this test is for.
$opaque = array();
foreach ($decls as $d) {
    if ($d['z'] === null) {
        $opaque[] = $d['file'] . ':' . $d['line'] . ' ' . $d['selector'] . ' => ' . $d['value'];
    }
}
ok(!$opaque, 'every z-index is a literal integer (' . implode('; ', $opaque) . ')', $pass, $fail, $errors);

// ------------------------------------------------------------- dialog layer
$dialogEntries = array();
$dialogSelectorText = '';
foreach ($decls as $d) {
    if (preg_match('/\.modal-(bg|overlay)\b/', $d['selector'])) {
        $dialogEntries[] = $d;
        $dialogSelectorText .= ' ' . $d['selector'];
    }
}
// One grouped rule declares both (`.modal-overlay,\n.modal-bg { z-index: ... }`),
// so the check is that both names are covered, not that there are two rules.
ok(count($dialogEntries) >= 1
    && strpos($dialogSelectorText, '.modal-bg') !== false
    && strpos($dialogSelectorText, '.modal-overlay') !== false,
    'both .modal-bg and .modal-overlay are on the dialog layer',
    $pass, $fail, $errors);

$dialogZ = $dialogEntries ? $dialogEntries[0]['z'] : null;
$mixed = array();
foreach ($dialogEntries as $d) {
    if ($d['z'] !== $dialogZ) {
        $mixed[] = $d['selector'] . ' => ' . $d['value'];
    }
}
ok(!$mixed, 'dialogs share one layer (' . implode('; ', $mixed) . ')', $pass, $fail, $errors);
ok(is_int($dialogZ) && $dialogZ > 0, 'the dialog layer is a positive integer', $pass, $fail, $errors);

// ------------------------------------------------------ who may sit above it
// selector fragment => why it is allowed above dialogs
$notices = array(
    '.api-locked-banner' => 'error strip for a 401: the app is unusable without it',
    '.app-loader'        => 'boot splash, removed once the app starts',
    'body::after'        => 'CRT scanlines, pointer-events: none',
    '.toast-container'   => 'notifications',
    '.approve-veil'      => 'a blocking approval prompt must be visible over a dialog',
);

// The few places a layer is set outside the stylesheets. Keyed by file and
// value, so raising the number still trips the audit.
$inlineNotices = array(
    'index.html:99999' => 'boot watchdog strip, only when a module failed to load',
    'ui/js/app.js:99999' => 'BOOT ERROR box, only when boot threw',
    'ui/js/app.js:70000' => '?debug=1 diagnostics HUD, pinned on purpose to be read over the app',
);

$violations = array();
foreach ($decls as $d) {
    if ($d['z'] === null || $d['z'] < $dialogZ) {
        continue;
    }
    if (notice_reason($d['selector'], $notices)) {
        continue;
    }
    // The dialogs themselves are the reference layer; they are not "above" it.
    if (preg_match('/\.modal-(bg|overlay)\b/', $d['selector'])) {
        continue;
    }
    $violations[] = $d['file'] . ':' . $d['line'] . ' ' . $d['selector']
        . ' (z=' . $d['z'] . ')' . ($d['media'] ? ' in ' . $d['media'] : '');
}
ok(!$violations,
    'no stylesheet surface ties or outranks dialogs (' . $dialogZ . '): ' . implode('; ', $violations),
    $pass, $fail, $errors);

// The exemption list must stay truthful: a notice that has drifted below the
// dialog layer no longer needs to be on it, and keeping it there would hide a
// future change.
$stale = array();
foreach ($decls as $d) {
    $why = notice_reason($d['selector'], $notices);
    if ($why !== null && $d['z'] !== null && $d['z'] <= $dialogZ) {
        $stale[] = $d['selector'] . ' (z=' . $d['z'] . ')';
    }
}
ok(!$stale, 'each declared notice really is above dialogs (' . implode('; ', $stale) . ')', $pass, $fail, $errors);

// The surfaces that were actually wrong once. Named individually so a
// regression reports "the browser pane outranks dialogs", not "something did".
$mustSitBelow = array(
    '.browser-screen'  => 'the built-in Browser pane',
    '.lab-drawer'      => 'the API Lab drawer',
    '.terminal-panel'  => 'the terminal panel',
    '.notif-dropdown'  => 'the narrow-window notification dropdown',
);
foreach ($mustSitBelow as $selector => $label) {
    $z = null;
    foreach ($decls as $d) {
        if (strpos($d['selector'], $selector) !== false && $d['z'] !== null) {
            $z = $d['z'];
        }
    }
    ok($z !== null && $z < $dialogZ,
        $label . ' sits below dialogs (z=' . var_export($z, true) . ' vs ' . $dialogZ . ')',
        $pass, $fail, $errors);
}

// ------------------------------------------------- z-index set from JS / HTML
/**
 * Workspace-relative path, for matching the allowlist.
 *
 * glob() can hand back a differently-spelled root than __DIR__ resolves to
 * (Windows drive symlinks do it), and an absolute path would silently never
 * match `ui/js/app.js:99999` -- turning an exemption into a mystery failure.
 */
function rel_path($root, $path)
{
    $p = str_replace('\\', '/', $path);
    $r = rtrim(str_replace('\\', '/', $root), '/');
    if (stripos($p, $r) === 0) {
        return ltrim(substr($p, strlen($r)), '/');
    }
    if (preg_match('~((?:ui|tests)/.*)$~', $p, $m)) {
        return $m[1];
    }
    return basename($p);
}

/** file, line, value for every literal z-index assigned from JavaScript. */
function read_js_layers($path)
{
    $src = @file_get_contents($path);
    if ($src === false) {
        return array();
    }
    $out = array();
    $lines = preg_split('/\r\n|\r|\n/', $src);
    foreach ($lines as $i => $ln) {
        $found = array();
        // el.style.zIndex = '3000'
        if (preg_match_all('/\bstyle\.zIndex\s*=\s*[\'"]?(-?\d+)/', $ln, $m)) {
            $found = array_merge($found, $m[1]);
        }
        // el.style.cssText = '...z-index:99999;...'
        if (preg_match_all('/\bcssText\b[^\n]*?z-index:\s*(-?\d+)/', $ln, $m2)) {
            $found = array_merge($found, $m2[1]);
        }
        // style.setProperty('z-index', '1200')
        if (preg_match_all("/setProperty\\(\\s*['\"]z-index['\"]\\s*,\\s*['\"]?(-?\\d+)/i", $ln, $m3)) {
            $found = array_merge($found, $m3[1]);
        }
        foreach ($found as $v) {
            $out[] = array('file' => $path, 'line' => $i + 1, 'z' => (int) $v);
        }
    }
    return $out;
}

$jsFiles = array_merge(
    glob($root . '/ui/js/*.js'),
    glob($root . '/ui/js/components/*.js'),
    glob($root . '/ui/js/components/topology3d/*.js')
);
sort($jsFiles);
$jsLayers = array();
foreach ($jsFiles as $file) {
    $jsLayers = array_merge($jsLayers, read_js_layers($file));
}
ok(count($jsLayers) >= 2, 'found the JS-set layers to audit (' . count($jsLayers) . ')', $pass, $fail, $errors);

$jsViolations = array();
foreach ($jsLayers as $j) {
    $rel = rel_path($root, $j['file']);
    $key = $rel . ':' . $j['z'];
    if (isset($inlineNotices[$key])) {
        continue;
    }
    if ($j['z'] >= $dialogZ) {
        $jsViolations[] = $rel . ':' . $j['line'] . ' (z=' . $j['z'] . ')';
    }
}
ok(!$jsViolations,
    'no JS-assigned layer ties or outranks dialogs: ' . implode('; ', $jsViolations),
    $pass, $fail, $errors);

// The floated agent menus are the exact thing that broke once -- a body-level
// clone at 3000 that painted over dialogs and the approval veil. Named, so the
// failure says which menu came back.
$menuZ = null;
foreach ($jsLayers as $j) {
    $rel = rel_path($root, $j['file']);
    if ($rel === 'ui/js/components/sidebar.js') {
        $menuZ = $menuZ === null ? $j['z'] : max($menuZ, $j['z']);
    }
}
ok($menuZ !== null && $menuZ < $dialogZ,
    'the floated agent menu stays under dialogs (z=' . var_export($menuZ, true) . ')',
    $pass, $fail, $errors);

// 3D labels compute `zIndex: String(1000 - ...)` per frame; the base is the
// ceiling they can reach.
$labels = @file_get_contents($root . '/ui/js/components/topology3d/labels.js');
$labelBase = null;
if ($labels !== false && preg_match('/zIndex:\s*String\(\s*(\d+)\s*-/', $labels, $m)) {
    $labelBase = (int) $m[1];
}
ok($labelBase !== null && $labelBase < $dialogZ,
    'chart labels stay under dialogs (base z=' . var_export($labelBase, true) . ')',
    $pass, $fail, $errors);

// Inline layers in the shell HTML (the boot watchdog writes one from a classic
// script, so it never reaches window.onerror).
$shell = @file_get_contents($root . '/index.html');
$inlineHtml = array();
if ($shell !== false && preg_match_all('/z-index:\s*(\d+)/', $shell, $mh)) {
    foreach ($mh[1] as $v) {
        $inlineHtml[] = (int) $v;
    }
}
$htmlViolations = array();
foreach ($inlineHtml as $z) {
    if (isset($inlineNotices['index.html:' . $z])) {
        continue;
    }
    if ($z >= $dialogZ) {
        $htmlViolations[] = 'index.html (z=' . $z . ')';
    }
}
ok(!$htmlViolations,
    'no inline layer in index.html ties or outranks dialogs: ' . implode('; ', $htmlViolations),
    $pass, $fail, $errors);

// ------------------------------------------------------ the ladder's own docs
// modals.css documents the ladder in a comment. If someone moves dialogs and
// leaves the note behind, the next reader trusts a number that is wrong.
// Read raw: the ladder is a comment, so stripping comments would hide it.
$modals = @file_get_contents($root . '/ui/css/modals.css');
$documented = null;
if ($modals !== false && preg_match('/^\s*(\d+)\s+DIALOGS\b/m', $modals, $m)) {
    $documented = (int) $m[1];
}
ok($documented !== null && $documented === $dialogZ,
    'the documented dialog layer matches the code (' . var_export($documented, true) . ' vs ' . $dialogZ . ')',
    $pass, $fail, $errors);

// ---------------------------------------------------------------- report
echo str_repeat('-', 60) . "\n";
if ($fail) {
    echo implode("\n", $errors) . "\n";
    echo $fail . ' failed, ' . $pass . ' passed' . "\n";
    exit(1);
}
echo $pass . ' passed' . "\n";
