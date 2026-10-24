<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// Router API - Multi-Model AI Orchestration
header('Content-Type: application/json');

// CORS: same-origin only.
//
// This used to be `Access-Control-Allow-Origin: *`, which let ANY website on
// the internet run fetch() against this server and read the answers: every
// agent's conversations, memory, and configuration. The UI is served from this
// same origin, so it never needed the wildcard -- it was pure attack surface.
//
// An extra allowlist can be supplied via ROUTER_CORS_ORIGINS (comma-separated)
// if a separate front end ever has to talk to it. Absent that, no Origin is
// echoed back, which is what makes a browser refuse the cross-origin call.
$routerCorsOrigins = array_filter(array_map('trim', explode(
    ',', (string)getenv('ROUTER_CORS_ORIGINS')
)));
$requestOrigin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');
// Default false, and never derived from the request unless the origin is
// explicitly listed. Same-origin requests send no Origin at all and are
// unaffected -- the browser does not apply CORS to them.
$routerCorsAllowed = $requestOrigin !== ''
    && in_array($requestOrigin, $routerCorsOrigins, true);

if ($routerCorsAllowed) {
    header('Access-Control-Allow-Origin: ' . $requestOrigin);
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Router-Token');
}
header('Vary: Origin');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    // A preflight only ever comes from a cross-origin caller. Without an
    // allowlisted Origin it is refused, so the browser stops here and never
    // sends the real request.
    http_response_code($routerCorsAllowed ? 204 : 403);
    exit(0);
}

// Load router classes
require_once __DIR__ . '/../autoload.php';
// The API Lab's request runner. A separate file because it is the one handler
// with its own safety rules (metadata-endpoint blocking, truncation) and it
// is a lot easier to keep those rules in one readable place.
require_once __DIR__ . '/lab.inc.php';

use Src\Config;
use Src\ModelManager;
use Src\Audio;
use Src\Sandbox;
use Src\Mcp;
use Src\McpServer;
use Src\Browser;
use Src\SessionManager;
use Src\TopologyGraph;

// Parse request
$method = $_SERVER['REQUEST_METHOD'];
$uri = $_SERVER['REQUEST_URI'];
$path = parse_url($uri, PHP_URL_PATH);

/**
 * Global authentication gate.
 *
 * Applies to EVERY endpoint, not just the sandbox ones. The reads were the
 * bigger leak: /api/state and /api/sessions return every agent's conversations
 * and memory to anyone who asks, and require_token never covered them.
 *
 * The token travels in X-Router-Token. A custom request header is deliberate:
 * it makes the browser send a CORS preflight for any cross-origin attempt, and
 * with no allowlisted Origin that preflight fails -- so the real request is
 * never sent. A plain POST could not have been stopped that way, because a
 * text/plain "simple request" is sent without any preflight at all.
 */
$routerConfig = Config::loadConfig();
$routerSandbox = $routerConfig['sandbox'] ?? [];
$routerToken = trim((string)($routerSandbox['token'] ?? ''));

// The MCP server RPC endpoint (/api/mcp-server) authenticates with its own
// per-friend Bearer token(s) — MCP clients send Authorization: Bearer, not our
// X-Router-Token. It is the one route the web-token gate leaves alone;
// McpServer::authenticate() guards it. The /mcp-server/config management route
// is NOT exempt (it stays behind the web token).
$isMcpRpc = (bool)preg_match('#/mcp-server/?$#', (string)$path);

if (!empty($routerSandbox['require_token']) && !$isMcpRpc) {
    // Fails CLOSED. This used to also require a non-empty token, which meant
    // require_token:true with no token set -- exactly what ships in the
    // handover bundle, since shipping a token would hand the recipient a live
    // credential -- silently disabled the gate. A freshly deployed copy was
    // wide open: no 401, no token, every conversation and API readable by
    // anyone who found the URL, while the README insisted you would get a 401.
    // Setting the flag has to be the thing that arms the gate.
    if ($routerToken === '') {
        http_response_code(503);
        header('Content-Type: application/json');
        // Actionable, and safe to show: this is the state an administrator has
        // to fix, not something a stranger is probing for.
        echo json_encode([
            'error' => 'no token configured',
            'detail' => 'This copy requires an access token but none is set. '
                . 'Run ./setup-token.sh to create one, or ./setup-token.sh --off '
                . 'to run without a token on a machine nothing else can reach.',
        ]);
        exit(0);
    }
    $routerSupplied = (string)($_SERVER['HTTP_X_ROUTER_TOKEN']
        ?? $_SERVER['HTTP_X_SANDBOX_TOKEN']
        ?? '');
    // Either header may carry the token: the sidebar field sends
    // X-Router-Token, the Config modal sends X-Sandbox-Token, and a browser
    // can hold a stale value in one while the other is current (typically
    // right after a rotation, when only one field got re-pasted). A correct
    // token in either header authenticates; a wrong one in the other is
    // ignored rather than letting a stale field lock out a good paste.
    // (hash_equals needs same-length strings to compare safely, so check
    // each header separately instead of concatenating them.)
    $routerAuthed = false;
    foreach (['HTTP_X_ROUTER_TOKEN', 'HTTP_X_SANDBOX_TOKEN'] as $routerHeader) {
        $candidate = (string)($_SERVER[$routerHeader] ?? '');
        if ($candidate !== '' && hash_equals($routerToken, $candidate)) {
            $routerAuthed = true;
            break;
        }
    }
    if (!$routerAuthed) {
        http_response_code(401);
        header('Content-Type: application/json');
        // Deliberately terse. This response goes to whoever is probing, and
        // there is no need to help them.
        echo json_encode(['error' => 'unauthorized']);
        exit(0);
    }
}

// Extract path after the api/ directory (works at any mount point)
$scriptDir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'])), '/');
$basePath = $scriptDir . '/';
$endpoint = '';
if (strpos($path, $basePath) === 0) {
    $endpoint = substr($path, strlen($basePath) - 1);
} else {
    $endpoint = '/';
}

$segments = explode('/', trim($endpoint, '/'));

$body = json_decode(file_get_contents('php://input'), true);

// Every call that leaves this machine (models, search, fetch, speech, MCP,
// diagnostics, proxy checks) goes through PHP's curl extension. A PHP with no
// php.ini -- the winget package, a bare zip -- has curl switched off, and the
// call then dies with a fatal error AFTER the stream headers went out, which
// the browser could only report as "the model returned an empty response".
// Say what is actually wrong instead.
$needsNet = ['llm', 'audio', 'sandbox', 'diag', 'lab', 'proxy-ping', 'proxy-ping-all', 'mcp', 'catalog', 'browser'];
if (in_array($segments[0] ?? '', $needsNet, true) && !function_exists('curl_init')) {
    http_response_code(503);
    echo json_encode([
        'success' => false,
        'error' => "PHP's curl extension is not enabled, so this server cannot reach the internet. "
            . 'Start the app with start.bat / start.sh (they switch it on), or enable '
            . '"extension=curl" in php.ini' . (php_ini_loaded_file() ? ' (' . php_ini_loaded_file() . ')' : ' (this PHP has no php.ini at all)')
            . ' and restart the server.',
        'code' => 'curl_missing',
    ]);
    exit;
}

