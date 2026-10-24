<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Router Module Integration Example
 * 
 * This file demonstrates how to integrate the router module into any PHP application.
 * Copy this pattern to your own PHP files where you need multi-model AI capabilities.
 */

// Step 1: Include the router autoloader
require_once __DIR__ . '/autoload.php';

// Step 2: Import the classes you need
use Src\Config;
use Src\ModelManager;
use Src\SessionManager;
use Src\TopologyGraph;

// Step 3: Use the router functionality

// Example 1: Get all configured models
$models = Config::getModels();
echo "Available models:\n";
foreach ($models as $model) {
    echo "- {$model['name']} ({$model['provider']})\n";
}

// Example 2: Create a new session
$sessionId = SessionManager::createSession("My Coding Session");
echo "\nCreated session: $sessionId\n";

// Example 3: Process a query through active models
$manager = new ModelManager();
$results = $manager->processRequest("Write a PHP function to validate email addresses");

if (!empty($results)) {
    foreach ($results as $result) {
        echo "\nResponse from {$result['model_name']} ({$result['role']}):\n";
        echo substr($result['response'], 0, 200) . "...\n";
    }
}

// Example 4: Get topology data for visualization
$sessions = SessionManager::getSessions();
$topology = TopologyGraph::generateGraphData($sessions);
echo "\nTopology: " . count($topology['nodes']) . " nodes, " . count($topology['edges']) . " connections\n";

// Example 5: Add a new model programmatically
if (false) { // Set to true to test
    Config::addModel([
        'name' => 'Local Code Llama',
        'provider' => 'ollama',
        'endpoint' => 'http://localhost:11434/api/generate',
        'model' => 'codellama:13b-code',
        'api_key' => '',
        'priority' => 5,
        'role' => 'coder',
        'active' => true
    ]);
    echo "Added new model\n";
}

// Example 6: Export a session
if (isset($_GET['export'])) {
    $sessionId = $_GET['export'];
    $session = SessionManager::getSession($sessionId);
    if ($session) {
        echo "<pre>" . json_encode($session, JSON_PRETTY_PRINT) . "</pre>";
    }
}

// Example 7: Check router status
$config = Config::loadConfig();
$status = [
    'theme' => $config['theme'] ?? 'neon',
    'sounds_enabled' => $config['sounds_enabled'] ?? true,
    'active_models' => count(array_filter(Config::getModels(), fn($m) => $m['active']))
];
echo "\nRouter Status:\n";
print_r($status);

?>