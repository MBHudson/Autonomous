<?php
// ============================================================
// Harness — one place that knows how to talk to each model family
// ============================================================
//
// Providers are not one API with different URLs. There are four real request
// shapes in the wild, plus a pile of OpenAI-compatible clones:
//
//   * openrouter   — the OpenAI /chat/completions shape. OpenRouter, NVIDIA
//                    NIM, OpenAI, Groq, Together, DeepSeek, xAI, Mistral,
//                    Cerebras, Fireworks, Perplexity, Moonshot/Kimi, LM Studio,
//                    vLLM, llama.cpp, text-generation-webui, Azure OpenAI *.
//   * anthropic    — the Messages API: x-api-key + anthropic-version, a
//                    top-level `system`, `max_tokens` mandatory, typed SSE.
//   * google       — generateContent: `contents`/`parts`, `?key=`, a
//                    generationConfig, `usageMetadata`.
//   * ollama       — native /api/chat or /api/generate on :11434.
//
// Everything above used to be decided by ad-hoc switches scattered through
// ModelManager (one for headers, one for the payload, three for parsing), and
// the provider→shape mapping was a single hardcoded array that silently sent
// anything unrecognised down the "custom" path. This class is the single
// registry: detect() picks the harness, and the rest of the app asks it how to
// authenticate, what body to send, and where the content / usage / reasoning
// live in the reply.
//
// Adding a new provider is now a one-line change to aliasMap() or a host to
// detect(); no call site needs to learn about it.
//
// (*) Azure OpenAI authenticates with an `api-key` header instead of Bearer;
//     that difference is handled in auth().

namespace Src;

class Harness {
    /** Fallback when nothing else matches: the OpenAI-compatible shape. */
    const DEFAULT_ID = 'openrouter';

    /**
     * Provider id (as stored on a provider/agent) -> harness id.
     *
     * This is the "which API is this" map, not "which model". On OpenRouter a
     * Claude model is still called through the OpenAI-compatible endpoint, so
     * model id never chooses the API shape here — only the tool dialect, which
     * the browser decides (see ui/js/harness.js).
     */
    private static function aliasMap() {
        return [
            // OpenAI-compatible chat
            'openrouter'            => 'openrouter',
            'openai'                => 'openrouter',
            'azure'                 => 'openrouter',
            'azure-openai'          => 'openrouter',
            'nvidia'                => 'openrouter',
            'nvidia-nim'            => 'openrouter',
            'nim'                   => 'openrouter',
            'groq'                  => 'openrouter',
            'together'              => 'openrouter',
            'together-ai'           => 'openrouter',
            'deepseek'              => 'openrouter',
            'xai'                   => 'openrouter',
            'x-ai'                  => 'openrouter',
            'grok'                  => 'openrouter',
            'mistral'               => 'openrouter',
            'mistralai'             => 'openrouter',
            'cerebras'              => 'openrouter',
            'fireworks'             => 'openrouter',
            'perplexity'            => 'openrouter',
            'pplx'                  => 'openrouter',
            'moonshot'              => 'openrouter',
            'kimi'                  => 'openrouter',
            'lmstudio'              => 'openrouter',
            'lm-studio'             => 'openrouter',
            'vllm'                  => 'openrouter',
            'llamacpp'              => 'openrouter',
            'llama.cpp'             => 'openrouter',
            'text-generation-webui' => 'openrouter',
            'oobabooga'             => 'openrouter',
            'ollama-openai'         => 'openrouter',

            // Genuinely different shapes
            'anthropic'             => 'anthropic',
            'google'                => 'google',
            'gemini'                => 'google',
            'vertex'                => 'google',
            'vertex-ai'             => 'google',
            'ollama'                => 'ollama',
        ];
    }

    /** Providers that use Azure's `api-key` header rather than Bearer. */
    private static function isAzure($provider) {
        return in_array($provider, ['azure', 'azure-openai'], true);
    }