try {
    switch ($segments[0] ?? '') {
        case 'models':
            handleModels($method, $segments, $body);
            break;
        case 'catalog':
            handleCatalog($method, $segments, $body);
            break;
        case 'sessions':
            handleSessions($method, $segments, $body);
            break;
        case 'query':
            handleQuery($method, $segments, $body);
            break;
        case 'llm':
            handleRelay($method, $segments, $body);
            break;
        case 'audio':
            handleAudio($method, $segments, $body);
            break;
        case 'sandbox':
            handleSandbox($method, $segments, $body);
            break;
        case 'topology':
            handleTopology($method, $segments, $body);
            break;
        case 'config':
            handleConfig($method, $segments, $body);
            break;
        case 'state':
            handleState($method, $segments, $body);
            break;
        case 'export':
            handleExport($method, $segments, $body);
            break;
        case 'backup':
            handleBackup($method, $segments, $body);
            break;
        case 'import':
            handleImport($method, $segments, $body);
            break;
        case 'diag':
            handleDiag($method, $segments, $body);
            break;
        case 'lab':
            handleLabRequest($method, $segments, $body);
            break;
        case 'proxies':
            handleProxies($method, $segments, $body);
            break;
        case 'proxy-ping':
            handleProxyPing($method, $segments, $body);
            break;
        case 'proxy-ping-all':
            handleProxyPingAll($method, $body);
            break;
        case 'proxy-active':
            handleProxyActive($method, $body);
            break;
        case 'mcp':
            handleMcp($method, $segments, $body);
            break;
        case 'mcp-server':
            handleMcpServer($method, $segments, $body, $_SERVER);
            break;
        case 'browser':
            handleBrowser($method, $segments, $body);
            break;
        case 'exec':
            handleExec($method, $segments, $body);
            break;
        default:
            echo json_encode(['error' => 'Endpoint not found']);
    }
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}

/**
 * Fetch a provider's live model catalog.
 *
 * The catalog URL is derived from the chat endpoint by dropping the last path
 * segment and appending "models" — Ollama is the exception (it exposes
 * /api/tags). Response shapes differ per provider, so ids are pulled from
 * data[].id, models[].name, or models[].id, and a leading "models/" is stripped
 * (Gemini returns names like "models/gemini-2.5-flash").
 *
 * POST { endpoint, api_key } -> { success, count, models: [...] }
 */
function handleCatalog($method, $segments, $body) {
    if ($method !== 'POST' || !$body) {
        echo json_encode(['error' => 'POST with endpoint required']);
        return;
    }
    $endpoint = trim((string)($body['endpoint'] ?? ''));
    $apiKey = trim((string)($body['api_key'] ?? ''));
    if ($endpoint === '') {
        echo json_encode(['error' => 'No endpoint']);
        return;
    }

    // Ollama-style: /api/chat -> /api/tags
    if (preg_match('~/api/chat$~', $endpoint)) {
        $catalog = preg_replace('~/api/chat$~', '/api/tags', $endpoint);
        $authHeader = null;
    } else {
        $ep = rtrim($endpoint, '/');
        // Drop the chat path, then APPEND /models. Replacing the last segment
        // turns .../v1 into .../models and loses the version prefix.
        if (preg_match('~/chat/completions$~', $ep)) {
            $catalog = preg_replace('~/chat/completions$~', '', $ep) . '/models';
        } else {
            $catalog = preg_replace('~/[^/]+$~', '', $ep) . '/models';
        }
        $authHeader = ['Authorization: Bearer ' . $apiKey, 'x-api-key: ' . $apiKey];
    }
    if (!$catalog) {
        echo json_encode(['error' => 'Could not derive catalog URL']);
        return;
    }

    $ch = curl_init($catalog);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 20);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    if (!empty($authHeader)) {
        curl_setopt($ch, CURLOPT_HTTPHEADER, $authHeader);
    }
    $raw = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);

    if ($raw === false) {
        echo json_encode(['error' => 'Catalog request failed: ' . $err]);
        return;
    }
    if ($code >= 400) {
        echo json_encode(['error' => "Catalog HTTP $code — "
            . substr(preg_replace('/\s+/', ' ', (string)$raw), 0, 200)]);
        return;
    }

    $data = json_decode($raw, true);
    $ids = [];
    if (is_array($data)) {
        $list = $data['data'] ?? $data['models'] ?? [];
        if (is_array($list)) {
            foreach ($list as $m) {
                if (!is_array($m)) { continue; }
                $id = $m['id'] ?? ($m['name'] ?? null);
                if ($id === null) { continue; }
                $id = preg_replace('~^models/~', '', (string)$id);
                if ($id !== '') { $ids[$id] = true; }
            }
        }
    }
    $ids = array_keys($ids);
    sort($ids);
    if (!$ids) {
        echo json_encode(['error' => 'No model ids found in response',
            'sample' => substr((string)$raw, 0, 200)]);
        return;
    }
    echo json_encode(['success' => true, 'count' => count($ids), 'catalog_url' => $catalog, 'models' => $ids]);
}

function handleModels($method, $segments, $body) {
    switch ($method) {
        case 'GET':
            if (isset($segments[1])) {
                $models = Config::getModels();
                $model = null;
                foreach ($models as $m) {
                    if ($m['id'] === $segments[1]) {
                        $model = $m;
                        break;
                    }
                }
                echo json_encode($model ?: ['error' => 'Model not found']);
            } else {
                echo json_encode(Config::getModels());
            }
            break;
            
        case 'POST':
            if ($body && isset($body['name'])) {
                $model = [
                    'id' => uniqid('model_'),
                    'name' => $body['name'],
                    'provider' => $body['provider'] ?? 'openrouter',
                    'endpoint' => $body['endpoint'] ?? '',
                    'model' => $body['model'] ?? '',
                    'api_key' => $body['api_key'] ?? '',
                    'priority' => $body['priority'] ?? 99,
                    'role' => $body['role'] ?? 'coder',
                    'active' => $body['active'] ?? true
                ];
                Config::addModel($model);
                echo json_encode(['success' => true, 'model' => $model]);
            } else {
                echo json_encode(['error' => 'Invalid model data']);
            }
            break;
            
        case 'PUT':
            if (isset($segments[1]) && $body) {
                $models = Config::getModels();
                foreach ($models as &$m) {
                    if ($m['id'] === $segments[1]) {
                        foreach ($body as $key => $value) {
                            $m[$key] = $value;
                        }
                        break;
                    }
                }
                file_put_contents(
                    __DIR__ . '/../storage/models.json',
                    json_encode($models, JSON_PRETTY_PRINT)
                );
                echo json_encode(['success' => true]);
            }
            break;
            
        case 'DELETE':
            if (isset($segments[1])) {
                Config::removeModel($segments[1]);
                echo json_encode(['success' => true]);
            }
            break;
    }
}

