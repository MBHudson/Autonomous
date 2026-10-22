// Harness registry tests (client copy).
//
// Usage: node tests/js/harness.test.mjs
//
// Pure functions only; no browser globals. Exits 0 on success, 1 on failure.

import { detectFamily, harnessFor, autoProtocol, toolProtocolFor, defaultRpmFor, contextLimitFor } from '../../ui/js/harness.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('Harness registry tests (client)');
console.log('-'.repeat(60));

// detectFamily: endpoint wins, then provider, then model
eq(detectFamily({ provider: 'anything', endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: 'anthropic/claude-3.5-sonnet' }), 'openai',
  'openrouter host -> openai shape even for claude');
eq(detectFamily({ provider: 'openrouter', endpoint: 'https://api.anthropic.com/v1/messages', model: 'x' }), 'anthropic',
  'anthropic host wins over provider id');
eq(detectFamily({ provider: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.1-70b' }), 'openai',
  'groq -> openai shape');
eq(detectFamily({ provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' }), 'openai',
  'deepseek -> openai shape');
eq(detectFamily({ provider: 'google', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', model: 'gemini-2.5-flash' }), 'google',
  'google -> google shape');
eq(detectFamily({ provider: 'ollama', endpoint: 'http://localhost:11434/api/chat', model: 'qwen2.5-coder' }), 'ollama',
  'ollama native -> ollama shape');
eq(detectFamily({ provider: 'ollama', endpoint: 'http://localhost:11434/v1/chat/completions', model: 'llama3.1' }), 'openai',
  'ollama /v1 shim -> openai shape');
eq(detectFamily({ provider: 'custom', endpoint: 'https://example.com/v1/x', model: 'gemini-2.0-flash' }), 'google',
  'unknown endpoint + gemini model -> google');
eq(detectFamily({ provider: 'custom', endpoint: 'https://example.com/v1/x', model: 'acme' }), 'openai',
  'unknown everything -> openai default');
eq(detectFamily({ provider: 'ollama', endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: 'llama3' }), 'openai',
  'endpoint overrides wrong provider id');

// tool dialect: model/provider, independent of API shape
eq(autoProtocol('openrouter', 'anthropic/claude-3.5-sonnet'), 'anthropic', 'claude via openrouter -> anthropic tools');
eq(autoProtocol('anthropic', 'claude-3-5-sonnet'), 'anthropic', 'anthropic provider -> anthropic tools');
eq(autoProtocol('ollama', 'qwen2.5-coder'), 'native', 'qwen on ollama -> native tools');
eq(autoProtocol('openai', 'gpt-4o'), 'json', 'gpt-4o -> json tools');
eq(autoProtocol('groq', 'llama-3.1-70b'), 'json', 'llama -> json tools');

// harnessFor bundles family + tool dialect
const h = harnessFor({ provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: 'anthropic/claude-3.5-sonnet' });
eq(h.id, 'openai', 'harnessFor: family id');
eq(h.label, 'OpenAI-compatible', 'harnessFor: label');
eq(h.toolProtocol, 'anthropic', 'harnessFor: picks anthropic tools for claude');
const g = harnessFor({ provider: 'google', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', model: 'gemini-2.5-flash' });
eq(g.toolProtocol, 'json', 'harnessFor: gemini -> json tools');

// explicit override always wins
eq(toolProtocolFor({ provider: 'openai', model: 'gpt-4o', toolProtocol: 'native' }), 'native', 'explicit toolProtocol override wins');
eq(toolProtocolFor({ provider: 'openai', model: 'gpt-4o', toolProtocol: 'auto' }), 'json', 'auto falls back to detection');

// default RPM per host (used by the rate governor when nothing is configured)
eq(defaultRpmFor('https://integrate.api.nvidia.com/v1/chat/completions'), 40, 'default rpm: NVIDIA NIM 40');
eq(defaultRpmFor('https://api.groq.com/openai/v1/chat/completions'), 30, 'default rpm: Groq 30');
eq(defaultRpmFor('https://openrouter.ai/api/v1/chat/completions'), 20, 'default rpm: OpenRouter 20');
eq(defaultRpmFor('http://localhost:11434/api/chat'), 0, 'default rpm: local unpaced');
eq(defaultRpmFor('https://unknown.example/v1/x'), 20, 'default rpm: unknown host 20');

// context windows from the generated table
eq(contextLimitFor('nvidia/nemotron-3-super-120b-a12b'), 131072, 'context: nemotron 128k');
eq(contextLimitFor('mystery-model'), null, 'context: unknown null');

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
for (const e of errors) console.log('  ' + e);
process.exit(fail ? 1 : 0);
