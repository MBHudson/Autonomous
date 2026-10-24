<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// Core Configuration Manager
namespace Src;

class Config {
    private static $configPath = __DIR__ . '/../storage/config.json';
    private static $modelsPath = __DIR__ . '/../storage/models.json';
    private static $sessionsPath = __DIR__ . '/../storage/sessions/';

    /**
     * Optional override for tests and side-by-side installs. Point
     * ROUTER_CONFIG at another JSON file and nothing under storage/ is touched.
     */
    private static function configPath() {
        $env = getenv('ROUTER_CONFIG');
        return is_string($env) && trim($env) !== '' ? trim($env) : self::$configPath;
    }

    public static function loadConfig() {
        $path = self::configPath();
        if (!file_exists($path)) {
            if ($path === self::$configPath) { self::saveDefaultConfig(); }
            else { return []; }
        }
        return json_decode(file_get_contents($path), true);
    }
    
    public static function saveConfig($config) {
        // Returns success, because callers decide what "saved" means: a deny
        // or allow decision that reports ok:true without persisting is a lie
        // the operator cannot detect. This used to return void while the
        // storage file was root-owned and the web user could not write it, so
        // every UI save silently did nothing.
        return file_put_contents(self::configPath(), json_encode($config, JSON_PRETTY_PRINT)) !== false;
    }
    
    private static function saveDefaultConfig() {
        $default = [
            'theme' => 'neon',
            'sounds_enabled' => true,
            'auto_scroll' => true,
            'code_isolation' => true,
            'session_timeout' => 86400
        ];
        file_put_contents(self::configPath(), json_encode($default, JSON_PRETTY_PRINT));
    }
    
    public static function getModels() {
        if (!file_exists(self::$modelsPath)) {
            self::saveDefaultModels();
        }
        return json_decode(file_get_contents(self::$modelsPath), true);
    }
    
    public static function addModel($model) {
        $models = self::getModels();
        $models[] = $model;
        file_put_contents(self::$modelsPath, json_encode($models, JSON_PRETTY_PRINT));
    }
    
    public static function removeModel($id) {
        $models = self::getModels();
        $models = array_filter($models, function($m) use ($id) {
            return $m['id'] !== $id;
        });
        file_put_contents(self::$modelsPath, json_encode($models, JSON_PRETTY_PRINT));
    }
    
    private static function saveDefaultModels() {
        $default = [
            [
                'id' => 'gpt4',
                'name' => 'ChatGPT-4',
                'provider' => 'openrouter',
                'endpoint' => 'https://openrouter.ai/api/v1/chat/completions',
                'model' => 'openai/gpt-4o',
                'api_key' => '',
                'priority' => 1,
                'role' => 'coder',
                'active' => true
            ],
            [
                'id' => 'claude',
                'name' => 'Claude 3.5',
                'provider' => 'anthropic',
                'endpoint' => 'https://api.anthropic.com/v1/messages',
                'model' => 'claude-3-5-sonnet-20241022',
                'api_key' => '',
                'priority' => 2,
                'role' => 'architect',
                'active' => true
            ],
            [
                'id' => 'gemini',
                'name' => 'Gemini 2.0',
                'provider' => 'google',
                'endpoint' => 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
                'model' => 'gemini-2.0-flash',
                'api_key' => '',
                'priority' => 3,
                'role' => 'reviewer',
                'active' => false
            ]
        ];
        file_put_contents(self::$modelsPath, json_encode($default, JSON_PRETTY_PRINT));
    }
}