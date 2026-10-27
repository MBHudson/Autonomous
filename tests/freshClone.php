<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Verify a FRESH COPY of this project: copy the tree to a temp folder, run both
 * suites there, then report.
 *
 * Usage: php tests/freshClone.php [--index] [--head] [--keep]
 *
 * Why this exists: a suite that passes in the checkout the tests were written on
 * can still fail on a fresh copy -- or, worse, quietly do LESS, because the
 * checkout carries things the repo does not (storage/config.json, session
 * transcripts, logs, an archived older copy) and a file's SKIP lines only become
 * visible when that file fails. Running both suites in a clean copy, the same
 * way every time, is the only way to see the difference; doing it by hand is a
 * `git ls-files` away from being forgotten.
 *
 * By default the copy is the WORKING TREE as git sees it: every tracked file at
 * its current content, plus files that are new and not ignored. A plain
 * `git clone` would not do that -- it copies the last COMMIT, so uncommitted
 * work (the usual state of a change under development) would be missing from the
 * copy and the suites would be testing something else entirely. `--head` does a
 * real `git clone` of the committed tree, which answers the other question:
 * what does someone who clones this repo right now get?
 *
 * `--index` copies the STAGED snapshot instead -- what the commit being prepared
 * will actually contain. That is the mode the pre-commit hook uses: verifying the
 * working tree would test a half-staged commit as if it were whole, and miss a
 * file that is staged but already edited again on disk.
 *
 * Ignored files are left behind on purpose -- storage/config.json, state.json,
 * the logs, session transcripts, cleancopy/ -- because they ARE the operator
 * state whose presence used to hide the difference. Both suites are run from the
 * copy, so nothing here reads or writes the operator's storage/.
 *
 * The copy is deleted when both suites pass, and KEPT when one fails, with its
 * path printed, so the failure can be looked at where it happened. `--keep`
 * keeps it either way.
 *
 * Needs git (the file list comes from it) and, for the JS half, node. A suite
 * that cannot run is reported as a failure, never as a pass.
 *
 * Every run ends by printing how long it took, split by phase (copy, PHP, JS),
 * on the way past whether it passed or failed. The README and the pre-commit
 * hook both quote a figure for this check so a reader can decide whether to pay
 * it: printing the real one is what keeps a quoted number from drifting, which
 * it had (`about two minutes` for a check that now runs in 17).
 *
 * Exits 0 when both suites pass, 1 otherwise.
 */

// Timed from here, so the figure at the end is the whole check and not just the
// suites. Every phase is measured separately: a reader deciding whether to run
// this (or to leave the pre-commit hook on) is deciding about the total, while
// whoever is trying to make it faster needs to know WHICH half is slow.
$t_started = microtime(true);

$root = dirname(__DIR__);
$args = isset($argv) ? array_slice($argv, 1) : [];
$head = in_array('--head', $args, true);
$index = in_array('--index', $args, true);
$keep = in_array('--keep', $args, true);

if ($head && $index) {
    fwrite(STDERR, "--head and --index answer different questions; pick one.\n");
    exit(1);
}

/** Delete a directory tree, quietly. */
function remove_tree($dir)
{
    if (!is_dir($dir)) {
        return;
    }
    $items = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($items as $item) {
        if ($item->isDir()) { @rmdir($item->getPathname()); } else { @unlink($item->getPathname()); }
    }
    @rmdir($dir);
}