    /**
     * Which harness should carry this request?
     *
     * Order matters and encodes a rule worth remembering: the ENDPOINT wins
     * over the provider id, because the endpoint is where the bytes actually
     * go. A provider mislabelled "groq" but pointed at api.anthropic.com must
     * be spoken to in the Anthropic dialect. Model id is only consulted as a
     * last resort, when the provider is unknown/auto and no endpoint host
     * matched, and even then it can only choose the two families whose APIs are
     * unmistakably model-tied (Claude, Gemini).
     *
     * @param array $spec {provider, endpoint, model}
     * @return string harness id
     */
    public static function detect(array $spec) {
        $provider = strtolower(trim((string)($spec['provider'] ?? '')));
        $endpoint = (string)($spec['endpoint'] ?? '');
        $model    = strtolower(trim((string)($spec['model'] ?? '')));

        $host = '';
        $path = '';
        if ($endpoint !== '') {
            $parts = parse_url($endpoint);
            if (is_array($parts)) {
                $host = strtolower((string)($parts['host'] ?? ''));
                $path = strtolower((string)($parts['path'] ?? ''));
                // Some endpoints carry a port in the host string oddly; keep the
                // raw endpoint too for the :11434 probe below.
            }
        }

        // 1. Endpoint host — the strongest signal.
        if ($host !== '') {
            if (strpos($host, 'openrouter.ai') !== false) return 'openrouter';
            if (strpos($host, 'anthropic.com') !== false) return 'anthropic';
            if (strpos($host, 'generativelanguage') !== false
                || strpos($host, 'googleapis.com') !== false
                || strpos($host, 'aiplatform.googleapis.com') !== false) {
                return 'google';
            }
            if (strpos($host, 'openai.azure.com') !== false) return 'openrouter';
            if (strpos($host, 'api.openai.com') !== false) return 'openrouter';
            if (strpos($host, 'localhost') !== false && self::pathIsOllama($path)) return 'ollama';
            if (strpos($host, 'localhost') === false && self::pathIsOllama($path)) return 'ollama';
        }
        // Ollama addressed by IP:port, e.g. http://192.168.1.5:11434/api/chat.
        // Its OpenAI-compatible shim lives under /v1, which is the openrouter
        // shape, so the port alone is not enough.
        if (strpos($endpoint, ':11434') !== false && strpos($path, '/v1') === false) return 'ollama';
        if ($path !== '' && self::pathIsOllama($path)) return 'ollama';

        // An explicit OpenAI chat/completions (or Responses) path is the
        // OpenAI shape whatever the provider is called -- this is how Ollama's
        // /v1 shim and every clone are reached.
        if (preg_match('#/chat/completions$#', $path)
            || preg_match('#/completions$#', $path)
            || strpos($path, '/responses') !== false) {
            return 'openrouter';
        }

        // 2. Provider id.
        $map = self::aliasMap();
        if ($provider !== '' && isset($map[$provider])) {
            return $map[$provider];
        }

        // 3. Model id, only when nothing above committed. Claude and Gemini are
        //    the only families whose API shape is implied by the model alone.
        if ($provider === '' || $provider === 'auto' || $provider === 'custom') {
            if (preg_match('#(^|[/_:])claude#', $model)) return 'anthropic';
            if (preg_match('#gemini|gemma#', $model)) return 'google';
        }

        return self::DEFAULT_ID;
    }

    private static function pathIsOllama($path) {
        if ($path === '') return false;
        // Ollama's native API. The OpenAI-compatible shim lives under /v1,
        // which is the openrouter shape, not this one.
        if (strpos($path, '/v1') !== false) return false;
        return strpos($path, '/api/chat') !== false
            || strpos($path, '/api/generate') !== false
            || strpos($path, '/api/tags') !== false
            || strpos($path, '/api/embed') !== false;
    }

    /** Human label for logs and the UI. */
    public static function label($id) {
        switch ($id) {
            case 'anthropic':  return 'Anthropic Messages';
            case 'google':     return 'Google generateContent';
            case 'ollama':     return 'Ollama';
            case 'openrouter':
            default:           return 'OpenAI-compatible';
        }
    }

