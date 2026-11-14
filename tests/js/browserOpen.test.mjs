/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// browser_open tests -- the agent's browser must be watchable by default.
//
// The Browser drill used to pass while every call ran against a headless Edge:
// the tool hardcoded `browserLaunch(true)`, so the model saw a clean result and
// the operator saw nothing. These assertions pin the two halves of the fix:
// visible is the default, and asking for visible restarts a headless browser.

import { TOOL_REGISTRY, bindSandboxTools } from '../../ui/js/tools.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };

console.log('browser_open tests');
console.log('-'.repeat(60));

let status = { enabled: true, available: true, running: false, headless: true };
let calls = [];
const api = {
  browserStatus: async () => status,
  browserLaunch: async (headless) => {
    calls.push(['launch', headless]);
    status = { ...status, running: true, headless: !!headless };
    return status;
  },
  browserNavigate: async (url) => {
    calls.push(['navigate', url]);
    return { url, title: 'Browser drill' };
  },
};
bindSandboxTools(api);

const open = (arg) => TOOL_REGISTRY.browser_open.run(arg, null, {});
const reset = (next = {}) => {
  status = { enabled: true, available: true, running: false, headless: true, ...next };
  calls = [];
};

reset();
const first = await open({ url: 'http://127.0.0.1:8080/router/ui/drill/browser.html' });
ok(calls.some(c => c[0] === 'launch' && c[1] === false),
  'browser_open launches visible when no headless flag is given');
ok(first.includes('(visible window)'), 'the result says the window is visible');

reset({ running: true, headless: true });
const relaunched = await open({ url: 'http://127.0.0.1:8080/router/ui/drill/browser.html', headless: false });
ok(calls.some(c => c[0] === 'launch' && c[1] === false),
  'asking for visible restarts an already-running headless browser');
ok(relaunched.includes('(visible window)'), 'the restart reports a visible window');

reset({ running: true, headless: true });
const explicitHeadless = await open({ url: 'http://127.0.0.1:8080/router/ui/drill/browser.html', headless: true });
ok(!calls.some(c => c[0] === 'launch'),
  'an explicitly headless request reuses the headless browser');
ok(explicitHeadless.includes('headless — no window to watch'),
  'the result warns that there is no window to watch');

reset({ running: true, headless: false });
const alreadyVisible = await open({ url: 'http://127.0.0.1:8080/router/ui/drill/browser.html' });
ok(!calls.some(c => c[0] === 'launch'), 'a visible browser is reused');
ok(alreadyVisible.includes('(visible window)'), 'and still reports the visible mode');

reset();
const background = await open({ url: 'http://127.0.0.1:8080/router/ui/drill/browser.html', headless: true });
ok(calls.some(c => c[0] === 'launch' && c[1] === true),
  'headless:true still launches the background mode');
ok(background.includes('(headless — no window to watch)'),
  'the background mode is named in the result');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(errors.join('\n')); process.exit(1); }
