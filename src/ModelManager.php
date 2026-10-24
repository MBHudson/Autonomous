<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// Multi-Model Manager - Handles concurrent requests to multiple AI models
namespace Src;

class ModelManager {
    private $models;
    private $timeout = 30;
    private $lastRaw = null;
    /** HTTP status of the last upstream call. Lets relay() report the real
     * code (429 vs 401 need opposite handling) instead of a bare string. */
    private $lastHttpCode = 200;
    
    public function __construct() {
        $this->models = Config::getModels();
    }
    
    /**
     * Relay a single browser-supplied provider call server-side.
     * Used when the browser cannot reach the provider directly (CORS).
     * Keys are used for this request only and never stored.
     * $spec: provider, endpoint, api_key, authType, model, temperature,
     *         max_tokens, messages (OpenAI-style array).
     */
    public function relay($spec) {
        $endpoint = $spec['endpoint'] ?? '';
        if (!preg_match('#^https?://#i', $endpoint)) {
            return ['error' => 'Invalid endpoint URL'];
        }

        // One registry decides which API dialect this request speaks. The
        // endpoint host wins, then the provider id, then a model hint; see
        // Src\Harness. This replaced a hardcoded provider list that silently
        // sent everything unrecognised (deepseek, xai, mistral, …) down the
        // "custom" path with a payload those APIs reject.
        $family = Harness::detect($spec);

        // Applied up front so every path below routes the same way.
        $spec['proxy'] = self::activeProxy($spec);

        // Raw passthrough for non-chat payload shapes (Responses-API
        // `input`, custom schemas, …): forwarded verbatim, response parsed
        // by family for content/usage/reasoning.
        if (isset($spec['raw_payload']) && is_array($spec['raw_payload'])) {
            return $this->relayRaw($endpoint, $spec['api_key'] ?? '', $family, $spec['raw_payload'], $spec['proxy']);
        }

        // Flatten OpenAI-style messages to a single prompt (role prompts skipped)
        $messages = $spec['messages'] ?? [];
        $parts = [];
        foreach ((array)$messages as $m) {
            $role = $m['role'] ?? 'user';
            $content = is_array($m['content'] ?? null) ? json_encode($m['content']) : ($m['content'] ?? '');
            $parts[] = ($role === 'user' ? '' : "[$role] ") . $content;
        }
        $prompt = implode("\n\n", $parts);

        $model = [
            'name' => 'relay',
            'provider' => $family,
            'endpoint' => $endpoint,
            'api_key' => $spec['api_key'] ?? '',
            'model' => $spec['model'] ?? '',
            'temperature' => $spec['temperature'] ?? 0.7,
            'max_tokens' => $spec['max_tokens'] ?? 4096,
            'role' => 'none',
            'proxy' => $spec['proxy'] ?? null,
        ];

        // Reasoning models can take minutes — allow a long wait server-side
        $this->timeout = 720;

        $result = $this->callModel($model, $prompt, []);
        if ($result === false) {
            // Curl-level failure (DNS, timeout, dropped connection): retryable.
            return ['error' => 'Relay request failed', 'retryable' => true];
        }
        if (is_array($result)) {
            $code = $this->lastHttpCode;
            return ['error' => 'Provider error: ' . json_encode($result),
                'status' => $code,
                'retryable' => $code === 429 || ($code >= 500 && $code < 600)];
        }
        if ($result === null || $result === '') {
            // Do not report success with empty content: that makes a dead or
            // nonexistent model look like a working one. Show what came back.
            $raw = preg_replace('/\s+/', ' ', (string) $this->lastRaw);
            return ['error' => 'Provider returned no readable content'
                . (trim((string) $raw) !== '' ? ': ' . substr(trim((string) $raw), 0, 300) : '.')];
        }
        $out = ['content' => $result];
        $usage = $this->parseUsage($this->lastRaw, $family);
        if ($usage) {
            $out['usage'] = $usage;
        }
        $reasoning = $this->parseReasoning($this->lastRaw);
        if ($reasoning) {
            $out['reasoning'] = $reasoning;
        }
        return $out;
    }