    /**
     * Auth headers and (possibly rewritten) endpoint for a harness.
     *
     * Google accepts the key as a `?key=` query param OR the x-goog-api-key
     * header; both are sent because different Google front doors honour
     * different ones. Anthropic needs its version header. Azure swaps Bearer
     * for `api-key`.
     *
     * @return array{headers: string[], endpoint: string}
     */
    public static function auth($id, $endpoint, $apiKey, $provider = '') {
        $headers = ['Content-Type: application/json'];
        $endpoint = (string)$endpoint;
        $apiKey = (string)$apiKey;

        if ($apiKey !== '') {
            if ($id === 'anthropic') {
                $headers[] = 'x-api-key: ' . $apiKey;
                $headers[] = 'anthropic-version: 2023-06-01';
            } elseif ($id === 'google') {
                $endpoint .= (strpos($endpoint, '?') === false ? '?' : '&') . 'key=' . $apiKey;
                $headers[] = 'x-goog-api-key: ' . $apiKey;
            } elseif (self::isAzure(strtolower((string)$provider))) {
                $headers[] = 'api-key: ' . $apiKey;
            } else {
                $headers[] = 'Authorization: Bearer ' . $apiKey;
            }
        }
        return ['headers' => $headers, 'endpoint' => $endpoint];
    }

    /**
     * The request body for a chat call.
     *
     * @param array $spec {model, prompt, messages, temperature, max_tokens}
     * @param bool  $stream
     */
    public static function payload($id, array $spec, $stream = false) {
        $model = $spec['model'] ?? '';
        $messages = $spec['messages'] ?? [];
        $prompt = $spec['prompt'] ?? '';
        $temperature = array_key_exists('temperature', $spec) ? $spec['temperature'] : 0.7;
        $maxTokens = array_key_exists('max_tokens', $spec) ? (int)$spec['max_tokens'] : 4096;

        switch ($id) {
            case 'anthropic':
                $conv = $messages ? self::toAnthropicMessages($messages) : [];
                $body = [
                    'model' => $model,
                    'max_tokens' => $maxTokens > 0 ? $maxTokens : 4000,
                    'messages' => $conv ?: [['role' => 'user', 'content' => $prompt]],
                    'stream' => (bool)$stream,
                ];
                $system = self::systemFrom($messages);
                if ($system !== '') { $body['system'] = $system; }
                return self::withTools($body, $spec);

            case 'google':
                $conv = $messages ? self::toGoogleContents($messages) : [];
                $body = [
                    'contents' => $conv ?: [['parts' => [['text' => $prompt]]]],
                    'generationConfig' => [
                        'temperature' => $temperature,
                        'maxOutputTokens' => $maxTokens > 0 ? $maxTokens : 2048,
                    ],
                ];
                $system = self::systemFrom($messages);
                if ($system !== '') {
                    $body['systemInstruction'] = ['parts' => [['text' => $system]]];
                }
                return self::withTools($body, $spec);

            case 'ollama':
                // Native chat API keeps the messages array; the older generate
                // API takes a single `prompt`.
                if ($messages) {
                    return self::withTools([
                        'model' => $model, 'messages' => $messages, 'stream' => (bool)$stream,
                    ], $spec);
                }
                return self::withTools([
                    'model' => $model, 'prompt' => $prompt, 'stream' => (bool)$stream,
                ], $spec);

            case 'openrouter':
            default:
                return self::withTools([
                    'model' => $model,
                    'messages' => $messages ?: [['role' => 'user', 'content' => $prompt]],
                    'temperature' => $temperature,
                    'max_tokens' => $maxTokens,
                    'stream' => (bool)$stream,
                ], $spec);
        }
    }

    /**
     * Attach native tool definitions and the provider's selection mode.
     *
     * These are built client-side because the tool registry lives in the
     * browser, but they must be placed in the provider-specific body here:
     * Anthropic wants `input_schema`, Google wants `functionDeclarations`, and
     * OpenAI-compatible APIs want `type:function`.
     */
    private static function withTools(array $body, array $spec) {
        if (!empty($spec['tools']) && is_array($spec['tools'])) {
            $body['tools'] = $spec['tools'];
        }
        if (array_key_exists('tool_choice', $spec) && $spec['tool_choice'] !== null) {
            $body['tool_choice'] = $spec['tool_choice'];
        }
        if (!empty($spec['tool_config']) && is_array($spec['tool_config'])) {
            $body['toolConfig'] = $spec['tool_config'];
        }
        return $body;
    }

    /**
     * Extra payload keys a streaming request needs, per harness.
     *
     * OpenAI-compatible endpoints only emit a usage block on a stream when
     * asked; nearly all of them accept `stream_options`. It is only added where
     * it is known to be accepted.
     */
    public static function streamOptions($id, $provider = '') {
        $provider = strtolower((string)$provider);
        $supports = in_array($provider, ['openrouter', 'openai', 'groq', 'together', 'deepseek'], true);
        if ($id === 'openrouter' && $supports) {
            return ['stream_options' => ['include_usage' => true]];
        }
        return [];
    }

