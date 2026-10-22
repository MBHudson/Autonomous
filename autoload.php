<?php
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