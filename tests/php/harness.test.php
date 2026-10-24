<?php
/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

/**
 * Harness registry unit tests.
 *
 * Usage: php tests/php/harness.test.php
 *
 * Pure functions only — no network, no config. Exits 0 on success, 1 on any
 * failure. Mirrors tests/php/sandbox.test.php's harness style.
 */

require_once __DIR__ . '/../../autoload.php';

use Src\Harness;

$pass = 0;
$fail = 0;
$errors = [];

function ok($cond, $name) {
    global $pass, $fail, $errors;
    if ($cond) { $pass++; }
    else { $fail++; $errors[] = "FAIL: $name"; }
}

echo "Harness registry tests\n";
echo str_repeat('-', 60) . "\n";

// --- detect: endpoint host wins, then provider, then model -------------
$detect = function ($provider, $endpoint, $model) {
    return Harness::detect(['provider' => $provider, 'endpoint' => $endpoint, 'model' => $model]);
};

ok($detect('anything', 'https://openrouter.ai/api/v1/chat/completions', 'anthropic/claude-3.5-sonnet') === 'openrouter',
    'openrouter host -> openai-compatible shape even for a claude model');
ok($detect('openrouter', 'https://api.anthropic.com/v1/messages', 'x') === 'anthropic',
    'anthropic host wins over a mismatched provider id');
ok($detect('groq', 'https://api.groq.com/openai/v1/chat/completions', 'llama-3.1-70b') === 'openrouter',
    'first-party clone (groq) -> openai-compatible');
ok($detect('deepseek', 'https://api.deepseek.com/chat/completions', 'deepseek-chat') === 'openrouter',
    'deepseek -> openai-compatible');
ok($detect('xai', 'https://api.x.ai/v1/chat/completions', 'grok-2') === 'openrouter',
    'xai -> openai-compatible');
ok($detect('mistral', 'https://api.mistral.ai/v1/chat/completions', 'mistral-large') === 'openrouter',
    'mistral -> openai-compatible');