function handleSessions($method, $segments, $body) {
    switch ($method) {
        case 'GET':
            if (isset($segments[1])) {
                $session = SessionManager::getSession($segments[1]);
                echo json_encode($session ?: ['error' => 'Session not found']);
            } else {
                echo json_encode(SessionManager::getSessions());
            }
            break;
            
        case 'POST':
            $title = $body['title'] ?? 'New Session';
            $sessionId = SessionManager::createSession($title);
            echo json_encode(['success' => true, 'session_id' => $sessionId]);
            break;
            
        case 'PUT':
            if (isset($segments[1]) && $body) {
                if (isset($body['dialog'])) {
                    SessionManager::addDialog($segments[1], $body['dialog']);
                } elseif (isset($body['models_used'])) {
                    $session = SessionManager::getSession($segments[1]);
                    if ($session) {
                        $session['models_used'] = array_unique(
                            array_merge($session['models_used'] ?? [], $body['models_used'])
                        );
                        SessionManager::saveSession($segments[1], $session);
                    }
                } elseif (isset($body['title'])) {
                    $session = SessionManager::getSession($segments[1]);
                    if ($session) {
                        $session['title'] = $body['title'];
                        SessionManager::saveSession($segments[1], $session);
                    }
                } elseif (isset($body['delete']) && $body['delete']) {
                    SessionManager::deleteSession($segments[1]);
                    echo json_encode(['success' => true, 'deleted' => $segments[1]]);
                    return;
                }
                echo json_encode(['success' => true]);
            }
            break;
            
        case 'DELETE':
            if (isset($segments[1])) {
                if ($segments[1] === 'close' && isset($segments[2])) {
                    SessionManager::closeSession($segments[2]);
                    echo json_encode(['success' => true, 'closed' => $segments[2]]);
                } else {
                    SessionManager::deleteSession($segments[1]);
                    echo json_encode(['success' => true, 'deleted' => $segments[1]]);
                }
            }
            break;
    }
}

function handleQuery($method, $segments, $body) {
    if ($method === 'POST' && $body) {
        $prompt = $body['prompt'] ?? '';
        $sessionId = $body['session_id'] ?? null;
        $excludeIds = $body['exclude'] ?? [];
        
        $sessionData = [];
        if ($sessionId) {
            $session = SessionManager::getSession($sessionId);
            if ($session) {
                $sessionData = $session;
            }
        }
        
        $manager = new ModelManager();
        $results = $manager->processRequest($prompt, $sessionData, $excludeIds);
        
        if ($sessionId) {
            $dialog = [
                'timestamp' => time(),
                'user_input' => $prompt,
                'responses' => $results
            ];
            SessionManager::addDialog($sessionId, $dialog);
        }
        
        echo json_encode([
            'success' => true,
            'responses' => $results
        ]);
    }
}

/**
 * Speech synthesis and transcription, proxied so the browser never talks to the
 * speech provider directly (both are CORS-blocked) and so a provider URL can
 * never be retargeted client-side. Keys are used for this request only and are
 * never written to disk, matching the chat relay below.
 *
 *   GET  audio/capabilities   -> { openai: {voices, models, ...}, groq: {...} }
 *   POST audio/speak          -> audio/mpeg bytes
 *   POST audio/transcribe     -> { text }
 *
 * `speak` returns binary, not JSON, so it is the one route that replaces the
 * JSON content type the front controller set. `transcribe` arrives as
 * multipart/form-data, which is why it reads $_POST/$_FILES rather than the
 * already-parsed JSON body.
 */
function handleAudio($method, $segments, $body) {
    $action = $segments[1] ?? '';

    if ($action === 'capabilities') {
        echo json_encode(['success' => true, 'providers' => Audio::capabilities()]);
        return;
    }

    if ($method !== 'POST') {
        http_response_code(405);
        echo json_encode(['error' => 'POST required']);
        return;
    }

    // Multipart uploads land in $_POST/$_FILES; everything else is the JSON body.
    $isUpload = ($_SERVER['CONTENT_TYPE'] ?? '') !== ''
        && stripos($_SERVER['CONTENT_TYPE'], 'multipart/form-data') !== false;
    $in = $isUpload ? $_POST : (is_array($body) ? $body : []);

    $spec = [
        'provider' => $in['provider'] ?? 'openai',
        'endpoint' => $in['endpoint'] ?? '',
        'api_key' => $in['api_key'] ?? '',
        'model' => $in['model'] ?? '',
    ];

    // Speech takes a while on the first byte but nothing like the 180s a
    // reasoning model needs.
    set_time_limit(90);

    if ($action === 'speak') {
        $spec['text'] = $in['text'] ?? '';
        $spec['voice'] = $in['voice'] ?? '';
        $spec['speed'] = isset($in['speed']) ? (float)$in['speed'] : 1.0;

        $result = Audio::speak($spec);
        if (isset($result['error'])) {
            http_response_code(400);
            echo json_encode(['error' => $result['error']]);
            return;
        }
        header('Content-Type: audio/mpeg');
        header('Content-Length: ' . strlen($result['audio']));
        header('Cache-Control: no-store');
        echo $result['audio'];
        return;
    }

    if ($action === 'transcribe') {
        $spec['file'] = $_FILES['file'] ?? null;
        $spec['language'] = $in['language'] ?? '';
        $spec['prompt'] = $in['prompt'] ?? '';

        $result = Audio::transcribe($spec);
        if (isset($result['error'])) {
            http_response_code(400);
            echo json_encode(['error' => $result['error']]);
            return;
        }
        echo json_encode(['success' => true, 'text' => $result['text']]);
        return;
    }

    http_response_code(404);
    echo json_encode(['error' => 'Unknown audio action "' . $action . '"']);
}

function handleRelay($method, $segments, $body) {
    // Server-side relay for providers the browser can't reach directly (CORS).
    // API keys are used for this request only and never stored.
    // Slow reasoning models need a long leash — don't let PHP cut us off.
    set_time_limit(180);
    if ($method === 'POST' && $body) {
        $manager = new ModelManager();
        if (!empty($body['stream'])) {
            // Streams SSE straight through and returns.
            $manager->relayStream($body);
            return;
        }
        $result = $manager->relay([
            'provider' => $body['provider'] ?? 'custom',
            'endpoint' => $body['endpoint'] ?? '',
            'api_key' => $body['api_key'] ?? '',
            'model' => $body['model'] ?? '',
            'temperature' => $body['temperature'] ?? 0.7,
            'max_tokens' => $body['max_tokens'] ?? 4096,
            'messages' => $body['messages'] ?? [],
            'raw_payload' => $body['raw_payload'] ?? null,
        ]);
        echo json_encode(array_merge(['success' => !isset($result['error'])], $result));
    } else {
        echo json_encode(['error' => 'POST with provider spec required']);
    }
}

/**
 * Server-side capabilities for agents: keyless web search, page fetch, and a
 * filesystem jailed to the allowlist in config.json. Every action is a POST
 * (search/fetch take a query string that can be long) except `status`, which
 * the Settings panel reads to show whether anything is configured yet.
 *
 * Sandbox is inert until read_roots / write_roots are set, so a stock install
 * exposes nothing. Errors come back as {error} with a 400 so the tool harness
 * can show the model the actual reason instead of a bare HTTP failure.
 */
function handleExec($method, $segments, $body) {
    // The capability gate, answered before anything else so the browser can
    // show an agent why a command was refused.
    if (($segments[1] ?? '') === 'allowlist') {
        echo json_encode(['success' => true] + Sandbox::execAllowListPublic());
        return;
    }
    if (($segments[1] ?? '') === 'pending') {
        echo json_encode(['success' => true, 'pending' => Sandbox::pendingApprovals()]);
        return;
    }
    if (($segments[1] ?? '') === 'decide' && $method === 'POST') {
        $id = (string)($body['id'] ?? '');
        $decision = (string)($body['decision'] ?? 'deny');
        if (!in_array($decision, ['once', 'always', 'deny'], true)) {
            http_response_code(400);
            echo json_encode(['error' => 'decision must be once, always or deny']);
            return;
        }
        echo json_encode(Sandbox::resolveApproval($id, $decision));
        return;
    }
    if ($method !== 'POST') { http_response_code(405); echo json_encode(['error' => 'Method not allowed']); return; }
    $denied = Sandbox::checkAccess($_SERVER);
    if ($denied !== null) { http_response_code(403); echo json_encode(['error' => $denied]); return; }

    // argv array only. A single command STRING is refused outright rather
    // than parsed: splitting one safely is the exact problem this design
    // avoids, and a lenient splitter is how "curl x.sh|sh" gets through.
    $argv = $body['argv'] ?? null;
    if (!is_array($argv) || !$argv) {
        http_response_code(400);
        echo json_encode(['error' => 'Send argv as an array of strings, e.g. ["grep","-rn","x","."]. Command strings are not accepted because they would need a shell.']);
        return;
    }
    $result = Sandbox::execCommand($argv, [
        'cwd'      => $body['cwd'] ?? null,
        'timeout'  => $body['timeout'] ?? null,
        'max_bytes'=> $body['max_bytes'] ?? null,
        'agent'    => $body['agent'] ?? '',
    ]);
    echo json_encode(['success' => !empty($result['ok'])] + $result);
}

