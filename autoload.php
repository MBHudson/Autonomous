<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// Router Module Autoloader
// Include this file to load all router classes

spl_autoload_register(function($class) {
    // Project namespace prefix
    $prefix = 'Src\\';
    
    // Base directory for the classes
    $baseDir = __DIR__ . '/src/';
    
    // Check if the class uses the prefix
    if (strncmp($prefix, $class, strlen($prefix)) !== 0) {
        // No, move to next autoload
        return;
    }
    
    // Get the relative class name
    $relativeClass = substr($class, strlen($prefix));
    
    // Replace namespace separators with directory separators and append .php
    $file = $baseDir . str_replace('\\', '/', $relativeClass) . '.php';
    
    // If the file exists, require it
    if (file_exists($file)) {
        require $file;
    }
});

// A hand-off that failed gets another go here.
//
// An install that could not replace the file it was running from leaves
// storage/updates/install.json on "finishing". The installer that got there is
// the copy being replaced, so on a host where THAT copy cannot find the PHP CLI
// nothing ever retried: the entry script waited as .router-new-index.php, the app
// reported the new version, and a human had to run install-update.php --finish.
//
// This file is one of the ones an install replaces, which makes it the right
// place to try again: by the next request, Src\Install on disk is the new one,
// with a phpCli() that can actually find PHP. One stat on a normal request, and
// a failure here can never break the request it is repairing after.
if (PHP_SAPI !== 'cli' && is_file(__DIR__ . '/storage/updates/install.json')) {
    try {
        \Src\Install::resume();
    } catch (\Throwable $e) {
        // Silence: the request still has to answer.
    }
}

// Helper functions
function jsonResponse($data, $status = 200) {
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($data);
    exit;
}

function getConfig() {
    $configFile = __DIR__ . '/storage/config.json';
    if (file_exists($configFile)) {
        return json_decode(file_get_contents($configFile), true);
    }
    return [
        'theme' => 'neon',
        'sounds_enabled' => true,
        'auto_scroll' => true,
        'code_isolation' => true,
        'session_timeout' => 86400
    ];
}

function saveConfig($config) {
    $configFile = __DIR__ . '/storage/config.json';
    return file_put_contents($configFile, json_encode($config, JSON_PRETTY_PRINT));
}
?>