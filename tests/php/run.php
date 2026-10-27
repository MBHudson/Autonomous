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
 * Usage: php tests/php/run.php [--jobs N]
 *
 * Every `*.test.php` in this directory runs as its own PHP process, exactly as
 * it would be run by hand, so one test's includes or globals cannot affect
 * another. A file fails if it exits non-zero; its full output is printed when
 * it does. The runner's own exit code is 1 if any file failed.
 *
 * The files now run SEVERAL AT A TIME -- 4 by default, `--jobs N` to change it,
 * `--jobs 1` for one after another. What that buys is the difference between
 * waiting for the whole suite and waiting for its slowest single file, because
 * the suite's time was never the sum of the work: it was mostly two long files
 * (programs, setupToken) while twelve others sat runnable. What it costs is
 * having had to take away the two things every file used to share:
 *
 *   * The PORT each server binds. `tcp://127.0.0.1:0` -- "any port the OS will
 *     give me" -- puts the number straight back in the pool when the socket
 *     closes, so two files starting at the same moment can be handed the same
 *     one and the second is then binding an occupied port or talking to the
 *     other file's server. Serially there was never a second file, so this
 *     never showed. See free-port.php: the walk starts from this process's own
 *     pid instead.
 *   * The LOG each file writes. exec.log and mcp.log live in the app's storage/
 *     and a test that asserts on its own audit lines truncates the file back to
 *     the size it found it at -- which, run concurrently, deletes a line
 *     another file is still going to read. Each file is given its own log
 *     directory here (ROUTER_LOG_DIR), so its trace is its own.
 *
 * Results are STILL printed in file-name order, whatever order they finish in,
 * and a file's full output still prints under its own FAIL line: two runs of
 * the same tree read the same way. Which file is STARTED next is a different
 * question, and there the longest files go first (line count is a poor but free
 * stand-in for how long a file takes) so that the slowest file is not the last
 * one to begin.
 *
 * A file that cannot run part of itself -- because the operator's install has no
 * session transcripts, or the archive that used to sit beside the app is not
 * there -- prints `SKIP:` with the reason. Those lines are repeated here for a
 * PASSING file as well, and counted, because otherwise "this file skipped two of
 * its checks" is indistinguishable from "this file had two checks", and a fresh
 * clone quietly runs fewer assertions than the machine they were written on.
 *
 * mcp-mock-server.php and free-port.php are helpers, not tests: they do not
 * match `*.test.php`, and are spawned or required by the tests themselves.
 */

$here = __DIR__;
$files = glob($here . DIRECTORY_SEPARATOR . '*.test.php');
sort($files);

// --- how many run at once ---------------------------------------------------

$jobs = 4;
$args = array_slice($argv, 1);
for ($i = 0; $i < count($args); $i++) {
    if ($args[$i] === '--jobs' || $args[$i] === '-j') {
        $jobs = (int) ($args[$i + 1] ?? 0);
        $i++;
    } elseif (preg_match('/^--jobs=(\d+)$/', $args[$i], $m)) {
        $jobs = (int) $m[1];
    } else {
        fwrite(STDERR, "Unknown argument: {$args[$i]}\nUsage: php tests/php/run.php [--jobs N]\n");
        exit(2);
    }
}
if ($jobs < 1) {
    fwrite(STDERR, "--jobs wants a number of at least 1\n");
    exit(2);
}

echo "PHP test suite\n";
echo str_repeat('=', 60) . "\n";

if (!$files) {
    fwrite(STDERR, "No *.test.php files in {$here}\n");
    exit(1);
}
if ($jobs > count($files)) { $jobs = count($files); }

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

/** Remove a directory tree, deepest first. */
function rm_tree($dir)
{
    if (!is_dir($dir)) {
        return;
    }
    foreach ((array) @scandir($dir) as $entry) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }
        $path = $dir . '/' . $entry;
        if (is_dir($path) && !is_link($path)) {
            rm_tree($path);
        } else {
            @unlink($path);
        }
    }
    @rmdir($dir);
}

// One directory for the whole run, outside the app: a subdirectory of it per
// file for that file's logs, and one output file per file, so no two files ever
// write the same path. Removed on the way out -- except after a failure, where
// the per-file logs are the one piece of evidence the printed output cannot
// carry, and a flake without a log is a flake nobody can chase.
$runDir = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-php-suite-' . getmypid();
rm_tree($runDir);
if (!@mkdir($runDir, 0777, true) && !is_dir($runDir)) {
    fwrite(STDERR, "Could not create {$runDir} -- no writable temp directory?\n");
    exit(1);
}
$keepRunDir = false;
register_shutdown_function(function () use ($runDir, &$keepRunDir) {
    if (!$keepRunDir) {
        rm_tree($runDir);
    }
});

