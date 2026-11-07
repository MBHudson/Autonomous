<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Exec argv handling: the word splitter, the kill signal and the timeout cap.
 *
 * Usage: php tests/php/execArgv.test.php
 *
 * Models constantly send one string ("ls -la") instead of an argv array, and
 * numbers for counts ("sleep", 5). The server splits single strings itself
 * (whitespace and quotes only -- never expansion, never operators) and the
 * client coerces scalars. These are pure functions, so nothing here touches
 * config, storage or any process: parallel-safe by construction.
 *
 * Backslash-bearing cases are built with chr(92) rather than written as
 * literals, so what the test means never depends on how an editor displays
 * escapes.
 *
 * What is asserted here:
 *
 *   * splitArgvString separates on whitespace, groups single/double quotes,
 *     honours backslash escapes, keeps | ; && $() and backticks literal, and
 *     never returns an empty array entry;
 *   * killSignal is a positive int on every host (SIGKILL with pcntl, else 9);
 *   * clampTimeout never lets a web request outlive the PHP time limit, and
 *     leaves CLI/unlimited values alone.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

require_once __DIR__ . '/../../autoload.php';

use Src\Sandbox;

$pass = 0;
$fail = 0;
$errors = [];

$ok = function ($cond, $name) use (&$pass, &$fail, &$errors) {
    if ($cond) { $pass++; }
    else { $fail++; $errors[] = 'FAIL: ' . $name; }
};
$eq = function ($a, $b, $name) use ($ok) {
    $ok($a === $b, $name . ' (got ' . json_encode($a) . ', want ' . json_encode($b) . ')');
};

$BS = chr(92);   // one real backslash, whatever the editor shows
$Q = chr(34);    // double quote
$S = chr(39);    // single quote

// --- splitArgvString ---------------------------------------------------------
$eq(Sandbox::splitArgvString('ls -la'), ['ls', '-la'], 'plain split');
$eq(Sandbox::splitArgvString('grep -rn x .'), ['grep', '-rn', 'x', '.'], 'four words');
$eq(Sandbox::splitArgvString('  pwd  '), ['pwd'], 'surrounding whitespace ignored');
$eq(Sandbox::splitArgvString(''), [], 'empty string');
$eq(Sandbox::splitArgvString('   '), [], 'whitespace only');

$eq(
    Sandbox::splitArgvString('echo ' . $Q . 'hello world' . $Q),
    ['echo', 'hello world'],
    'double quotes group'
);
$eq(
    Sandbox::splitArgvString('echo ' . $S . 'a b' . $S . ' c'),
    ['echo', 'a b', 'c'],
    'single quotes group'
);
$eq(
    Sandbox::splitArgvString('echo ' . $Q . $Q . ' x'),
    ['echo', '', 'x'],
    'empty quotes are an empty argument, not nothing'
);
$eq(
    Sandbox::splitArgvString('echo a' . $BS . ' b'),
    ['echo', 'a b'],
    'backslash escapes the space'
);
$eq(
    Sandbox::splitArgvString('echo ' . $Q . 'a' . $BS . 'b' . $Q),
    ['echo', 'a' . $BS . 'b'],
    'backslash survives inside double quotes'
);

// Shell syntax must stay literal: the splitter separates WORDS, it never
// grants pipes, chaining or substitution.
$eq(Sandbox::splitArgvString('echo a|b'), ['echo', 'a|b'], 'pipe stays literal');
$eq(Sandbox::splitArgvString('a && b'), ['a', '&&', 'b'], 'ampersands stay literal');
$eq(Sandbox::splitArgvString('echo $(whoami)'), ['echo', '$(whoami)'], 'substitution stays literal');
$eq(Sandbox::splitArgvString('echo `date`'), ['echo', '`date`'], 'backticks stay literal');
$eq(Sandbox::splitArgvString('echo a;b'), ['echo', 'a;b'], 'semicolon stays literal');

// An unterminated quote runs to the end of the string rather than vanishing.
$eq(Sandbox::splitArgvString('echo ' . $Q . 'abc'), ['echo', 'abc'], 'unterminated quote');

// --- killSignal ----------------------------------------------------------------
$sig = Sandbox::killSignal();
$ok(is_int($sig) && $sig > 0, 'killSignal is a positive int (got ' . json_encode($sig) . ')');

// --- clampTimeout ---------------------------------------------------------------
$eq(Sandbox::clampTimeout(600, 'apache', 30), 20, 'web: capped below the PHP limit');
$eq(Sandbox::clampTimeout(60, 'apache', 30), 20, 'web: default exec timeout capped too');
$eq(Sandbox::clampTimeout(600, 'cli', 30), 600, 'CLI: no ceiling');
$eq(Sandbox::clampTimeout(600, 'apache', 0), 600, 'unlimited ini: no ceiling');
$eq(Sandbox::clampTimeout(3, 'apache', 30), 3, 'small timeout untouched');
$eq(Sandbox::clampTimeout(600, 'apache', 5), 5, 'floor of 5 when the limit is tiny');

foreach ($errors as $line) {
    echo $line . "\n";
}
echo "execArgv: $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
