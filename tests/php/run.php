<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Run the whole PHP suite.
 *
 * Usage: php tests/php/run.php
 *
 * Every `*.test.php` in this directory runs as its own PHP process, exactly as
 * it would be run by hand, so one test's includes or globals cannot affect
 * another. A file fails if it exits non-zero; its full output is printed when
 * it does. The runner's own exit code is 1 if any file failed.
 *
 * A file that cannot run part of itself -- because the operator's install has no
 * session transcripts, or the archive that used to sit beside the app is not
 * there -- prints `SKIP:` with the reason. Those lines are repeated here for a
 * PASSING file as well, and counted, because otherwise "this file skipped two of
 * its checks" is indistinguishable from "this file had two checks", and a fresh
 * clone quietly runs fewer assertions than the machine they were written on.
 *
 * mcp-mock-server.php is a helper, not a test: it does not match `*.test.php`
 * and is spawned by mcp.test.php itself.
 */

$here = __DIR__;
$files = glob($here . DIRECTORY_SEPARATOR . '*.test.php');
sort($files);

echo "PHP test suite\n";
echo str_repeat('=', 60) . "\n";

if (!$files) {
    fwrite(STDERR, "No *.test.php files in {$here}\n");
    exit(1);
}

/** Last non-empty line of a block of output, trimmed. */
function last_line(array $lines): string
{
    for ($i = count($lines) - 1; $i >= 0; $i--) {
        $line = trim($lines[$i]);
        if ($line !== '') {
            return $line;
        }
    }
    return '';
}

$failures = [];
$assertions = 0;
$counted = 0;
$skips = 0;

foreach ($files as $file) {
    $name = basename($file);
    $lines = [];
    $code = 0;
    // 2>&1: a test that dies writes its reason to stderr, and that is exactly
    // what has to be shown when it fails.
    $cmd = escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($file) . ' 2>&1';
    exec($cmd, $lines, $code);

    if ($code !== 0) {
        $failures[] = $name;
        echo "\nFAIL  {$name} (exit {$code})\n";
        foreach ($lines as $line) {
            echo '      ' . rtrim($line) . "\n";
        }
        continue;
    }

    // Only a passing file's count is trusted: a failing one stops wherever it
    // failed, so whatever it last printed is not the number that ran.
    $summary = last_line($lines);
    if (preg_match('/(\d+) passed/', $summary, $m)) {
        $assertions += (int) $m[1];
        $counted++;
    }
    echo "ok    {$name}  --  {$summary}\n";
    // A passing file's own SKIP lines, under its result. Only passing files are
    // counted: when one fails the whole output is already on screen above.
    foreach ($lines as $line) {
        if (preg_match('/^\s*SKIP:/', $line)) {
            echo '      ' . rtrim($line) . "\n";
            $skips++;
        }
    }
}

echo str_repeat('=', 60) . "\n";
$total = count($files);
$passed = $total - count($failures);
$tally = $counted === $total ? ", {$assertions} assertions" : '';
$skipTally = $skips ? ", {$skips} skipped" : '';
echo "{$total} files, {$passed} passed, " . count($failures) . " failed{$tally}{$skipTally}\n";

if ($failures) {
    fwrite(STDERR, "\nFailed: " . implode(', ', $failures) . "\n");
    exit(1);
}