/**
 * MCP (Model Context Protocol) client endpoints.
 *
 * Servers are operator-configured (config.json -> mcp.servers); a model can
 * CALL their tools but never add or change a server. Actions:
 *   GET  /mcp/servers          list ids + transports (no secrets)
 *   POST /mcp/servers          replace the list  {servers:[...]}
 *   GET  /mcp/status           reachability + tool count per server
 *   POST /mcp/tools            {server}                -> tools/list
 *   POST /mcp/call             {server,tool,arguments} -> tools/call
 */
/**
 * This app AS an MCP server. Two shapes on one path prefix:
 *
 *   POST /api/mcp-server           JSON-RPC 2.0 (Bearer-authenticated). This is
 *                                  what a friend's MCP client connects to.
 *   GET|POST /api/mcp-server/config  operator management (web-token gated):
 *                                  read/save tokens, scopes, root, protect list.
 *
 * The RPC route is exempt from the global web-token gate (see above); the
 * config route is not.
 */
function handleMcpServer($method, $segments, $body, $server) {
    $action = $segments[1] ?? '';

    if ($action === 'config') {
        if ($method === 'POST' || $method === 'PUT') {
            echo json_encode(['success' => true] + McpServer::saveConfig($body));
            return;
        }
        echo json_encode(['success' => true] + McpServer::uiConfig());
        return;
    }

    // Recent calls FRIENDS have made into us (reads storage/mcp.log). Operator
    // only: this route is not the RPC endpoint, so it stays web-token gated.
    if ($action === 'activity') {
        echo json_encode(['success' => true, 'entries' => McpServer::activity(80)]);
        return;
    }

    if ($method !== 'POST') {
        http_response_code(405);
        echo json_encode(['error' => 'POST required (JSON-RPC)']);
        return;
    }
    $res = McpServer::handle(is_array($body) ? $body : [], $server);
    http_response_code($res['http']);
    if (!empty($res['json'])) {
        echo json_encode($res['json'], JSON_UNESCAPED_SLASHES);
    }
    // A 202 notification returns an empty body, which is what the spec expects.
}

/**
 * Browser screen: drive an installed Chrome/Edge over the DevTools Protocol.
 *
 * Off unless Config → Labs → Browser is on (stored as browser.enabled in
 * config.json, so the gate is server-side, not just a hidden button). The
 * route is behind the web token like every other non-MCP route.
 */
function handleBrowser($method, $segments, $body) {
    $cfg = Config::loadConfig();
    $enabled = !empty($cfg['browser']['enabled']);
    $action = $segments[1] ?? 'status';
    try {
        if ($action === 'status') {
            echo json_encode(['success' => true, 'enabled' => $enabled] + Browser::status());
            return;
        }
        if (!$enabled) {
            http_response_code(403);
            echo json_encode(['error' => 'The browser is switched off — turn it on in Config → Labs → Browser.']);
            return;
        }
        switch ($action) {
            case 'launch':
                $headless = array_key_exists('headless', $body) ? (bool)$body['headless'] : true;
                echo json_encode(['success' => true] + Browser::launch($headless));
                return;
            case 'stop':
                echo json_encode(['success' => true] + Browser::stop());
                return;
            case 'navigate':
                echo json_encode(['success' => true] + Browser::navigate($body['url'] ?? ''));
                return;
            case 'screenshot':
                echo json_encode(['success' => true] + Browser::screenshot());
                return;
            case 'click':
                echo json_encode(['success' => true] + Browser::click($body['x'] ?? 0, $body['y'] ?? 0));
                return;
            case 'type':
                echo json_encode(['success' => true] + Browser::typeText($body['text'] ?? ''));
                return;
            case 'key':
                echo json_encode(['success' => true] + Browser::pressKey($body['key'] ?? 'Enter'));
                return;
            case 'eval':
                echo json_encode(['success' => true] + Browser::evaluate((string)($body['expression'] ?? '')));
                return;
            case 'read':
                echo json_encode(['success' => true] + Browser::readText());
                return;
        }
        echo json_encode(['error' => 'unknown browser action']);
    } catch (\Throwable $e) {
        http_response_code(400);
        echo json_encode(['error' => $e->getMessage()]);
    }
}

function handleMcp($method, $segments, $body) {    $action = $segments[1] ?? '';
    try {
        if ($action === 'servers') {
            if ($method === 'POST' || $method === 'PUT') {
                $servers = $body['servers'] ?? [];
                Mcp::saveServers(is_array($servers) ? $servers : []);
            }
            // Full config (incl. command/args/url/headers) so the editor can
            // round-trip an existing server. This endpoint is behind the web
            // token gate, so it is operator-only.
            echo json_encode(['success' => true, 'servers' => Mcp::servers()]);
            return;
        }
        if ($action === 'status') {
            echo json_encode(['success' => true, 'status' => Mcp::statusAll()]);
            return;
        }
        if ($action === 'tools' && $method === 'POST') {
            echo json_encode(['success' => true, 'tools' => Mcp::listTools($body['server'] ?? '')]);
            return;
        }
        if ($action === 'call' && $method === 'POST') {
            $res = Mcp::callTool($body['server'] ?? '', $body['tool'] ?? '', $body['arguments'] ?? []);
            echo json_encode(['success' => true] + $res);
            return;
        }
        echo json_encode(['error' => 'unknown mcp action']);
    } catch (\Throwable $e) {
        http_response_code(400);
        echo json_encode(['error' => $e->getMessage()]);
    }
}