ok($detect('google', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', 'gemini-2.5-flash') === 'google',
    'google -> generateContent shape');
ok($detect('vertex', 'https://us-central1-aiplatform.googleapis.com/v1/projects/x/locations/y/publishers/google/models/gemini-1.5-pro:generateContent', 'gemini-1.5-pro') === 'google',
    'vertex AI -> google shape');
ok($detect('ollama', 'http://localhost:11434/api/chat', 'qwen2.5-coder') === 'ollama',
    'ollama native -> ollama shape');
ok($detect('', 'http://192.168.1.5:11434/api/generate', 'llama3.1') === 'ollama',
    'ollama by ip:port -> ollama shape');
ok($detect('custom', 'https://example.com/v1/anything', 'gemini-2.0-flash') === 'google',
    'unknown endpoint + gemini model -> google hint');
ok($detect('custom', 'https://example.com/v1/anything', 'acme-llm') === 'openrouter',
    'unknown everything -> openai-compatible default');
ok($detect('openai', 'https://api.openai.com/v1/chat/completions', 'gpt-4o') === 'openrouter',
    'api.openai.com -> openai-compatible shape');

// --- a provider mislabelled "ollama" on an OpenAI-compatible host -------
ok($detect('ollama', 'https://openrouter.ai/api/v1/chat/completions', 'llama3') === 'openrouter',
    'endpoint overrides a wrong ollama provider id');

// --- payload shapes -----------------------------------------------------
$or = Harness::payload('openrouter', ['model' => 'm', 'prompt' => 'P', 'temperature' => 0.3, 'max_tokens' => 10]);
ok($or['model'] === 'm' && $or['messages'][0]['content'] === 'P' && $or['temperature'] === 0.3 && $or['max_tokens'] === 10,
    'openai-compatible payload: messages + temperature + max_tokens');

// Native tools are built client-side but must survive into the provider body.
$tools = [['type' => 'function', 'function' => ['name' => 'echo']]];
$orTools = Harness::payload('openrouter', [
    'model' => 'm', 'prompt' => 'P', 'tools' => $tools, 'tool_choice' => 'auto',
]);
ok($orTools['tools'] === $tools, 'openai-compatible payload carries native tools');
ok($orTools['tool_choice'] === 'auto', 'openai-compatible payload carries tool_choice');
$anTools = Harness::payload('anthropic', [
    'model' => 'claude', 'prompt' => 'P', 'tools' => $tools, 'tool_choice' => ['type' => 'auto'],
]);
ok($anTools['tools'] === $tools, 'anthropic payload carries native tools');
ok($anTools['tool_choice'] === ['type' => 'auto'], 'anthropic payload carries its tool_choice shape');
$goTools = Harness::payload('google', [
    'model' => 'gemini', 'prompt' => 'P', 'tools' => [['functionDeclarations' => []]],
    'tool_config' => ['functionCallingConfig' => ['mode' => 'AUTO']],
]);
ok(isset($goTools['tools'][0]['functionDeclarations']), 'google payload carries functionDeclarations');
ok($goTools['toolConfig']['functionCallingConfig']['mode'] === 'AUTO', 'google payload carries toolConfig');

$an = Harness::payload('anthropic', [
    'model' => 'claude', 'messages' => [
        ['role' => 'system', 'content' => 'SYS'],
        ['role' => 'user', 'content' => 'HI'],
    ], 'max_tokens' => 32,
]);
ok($an['system'] === 'SYS', 'anthropic: system lifted to the top-level system field');
ok(count($an['messages']) === 1 && $an['messages'][0]['role'] === 'user', 'anthropic: system removed from messages');
ok($an['max_tokens'] === 32, 'anthropic: max_tokens present (mandatory)');

$go = Harness::payload('google', [
    'model' => 'gemini', 'messages' => [
        ['role' => 'system', 'content' => 'SYS'],
        ['role' => 'user', 'content' => 'HI'],
        ['role' => 'assistant', 'content' => 'YO'],
    ], 'max_tokens' => 64, 'temperature' => 0.1,
]);
ok(isset($go['contents'][1]) && $go['contents'][1]['role'] === 'model', 'google: assistant -> model role');
ok($go['systemInstruction']['parts'][0]['text'] === 'SYS', 'google: systemInstruction set');
ok($go['generationConfig']['maxOutputTokens'] === 64, 'google: maxOutputTokens from max_tokens');

$ol = Harness::payload('ollama', ['model' => 'q', 'prompt' => 'P', 'max_tokens' => 5]);
ok($ol['prompt'] === 'P' && !isset($ol['messages']), 'ollama single-prompt form');

$ols = Harness::payload('ollama', ['model' => 'q', 'messages' => [['role' => 'user', 'content' => 'P']]], true);
ok(isset($ols['messages']) && $ols['stream'] === true, 'ollama chat form when messages given');

// --- stream options -----------------------------------------------------
ok(Harness::streamOptions('openrouter', 'openrouter')['stream_options']['include_usage'] === true,
    'openai-compatible stream opts: include_usage');
ok(Harness::streamOptions('openrouter', 'my-proxy') === [], 'unknown openai host: no stream_options');
ok(Harness::streamOptions('anthropic', 'anthropic') === [], 'anthropic: no stream_options');

// --- content extraction -------------------------------------------------
ok(Harness::content(['choices' => [['message' => ['content' => 'hi']]]], 'openrouter') === 'hi', 'content: openai');
ok(Harness::content(['content' => [['type' => 'text', 'text' => 'hi']]], 'anthropic') === 'hi', 'content: anthropic');
ok(Harness::content(['candidates' => [['content' => ['parts' => [['text' => 'hi']]]]]], 'google') === 'hi', 'content: google');
ok(Harness::content(['message' => ['content' => 'hi']], 'ollama') === 'hi', 'content: ollama chat');
ok(Harness::content(['response' => 'hi'], 'ollama') === 'hi', 'content: ollama generate');
ok(Harness::content(['nope' => 1], 'openrouter') === null, 'content: none -> null');

// --- usage --------------------------------------------------------------
$u = Harness::usage(['usage' => ['prompt_tokens' => 3, 'completion_tokens' => 4]], 'openrouter');
ok($u['prompt'] === 3 && $u['completion'] === 4 && $u['total'] === 7, 'usage: openai');
$u = Harness::usage(['usage' => ['input_tokens' => 5, 'output_tokens' => 6]], 'anthropic');
ok($u['prompt'] === 5 && $u['completion'] === 6, 'usage: anthropic');
$u = Harness::usage(['usageMetadata' => ['promptTokenCount' => 7, 'candidatesTokenCount' => 8, 'totalTokenCount' => 15]], 'google');
ok($u['prompt'] === 7 && $u['completion'] === 8 && $u['total'] === 15, 'usage: google');
$u = Harness::usage(['prompt_eval_count' => 9, 'eval_count' => 10], 'ollama');
ok($u['prompt'] === 9 && $u['completion'] === 10, 'usage: ollama');
ok(Harness::usage(['nope' => 1], 'openrouter') === null, 'usage: none -> null');

// --- reasoning ----------------------------------------------------------
ok(Harness::reasoning(['choices' => [['message' => ['reasoning_content' => 'think']]]], 'openrouter') === 'think',
    'reasoning: openai reasoning_content');
ok(Harness::reasoning(['content' => [['type' => 'thinking', 'thinking' => 'why']]], 'anthropic') === 'why',
    'reasoning: anthropic thinking block');
ok(Harness::reasoning(['candidates' => [['content' => ['parts' => [['thought' => true, 'text' => 'hmm']]]]]], 'google') === 'hmm',
    'reasoning: google thought part');
ok(Harness::reasoning(['nope' => 1], 'openrouter') === null, 'reasoning: none -> null');

// --- tool dialect -------------------------------------------------------
ok(Harness::toolProtocol(['provider' => 'openrouter', 'model' => 'anthropic/claude-3.5-sonnet']) === 'anthropic',
    'tool: claude (even via openrouter) -> anthropic xml');
ok(Harness::toolProtocol(['provider' => 'ollama', 'model' => 'qwen2.5-coder']) === 'native',
    'tool: qwen on ollama -> native');
ok(Harness::toolProtocol(['provider' => 'openai', 'model' => 'gpt-4o']) === 'json',
    'tool: gpt-4o -> json');

// --- capMaxTokens -------------------------------------------------------
ok(Harness::capMaxTokens('google', 'gemini-2.0-flash', 99999) === 8192, 'cap: gemini-2.0-flash clamps to 8192');
ok(Harness::capMaxTokens('google', 'gemini-2.0-flash', 100) === 100, 'cap: does not raise a smaller request');
ok(Harness::capMaxTokens('openrouter', 'mystery-model', 99999) === null, 'cap: unknown model -> null (no opinion)');

// --- default RPM (rate governor fallback) -------------------------------
ok(Harness::defaultRpmFor('https://integrate.api.nvidia.com/v1/chat/completions') === 40, 'default rpm: NVIDIA NIM 40');
ok(Harness::defaultRpmFor('https://api.groq.com/openai/v1/chat/completions') === 30, 'default rpm: Groq 30');
ok(Harness::defaultRpmFor('https://openrouter.ai/api/v1/chat/completions') === 20, 'default rpm: OpenRouter 20');
ok(Harness::defaultRpmFor('http://localhost:11434/api/chat') === 0, 'default rpm: local unpaced');
ok(Harness::defaultRpmFor('https://unknown.example/v1/x') === 20, 'default rpm: unknown host 20');

echo str_repeat('-', 60) . "\n";
echo "$pass passed, $fail failed\n";
foreach ($errors as $e) { echo "  $e\n"; }
exit($fail ? 1 : 0);