    /** Extract the assistant text from a decoded (non-stream) response. */
    public static function content($data, $id) {
        if (!is_array($data)) {
            return null;
        }
        switch ($id) {
            case 'anthropic':
                if (isset($data['content'][0]['text'])) return $data['content'][0]['text'];
                // Concatenate multi-block replies (text blocks only).
                if (isset($data['content']) && is_array($data['content'])) {
                    $out = '';
                    foreach ($data['content'] as $b) {
                        if (is_array($b) && ($b['type'] ?? '') === 'text') $out .= $b['text'] ?? '';
                    }
                    if ($out !== '') return $out;
                }
                return null;

            case 'google':
                if (isset($data['candidates'][0]['content']['parts'][0]['text'])) {
                    return $data['candidates'][0]['content']['parts'][0]['text'];
                }
                if (isset($data['candidates'][0]['content']['parts']) && is_array($data['candidates'][0]['content']['parts'])) {
                    $out = '';
                    foreach ($data['candidates'][0]['content']['parts'] as $p) {
                        if (is_array($p) && isset($p['text'])) $out .= $p['text'];
                    }
                    if ($out !== '') return $out;
                }
                return null;

            case 'ollama':
                if (isset($data['message']['content'])) return $data['message']['content'];
                if (isset($data['response'])) return $data['response'];
                return null;

            case 'openrouter':
            default:
                if (isset($data['choices'][0]['message']['content'])) {
                    $c = $data['choices'][0]['message']['content'];
                    return is_array($c) ? json_encode($c) : $c;
                }
                if (isset($data['choices'][0]['text'])) return $data['choices'][0]['text'];
                if (isset($data['response'])) return $data['response'];
                return null;
        }
    }

    /**
     * Token usage, normalised to ['prompt'=>int,'completion'=>int,'total'=>int].
     * Returns null when the provider sent none.
     */
    public static function usage($data, $id) {
        if (!is_array($data)) {
            return null;
        }
        $u = null;
        switch ($id) {
            case 'anthropic':
                if (isset($data['usage'])) {
                    $u = [
                        'prompt_tokens' => $data['usage']['input_tokens'] ?? 0,
                        'completion_tokens' => $data['usage']['output_tokens'] ?? 0,
                    ];
                }
                break;
            case 'google':
                if (isset($data['usageMetadata'])) {
                    $u = [
                        'prompt_tokens' => $data['usageMetadata']['promptTokenCount'] ?? 0,
                        'completion_tokens' => $data['usageMetadata']['candidatesTokenCount'] ?? 0,
                        'total_tokens' => $data['usageMetadata']['totalTokenCount'] ?? 0,
                    ];
                }
                break;
            case 'ollama':
                if (isset($data['prompt_eval_count']) || isset($data['eval_count'])) {
                    $u = [
                        'prompt_tokens' => $data['prompt_eval_count'] ?? 0,
                        'completion_tokens' => $data['eval_count'] ?? 0,
                    ];
                }
                break;
            case 'openrouter':
            default:
                $u = $data['usage'] ?? null;
                break;
        }
        if (!$u) {
            return null;
        }
        $prompt = (int)($u['prompt_tokens'] ?? 0);
        $completion = (int)($u['completion_tokens'] ?? 0);
        return [
            'prompt' => $prompt,
            'completion' => $completion,
            'total' => (int)($u['total_tokens'] ?? ($prompt + $completion)),
        ];
    }

