/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// Per-agent context window precedence.
//
// Usage: node tests/js/contextWindow.test.mjs
//
// The window an agent actually works with is, widest knowledge last:
//
//   explicit per-agent number > learned for THIS host+model > model table > null
//
// An 8k LM Studio session serving a 131k model is the case that matters: the
// name says 131k, the runner says 8k, and the operator can say either.

import {
  contextLimitForAgent, settingFor, setSetting, endpointForAgent,
} from '../../ui/js/agentConfig.js';
import { rememberContextLimit } from '../../ui/js/harness.js';
// The ?v= matters: agentConfig imports store.js?v=431, and ESM would otherwise
// hand this file a SECOND store instance that the code under test never sees.
import { store } from '../../ui/js/store.js?v=431';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('Context window precedence tests');
console.log('-'.repeat(60));

const model = 'nvidia/nemotron-3-nano-4b';
const lms = 'http://10.0.0.57:1234/v1/chat/completions';
const cloud = 'https://openrouter.ai/api/v1/chat/completions';

// The name table's guess.
eq(contextLimitForAgent({ model }), 131072, 'auto: an unknown runner uses the model table');

// What the runner told us, for one host only.
rememberContextLimit(model, 8192, lms);
eq(contextLimitForAgent({ model, endpoint: lms }), 8192, 'auto: the learned window wins for its host');
eq(contextLimitForAgent({ model, endpoint: cloud }), 131072,
  'auto: the same model on another host keeps the table value');
eq(contextLimitForAgent({ model }), 131072, 'auto: no endpoint means no host-scoped value');

// The operator's explicit number beats everything.
const declared = { model, endpoint: lms, overrides: { contextWindow: 32768 } };
eq(settingFor(declared, 'contextWindow'), 32768, 'the override is the effective setting');
eq(contextLimitForAgent(declared), 32768, 'declared: an explicit window beats the learned one');

// 0 is AUTO, not "a zero-token window".
const auto = { model, endpoint: lms, overrides: { contextWindow: 0 } };
eq(settingFor(auto, 'contextWindow'), 0, 'zero reads back as auto');
eq(contextLimitForAgent(auto), 8192, 'zero falls through to what the runner said');

// Locking then clearing the lock returns the agent to auto.
setSetting(auto, 'contextWindow', 16384);
eq(contextLimitForAgent(auto), 16384, 'a value set through the override bag is honoured');
delete auto.overrides.contextWindow;
eq(contextLimitForAgent(auto), 8192, 'unlocking returns to the learned window');

// A provider's endpoint is used when the agent does not pin one.
store.set('providers', [{ id: 'lmstudio', endpoint: lms }]);
eq(endpointForAgent({ provider: 'lmstudio' }), lms, 'the provider endpoint is used as a fallback');
eq(contextLimitForAgent({ provider: 'lmstudio', model }), 8192,
  'an agent with no endpoint inherits its provider host');

console.log('-'.repeat(60));
if (fail) {
  console.error(errors.join('\n'));
  console.error(`${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`${pass} passed`);