/**
 * Start one test file.
 *
 * proc_open rather than the exec() this used to use, because the children have
 * to overlap; and the array form because on Windows a string command line is
 * handed to cmd.exe, which would read the path's own characters as its grammar.
 * Both output streams are opened in append mode on the SAME file: two
 * descriptors from zero (one 'w', one 'a') would leave the second stream
 * overwriting the first's bytes rather than joining them.
 *
 * Returns the process resource, or null when it would not start -- which is a
 * failure, not a skip: the environment did not decline this check, the runner
 * could not run a file it found.
 */
function spawn($file, $out, $logDir)
{
    @mkdir($logDir, 0777, true);
    $env = (array) getenv();
    $env['ROUTER_LOG_DIR'] = $logDir;
    $spec = array(1 => array('file', $out, 'a'), 2 => array('file', $out, 'a'));
    $pipes = array();
    $proc = @proc_open(array(PHP_BINARY, $file), $spec, $pipes, null, $env);
    return is_resource($proc) ? $proc : null;
}

$total = count($files);
$failures = array();
$assertions = 0;
$counted = 0;
$skips = 0;
$started = microtime(true);

// Longest first: line count as a stand-in for runtime, used only to decide the
// order files are STARTED in. Printing stays in file-name order (below).
$schedule = array();
foreach ($files as $index => $file) {
    $schedule[$index] = (int) @filesize($file);
}
arsort($schedule);
$schedule = array_keys($schedule);

$running = array();   // index => process resource
$results = array();   // index => [lines, code, out]
$next = 0;            // the next index that may be printed

while ($schedule || $running) {
    while ($schedule && count($running) < $jobs) {
        $index = array_shift($schedule);
        $out = $runDir . '/' . $index . '.out';
        $proc = spawn($files[$index], $out, $runDir . '/' . $index . '.logs');
        if ($proc === null) {
            $results[$index] = array('lines' => array('could not start ' . PHP_BINARY), 'code' => 1, 'out' => $out);
        } else {
            $running[$index] = $proc;
        }
    }

    foreach ($running as $index => $proc) {
        $st = @proc_get_status($proc);
        if ($st === false || !empty($st['running'])) {
            continue;
        }
        // This first call that reports the process gone carries its exit code
        // (asking again reports -1 on PHP before 8.3), so it is read here and
        // the handle is closed rather than interrogated once more.
        $code = (int) ($st['exitcode'] ?? -1);
        @proc_close($proc);
        unset($running[$index]);
        $out = $runDir . '/' . $index . '.out';
        $results[$index] = array(
            'lines' => is_file($out) ? (array) @file($out, FILE_IGNORE_NEW_LINES) : array(),
            'code' => $code,
            'out' => $out,
        );
    }

    // Print in file-name order, as soon as the head of that order is known.
    while (isset($results[$next])) {
        $name = basename($files[$next]);
        $lines = $results[$next]['lines'];
        $code = $results[$next]['code'];
        unset($results[$next]);

        if ($code !== 0) {
            $failures[] = $name;
            echo "\nFAIL  {$name} (exit {$code})\n";
            foreach ($lines as $line) {
                echo '      ' . rtrim($line) . "\n";
            }
        } else {
            // Only a passing file's count is trusted: a failing one stops
            // wherever it failed, so whatever it last printed is not the number
            // that ran.
            $summary = last_line($lines);
            if (preg_match('/(\d+) passed/', $summary, $m)) {
                $assertions += (int) $m[1];
                $counted++;
            }
            echo "ok    {$name}  --  {$summary}\n";
            // A passing file's own SKIP lines, under its result. Only passing
            // files are counted: when one fails the whole output is already on
            // screen above.
            foreach ($lines as $line) {
                if (preg_match('/^\s*SKIP:/', $line)) {
                    echo '      ' . rtrim($line) . "\n";
                    $skips++;
                }
            }
        }
        $next++;
    }

    if ($running) {
        usleep(20000);
    }
}

$keepRunDir = $failures ? true : false;

echo str_repeat('=', 60) . "\n";
$passed = $total - count($failures);
$tally = $counted === $total ? ", {$assertions} assertions" : '';
$skipTally = $skips ? ", {$skips} skipped" : '';
echo 'ran ' . $total . ' files, ' . $jobs . ' at a time, in ' . number_format(microtime(true) - $started, 1) . "s\n";
echo "{$total} files, {$passed} passed, " . count($failures) . " failed{$tally}{$skipTally}\n";

if ($failures) {
    fwrite(STDERR, "\nFailed: " . implode(', ', $failures) . "\n");
    fwrite(STDERR, "Per-file logs and output kept in {$runDir}\n");
    exit(1);
}