    /**
     * Model reasoning / thinking text, whenever the family exposes it.
     * Many providers send none; that is a normal null, not an error.
     */
    public static function reasoning($data, $id) {
        if (!is_array($data)) {
            return null;
        }
        // OpenAI-compatible "reasoning" models (DeepSeek, NVIDIA, Groq, …) put
        // it beside the content.
        if (isset($data['choices'][0]['message']) && is_array($data['choices'][0]['message'])) {
            $msg = $data['choices'][0]['message'];
            if (!empty($msg['reasoning_content']) && is_string($msg['reasoning_content'])) return $msg['reasoning_content'];
            if (!empty($msg['reasoning']) && is_string($msg['reasoning'])) return $msg['reasoning'];
        }
        if (!empty($data['reasoning_content']) && is_string($data['reasoning_content'])) return $data['reasoning_content'];
        if (!empty($data['reasoning']) && is_string($data['reasoning'])) return $data['reasoning'];
        // Anthropic thinking blocks.
        if (isset($data['content']) && is_array($data['content'])) {
            $parts = [];
            foreach ($data['content'] as $block) {
                if (is_array($block) && in_array($block['type'] ?? '', ['thinking', 'redacted_thinking'], true)) {
                    $parts[] = $block['thinking'] ?? '';
                }
            }
            $thinking = trim(implode("\n\n", array_filter($parts)));
            if ($thinking !== '') return $thinking;
        }
        if (!empty($data['thinking']) && is_string($data['thinking'])) return $data['thinking'];
        // Google puts thoughts on parts with `thought: true`.
        if (isset($data['candidates'][0]['content']['parts']) && is_array($data['candidates'][0]['content']['parts'])) {
            $out = '';
            foreach ($data['candidates'][0]['content']['parts'] as $p) {
                if (is_array($p) && !empty($p['thought']) && isset($p['text'])) $out .= $p['text'];
            }
            if ($out !== '') return $out;
        }
        return null;
    }

    /**
     * The tool-call dialect to TEACH a model in its system prompt. The client
     * parser is lenient and reads all of them, so this only picks which one to
     * demonstrate. Mirrors ui/js/harness.js so the server can describe an
     * agent without a round trip.
     */
    public static function toolProtocol(array $spec, $id = null) {
        $id = $id ?: self::detect($spec);
        $model = strtolower((string)($spec['model'] ?? ''));
        $provider = strtolower((string)($spec['provider'] ?? ''));

        if ($id === 'anthropic' || preg_match('#claude|anthropic/#', $model)) return 'anthropic';
        if (preg_match('#(qwen|glm|hermes|nous|kimi|moonshot)#', $model)) return 'native';
        if ($provider === 'ollama' && preg_match('#(qwen|glm|hermes)#', $model)) return 'native';
        return 'json';
    }

    /**
     * A model's output-token ceiling for the harness, when it is known and
     * lower than what was asked. null = no harness opinion (leave the value
     * alone). This is the hook for the "NIM rejects max_tokens above the
     * model's output limit" class of 400s: add the cap here, once.
     */
    public static function capMaxTokens($id, $model, $requested) {
        $model = strtolower((string)$model);
        $caps = [
            // model substring => hard output ceiling
            'gemini-2.0-flash' => 8192,
            'gemini-1.5-flash' => 8192,
            'gemini-1.5-pro'   => 8192,
            'gpt-4o-mini'      => 16384,
            'gpt-4o'           => 16384,
        ];
        foreach ($caps as $needle => $cap) {
            if (strpos($model, $needle) !== false) {
                return min((int)$requested, $cap);
            }
        }
        return null;
    }

    /** A short descriptor for the UI / diagnostics. */
    public static function describe($id) {
        return [
            'id' => $id,
            'label' => self::label($id),
            'streaming' => 'sse',
        ];
    }

    // ---------------------------------------------------------------
    // Message-shape conversions for the non-OpenAI APIs
    // ---------------------------------------------------------------

    private static function messageText($content) {
        if (is_array($content)) {
            $out = '';
            foreach ($content as $part) {
                if (is_string($part)) { $out .= $part; }
                elseif (is_array($part) && isset($part['text'])) { $out .= $part['text']; }
            }
            return $out;
        }
        return (string)$content;
    }

    private static function systemFrom(array $messages) {
        $sys = [];
        foreach ($messages as $m) {
            if (is_array($m) && ($m['role'] ?? '') === 'system') {
                $sys[] = self::messageText($m['content'] ?? '');
            }
        }
        return trim(implode("\n\n", array_filter($sys)));
    }

    /** OpenAI-style messages -> Anthropic: system lifted out, roles narrowed. */
    private static function toAnthropicMessages(array $messages) {
        $out = [];
        foreach ($messages as $m) {
            if (!is_array($m)) continue;
            $role = $m['role'] ?? 'user';
            if ($role === 'system') continue;       // lifted to the top-level system
            if ($role !== 'assistant') $role = 'user';
            $text = self::messageText($m['content'] ?? '');
            if ($text === '') continue;
            $out[] = ['role' => $role, 'content' => $text];
        }
        return $out;   // caller falls back to the single-prompt form when empty
    }

