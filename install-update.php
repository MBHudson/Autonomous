<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Install (or undo) a downloaded update from the command line.
 *
 *   php install-update.php              install what is staged
 *   php install-update.php --finish     swap in any file an install had to defer
 *   php install-update.php --rollback   restore the newest backup in storage/backups
 *   php install-update.php --status     what is staged, and what the last run did
 *
 * Why this exists as a separate file: the app installs updates fine when the
 * web server owns its files, but not when it does not — and it cannot fix a tree
 * that a half-finished update already broke, because the code that would do the
 * fixing is inside that tree. This shim loads ONE file (src/Install.php), uses
 * no autoloader and no framework, and therefore keeps working when nothing else
 * does. It is also the escape hatch for a Linux host where www-data cannot write
 * the app folder: run it as the user who can.
 *
 * Nothing here is reachable over HTTP: `install-update.php` is a plain script
 * with no side effects on GET, it refuses to do anything without a staged plan,
 * and every path it writes goes through the same refusals as the web path.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    header('Content-Type: text/plain');
    echo "install-update.php is a command-line tool.\n\n"
        . "Run it from a terminal in the app folder:\n"
        . "  php install-update.php\n";
    exit;
}

$installer = __DIR__ . '/src/Install.php';
if (!is_file($installer)) {
    fwrite(STDERR, "src/Install.php is missing — this copy cannot install an update.\n");
    exit(1);
}
require $installer;

$arg = isset($argv[1]) ? strtolower(trim((string) $argv[1])) : 'install';

function line($text = '')
{
    echo $text . "\n";
}

function fail($text)
{
    fwrite(STDERR, "\n" . $text . "\n");
    exit(1);
}

line('');
line('Autonomous Loop Studio — update installer (command line)');
line(str_repeat('-', 58));

try {
    if ($arg === '--status' || $arg === 'status') {
        $pre = \Src\Install::preflight();
        line('This copy:      v' . ($pre['currentVersion'] ?: '?'));
        line('Staged release: ' . ($pre['targetVersion'] ? 'v' . $pre['targetVersion'] : '(nothing downloaded)'));
        line('Can install:    ' . ($pre['ok'] ? 'yes' : 'no — ' . implode(' ', $pre['problems'])));
        $pending = \Src\Install::pendingSwaps();
        line('Waiting swaps:  ' . ($pending ? implode(', ', $pending) . '  (run --finish)' : '(none)'));
        $snaps = \Src\Install::snapshots();
        line('Backups:        ' . ($snaps ? count($snaps) . ' in storage/backups' : '(none)'));
        foreach ($snaps as $s) {
            line('  · ' . $s['name'] . '  (v' . ($s['version'] ?: '?') . ', ' . $s['files'] . ' files, '
                . date('Y-m-d H:i', $s['at']) . ')');
        }
        $log = \Src\Install::tailLog(10);
        if ($log !== '') {
            line('');
            line('Last lines of storage/updates/install.log:');
            line($log);
        }
        line('');
        exit(0);
    }

    if ($arg === '--finish' || $arg === 'finish') {
        // The web installer runs INSIDE api/index.php, and Windows will not let
        // a process rename the script it is executing. That one file is written
        // as .router-new-index.php and left for somebody who is not holding it:
        // this command, spawned automatically at the end of a web install.
        $res = \Src\Install::finish();
        if ($res['swapped']) {
            line('Swapped in: ' . implode(', ', $res['swapped']));
        }
        if (!$res['ok']) {
            line('Still held by the running server: ' . implode(', ', $res['pending']));
            line('Stop Apache, then run this again:  php install-update.php --finish');
            line('');
            exit(1);
        }
        if (!$res['swapped']) {
            line('Nothing was waiting to be swapped in.');
        }
        line('');
        exit(0);
    }

    if ($arg === '--rollback' || $arg === 'rollback') {
        $dir = isset($argv[2]) ? (string) $argv[2] : null;
        line('Restoring ' . ($dir ?: 'the newest backup') . '…');
        $res = \Src\Install::rollback($dir);
        line('Done. ' . $res['restored'] . ' file(s) restored, ' . $res['unchanged'] . ' already correct.');
        line('This copy now reports v' . ($res['to'] ?: '?') . '.');
        line('');
        line('Restart the web server (or reload the page) to pick it up.');
        line('');
        exit(0);
    }

    // Default: install.
    $pre = \Src\Install::preflight();
    if (!$pre['ok']) {
        fail('Cannot install yet: ' . implode(' ', $pre['problems']));
    }
    line('Installing v' . $pre['targetVersion'] . ' over v' . ($pre['currentVersion'] ?: '?') . '.');
    line('A rollback copy is written to storage/backups first. Nothing under storage/ is touched.');
    line('');

    $res = \Src\Install::apply();

    line('Installed ' . $res['installed'] . ' file(s). This copy now reports v' . ($res['to'] ?: '?') . '.');
    line('Rollback copy: ' . $res['backup']);
    line('');
    line('If anything looks wrong:  php install-update.php --rollback');
    line('');
    exit(0);
} catch (\Throwable $e) {
    fail('Failed: ' . $e->getMessage() . "\n\n"
        . "The app tree is as it was before the failing file. To undo the whole install:\n"
        . "  php install-update.php --rollback");
}