    /**
     * STREAMING relay.
     *
     * Requests with stream:true and forwards Server-Sent Events to the browser
     * as they arrive, forwarding each upstream chunk as it lands so the reply
     * appears token by token.
     *
     * Providers disagree on the SSE envelope (OpenAI-compatible streams
     * `data: {…delta…}`, Anthropic types its events, Gemini differs again), so
     * chunks are passed through verbatim and normalized client-side — a chunk
     * we cannot interpret is forwarded rather than dropped, and the client
     * falls back to treating the accumulated body as one completion.
     */
    /**
     * The proxy outbound model traffic should use, or null for a direct call.
     *
     * A per-request `proxy` in the spec always wins, so a curl-template agent
     * can pin its own route. Otherwise the operator's selection from the Proxy
     * tab applies.
     *
     * Deliberately NOT failing closed: if the chosen proxy is dead, every agent
     * call breaks with nothing but a curl error to show for it. Free proxy
     * lists rot constantly, and an unreachable proxy is the common case rather
     * than the exceptional one. The operator picks the proxy knowingly, and the
     * status line in the Proxy tab says whether the last sweep reached it.
     */
    private static function activeProxy(array $spec) {
        if (!empty($spec['proxy'])) return (string)$spec['proxy'];
        try {
            $cfg = Config::loadConfig();
            $p = trim((string)($cfg['sandbox']['proxy_active'] ?? ''));
            return $p !== '' ? $p : null;
        } catch (\Throwable $e) {
            return null;   // never let routing config break a model call
        }
    }