    /** OpenAI-style messages -> Google contents: user/model roles, system out. */
    private static function toGoogleContents(array $messages) {
        $out = [];
        foreach ($messages as $m) {
            if (!is_array($m)) continue;
            $role = $m['role'] ?? 'user';
            if ($role === 'system') continue;       // lifted to systemInstruction
            $text = self::messageText($m['content'] ?? '');
            if ($text === '') continue;
            $out[] = [
                'role' => $role === 'assistant' ? 'model' : 'user',
                'parts' => [['text' => $text]],
            ];
        }
        return $out;   // caller falls back to the single-prompt form when empty
    }

    // ---------------------------------------------------------------
    // Shared data tables — the single source of truth.
    //
    // tools/gen-harness.php reads these and emits ui/js/harness.data.js so the
    // browser copy is generated, not hand-maintained. Editing a provider or a
    // cap here and running the generator is the whole workflow.
    // ---------------------------------------------------------------

    /** API family descriptors (label shown in the UI). */
    public static function families() {
        return [
            'openai'    => ['label' => 'OpenAI-compatible',      'auth' => 'bearer',    'toolProtocol' => 'json',      'images' => true],
            'anthropic' => ['label' => 'Anthropic Messages',     'auth' => 'x-api-key', 'toolProtocol' => 'anthropic', 'images' => true],
            'google'    => ['label' => 'Google generateContent', 'auth' => 'query-key', 'toolProtocol' => 'json',      'images' => true],
            'ollama'    => ['label' => 'Ollama',                 'auth' => 'none',      'toolProtocol' => 'json',      'images' => false],
        ];
    }

    /** Public provider→family alias table. */
    public static function aliases() {
        return self::aliasMap();
    }

    /** Endpoint host substring → family, in evaluation order. */
    public static function hostMatchers() {
        return [
            ['openrouter.ai', 'openrouter'],
            ['anthropic.com', 'anthropic'],
            ['generativelanguage', 'google'],
            ['googleapis.com', 'google'],
            ['aiplatform.googleapis.com', 'google'],
            ['openai.azure.com', 'openrouter'],
            ['api.openai.com', 'openrouter'],
        ];
    }

    /** Model-id regex → tool dialect, in evaluation order. */
    public static function toolPatterns() {
        return [
            ['(^|[/_:])claude', 'anthropic'],
            ['(qwen|glm|hermes|nous)', 'native'],
        ];
    }

    /** Known context windows, matched by substring on the model id. */
    public static function contextLimits() {
        return [
            ['kimi-k3', 262144],
            ['glm-5', 131072],
            ['laguna-xs-2.1', 32768],
            ['qwen3.8-27b', 32768],
            ['qwen3', 32768],
            ['nomic-embed', 8192],
            ['nemotron', 131072],
            ['gemma-4', 131072],
            ['gemma-3', 131072],
            ['muse-glimmer', 131072],
        ];
    }

    /**
     * Free-tier requests/minute by endpoint host, used when the operator has
     * not set a global rateLimitRpm. 0 = no pacing (local runners).
     * These are the published free-tier numbers; a paid key should raise them
     * in Config, and the governor will pace to whatever is set there.
     */
    public static function defaultRpm() {
        return [
            'integrate.api.nvidia.com'           => 40,
            'api.groq.com'                       => 30,
            'openrouter.ai'                      => 20,
            'api.deepseek.com'                   => 60,
            'api.mistral.ai'                     => 60,
            'api.x.ai'                           => 60,
            'api.openai.com'                     => 500,
            'generativelanguage.googleapis.com'  => 15,
            'api.anthropic.com'                  => 50,
            'api.cerebras.ai'                    => 30,
            'api.together.xyz'                   => 60,
            'localhost'                          => 0,
            '127.0.0.1'                          => 0,
        ];
    }

    /** The host's default RPM, or 20 when the host is unknown. */
    public static function defaultRpmFor($endpoint) {
        $host = strtolower((string)(parse_url((string)$endpoint, PHP_URL_HOST) ?: ''));
        foreach (self::defaultRpm() as $needle => $rpm) {
            if ($needle !== '' && strpos($host, strtolower($needle)) !== false) return (int)$rpm;
        }
        return 20;
    }
}
