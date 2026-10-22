<?php
// Session Management - Persistent JSON-based sessions
namespace Src;

class SessionManager {
    private static $sessionsPath = __DIR__ . '/../storage/sessions/';
    private static $sessionTimeout = 86400; // 24 hours
    
    public static function init() {
        if (!is_dir(self::$sessionsPath)) {
            mkdir(self::$sessionsPath, 0755, true);
        }
    }
    
    public static function createSession($title = 'New Session') {
        self::init();
        
        $sessionId = uniqid('sess_' . bin2hex(random_bytes(4)) . '_', true);
        $session = [
            'id' => $sessionId,
            'title' => $title,
            'created_at' => time(),
            'last_activity' => time(),
            'active' => true,
            'models_used' => [],
            'dialogs' => [],
            'settings' => [],
            'metadata' => [
                'version' => '1.0',
                'user_agent' => $_SERVER['HTTP_USER_AGENT'] ?? 'Unknown'
            ]
        ];
        
        file_put_contents(
            self::$sessionsPath . $sessionId . '.json',
            json_encode($session, JSON_PRETTY_PRINT)
        );
        
        return $sessionId;
    }
    
    public static function getSession($sessionId) {
        self::init();
        
        $path = self::$sessionsPath . $sessionId . '.json';
        if (!file_exists($path)) {
            return null;
        }
        
        // Check if session has expired
        $session = json_decode(file_get_contents($path), true);
        if (time() - $session['last_activity'] > self::$sessionTimeout) {
            $session['active'] = false;
            self::saveSession($sessionId, $session);
        }
        
        $session['last_activity'] = time();
        file_put_contents($path, json_encode($session, JSON_PRETTY_PRINT));
        
        return $session;
    }
    
    public static function addDialog($sessionId, $dialog) {
        $session = self::getSession($sessionId);
        if (!$session) return false;
        
        $session['dialogs'][] = $dialog;
        $session['last_activity'] = time();
        
        return self::saveSession($sessionId, $session);
    }
    
    public static function updateSession($sessionId, $updates) {
        $session = self::getSession($sessionId);
        if (!$session) return false;
        
        foreach ($updates as $key => $value) {
            if ($key === 'active') {
                $session['active'] = (bool)$value;
            } elseif ($key === 'title') {
                $session['title'] = $value;
            } elseif ($key === 'models_used') {
                $session['models_used'] = array_unique(
                    array_merge($session['models_used'] ?? [], $value)
                );
            } elseif ($key === 'settings') {
                $session['settings'] = array_merge(
                    $session['settings'] ?? [], $value
                );
            }
        }
        
        $session['last_activity'] = time();
        return self::saveSession($sessionId, $session);
    }
    
    public static function saveSession($sessionId, $session) {
        $path = self::$sessionsPath . $sessionId . '.json';
        return file_put_contents($path, json_encode($session, JSON_PRETTY_PRINT)) !== false;
    }
    
    public static function deleteSession($sessionId) {
        $path = self::$sessionsPath . $sessionId . '.json';
        if (file_exists($path)) {
            return unlink($path);
        }
        return false;
    }
    
    public static function getSessions() {
        self::init();
        
        $sessions = [];
        $files = glob(self::$sessionsPath . '*.json');
        
        foreach ($files as $file) {
            $session = json_decode(file_get_contents($file), true);
            if ($session && ($session['active'] ?? false)) {
                $sessions[] = $session;
            }
        }
        
        // Sort by last activity (newest first)
        usort($sessions, function($a, $b) {
            return $b['last_activity'] - $a['last_activity'];
        });
        
        return $sessions;
    }
    
    public static function closeSession($sessionId) {
        $session = self::getSession($sessionId);
        if (!$session) return false;
        
        $session['active'] = false;
        $session['closed_at'] = time();
        return self::saveSession($sessionId, $session);
    }
    
    public static function exportSession($sessionId) {
        $session = self::getSession($sessionId);
        if (!$session) return false;
        
        $filename = 'session_' . $sessionId . '_' . date('Y-m-d_H-i-s') . '.json';
        $exportDir = __DIR__ . '/../storage/exports/';
        if (!is_dir($exportDir)) {
            mkdir($exportDir, 0755, true);
        }
        
        $exportPath = $exportDir . $filename;
        file_put_contents($exportPath, json_encode($session, JSON_PRETTY_PRINT));
        
        return $filename;
    }
}