function handleSandbox($method, $segments, $body) {
    $action = $segments[1] ?? 'status';

    if ($action === 'status') {
        echo json_encode(Sandbox::status());
        return;
    }

    $denied = Sandbox::checkAccess($_SERVER);
    if ($denied !== null) {
        http_response_code(403);
        echo json_encode(['error' => $denied]);
        return;
    }

    // An empty {} is a legitimate request (list_dir with no path, for
    // instance), so only reject when there is no body at all -- otherwise the
    // check throws out the calls where nothing needs to be passed.
    if ($method !== 'POST' || $body === null) {
        echo json_encode(['error' => 'POST with a JSON body required']);
        return;
    }

    // search and fetch make outbound requests that can take a while.
    if ($action === 'search' || $action === 'fetch') {
        set_time_limit(60);
    }

    try {
        switch ($action) {
            case 'search':
                echo json_encode(Sandbox::webSearch($body['query'] ?? '', $body['limit'] ?? 8));
                break;
            case 'fetch':
                echo json_encode(Sandbox::fetchUrl($body['url'] ?? '', $body['max_chars'] ?? 20000));
                break;
            case 'read':
                echo json_encode(Sandbox::readFile(
                    $body['path'] ?? '',
                    $body['range'] ?? null,
                    $body['root'] ?? null
                ));
                break;
            case 'read_text':
                echo json_encode(Sandbox::readText(
                    $body['path'] ?? '',
                    $body['root'] ?? null,
                    $body['max_bytes'] ?? null
                ));
                break;
            case 'read_binary':
                echo json_encode(Sandbox::readBinary(
                    $body['path'] ?? '',
                    $body['root'] ?? null,
                    $body['max_bytes'] ?? null
                ));
                break;
            case 'write':
                echo json_encode(Sandbox::writeFile(
                    $body['path'] ?? '',
                    $body['content'] ?? '',
                    $body['mode'] ?? 'write',
                    $body['root'] ?? null
                ));
                break;
            case 'str_replace':
                echo json_encode(Sandbox::strReplace(
                    $body['path'] ?? '',
                    $body['old'] ?? '',
                    $body['new'] ?? '',
                    !empty($body['replace_all']),
                    $body['root'] ?? null
                ));
                break;
            case 'insert':
                echo json_encode(Sandbox::insertAt(
                    $body['path'] ?? '',
                    $body['line'] ?? 0,
                    $body['text'] ?? '',
                    $body['root'] ?? null
                ));
                break;
            case 'apply_patch':
                echo json_encode(Sandbox::applyPatch(
                    $body['patch'] ?? '',
                    $body['root'] ?? null
                ));
                break;
            case 'http':
                echo json_encode(Sandbox::httpRequest(
                    $body['method'] ?? 'GET',
                    $body['url'] ?? '',
                    $body['headers'] ?? [],
                    $body['body'] ?? null,
                    $body['max_chars'] ?? 20000
                ));
                break;
            case 'git':
                echo json_encode(Sandbox::gitRun(
                    $body['args'] ?? [],
                    $body['cwd'] ?? null,
                    $body['root'] ?? null
                ));
                break;
            case 'git_commit':
                echo json_encode(Sandbox::gitCommit(
                    $body['message'] ?? '',
                    $body['paths'] ?? [],
                    $body['cwd'] ?? null,
                    $body['root'] ?? null
                ));
                break;
            case 'multi_edit':
                echo json_encode(Sandbox::multiEdit(
                    $body['edits'] ?? [],
                    $body['root'] ?? null
                ));
                break;
            case 'code':
                echo json_encode(Sandbox::runCode(
                    $body['language'] ?? 'python',
                    $body['code'] ?? '',
                    [
                        'cwd' => $body['cwd'] ?? null,
                        'root' => $body['root'] ?? null,
                        'timeout' => $body['timeout'] ?? null,
                    ]
                ));
                break;
            case 'upload':
                echo json_encode(Sandbox::writeBinary(
                    $body['path'] ?? '',
                    $body['data'] ?? '',
                    $body['root'] ?? null
                ));
                break;
            case 'list':
                echo json_encode(Sandbox::listDir(
                    $body['path'] ?? null,
                    $body['limit'] ?? 200,
                    $body['root'] ?? null
                ));
                break;
            case 'glob':
                echo json_encode(Sandbox::globFiles(
                    $body['pattern'] ?? '',
                    $body['root'] ?? null,
                    $body['scope'] ?? null
                ));
                break;
            case 'grep':
                echo json_encode(Sandbox::grepCode(
                    $body['pattern'] ?? '',
                    $body['glob'] ?? '*.{php,js,css,html,json,md,ts,py,sh,yml,yaml,txt}',
                    $body['max_matches'] ?? 80,
                    $body['scope'] ?? null
                ));
                break;
            case 'mkdir':
                echo json_encode(Sandbox::makeDir($body['path'] ?? '', $body['root'] ?? null));
                break;
            case 'remove':
                echo json_encode(Sandbox::removePath($body['path'] ?? '', $body['root'] ?? null));
                break;
            case 'copy':
            case 'move':
                echo json_encode(Sandbox::copyMove(
                    $body['from'] ?? '',
                    $body['to'] ?? '',
                    $action === 'move',
                    $body['root'] ?? null
                ));
                break;
            case 'chmod':
                echo json_encode(Sandbox::setMode(
                    $body['path'] ?? '',
                    $body['mode'] ?? '',
                    $body['root'] ?? null
                ));
                break;
            case 'stat':
                echo json_encode(Sandbox::statPath($body['path'] ?? '', $body['root'] ?? null));
                break;
            case 'zip':
                echo json_encode(Sandbox::zipPaths(
                    $body['paths'] ?? [],
                    $body['dest'] ?? 'archive.zip',
                    $body['root'] ?? null
                ));
                break;
            case 'unzip':
                echo json_encode(Sandbox::unzipArchive(
                    $body['path'] ?? '',
                    $body['dest'] ?? '.',
                    $body['root'] ?? null
                ));
                break;
            default:
                echo json_encode(['error' => "Unknown sandbox action \"$action\""]);
        }
    } catch (RuntimeException $e) {
        // Sandbox errors are expected and descriptive — surface them to the
        // model rather than as a 500 with a stack-trace-free void.
        http_response_code(400);
        echo json_encode(['error' => $e->getMessage()]);
    }
}

/**
 * The whole per-copy state bundle: agents, providers, settings, conversations,
 * metrics and memory.
 *
 * This exists so a copy is a copy. Everything the app knows used to live only in
 * one browser's localStorage, which meant the desktop and a phone saw entirely
 * different agents for the same install. Storing the bundle beside the code, in
 * storage/state.json, makes each directory self-contained: every device that
 * opens /router/ gets the same agents, and /cleancopy/ is unaffected because it
 * has its own storage directory.
 *
 * GET  -> the stored bundle, or {exists:false} when this copy has never synced.
 * PUT  -> replaces it. Last write wins; there is no merge, because a partial
 *         merge of two devices' agents has no obviously correct answer.
 */
