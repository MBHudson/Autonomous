/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================================
// HARNESS.DATA.JS - GENERATED FILE. DO NOT EDIT BY HAND.
//
// Source of truth: src/Harness.php
// Regenerate:      php tools/gen-harness.php
// ============================================================

export const API_FAMILIES = {"openai":{"label":"OpenAI-compatible","auth":"bearer","toolProtocol":"json","images":true},"anthropic":{"label":"Anthropic Messages","auth":"x-api-key","toolProtocol":"anthropic","images":true},"google":{"label":"Google generateContent","auth":"query-key","toolProtocol":"json","images":true},"ollama":{"label":"Ollama","auth":"none","toolProtocol":"json","images":false}};

export const PROVIDER_ALIASES = {"openrouter":"openai","openai":"openai","azure":"openai","azure-openai":"openai","nvidia":"openai","nvidia-nim":"openai","nim":"openai","groq":"openai","together":"openai","together-ai":"openai","deepseek":"openai","xai":"openai","x-ai":"openai","grok":"openai","mistral":"openai","mistralai":"openai","cerebras":"openai","fireworks":"openai","perplexity":"openai","pplx":"openai","moonshot":"openai","kimi":"openai","lmstudio":"openai","lm-studio":"openai","vllm":"openai","llamacpp":"openai","llama.cpp":"openai","text-generation-webui":"openai","oobabooga":"openai","ollama-openai":"openai","anthropic":"anthropic","google":"google","gemini":"google","vertex":"google","vertex-ai":"google","ollama":"ollama"};

export const HOST_MATCHERS = [["openrouter.ai","openai"],["anthropic.com","anthropic"],["generativelanguage","google"],["googleapis.com","google"],["aiplatform.googleapis.com","google"],["openai.azure.com","openai"],["api.openai.com","openai"]];

export const TOOL_PATTERNS = [["(^|[/_:])claude","anthropic"],["(qwen|glm|hermes|nous)","native"]];

export const CONTEXT_LIMITS = [["kimi-k3",262144],["glm-5",131072],["laguna-xs-2.1",32768],["qwen3.8-27b",32768],["qwen3",32768],["nomic-embed",8192],["nemotron",131072],["gemma-4",131072],["gemma-3",131072],["muse-glimmer",131072]];

export const DEFAULT_RPM = [["integrate.api.nvidia.com",40],["api.groq.com",30],["openrouter.ai",20],["api.deepseek.com",60],["api.mistral.ai",60],["api.x.ai",60],["api.openai.com",500],["generativelanguage.googleapis.com",15],["api.anthropic.com",50],["api.cerebras.ai",30],["api.together.xyz",60],["localhost",0],["127.0.0.1",0]];
