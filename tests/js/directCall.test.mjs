/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// Drives Chat._callAgentCore down the DIRECT (non-streamed) path with only the
// network call stubbed, so the sentence an operator actually sees for a
// token-ceiling cut-off is asserted here -- not just the parser that feeds it.

// Minimal headless shims so the real module graph (store, api, chat) loads.
globalThis.window = globalThis;
globalThis.location = {
  href: 'http://localhost/ui/', origin: 'http://localhost', protocol: 'http:',
  pathname: '/ui/', search: '', hash: '',
};
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
  clear: () => mem.clear(),
  key: i => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
const el = () => ({
  style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  appendChild() {}, removeChild() {}, addEventListener() {}, removeEventListener() {},
  setAttribute() {}, removeAttribute() {}, focus() {}, click() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  getContext() { return null; },
});
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  createElement: el, createTextNode: () => ({}),
  body: el(), documentElement: el(), head: el(), hidden: false,
};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

const { Chat } = await import('../../ui/js/components/chat.js?v=428');
const { api } = await import('../../ui/js/api.js?v=428');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}
function same(actual, expected, label) {
  ok(actual === expected, `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const agent = { id: 'a1', name: 'Tester', model: 'test-model', provider: 'p1', stream: false };
const provider = {
  id: 'p1', name: 'Test Provider', apiKey: 'test-key',
  endpoint: 'https://api.openai.com/v1/chat/completions',
};

function makeChat() {
  const chat = Object.create(Chat.prototype);
  chat.currentSessionId = null;
  chat.recording = 0;
  chat._messagesFor = () => [{ role: 'user', content: 'hi' }];
  chat._recordUsage = () => { chat.recording++; };
  chat._parseSections = text => ({ text: String(text), sections: null });
  return chat;
}

// The one seam: the network. Everything else is the real method.
let body = {};
let lastCall = null;
api.callProvider = async (p, messages, options, signal) => {
  lastCall = { provider: p, messages, options, signal };
  return body;
};

async function replyWith(b) {
  body = b;
  const chat = makeChat();
  try {
    const reply = await chat._callAgentCore('hi', agent, provider, 'test-key', null, null, null, null);
    return { chat, reply, error: null };
  } catch (error) {
    return { chat, reply: null, error };
  }
}

console.log('direct call tests');
console.log('-'.repeat(60));

// --- a body cut off at the token ceiling --------------------------------
{
  const { error, chat } = await replyWith({ content: '', finishReason: 'length', usage: { prompt: 9, completion: 0 } });
  ok(error instanceof Error, 'a token-ceiling body throws instead of returning nothing');
  ok(/token ceiling/i.test(error?.message || ''), 'the message names the token ceiling');
  ok(String(error?.message || '').includes('test-model'), 'the message names the model to fix');
  ok(/Max Tokens/.test(error?.message || ''), 'the message says which setting to raise');
  ok(!/returned an empty response/i.test(error?.message || ''),
    'it does not fall back to the empty-response wording');
  same(lastCall?.options?.model, 'test-model', 'the direct call carried the agent model');
  same(chat.recording, 0, 'nothing is recorded when there is no content');
}

// --- an empty body that stopped normally ---------------------------------
{
  const { error } = await replyWith({ content: '', finishReason: 'stop' });
  ok(/empty response/i.test(error?.message || ''), 'a normal stop with no content keeps the empty-response wording');
  ok(!/token ceiling/i.test(error?.message || ''), 'it does not blame a token ceiling that was not hit');
}

// --- an empty body that said nothing at all ------------------------------
{
  const { error } = await replyWith({ content: '', finishReason: null });
  ok(/empty response/i.test(error?.message || ''), 'a missing stop reason still gets the empty-response wording');
}

// --- a partially cut reply is returned, with the reason attached --------
{
  const { chat, reply, error } = await replyWith({ content: 'Half a sen', finishReason: 'length' });
  ok(!error, 'content is returned even when the body was cut off');
  same(reply?.content, 'Half a sen', 'the partial content is preserved');
  same(reply?.finishReason, 'length', 'the stop reason travels with the reply');
  same(chat.recording, 1, 'usage is recorded for the partial reply');
}

// --- the relay fallback still reports its own replies --------------------
{
  const { reply, error } = await replyWith({ content: 'from relay', finishReason: 'stop' });
  ok(!error, 'an ordinary reply resolves');
  same(reply?.finishReason, 'stop', 'an ordinary reply carries its stop reason');
}

console.log('-'.repeat(60));
console.log(`directCall: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