function handleState($method, $segments, $body) {
    $path = __DIR__ . '/../storage/state.json';

    if ($method === 'GET') {
        if (!is_file($path)) {
            echo json_encode(['exists' => false, 'state' => null, 'rev' => 0]);
            return;
        }
        $raw = file_get_contents($path);
        $data = $raw === false ? null : json_decode($raw, true);
        if ($data === null) {
            echo json_encode(['exists' => false, 'state' => null, 'rev' => 0]);
            return;
        }
        // Cheap liveness check for polling: ?rev=N answers with a few bytes when
        // nothing has changed, and only sends the whole bundle when it has.
        $rev = (int)($data['rev'] ?? 0);
        if (isset($_GET['rev']) && (int)$_GET['rev'] === $rev) {
            echo json_encode(['exists' => true, 'changed' => false, 'rev' => $rev]);
            return;
        }
        echo json_encode(['exists' => true, 'changed' => true, 'rev' => $rev, 'state' => $data]);
        return;
    }

    if ($method === 'PUT') {
        $incoming = $body['state'] ?? null;
        if (!is_array($incoming)) {
            echo json_encode(['error' => 'PUT with a {state: {...}} body required']);
            return;
        }
        // Device-local credentials must never roam: a browser with an empty
        // (or stale) token field would otherwise overwrite the server's copy
        // and lock out every other browser on the next poll. Strip on receipt
        // so even old clients cannot poison it.
        if (isset($incoming['slots']['settings']) && is_array($incoming['slots']['settings'])) {
            unset($incoming['slots']['settings']['routerToken'], $incoming['slots']['settings']['sandboxToken']);
        }
        // The bundle holds API keys, so it is exactly as sensitive as the file
        // it becomes. storage/.htaccess already denies direct web access to it.
        $json = json_encode($incoming, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            echo json_encode(['error' => 'State could not be encoded as JSON']);
            return;
        }
        if (strlen($json) > 8 * 1024 * 1024) {
            echo json_encode(['error' => 'State bundle is too large to save']);
            return;
        }
        // Bump the revision so other devices can tell "changed" from "same"
        // with a single number instead of diffing the whole bundle.
        $current = is_file($path) ? json_decode((string)@file_get_contents($path), true) : null;
        // Per-slot merge, incoming wins. A writer that never loaded a slot (a
        // fresh browser, an older client) OMITS it -- and with the old
        // full-replace that omission deleted the server's copy. That is how
        // workflows and settings kept vanishing: any save from a client that
        // hadn't opened the chart wiped everyone else's pipelines.
        $currentSlots = (is_array($current) && isset($current['slots']) && is_array($current['slots']))
            ? $current['slots'] : [];
        $incomingSlots = (isset($incoming['slots']) && is_array($incoming['slots'])) ? $incoming['slots'] : [];
        $incoming['slots'] = array_merge($currentSlots, $incomingSlots);
        $incoming['rev'] = (int)($current['rev'] ?? 0) + 1;
        $incoming['updated'] = time();
        $json = json_encode($incoming, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);

        // Write to a sibling then rename, so a crash mid-write cannot leave a
        // half-written file that fails to parse on the next load.
        $tmp = $path . '.' . getmypid() . '.tmp';
        if (@file_put_contents($tmp, $json, LOCK_EX) === false || !@rename($tmp, $path)) {
            @unlink($tmp);
            echo json_encode(['error' => 'Could not write storage/state.json']);
            return;
        }
        echo json_encode(['success' => true, 'bytes' => strlen($json), 'rev' => $incoming['rev']]);
        return;
    }

    echo json_encode(['error' => 'GET or PUT only']);
}

function handleTopology($method, $segments, $body) {    $sessions = SessionManager::getSessions();
    echo json_encode(TopologyGraph::generateGraphData($sessions));
}

function handleConfig($method, $segments, $body) {
    switch ($method) {
        case 'GET':
            echo json_encode(Config::loadConfig());
            break;
        case 'PUT':
            if ($body) {
                Config::saveConfig($body);
                echo json_encode(['success' => true]);
            }
            break;
    }
}

function handleExport($method, $segments, $body) {
    if (isset($segments[1])) {
        $session = SessionManager::getSession($segments[1]);
        if ($session) {
            $filename = 'session_' . $segments[1] . '_' . date('Y-m-d') . '.json';
            header('Content-Type: application/json');
            header('Content-Disposition: attachment; filename="' . $filename . '"');
            echo json_encode($session, JSON_PRETTY_PRINT);
        } else {
            http_response_code(404);
            echo json_encode(['error' => 'Session not found']);
        }
    }
}

/**
 * Full backup: everything needed to restore this copy elsewhere.
 *
 *   GET -> { app, backupVersion, exportedAt, state, sessions, config, approvals }
 *
 * - state: the whole state.json bundle (agents with their settings, prompts
 *   and memory; providers; workflows; conversations; metrics).
 * - sessions: every session file, active or closed (getSessions filters to
 *   active only, so this reads the directory directly).
 * - config: storage/config.json verbatim, INCLUDING the access token and the
 *   sandbox allow/deny lists. It is a backup, not a handover: keep the file
 *   somewhere safe, never post it.
 * - approvals: pending exec-approval grants, if the file exists.
 */
function handleBackup($method, $segments, $body) {
    if ($method !== 'GET') {
        http_response_code(405);
        echo json_encode(['error' => 'GET only']);
        return;
    }
    $statePath = __DIR__ . '/../storage/state.json';
    $state = is_file($statePath) ? json_decode((string)@file_get_contents($statePath), true) : null;

    $sessions = [];
    foreach ((array)glob(__DIR__ . '/../storage/sessions/*.json') as $file) {
        $s = json_decode((string)@file_get_contents($file), true);
        if (is_array($s)) $sessions[] = $s;
    }

    $approvalsPath = __DIR__ . '/../storage/exec-approvals.json';
    $approvals = is_file($approvalsPath)
        ? json_decode((string)@file_get_contents($approvalsPath), true) : null;

    echo json_encode([
        'app' => 'router-studio',
        'backupVersion' => 1,
        'exportedAt' => time(),
        'state' => $state,
        'sessions' => $sessions,
        'config' => Config::loadConfig(),
        'approvals' => $approvals,
    ]);
}

/**
 * Restore a backup made by handleBackup.
 *
 *   POST { backup: {...} } -> { success, sessions, rev }
 *
 * True restore semantics: the app ends up looking like the backup. Session
 * files not in the backup are removed; state, config and approvals are
 * replaced wholesale (with the revision bumped, so other devices adopt it).
 * Refuses anything that is not recognisably our backup, caps the body well
 * below PHP's post limits, and sanitises session filenames so a crafted
 * backup cannot write outside the sessions directory.
 */
