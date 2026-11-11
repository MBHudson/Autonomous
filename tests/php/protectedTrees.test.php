<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The protected-path deny list inside whole-tree operations.
 *
 * Usage: php tests/php/protectedTrees.test.php
 *
 * grep and glob skip protected paths, but the tree operations did not: zip
 * walked every file under the root into the archive, copy reproduced the whole
 * tree under a readable name, and move/delete would relocate or shred secrets
 * the file tools refuse to touch. Zip and copy now SKIP a protected entry;
 * move, delete and unzip REFUSE, because none of those three can be undone
 * halfway.
 *
 * Exits 0 on success, 1 on any failure.
 */

$root = dirname(__DIR__, 2);
require $root . '/autoload.php';

use Src\Sandbox;

$pass = 0;
$fail = 0;
$errors = array();

function ok($cond, $name)
{
    global $pass, $fail, $errors;
    if ($cond) {
        $pass++;
        return true;
    }
    $fail++;
    $errors[] = 'FAIL: ' . $name;
    return false;
}

function rm_tree($dir)
{
    if (!is_dir($dir)) { return; }
    foreach ((array) @scandir($dir) as $entry) {
        if ($entry === '.' || $entry === '..') { continue; }
        $p = $dir . '/' . $entry;
        if (is_dir($p) && !is_link($p)) { rm_tree($p); } else { @unlink($p); }
    }
    @rmdir($dir);
}

echo "protected tree tests\n";

$base = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-trees-' . getmypid();
rm_tree($base);
$tree = $base . '/tree';
foreach (array($tree . '/storage', $tree . '/src', $base . '/logs') as $d) {
    @mkdir($d, 0775, true);
}
file_put_contents($tree . '/storage/config.json', "{\"sandbox\":{\"token\":\"MARKER\"}}\n");
file_put_contents($tree . '/src/app.js', "const MARKER = 1;\n");
file_put_contents($tree . '/notes.txt', "MARKER in the open\n");

$configFile = $base . '/config.json';
file_put_contents($configFile, json_encode(array('sandbox' => array(
    'read_roots' => array($base),
    'write_roots' => array($base),
    'require_token' => false,
    'token' => '',
    'exec_enabled' => false,
    'code_enabled' => false,
))));
putenv('ROUTER_CONFIG=' . $configFile);
putenv('ROUTER_LOG_DIR=' . $base . '/logs');

// --- zip skips it -----------------------------------------------------------
$zipFile = $base . '/a.zip';
$made = Sandbox::zipPaths(array($tree), $zipFile);
ok(is_file($zipFile) && (int)$made['items'] >= 1, 'zip: the archive is written');

$entries = null;
if (class_exists('ZipArchive')) {
    $z = new ZipArchive();
    if ($z->open($zipFile) === true) {
        $entries = array();
        for ($i = 0; $i < $z->numFiles; $i++) {
            $n = $z->getNameIndex($i);
            if ($n !== false) { $entries[] = str_replace('\\', '/', $n); }
        }
        $z->close();
    }
} elseif (class_exists('PharData')) {
    try {
        $entries = array();
        foreach (new RecursiveIteratorIterator(new PharData($zipFile)) as $f) {
            $entries[] = str_replace('\\', '/', $f->getPathname());
        }
    } catch (\Throwable $e) {
        $entries = null;
    }
}
if ($entries === null) {
    echo "SKIP: no zip extension available to read the archive back\n";
} else {
    $joined = implode("\n", $entries);
    ok(stripos($joined, 'storage/config.json') === false,
        'zip: storage/config.json is not archived');
    ok(stripos($joined, 'src/app.js') !== false,
        'zip: an ordinary file is archived');
}

// --- copy skips it ----------------------------------------------------------
$copy = $base . '/copy';
Sandbox::copyMove($tree, $copy);
ok(is_file($copy . '/src/app.js'), 'copy: an ordinary file is copied');
ok(!is_dir($copy . '/storage'), 'copy: the protected directory is skipped');
ok(!file_exists($copy . '/storage/config.json'), 'copy: the secret never appears in the copy');

// --- move refuses -----------------------------------------------------------
$moveMsg = '';
try {
    Sandbox::copyMove($tree, $base . '/moved', true);
} catch (\RuntimeException $e) {
    $moveMsg = $e->getMessage();
}
ok($moveMsg !== '' && stripos($moveMsg, 'protected') !== false,
    'move: a tree holding secrets is refused');
ok(is_file($tree . '/storage/config.json'), 'move: the secret is still where it was');

// --- delete refuses ---------------------------------------------------------
$removeMsg = '';
try {
    Sandbox::removePath($tree);
} catch (\RuntimeException $e) {
    $removeMsg = $e->getMessage();
}
ok(stripos($removeMsg, 'protected') !== false, 'remove: a tree holding secrets is refused');
ok(is_file($tree . '/storage/config.json') && is_file($tree . '/src/app.js'),
    'remove: nothing was deleted');

// --- a clean subtree still goes --------------------------------------------
Sandbox::removePath($tree . '/src');
ok(!is_dir($tree . '/src'), 'remove: an ordinary directory still deletes');

// --- cleanup ---------------------------------------------------------------
rm_tree($base);

echo str_repeat('-', 60) . "\n";
foreach ($errors as $e) { echo $e . "\n"; }
echo "protectedTrees: {$pass} passed, {$fail} failed\n";
exit($fail ? 1 : 0);
