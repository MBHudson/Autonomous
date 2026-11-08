/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// localEndpoints tests -- which endpoints the Proxy tab reports as bypassing
// the selected proxy.
//
// Usage: node tests/js/localEndpoints.test.mjs
//
// DOM-free. This is a display mirror of Src\Tls::isLocalUrl, so the cases that
// matter are the ones an operator actually has: a runner on 127.0.0.1, LM
// Studio on a 10.x box, a .local name, a bare hostname -- and, in the other
// direction, that public endpoints are never labelled local, because a wrong
// "bypassed" note would hide a proxy that is really being used.

import {
  hostOf, isLocalHost, isLocalEndpoint, localEndpoints,
} from '../../ui/js/localEndpoints.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };

console.log('localEndpoints tests');
console.log('-'.repeat(60));

// --- hostOf -----------------------------------------------------------------
ok(hostOf('http://10.0.0.128:1235/v1/chat/completions') === '10.0.0.128', 'host and port split');
ok(hostOf('https://API.Example.com/v1') === 'api.example.com', 'host is lowercased');
ok(hostOf('http://[::1]:1234/v1') === '[::1]', 'bracketed IPv6 kept whole');
ok(hostOf('http://box.local/') === 'box.local', 'no port is fine');
ok(hostOf('') === '' && hostOf('not a url') === '', 'non-URLs have no host');

// --- loopback and private ranges -------------------------------------------
ok(isLocalEndpoint('http://localhost:1234/v1/chat/completions'), 'localhost is local');
ok(isLocalEndpoint('http://127.0.0.1:1234/v1'), '127.0.0.1 is local');
ok(isLocalEndpoint('http://10.0.0.128:1235/v1/chat/completions'), 'a 10.x runner is local');
ok(isLocalEndpoint('http://192.168.1.50:8000/'), '192.168 is local');
ok(isLocalEndpoint('http://172.16.5.4/v1'), '172.16 is local');
ok(isLocalEndpoint('http://172.31.255.1/v1'), 'the top of 172.16/12 is local');
ok(isLocalEndpoint('http://100.64.0.7/v1'), 'CGNAT is local');
ok(isLocalEndpoint('http://169.254.3.3/'), 'link-local is local');
ok(isLocalEndpoint('http://[::1]:1234/v1'), 'IPv6 loopback is local');

// --- names ------------------------------------------------------------------
ok(isLocalEndpoint('http://gpu-box.local:1234/v1'), '.local is local');
ok(isLocalEndpoint('http://ollama:11434/v1'), 'a bare hostname is local');
ok(isLocalEndpoint('http://host.docker.internal:1234/v1'), 'docker host alias is local');

// --- never labelled local ---------------------------------------------------
ok(!isLocalEndpoint('https://api.openai.com/v1/chat/completions'), 'a public API is not local');
ok(!isLocalEndpoint('http://8.8.8.8/'), 'a public IP is not local');
ok(!isLocalEndpoint('http://172.32.0.1/v1'), '172.32 is outside 172.16/12');
ok(!isLocalEndpoint('https://example.hosted.internal.example.com/v1'),
  'a suffix in the middle of a name does not make it local');
ok(!isLocalEndpoint(''), 'an empty endpoint is not local');
ok(!isLocalHost('example.com'), 'a dotted public name is not local');

// --- the list the tab renders ----------------------------------------------
const providers = [
  { id: 'a', endpoint: 'http://10.0.0.128:1235/v1/chat/completions' },
  { id: 'b', endpoint: 'https://api.openai.com/v1/chat/completions' },
  { id: 'c', endpoint: 'http://10.0.0.128:1235/v1/chat/completions' },
  { id: 'd', endpoint: 'http://localhost:1234/v1' },
  { id: 'e', endpoint: '' },
  { id: 'f' },
];
const locals = localEndpoints(providers);
ok(locals.length === 2, 'only the distinct local endpoints survive');
ok(locals[0] === 'http://10.0.0.128:1235/v1/chat/completions', 'the first local endpoint is kept in order');
ok(locals[1] === 'http://localhost:1234/v1', 'the second, with the duplicate removed');
ok(localEndpoints([]).length === 0, 'no providers means nothing to report');
ok(localEndpoints(null).length === 0, 'a missing provider list is not a crash');
ok(localEndpoints([{ endpoint: 'https://api.openai.com/v1' }]).length === 0,
  'a cloud-only setup reports no bypass');

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
