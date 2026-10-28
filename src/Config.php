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
     * What a stored secret looks like on the way OUT.
     *
     * GET /config used to answer with the file verbatim -- the access token,
     * every MCP server's Authorization header, every friend's inbound token.
     * That route is behind the web token, but the web token itself is off on a
     * copy running without one (setup-token.sh --off), and it disclosed the
     * very values the other gates check: `sandbox.token` is what
     * Sandbox::checkAccess() compares, and the friend tokens are what
     * McpServer::authenticate() compares. One unauthenticated GET handed over
     * the keys to every other door.
     *
     * So the read path masks them and the write path puts them back: an editor
     * that round-trips a value it never displayed must not overwrite it with
     * asterisks. Secret values are visible only at the moment they are typed or
     * generated (see McpServer::saveConfig for friend tokens).
     */
    const SECRET_MASK = '********';

    /** Is this value the mask, i.e. "unchanged, keep what you have"? */
    public static function isMask($value) {
        return is_string($value) && $value === self::SECRET_MASK;
    }

    /**
     * Every stored secret replaced by the mask, for anything that LEAVES.
     *
     * Non-strings and empty values are left alone: an unset token must still
     * read as unset, so the UI can tell "no token configured" from "a token
     * you are not allowed to see".
     */
    public static function maskSecrets($cfg) {
        if (!is_array($cfg)) { return $cfg; }

        if (!empty($cfg['sandbox']['token'])) {
            $cfg['sandbox']['token'] = self::SECRET_MASK;
        }
        // A proxy URL can carry user:password in its authority. Mask it only
        // when it actually does, so a plain http://host:port stays readable
        // (the UI shows which proxy is active, and that is not a secret).
        $proxy = (string)($cfg['sandbox']['proxy_active'] ?? '');
        if ($proxy !== '' && preg_match('#^[a-z][a-z0-9+.\-]*://[^/@\s]+@#i', $proxy)) {
            $cfg['sandbox']['proxy_active'] = self::SECRET_MASK;
        }

        foreach ((array)($cfg['mcp']['servers'] ?? []) as $i => $server) {
            if (!is_array($server)) { continue; }
            $cfg['mcp']['servers'][$i] = self::maskServerSecrets($server);
        }

        foreach ((array)($cfg['mcp_server']['tokens'] ?? []) as $i => $token) {
            if (is_array($token) && !empty($token['token'])) {
                $cfg['mcp_server']['tokens'][$i]['token'] = self::SECRET_MASK;
            }
        }

        return $cfg;
    }

    /**
     * One MCP client server with its credentials replaced by the mask.
     *
     * headers and env are free-form key/value bags, so whatever the operator
     * put in them is a credential as far as a read route knows -- an
     * Authorization header, a GITHUB_TOKEN, a session cookie. Public because
     * GET /mcp/servers needs exactly this and must not grow a second copy of
     * the rule (Mcp::uiServers() calls it).
     */
    public static function maskServerSecrets(array $server) {
        foreach (['headers', 'env'] as $field) {
            if (!isset($server[$field]) || !is_array($server[$field])) { continue; }
            foreach ($server[$field] as $key => $value) {
                if (is_scalar($value) && (string)$value !== '') {
                    $server[$field][$key] = self::SECRET_MASK;
                }
            }
        }
        return $server;
    }

    /**
     * Put stored secrets back wherever the incoming config carries the mask.
     *
     * Matching is by identity first, never by guesswork that could attach one
     * server's credential to another:
     *
     *   * an MCP server is matched by its id, then by its URL (http) or by its
     *     command line (stdio) -- that second key is what survives a rename;
     *   * a friend token is matched by its id, then its label, then its index.
     *
     * Anything with no match is dropped rather than written: storing the mask
     * would lock the friend out with "invalid token", and storing a token under
     * a fresh id would attach a credential to whatever the operator had just
     * renamed.
     *
     * @return array{0:array,1:int,2:array} [config, restored count, dropped names]
     */
    public static function restoreSecrets($incoming, $stored) {
        if (!is_array($incoming)) { return [$incoming, 0, []]; }
        if (!is_array($stored)) { $stored = []; }
        $restored = 0;
        $dropped = [];

        foreach (['token', 'proxy_active'] as $field) {
            if (!self::isMask($incoming['sandbox'][$field] ?? null)) { continue; }
            $have = (string)($stored['sandbox'][$field] ?? '');
            if ($have !== '') {
                $incoming['sandbox'][$field] = $have;
                $restored++;
            } else {
                $incoming['sandbox'][$field] = '';
                $dropped[] = 'sandbox.' . $field;
            }
        }

        $inServers = $incoming['mcp']['servers'] ?? null;
        if (is_array($inServers)) {
            [$inServers, $n, $d] = self::restoreServerSecrets(
                $inServers, (array)($stored['mcp']['servers'] ?? []));
            $incoming['mcp']['servers'] = $inServers;
            $restored += $n;
            $dropped = array_merge($dropped, $d);
        }

        $inTokens = $incoming['mcp_server']['tokens'] ?? null;
        if (is_array($inTokens)) {
            $store = array_values(array_filter((array)($stored['mcp_server']['tokens'] ?? []), 'is_array'));
            foreach ($inTokens as $i => $token) {
                if (!is_array($token) || !self::isMask($token['token'] ?? null)) { continue; }
                $have = self::matchStoredToken($store, $token, (int)$i);
                if ($have !== null) {
                    $incoming['mcp_server']['tokens'][$i]['token'] = $have;
                    $restored++;
                } else {
                    // Unmatched: generate a fresh one rather than storing the
                    // mask. A new token is recoverable; a masked-out friend is
                    // a support ticket.
                    $incoming['mcp_server']['tokens'][$i]['token'] = bin2hex(random_bytes(32));
                    $dropped[] = 'friend "' . (string)($token['label'] ?? $i) . '" (no stored token; issued a new one)';
                }
            }
        }

        return [$incoming, $restored, $dropped];
    }

    /**
     * The same job for one list of MCP client servers.
     *
     * Split out because there are two write paths to the same list and they had
     * to agree: POST /config (the whole file, read-modify-write by the panels)
     * and POST /mcp/servers (the MCP client card, which sends the list on its
     * own). Both read the list back through a masking route first, so both need
     * the credentials put back before anything is normalised or saved -- a
     * masked value that reaches disk locks that server out with a 401 and the
     * operator sees only "not reachable".
     *
     * @return array{0:array,1:int,2:array} [servers, restored count, dropped names]
     */
    public static function restoreServerSecrets(array $servers, array $stored) {
        $store = [];
        foreach ($stored as $s) {
            if (is_array($s)) { $store[] = $s; }
        }
        $restored = 0;
        $dropped = [];
        foreach ($servers as $i => $server) {
            if (!is_array($server)) { continue; }
            $match = self::matchServer($store, $server, (int)$i);
            foreach (['headers', 'env'] as $field) {
                foreach ((array)($server[$field] ?? []) as $key => $value) {
                    if (!self::isMask($value)) { continue; }
                    $have = ($match === null || !is_array($match[$field] ?? null))
                        ? null : ($match[$field][$key] ?? null);
                    if (is_scalar($have) && (string)$have !== '' && !self::isMask($have)) {
                        $servers[$i][$field][$key] = (string)$have;
                        $restored++;
                    } else {
                        // No stored value for this key: drop it rather than
                        // writing the mask in as a literal credential.
                        unset($servers[$i][$field][$key]);
                        $dropped[] = 'mcp server "' . (string)($server['id'] ?? $server['name'] ?? $i)
                            . '" ' . $field . '.' . $key;
                    }
                }
                if (empty($servers[$i][$field])) { unset($servers[$i][$field]); }
            }
        }
        return [$servers, $restored, $dropped];
    }

    /**
     * The stored MCP server an incoming one refers to, or null.
     *
     * id first (that is the server's name in this app), then the URL, then the
     * command line -- a rename must not lose the Authorization header that
     * belongs to it, and a positional fallback is deliberately NOT used because
     * it would attach one server's credential to another's endpoint.
     */
    private static function matchServer(array $store, array $server, $index) {
        $id = strtolower(trim((string)($server['id'] ?? $server['name'] ?? '')));
        if ($id !== '') {
            foreach ($store as $s) {
                if (strtolower(trim((string)($s['id'] ?? $s['name'] ?? ''))) === $id) { return $s; }
            }
        }
        $url = trim((string)($server['url'] ?? ''));
        if ($url !== '') {
            foreach ($store as $s) {
                if (trim((string)($s['url'] ?? '')) === $url) { return $s; }
            }
        }
        $command = trim((string)($server['command'] ?? ''));
        if ($command !== '') {
            $args = implode(' ', array_map('strval', (array)($server['args'] ?? [])));
            foreach ($store as $s) {
                if (trim((string)($s['command'] ?? '')) === $command
                    && implode(' ', array_map('strval', (array)($s['args'] ?? []))) === $args) { return $s; }
            }
        }
        // Last resort: the same position, but only when the stored entry has
        // no id at all (a hand-edited config), so a rename is never guessed.
        $stored = $store[$index] ?? null;
        if ($stored !== null && trim((string)($stored['id'] ?? $stored['name'] ?? '')) === '') { return $stored; }
        return null;
    }

    /**
     * The stored friend token an incoming (masked) one refers to.
     *
     * Public because McpServer::saveConfig() writes the friend list on its own
     * route (POST /mcp-server/config) and has to resolve a masked row the same
     * way this does; a second implementation is how the two drift.
     */
    public static function matchStoredToken(array $store, array $token, $index) {
        $id = trim((string)($token['id'] ?? ''));
        if ($id !== '') {
            foreach ($store as $t) {
                if (trim((string)($t['id'] ?? '')) === $id && !empty($t['token'])) { return (string)$t['token']; }
            }
        }
        $label = strtolower(trim((string)($token['label'] ?? '')));
        if ($label !== '') {
            foreach ($store as $t) {
                if (strtolower(trim((string)($t['label'] ?? ''))) === $label && !empty($t['token'])) {
                    return (string)$t['token'];
                }
            }
        }
        // Friend rows keep their order and carry ids, so the index is a safe
        // last resort here in a way it is not for servers (whose rows can be
        // reordered by editing a URL).
        $t = $store[$index] ?? null;
        return ($t !== null && !empty($t['token'])) ? (string)$t['token'] : null;
    }

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
        //
        // Every write goes through the gate guard below. A config that does not
        // MENTION require_token or token keeps the ones on disk, because both
        // settings belong to this machine: the UI round-trips the config it
        // read, and a backup import carries the config of wherever it came
        // from. Writing such a payload verbatim is how a LAN-reachable install
        // lost its access token and its gate -- the request looked like an
        // ordinary save, and the only symptom was that every endpoint answered
        // without a token. An explicit value (including false, or an empty
        // token) is still honoured: turning the gate off is a decision, just
        // not one a payload can make by leaving the key out.
        $config = self::keepLocalGate($config);
        return file_put_contents(self::configPath(), json_encode($config, JSON_PRETTY_PRINT)) !== false;
    }

    /**
     * Put back the keys that belong to this machine when a caller omitted them.
     *
     * Absent means "I am not changing this", never "clear it". Those four keys
     * are the gate flag, the token guarding it, and the two sandbox roots: a
     * payload that does not mention them is not making a statement about them,
     * and a partial write used to erase all four (the roots went first, and the
     * file tools were then scoped to nothing at all).
     *
     * An explicit value is still obeyed -- `require_token: false` disarms,
     * `"token": ""` clears, `read_roots: []` means no roots -- so nothing here
     * blocks a change somebody actually asked for. `setup-token.sh --off` writes
     * the file directly and never comes through this path.
     */
    private static function keepLocalGate($config) {
        if (!is_array($config)) { return $config; }
        $path = self::configPath();
        $stored = is_file($path) ? json_decode((string)@file_get_contents($path), true) : null;
        if (!is_array($stored) || !is_array($stored['sandbox'] ?? null)) { return $config; }
        if (!isset($config['sandbox']) || !is_array($config['sandbox'])) { $config['sandbox'] = []; }
        foreach (['require_token', 'token', 'read_roots', 'write_roots'] as $key) {
            if (!array_key_exists($key, $config['sandbox']) && array_key_exists($key, $stored['sandbox'])) {
                $config['sandbox'][$key] = $stored['sandbox'][$key];
            }
        }
        return $config;
    }

    /**
     * A backup's config, made safe for the machine restoring it.
     *
     * An import is a restore, so almost everything arrives verbatim on purpose
     * -- exec allow/deny lists, timeouts, provider settings. Four keys are not
     * settings but facts about THIS host, and a backup cannot know them:
     *
     *   * `require_token` and `token` -- this install's gate and the credential
     *     guarding it. A backup from a machine with the gate off would disarm
     *     this one; a backup from another machine carries a token no device here
     *     has ever been given, which locks out every browser that was working.
     *     Both stay exactly as they are on disk, whatever the archive says.
     *   * `read_roots` / `write_roots` -- absolute paths, so a backup taken on
     *     Linux restores `/var/www/...` onto a Windows box and every file tool
     *     is scoped to somewhere the operator never chose. These are kept as
     *     this machine has them whenever it has any, even if the imported path
     *     happens to exist here (a `C:\var\www\...` mirror of a Linux layout
     *     is exactly the kind of coincidence that would otherwise pass a
     *     "does it exist" test). Only an install with NO roots of its own -- a
     *     fresh restore onto a new machine -- adopts the backup's, and only the
     *     ones that exist here.
     *
     * @return array{0:array,1:array} [config to save, notes for the operator]
     */
    public static function sanitizeImportedConfig($incoming, $current) {
        $config = is_array($incoming) ? $incoming : [];
        $current = is_array($current) ? $current : [];
        $stored = is_array($current['sandbox'] ?? null) ? $current['sandbox'] : [];
        if (!isset($config['sandbox']) || !is_array($config['sandbox'])) { $config['sandbox'] = []; }
        $notes = [];

        foreach (['require_token' => 'the access-token gate', 'token' => 'the access token'] as $key => $label) {
            $changed = array_key_exists($key, $config['sandbox'])
                && ($config['sandbox'][$key] ?? null) !== ($stored[$key] ?? null);
            if (array_key_exists($key, $stored)) {
                $config['sandbox'][$key] = $stored[$key];
            } else {
                // Never armed here: do not let a backup arm it either.
                unset($config['sandbox'][$key]);
            }
            if ($changed) { $notes[] = $label . ' kept as this machine had it'; }
        }

        foreach (['read_roots', 'write_roots'] as $field) {
            $local = [];
            foreach ((array)($stored[$field] ?? []) as $root) {
                if (is_scalar($root) && trim((string)$root) !== '') { $local[] = (string)$root; }
            }
            $incomingRoots = [];
            foreach ((array)($config['sandbox'][$field] ?? []) as $root) {
                if (is_scalar($root) && trim((string)$root) !== '') { $incomingRoots[] = (string)$root; }
            }

            if ($local) {
                // This install has roots of its own: the backup does not get to
                // move them, however plausible its paths look on this disk.
                if ($incomingRoots !== $local) {
                    $notes[] = $field . ' kept as this machine had it (the backup said '
                        . ($incomingRoots ? implode(', ', $incomingRoots) : 'nothing') . ')';
                }
                $config['sandbox'][$field] = $local;
                continue;
            }

            // No roots here (a restore onto a fresh machine): adopt the backup's,
            // but only the ones that really are directories on this disk.
            $kept = [];
            $dropped = [];
            foreach ($incomingRoots as $root) {
                if (@is_dir($root)) { $kept[] = $root; } else { $dropped[] = $root; }
            }
            if ($dropped) {
                $notes[] = $field . ' dropped ' . implode(', ', $dropped) . ' (not on this machine)';
            }
            $config['sandbox'][$field] = $kept;
        }

        return [$config, $notes];
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