/** Run a command, merged output and all. [exit code, output]. 127 = never ran. */
function run(array $cmd, $cwd = null)
{
    if (!function_exists('proc_open')) {
        return array(127, "proc_open is disabled, cannot run " . $cmd[0] . "\n");
    }
    $spec = array(1 => array('pipe', 'w'), 2 => array('pipe', 'w'));
    $proc = @proc_open($cmd, $spec, $pipes, $cwd);
    if (!is_resource($proc)) {
        return array(127, $cmd[0] . " could not be started (not on PATH?)\n");
    }
    $out = (string) stream_get_contents($pipes[1]);
    $err = (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    return array(proc_close($proc), $out . $err);
}

/** Last non-empty line of a block of output. */
function last_line($text)
{
    $lines = preg_split('/\r?\n/', (string) $text);
    for ($i = count($lines) - 1; $i >= 0; $i--) {
        if (trim($lines[$i]) !== '') {
            return trim($lines[$i]);
        }
    }
    return '';
}

function stop($message)
{
    fwrite(STDERR, $message . "\n");
    exit(1);
}

$dest = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-fresh-check-' . getmypid();
$app = $dest . '/app';
remove_tree($dest);
if (!@mkdir($app, 0777, true)) {
    stop('Could not create ' . $app);
}

echo "Fresh copy check\n";
echo str_repeat('=', 60) . "\n";

if ($head) {
    // A real clone of the committed tree. --quiet keeps git's progress noise out;
    // --no-hardlinks because this source is a local path, and a copy that shares
    // inodes with the original is not a fresh copy.
    list($code, $out) = run(array('git', 'clone', '--quiet', '--no-hardlinks', $root, $app . '-clone'), $root);
    if ($code !== 0) {
        remove_tree($dest);
        stop("git clone of the last commit failed:\n" . $out);
    }
    remove_tree($app);
    if (!@rename($app . '-clone', $app)) {
        stop('Could not settle the clone at ' . $app);
    }
    echo "copy: git clone of the last commit (HEAD)\n";
} elseif ($index) {
    // The staged snapshot, and nothing else: git writes the index out without a
    // .git, so this is exactly the tree the commit will contain.
    list($code, $out) = run(array('git', '-C', $root, 'checkout-index', '-a', '-f', '--prefix=' . $app . '/'), $root);
    if ($code !== 0) {
        remove_tree($dest);
        stop("Could not export the staged snapshot:\n" . $out);
    }
    $count = 0;
    $walk = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($app, FilesystemIterator::SKIP_DOTS));
    foreach ($walk as $item) {
        if ($item->isFile()) { $count++; }
    }
    echo "copy: the staged snapshot -- " . $count . " files (what this commit will contain)\n";
} else {
    list($code, $files) = run(array('git', '-C', $root, 'ls-files', '-z', '-co', '--exclude-standard'), $root);
    if ($code !== 0) {
        remove_tree($dest);
        stop("This is not a git work tree, so there is no file list to copy:\n" . $files
            . "\nRun it from a checkout -- git supplies the list of files that belong to the repo.");
    }
    $copied = 0;
    $gone = 0;
    foreach (array_filter(explode("\0", $files), 'strlen') as $rel) {
        $src = $root . '/' . $rel;
        if (!is_file($src) && !is_link($src)) {
            // Listed in the index, deleted on disk. Worth counting: the copy is
            // meant to be the tree as it is, not as it was committed.
            $gone++;
            continue;
        }
        $to = $app . '/' . $rel;
        if (!is_dir(dirname($to)) && !@mkdir(dirname($to), 0777, true)) {
            stop('Could not create ' . dirname($to));
        }
        if (!@copy($src, $to)) {
            stop('Could not copy ' . $rel . ' into the fresh copy.');
        }
        $copied++;
    }
    echo "copy: the working tree as git sees it -- " . $copied . " files"
        . ($gone ? " (" . $gone . " listed in the index but missing on disk)" : '') . "\n";
}

$t_copied = microtime(true);

// The point of the exercise: none of the operator's runtime state is here. Say
// so, because that absence is the thing the suites are being checked against.
$runtime = array();
foreach (array('storage/config.json', 'storage/state.json', 'storage/exec.log', 'storage/mcp.log') as $rel) {
    if (file_exists($app . '/' . $rel)) {
        $runtime[] = $rel;
    }
}
echo "copy: no storage runtime state" . ($runtime ? ' (except ' . implode(', ', $runtime) . ')' : '') . "\n";
if (!$head) {
    echo "copy: no .git" . (is_dir($app . '/.git') ? ' (there IS one)' : '') . "\n";
}
echo "copy: " . $app . "\n\n";

$suites = array(
    'PHP' => array(PHP_BINARY, 'tests/php/run.php'),
    'JS' => array('node', 'tests/js/run.mjs'),
);
$failed = array();
$summaries = array();
$seconds = array();

foreach ($suites as $label => $cmd) {
    echo str_repeat('-', 60) . "\n";
    echo $label . ": " . implode(' ', $cmd) . "  (in the fresh copy)\n";
    echo str_repeat('-', 60) . "\n";
    $suiteStart = microtime(true);
    list($code, $out) = run($cmd, $app);
    $seconds[$label] = microtime(true) - $suiteStart;
    echo $out;
    if ($code !== 0) {
        $failed[] = $label;
    }
    $summaries[$label] = $code === 127
        ? 'did not run -- ' . trim(last_line($out))
        : last_line($out);
}

echo str_repeat('=', 60) . "\n";
foreach ($summaries as $label => $summary) {
    echo str_pad($label, 4) . ' ' . $summary . "\n";
}

// What it cost, measured -- printed on the way past on BOTH outcomes, because a
// failure's duration is a fact about the failure. The README and the
// pre-commit hook each quote a figure so a reader can decide whether to pay it;
// a quoted figure nobody re-measures drifts (this one was wrong by 3x), and this
// line is what makes the documented number checkable instead of remembered.
$phases = array('copy ' . number_format($t_copied - $t_started, 1) . 's');
foreach ($seconds as $label => $took) {
    $phases[] = $label . ' ' . number_format($took, 1) . 's';
}
echo 'took: ' . number_format(microtime(true) - $t_started, 1) . 's  (' . implode(', ', $phases) . ")\n";

if ($failed) {
    echo "\nFAILED: " . implode(' and ', $failed) . " in a fresh copy of this tree.\n";
    echo "The copy is kept for inspection: " . $app . "\n";
    exit(1);
}

if ($keep) {
    echo "\nBoth suites pass in a fresh copy of this tree. Copy kept: " . $app . "\n";
} else {
    remove_tree($dest);
    echo "\nBoth suites pass in a fresh copy of this tree.\n";
}
exit(0);