    public function relayStream($spec) {
        // Route through the operator's chosen proxy when one is set. The spec
        // arrives from the browser, which never sets this -- a browser-side
        // setting is invisible to the server that actually makes the call, so
        // selecting a proxy previously changed nothing at all.
        $spec['proxy'] = self::activeProxy($spec);
        $endpoint = (string)($spec['endpoint'] ?? '');
        $apiKey = (string)($spec['api_key'] ?? '');
        $family = Harness::detect($spec);

        $messages = $spec['messages'] ?? [];
        $parts = [];
        foreach ((array)$messages as $m) {
            $role = $m['role'] ?? 'user';
            $content = is_array($m['content'] ?? null) ? json_encode($m['content']) : ($m['content'] ?? '');
            $parts[] = ($role === 'user' ? '' : "[$role] ") . $content;
        }
        $promptFallback = implode("\n\n", $parts);

        $maxTokens = (int)($spec['max_tokens'] ?? 4096);
        $cap = Harness::capMaxTokens($family, (string)($spec['model'] ?? ''), $maxTokens);
        if ($cap !== null) { $maxTokens = $cap; }

        // Google streams from a DIFFERENT method than it answers on
        // (streamGenerateContent, SSE via alt=sse). Posting stream:true to
        // generateContent is silently ignored and returns one JSON blob.
        if ($family === 'google') {
            $endpoint = str_replace(':generateContent', ':streamGenerateContent', $endpoint);
            if (strpos($endpoint, ':streamGenerateContent') === false) {
                $endpoint = rtrim($endpoint, '/') . ':streamGenerateContent';
            }
            $endpoint .= (strpos($endpoint, '?') === false ? '?' : '&') . 'alt=sse';
        }

        // The harness builds the right body for this API. Previously every
        // family received the OpenAI chat body, so streaming to Anthropic or
        // Google posted a shape those APIs reject.
        $payload = Harness::payload($family, [
            'model' => $spec['model'] ?? '',
            'messages' => $messages ?: [['role' => 'user', 'content' => $promptFallback]],
            'prompt' => $promptFallback,
            'temperature' => $spec['temperature'] ?? 0.7,
            'max_tokens' => $maxTokens,
            'tools' => $spec['tools'] ?? null,
            'tool_choice' => $spec['tool_choice'] ?? null,
            'tool_config' => $spec['tool_config'] ?? null,
        ], true);
        foreach (Harness::streamOptions($family, (string)($spec['provider'] ?? '')) as $k => $v) {
            $payload[$k] = $v;
        }

        $auth = Harness::auth($family, $endpoint, $apiKey, (string)($spec['provider'] ?? ''));
        $endpoint = $auth['endpoint'];
        $headers = array_merge($auth['headers'], ['Accept: text/event-stream']);

        // Flush to the client as data is produced.
        while (ob_get_level() > 0) { @ob_end_flush(); }
        @ob_implicit_flush(true);
        @ini_set('output_buffering', '0');
        if (function_exists('apache_setenv')) { @apache_setenv('no-gzip', 1); }
        @ini_set('zlib.output_compression', 'Off');
        header('Content-Type: text/event-stream; charset=utf-8');
        header('Cache-Control: no-cache, no-store');
        header('Connection: keep-alive');
        header('X-Accel-Buffering: no');   // harmless without nginx, essential with it

        $t0 = microtime(true);
        // Upstream errors arrive as HTTP 429/401/etc, but the SSE stream below
        // always goes out as HTTP 200 -- so without this the browser can never
        // tell "slow down and retry" apart from "bad key, don't bother". The
        // status and Retry-After are captured here and re-emitted as a
        // structured error frame after the transfer (see below).
        $httpCode = 200;
        $retryAfterMs = null;
        $ch = curl_init($endpoint);
        curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($ch, $header) use (&$httpCode, &$retryAfterMs) {
            $len = strlen($header);
            $line = trim($header);
            if (preg_match('#^HTTP/\S+\s+(\d{3})#i', $line, $m)) {
                $httpCode = (int)$m[1];
            } elseif (stripos($line, 'Retry-After:') === 0) {
                $v = trim(substr($line, strlen('Retry-After:')));
                if (preg_match('#^\d+$#', $v)) {
                    $retryAfterMs = ((int)$v) * 1000;
                } elseif (($t = strtotime($v)) !== false) {
                    $retryAfterMs = max(0, ($t - time()) * 1000);
                }
            }
            return $len;
        });
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
        if (!empty($spec['proxy'])) {
            curl_setopt($ch, CURLOPT_PROXY, $spec['proxy']);
            curl_setopt($ch, CURLOPT_PROXYTYPE, CURLPROXY_HTTP);
            curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
            curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);
        } else {
            // No proxy configured, so nothing to set.
        }
        curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) {
            // MUST return the ORIGINAL length. Returning the trimmed length
            // tells curl we under-consumed, which aborts the transfer after the
            // first chunk — that is what collapsed a 397-event stream to 2.
            $len = strlen($chunk);
            $data = trim((string)$chunk);
            if ($data === '') { return $len; }
            if (strpos($data, 'data:') !== 0 && strpos($data, 'event:') !== 0
                && strpos($data, ':') !== 0) {
                $data = 'data: ' . $data;
            }
            echo $data . "\n\n";
            @flush();
            return $len;
        });
        // This was a hardcoded 180 while every other path used $this->timeout
        // (720). Streaming agents therefore timed out at 3 minutes while
        // curl-template agents got 12 — the streaming path is what the
        // tool-loop agents use, so ordinary agents failed and templates did not.
        curl_setopt($ch, CURLOPT_TIMEOUT, 720);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_BUFFERSIZE, 1);

        $ok = curl_exec($ch);
        $curlErr = curl_error($ch);
        $curlErrNo = curl_errno($ch);
        $infoCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        if ($infoCode > 0) { $httpCode = $infoCode; }
        curl_close($ch);

        // A timeout or dropped connection used to fall through to the [DONE]
        // below, so the client received a perfectly well-formed stream that
        // happened to contain no content. It read that as the model's answer
        // and ended the turn -- an agent looked like it finished having done
        // nothing. Say what happened instead, in a shape the client can raise.
        if ($ok === false) {
            $reason = $curlErr !== '' ? $curlErr : "curl error $curlErrNo";
            error_log("Relay stream failed after " . round(microtime(true) - $t0, 1) . "s: $reason");
            echo 'data: ' . json_encode([
                'error' => 'upstream request failed: ' . $reason,
                'retryable' => true,
            ]) . "\n\n";
            @flush();
            echo "data: [DONE]\n\n";
            @flush();
            return ['streamed' => true, 'failed' => true];
        }

        // The upstream body above was forwarded verbatim, so the browser has
        // the provider's error text -- but not the status. A 429 ("wait and
        // retry") and a 401 ("the key is wrong, retrying is pointless") looked
        // identical, so the client retried both blindly at 1s/2s. This frame
        // carries the machine-readable part; it is emitted AFTER the body
        // frames so it wins when the client keeps the last structured frame.
        if ($httpCode === 429) {
            echo 'data: ' . json_encode([
                'error' => 'upstream rate limit (HTTP 429): the provider asked us to slow down. '
                    . 'The app will wait and retry automatically.',
                'status' => 429,
                'retryable' => true,
                'retryAfterMs' => $retryAfterMs,
            ]) . "\n\n";
            @flush();
        } elseif ($httpCode === 401 || $httpCode === 403) {
            echo 'data: ' . json_encode([
                'error' => "upstream refused the request (HTTP $httpCode). "
                    . 'Check the API key and that the model id is allowed on it.',
                'status' => $httpCode,
                'retryable' => false,
            ]) . "\n\n";
            @flush();
        } elseif ($httpCode >= 400) {
            $retryable = $httpCode >= 500 && $httpCode < 600;
            echo 'data: ' . json_encode([
                'error' => "upstream error (HTTP $httpCode)."
                    . ($retryable ? ' The app will retry automatically.' : ''),
                'status' => $httpCode,
                'retryable' => $retryable,
            ]) . "\n\n";
            @flush();
        }

        echo "data: [DONE]\n\n";
        @flush();
        return ['streamed' => true];
    }

    /**
     * Restore empty JSON-Schema objects lost to PHP decoding.
     *
     * json_decode(..., true) turns BOTH [] and {} into PHP [], so a template
     * body carrying `"parameters": {}` re-encodes as `"parameters": []` and
     * OpenRouter 400s ("[] is not of type 'object'"). Only empty values are
     * ambiguous, and only schema-object positions must be objects, so this
     * converts empty arrays to objects exclusively under schema-object keys
     * (recursively — properties nest). Everything else keeps wire shape:
     * `"messages": []` stays an array. Applied to the raw relay path only;
     * the prompt-based paths build their payloads in PHP and never lose shape.
     */
    private static function normalizeSchemaEmpties($v, $parentKey = null) {
        static $objectKeys = ['parameters', 'properties', 'definitions', '$defs',
            'patternProperties', 'dependencies', 'propertyNames', 'schema'];
        if (is_array($v)) {
            if (empty($v)) {
                return in_array((string)$parentKey, $objectKeys, true) ? (object)[] : [];
            }
            foreach ($v as $k => $item) {
                $v[$k] = self::normalizeSchemaEmpties($item, $k);
            }
            return $v;
        }
        return $v;
    }

    /**
     * POST an arbitrary payload verbatim (non-chat shapes) and extract
     * content/usage/reasoning from the response by provider family.
     */
    public function relayRaw($endpoint, $apiKey, $family, $payload, $proxy = null) {
        // Repair first: a template body carrying `"parameters": {}` arrives
        // here with the empty object already decoded to PHP [], which would
        // re-encode as `"parameters": []` and make OpenRouter 400 the schema.
        $payload = self::normalizeSchemaEmpties($payload);
        // Same registry as the chat paths: the raw passthrough still needs the
        // provider's auth style (Anthropic x-api-key, Google ?key=, Azure
        // api-key, everyone else Bearer).
        $auth = Harness::auth($family, $endpoint, $apiKey);
        $headers = $auth['headers'];
        $endpoint = $auth['endpoint'];

        $this->timeout = 720;
        $ch = curl_init($endpoint);
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, $this->timeout);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        if ($proxy) {
            curl_setopt($ch, CURLOPT_PROXY, $proxy);
            curl_setopt($ch, CURLOPT_PROXYTYPE, CURLPROXY_HTTP);
            curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
            curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);
        }
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($response === false) {
            return ['error' => 'Relay request failed', 'retryable' => true];
        }
        $this->lastRaw = $response;
        if ($httpCode >= 400) {
            return ['error' => "Provider error: $response",
                'status' => (int)$httpCode,
                'retryable' => (int)$httpCode === 429 || ((int)$httpCode >= 500 && (int)$httpCode < 600)];
        }
        $parsed = $this->parseResponse($response, $family);
        if ($parsed === null || $parsed === '') {
            // Reporting success with empty content makes a dead model look
            // like a working one. Say what actually came back instead.
            return ['error' => 'Unrecognized provider response: '
                . substr(preg_replace('/\s+/', ' ', (string) $response), 0, 300)];
        }
        $out = ['content' => $parsed];
        $usage = $this->parseUsage($response, $family);
        if ($usage) {
            $out['usage'] = $usage;
        }
        $reasoning = $this->parseReasoning($response);
        if ($reasoning) {
            $out['reasoning'] = $reasoning;
        }
        return $out;
    }

    /**
     * Extract model reasoning/thinking from a raw provider response.
     * Returns string or null (many providers don't supply it).
     *
     * Delegates to the harness registry so every family's thinking shape
     * (OpenAI reasoning_content, Anthropic thinking blocks, Google thought
     * parts) lives in one place.
     */
    public function parseReasoning($raw) {
        if (!$raw) {
            return null;
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            return null;
        }
        return Harness::reasoning($data, 'openrouter');
    }

    /**
     * Extract token usage from a raw provider response.
     * Returns ['prompt'=>int,'completion'=>int,'total'=>int] or null.
     */
    public function parseUsage($raw, $provider) {
        if (!$raw) {
            return null;
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            return null;
        }
        return Harness::usage($data, $provider);
    }

    public function getActiveModels() {
        return array_filter($this->models, function($model) {
            return $model['active'] ?? false;
        });
    }
    
    public function processRequest($prompt, $sessionData = [], $excludeIds = []) {        $activeModels = $this->getActiveModels();
        $results = [];
        
        // Filter out excluded models
        $activeModels = array_filter($activeModels, function($m) use ($excludeIds) {
            return !in_array($m['id'], $excludeIds);
        });
        
        if (empty($activeModels)) {
            return [['error' => 'No active models available']];
        }
        
        foreach ($activeModels as $model) {
            $startTime = microtime(true);
            $response = $this->callModel($model, $prompt, $sessionData);
            $endTime = microtime(true);
            
            if ($response !== false) {
                $results[] = [
                    'model_id' => $model['id'],
                    'model_name' => $model['name'],
                    'role' => $model['role'],
                    'response' => $response,
                    'latency' => round(($endTime - $startTime) * 1000, 0),
                    'timestamp' => time()
                ];
            } else {
                $results[] = [
                    'model_id' => $model['id'],
                    'model_name' => $model['name'],
                    'role' => $model['role'],
                    'error' => 'Request failed',
                    'timestamp' => time(),
                    'latency' => 0
                ];
            }
        }
        
        return $results;
    }
    
    private function callModel($model, $prompt, $sessionData) {
        $provider = (string)($model['provider'] ?? 'openrouter');
        $apiKey = (string)($model['api_key'] ?? '');

        // Build context-aware prompt
        $fullPrompt = $this->buildPromptWithContext($prompt, $sessionData, $model['role']);

        $payload = $this->buildPayload($model, $fullPrompt);

        // Auth + endpoint rewrite come from the registry (Anthropic x-api-key +
        // version, Google ?key= + x-goog-api-key, Azure api-key, else Bearer).
        $auth = Harness::auth($provider, (string)$model['endpoint'], $apiKey, $provider);
        $endpoint = $auth['endpoint'];
        $headers = $auth['headers'];
        
        $ch = curl_init($endpoint);
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, $this->timeout);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);

        // This is the path the NON-streaming relay actually takes -- relay()
        // hands off to callModel(). Proxy support existed on relayStream and
        // relayRaw only, so selecting a proxy appeared to do nothing at all
        // for any call that did not stream.
        $proxyForCall = $model['proxy'] ?? self::activeProxy([]);
        if ($proxyForCall) {
            curl_setopt($ch, CURLOPT_PROXY, $proxyForCall);
            curl_setopt($ch, CURLOPT_PROXYTYPE, CURLPROXY_HTTP);
        }
        
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);
        $this->lastHttpCode = (int)$httpCode;
        
        if ($response === false) {
            error_log("Model call failed for {$model['name']}: $error");
            return false;
        }

        $this->lastRaw = $response;
        
        if ($httpCode >= 400) {
            error_log("API error for {$model['name']}: HTTP $httpCode - $response");
            return json_decode($response, true);
        }
        
        return $this->parseResponse($response, $model['provider']);
    }
    
    private function buildPayload($model, $fullPrompt) {
        $provider = (string)($model['provider'] ?? 'openrouter');

        // Family-specific default output ceiling, then the harness's own cap
        // (e.g. Gemini 8k) so an over-large global max_tokens cannot 400.
        $base = $provider === 'anthropic' ? 4000 : ($provider === 'google' ? 2048 : 4096);
        $asked = array_key_exists('max_tokens', $model) ? (int)$model['max_tokens'] : 0;
        $maxTokens = $asked > 0 ? $asked : $base;
        $cap = Harness::capMaxTokens($provider, (string)($model['model'] ?? ''), $maxTokens);
        if ($cap !== null) { $maxTokens = $cap; }

        // The registry owns the request shape per API. Passing the flattened
        // prompt (no messages array) reproduces the long-standing single-turn
        // body each family expects.
        return Harness::payload($provider, [
            'model' => $model['model'] ?? '',
            'prompt' => $fullPrompt,
            'temperature' => $model['temperature'] ?? 0.7,
            'max_tokens' => $maxTokens,
        ]);
    }
    
    private function buildPromptWithContext($prompt, $sessionData, $role) {
        // Relay mode: caller supplies the full prompt, no role prefix
        if ($role === 'none') {
            return $prompt;
        }
        $rolePrompts = [
            'coder' => "You are an expert code generator and software engineer. Generate clean, well-commented code. Format all code in proper markdown blocks with language specifiers.",
            'architect' => "You are a system architect specializing in complex multi-service deployments. Analyze requirements deeply and provide architectural insights, design patterns, and structural recommendations.",
            'reviewer' => "You are a code reviewer focused on quality, security, performance, and maintainability. Provide detailed analysis with specific improvement suggestions.",
            'debugger' => "You are a debugging specialist. Analyze code issues and provide precise fix recommendations with examples.",
            'optimizer' => "You are a performance optimization expert. Focus on efficiency, resource usage, and scalability improvements."
        ];
        
        $roleContext = $rolePrompts[$role] ?? $rolePrompts['coder'];
        
        $context = "";
        if (!empty($sessionData['previous_responses'])) {
            $context = "Previous responses in this session:\n" . 
                      implode("\n---\n", $sessionData['previous_responses']) . "\n\n";
        }
        
        return "{$roleContext}\n\n{$context}User Request: {$prompt}";
    }
    
    private function parseResponse($response, $provider) {
        $data = json_decode($response, true);
        
        if (json_last_error() !== JSON_ERROR_NONE) {
            return $response; // Return raw response if JSON parsing fails
        }
        
        // The registry knows where each family hides the assistant text.
        $content = Harness::content($data, (string)$provider);
        if ($content !== null) {
            return $content;
        }

        // Fallback: return raw response if nothing matched
        return is_string($data) ? $data : json_encode($data);
    }
}