function handleImport($method, $segments, $body) {
    if ($method !== 'POST') {
        http_response_code(405);
        echo json_encode(['error' => 'POST only']);
        return;
    }
    $raw = (string)@file_get_contents('php://input');
    if (strlen($raw) > 32 * 1024 * 1024) {
        http_response_code(413);
        echo json_encode(['error' => 'Backup is too large (32 MB cap)']);
        return;
    }
    $backup = (is_array($body) && isset($body['backup']) && is_array($body['backup']))
        ? $body['backup'] : null;
    if ($backup === null
        || ($backup['app'] ?? null) !== 'router-studio'
        || !isset($backup['state']) || !isset($backup['sessions']) || !isset($backup['config'])
    ) {
        http_response_code(400);
        echo json_encode(['error' => 'Not a router-studio backup (need app, state, sessions, config)']);
        return;
    }

    // Sessions: drop the current files, then write the backup's. IDs are
    // basename-sanitised and restricted to safe characters.
    $sessionsDir = __DIR__ . '/../storage/sessions/';
    if (!is_dir($sessionsDir)) @mkdir($sessionsDir, 0755, true);
    foreach ((array)glob($sessionsDir . '*.json') as $file) @unlink($file);
    $sessionCount = 0;
    foreach ((array)$backup['sessions'] as $session) {
        if (!is_array($session)) continue;
        $id = isset($session['id']) ? basename((string)$session['id']) : '';
        if (!preg_match('/^[A-Za-z0-9_.-]+$/', $id)) continue;
        $session['id'] = $id;
        if (@file_put_contents($sessionsDir . $id . '.json',
            json_encode($session, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) !== false) {
            $sessionCount++;
        }
    }

    // State bundle: replace wholesale (this is a restore, not a merge), with
    // the revision bumped so other devices adopt it on their next poll.
    $statePath = __DIR__ . '/../storage/state.json';
    $current = is_file($statePath) ? json_decode((string)@file_get_contents($statePath), true) : null;
    $incoming = $backup['state'];
    if (!is_array($incoming)) $incoming = ['slots' => []];
    // Tokens never roam, not even in a backup restore pushed over sync: strip
    // device credentials the same way live PUTs do.
    if (isset($incoming['slots']['settings']) && is_array($incoming['slots']['settings'])) {
        unset($incoming['slots']['settings']['routerToken'], $incoming['slots']['settings']['sandboxToken']);
    }
    $incoming['rev'] = (int)(is_array($current) ? ($current['rev'] ?? 0) : 0) + 1;
    $incoming['updated'] = time();
    $json = json_encode($incoming, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        http_response_code(400);
        echo json_encode(['error' => 'Restored state could not be encoded as JSON']);
        return;
    }
    $tmp = $statePath . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, $json, LOCK_EX) === false || !@rename($tmp, $statePath)) {
        @unlink($tmp);
        http_response_code(500);
        echo json_encode(['error' => 'Could not write storage/state.json']);
        return;
    }

    // Config (allow/deny lists, sandbox roots, exec policy, token) and exec
    // approval grants: replaced verbatim -- that is what makes this a restore.
    Config::saveConfig($backup['config']);
    if (isset($backup['approvals'])) {
        @file_put_contents(__DIR__ . '/../storage/exec-approvals.json',
            json_encode($backup['approvals'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    }

    echo json_encode(['success' => true, 'sessions' => $sessionCount, 'rev' => $incoming['rev']]);
}

/**
 * Why can't this app reach a provider?
 *
 * The browser can only ever report "NetworkError when attempting to fetch
 * resource", which conflates four completely different faults: this server
 * not running, the token refused, the provider unreachable, and the provider
 * rejecting the key. Each needs a different fix, so each is tested and named
 * here instead of leaving the operator to guess.
 *
 *   POST /api/diag { providers: [{name, endpoint, api_key, model}] }
 *   ->  { results: [{ name, ok, stage, code, ms, message }] }
 *
 * `stage` is the one that matters: 'local' (we answered), 'dns', 'connect',
 * 'tls', 'http' (we reached them, they said no), or 'auth'.
 *
 * Deliberately server-side: the browser's own fetch to the provider is
 * subject to CORS, so testing from here tests the machine's real network
 * path and reports DNS/TLS/connect errors with their actual text instead of
 * collapsing them into "network error".
 */
function handleDiag($method, $segments, $body) {
    // GET identifies the running server. Every "it works on my other copy"
    // debugging session ended in not knowing WHICH copy the browser was
    // talking to; opening /api/diag in the browser now answers that outright.
    if ($method !== 'POST') {
        header('Content-Type: application/json');
        header('Cache-Control: no-store');
        echo json_encode([
            'service' => 'loop-studio-diag',
            'supports' => ['received_field' => true, 'provider_probe' => true],
            'php' => PHP_VERSION,
            'server_software' => isset($_SERVER['SERVER_SOFTWARE']) ? $_SERVER['SERVER_SOFTWARE'] : 'cli-server',
            'docroot' => __DIR__ . '/..',
        ]);
        return;
    }
    $providers = (is_array($body) && isset($body['providers']) && is_array($body['providers']))
        ? $body['providers'] : [];
    if (!count($providers)) {
        // `received` is here so a client that sent nothing (or sent the wrong
        // field) can tell which half is at fault without guesswork.
        echo json_encode(['success' => true, 'results' => [], 'received' => 0]);
        return;
    }

    $results = [];
    foreach (array_slice($providers, 0, 12) as $p) {
        $name = (string)($p['name'] ?? 'provider');
        $endpoint = (string)($p['endpoint'] ?? '');
        $key = (string)($p['api_key'] ?? '');
        $model = (string)($p['model'] ?? '');
        $r = ['name' => $name, 'ok' => false, 'stage' => 'local', 'code' => null,
              'ms' => null, 'message' => ''];

        if (!preg_match('#^https?://#i', $endpoint)) {
            $r['stage'] = 'config';
            $r['message'] = $endpoint ? 'Endpoint is not a http(s) URL.' : 'No endpoint set.';
            $results[] = $r; continue;
        }

        // A real, minimal request on the same path the relay uses. Uses the
        // cheapest thing that still proves key+model+network together.
        $host = parse_url($endpoint, PHP_URL_HOST) ?: '';
        $url = $endpoint;
        $payload = null;
        if (preg_match('#/chat/completions$#i', $endpoint)) {
            $url = preg_replace('#/chat/completions$#i', '/chat/completions', $endpoint);
            $payload = [
                'model' => $model ?: 'unknown',
                'messages' => [['role' => 'user', 'content' => 'ping']],
                'max_tokens' => 4,
                'stream' => false,
            ];
        }
        // Google-style and Ollama-style endpoints have no cheap GET; fall back
        // to a HEAD/GET on the host, which still proves DNS + TLS + connect.
        $headers = ['Content-Type: application/json'];
        if ($key !== '') { $headers[] = 'Authorization: Bearer ' . $key; }
        if ($payload === null) {
            $headers = ['Authorization: Bearer ' . $key];
        }

        $t0 = microtime(true);
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 15);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 8);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);
        if ($payload !== null) {
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
        }
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        $out = curl_exec($ch);
        $errno = curl_errno($ch);
        $err = curl_error($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        $r['ms'] = (int)round((microtime(true) - $t0) * 1000);
        $r['code'] = $code ?: null;

        if ($out === false && $errno) {
            // curl names the failing layer in its error number; surface that
            // rather than a generic "could not connect".
            $stage = 'connect';
            if ($errno === CURLE_COULDNT_RESOLVE_HOST || $errno === CURLE_COULDNT_RESOLVE_PROXY) $stage = 'dns';
            elseif ($errno === CURLE_SSL_CONNECT_ERROR || $errno === CURLE_SSL_PEER_CERTIFICATE
                || $errno === CURLE_SSL_CACERT || $errno === CURLE_SSL_CIPHER) $stage = 'tls';
            $r['stage'] = $stage;
            $r['message'] = $err !== '' ? $err : "curl error $errno";
            $r['ok'] = false;
        } elseif ($code >= 200 && $code < 400) {
            $r['stage'] = 'ok';
            $r['ok'] = true;
            $r['message'] = 'Reachable and accepted.';
        } elseif ($code === 401 || $code === 403) {
            $r['stage'] = 'auth';
            $r['message'] = 'The provider rejected the API key (HTTP ' . $code . ').';
        } elseif ($code === 404) {
            $r['stage'] = 'http';
            $r['message'] = 'Reached the provider, but the endpoint or model id was not found (HTTP 404).';
        } elseif ($code >= 400) {
            $r['stage'] = 'http';
            $r['message'] = 'Reached the provider, which refused the request (HTTP ' . $code . ').';
        } else {
            $r['stage'] = 'http';
            $r['message'] = 'Unexpected response (HTTP ' . ($code ?: 'none') . ').';
        }
        $results[] = $r;
    }
    echo json_encode([
        'success' => true,
        'results' => $results,
        'received' => count($providers),
        // Which copy actually answered. Every "works on my other copy"
        // debugging session died on not knowing this, and the UI is the only
        // place the operator is already authorised to ask.
        'server' => [
            'software' => isset($_SERVER['SERVER_SOFTWARE']) ? $_SERVER['SERVER_SOFTWARE'] : 'cli-server',
            'php' => PHP_VERSION,
            'path' => realpath(__DIR__ . '/..') ?: (__DIR__ . '/..'),
        ],
    ]);
}

function handleProxies($method, $segments, $body) {
    if ($method === 'GET') {
        $fetched = fetchProxies();
        jsonResponse([
            'ok' => true,
            'proxies' => $fetched['proxies'],
            'stats' => $fetched['stats'],
        ]);
    } elseif ($method === 'POST') {
        jsonResponse(['error' => 'Not implemented'], 501);
    } else {
        jsonResponse(['error' => 'Method not allowed'], 405);
    }
}

/**
 * Ping many proxies at once.
 *
 * Ping All used to loop in the browser, one request at a time, against a 15s
 * timeout. With 255 proxies that is worst case ~64 MINUTES of a disabled
 * button, which reads as "this button does not work". curl_multi runs them
 * concurrently in one request, so the same sweep takes seconds.
 */
function handleProxyPingAll($method, $body) {
    if ($method !== 'POST') { jsonResponse(['error' => 'Method not allowed'], 405); return; }
    $list = $body['proxies'] ?? null;
    if (!is_array($list) || !$list) { jsonResponse(['error' => 'proxies array required'], 400); return; }
    $list = array_slice($list, 0, 300);

    $mh = curl_multi_init();
    $handles = [];
    foreach ($list as $item) {
        $ip = trim((string)($item['ip'] ?? ''));
        $port = (int)($item['port'] ?? 0);
        if (!$ip || !$port) continue;
        $ch = curl_init('https://httpbin.org/ip');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            // Shorter than the single-ping timeout: a sweep of 255 needs every
            // one to give up quickly, and a proxy slower than this is not
            // going to win the race for "fastest" anyway.
            CURLOPT_TIMEOUT => 8,
            CURLOPT_CONNECTTIMEOUT => 6,
            CURLOPT_PROXY => "$ip:$port",
            CURLOPT_PROXYTYPE => CURLPROXY_HTTP,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_SSL_VERIFYHOST => 0,
            CURLOPT_USERAGENT => 'Router/1.0',
        ]);
        curl_multi_add_handle($mh, $ch);
        $handles[] = ['ch' => $ch, 'ip' => $ip, 'port' => $port];
    }

    // Run the whole set concurrently, checking for completion as they finish.
    $running = null;
    do {
        curl_multi_exec($mh, $running);
        curl_multi_select($mh, 0.2);
    } while ($running > 0);

    $results = [];
    foreach ($handles as $h) {
        $ms = null;
        $err = curl_error($h['ch']);
        $code = (int)curl_getinfo($h['ch'], CURLINFO_HTTP_CODE);
        if (!$err && $code === 200) {
            $info = curl_getinfo($h['ch']);
            $ms = (int)round(((float)$info['total_time']) * 1000);
        }
        $results[] = ['ip' => $h['ip'], 'port' => $h['port'], 'pingMs' => $ms];
        curl_multi_remove_handle($mh, $h['ch']);
        curl_close($h['ch']);
    }
    curl_multi_close($mh);

    // Fastest first, dead ones last.
    usort($results, function ($a, $b) {
        $am = $a['pingMs'] === null ? PHP_INT_MAX : $a['pingMs'];
        $bm = $b['pingMs'] === null ? PHP_INT_MAX : $b['pingMs'];
        return $am <=> $bm;
    });
    jsonResponse(['success' => true, 'results' => $results]);
}

/**
 * Read or set the proxy that outbound model traffic should use.
 *
 * Server-side on purpose: the relay is called by the server, and a browser-side
 * setting is not visible to it. Storing it in config.json means whichever
 * browser or agent triggers a call gets the same routing.
 */
function handleProxyActive($method, $body) {
    $cfg = Config::loadConfig();
    if ($method === 'GET') {
        jsonResponse(['success' => true, 'proxy' => $cfg['sandbox']['proxy_active'] ?? '']);
        return;
    }
    if ($method === 'PUT' || $method === 'POST') {
        $proxy = trim((string)($body['proxy'] ?? ''));
        // Empty means "no proxy", which is a real choice, so it is stored as an
        // empty string rather than left unset.
        if ($proxy !== '' && !preg_match('/^[a-z0-9.\-]+:\d{1,5}$/i', $proxy)) {
            jsonResponse(['error' => 'proxy must be host:port, or empty to clear'], 400);
            return;
        }
        $cfg['sandbox']['proxy_active'] = $proxy;
        Config::saveConfig($cfg);
        jsonResponse(['success' => true, 'proxy' => $proxy]);
        return;
    }
    jsonResponse(['error' => 'Method not allowed'], 405);
}

function handleProxyPing($method, $segments, $body) {
    if ($method !== 'POST') { jsonResponse(['error' => 'Method not allowed'], 405); return; }
    $ip = $body['ip'] ?? '';
    $port = (int)($body['port'] ?? 0);
    if (!$ip || !$port) { jsonResponse(['error' => 'ip and port required'], 400); return; }
    $pingMs = pingProxy($ip, $port);
    jsonResponse(['ok' => $pingMs !== null, 'pingMs' => $pingMs]);
}

function fetchProxies() {
    $url = 'https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=10000&country=all&anonymity=elite,anonymous&format=json';
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_USERAGENT => 'Router/1.0',
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $resp = curl_exec($ch);
    $err = curl_error($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($err || $code !== 200) return [];
    $data = json_decode($resp, true);
    // The API returns { "proxies": [ ... ], "shown_records": N, ... }
    $list = is_array($data) && isset($data['proxies']) ? $data['proxies'] : $data;
    if (!is_array($list)) return [];
    $out = [];
    // Counters, so the UI can say what was dropped instead of the list just
    // quietly being shorter than expected.
    $stats = ['seen' => 0, 'not_alive' => 0, 'not_anonymous' => 0,
              'not_ipv4' => 0, 'kept' => 0];
    foreach ($list as $item) {
        $stats['seen']++;
        if (!isset($item['alive']) || !$item['alive']) { $stats['not_alive']++; continue; }
        $anon = $item['anonymity'] ?? '';
        if (!in_array($anon, ['elite', 'anonymous'], true)) { $stats['not_anonymous']++; continue; }
        $ip = $item['ip'] ?? '';
        $port = (int)($item['port'] ?? 0);
        if (!$ip || !$port) continue;

        // IPv4 literals only.
        //
        // This host resolves outbound connections to IPv6 first, and the feed
        // mixes both families with no indication of which is which. An IPv6
        // entry in a list the UI cannot label is worse than useless: selecting
        // it looks like routing is set up, and traffic either fails or quietly
        // takes the direct path. IPv4 is what this server dials for every
        // CURLOPT_PROXY value, so the list should only offer that.
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) === false) {
            $stats['not_ipv4']++;
            continue;
        }
        $out[] = [
            'proxy' => $ip . ':' . $port,
            'ip' => $ip,
            'port' => $port,
            'anonymity' => $anon,
            'country' => $item['country'] ?? '',
            'countryCode' => $item['countryCode'] ?? '',
            'city' => $item['city'] ?? '',
            'isp' => $item['isp'] ?? '',
            'ssl' => (bool)($item['ssl'] ?? false),
            'timeout' => $item['timeout'] ?? null,
            'uptime' => $item['uptime'] ?? null,
            'first_seen' => $item['first_seen'] ?? null,
            'last_seen' => $item['last_seen'] ?? null,
            'pingMs' => null,
        ];
        $stats['kept']++;
    }
    return ['proxies' => $out, 'stats' => $stats];
}

function pingProxy($ip, $port) {
    $testUrl = 'https://httpbin.org/ip';
    $ch = curl_init($testUrl);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_PROXY => "$ip:$port",
        CURLOPT_PROXYTYPE => CURLPROXY_HTTP,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => 0,
        CURLOPT_USERAGENT => 'Router/1.0',
    ]);
    $start = microtime(true);
    $resp = curl_exec($ch);
    $elapsed = (microtime(true) - $start) * 1000;
    $err = curl_error($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($err || $code !== 200) return null;
    return (int)round($elapsed);
}
?>