/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// LOCALENDPOINTS.JS — which provider URLs the server calls directly
// ============================================
//
// Mirrors Src\Tls::isLocalUrl, which ModelManager::activeProxy() uses to keep
// loopback, private, link-local and .local endpoints off the proxy. The reason
// to know it in the browser is the Proxy tab: when a proxy is selected, the
// operator needs to see that their own runner is not going through it, or the
// tab reads as "everything is proxied" while the one call they care about goes
// direct.
//
// DISPLAY ONLY. The decision is the server's, made per call, and this file must
// never be trusted as a gate — it exists so the UI can describe it, not enforce
// it. Keep the rules here in step with Tls::isLocalUrl if that changes.

const EXACT_HOSTS = [
  'localhost',
  '::1',
  '[::1]',
  '0.0.0.0',
  'host.docker.internal',
  'gateway.docker.internal',
];

const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.internal', '.home.arpa', '.home', '.localdomain'];

// IPv4 ranges a proxy never reaches, with the prefix length each covers.
const LOCAL_RANGES = [
  ['127.0.0.0', 8],    // loopback
  ['10.0.0.0', 8],     // private
  ['172.16.0.0', 12],  // private
  ['192.168.0.0', 16], // private
  ['169.254.0.0', 16], // link-local
  ['100.64.0.0', 10],  // carrier-grade NAT, also common on LANs
  ['0.0.0.0', 8],      // "this host"
];

/** The host of an http(s) URL, bracketed IPv6 kept as written, or ''. */
export function hostOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : '';
}

function ipv4Octets(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function inRange(octets, base, bits) {
  const toLong = o => ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toLong(octets) & mask) === (toLong(ipv4Octets(base)) & mask);
}

/** True when a host is one the proxy cannot usefully reach. */
export function isLocalHost(host) {
  const h = String(host || '').toLowerCase().trim();
  if (h === '') return false;
  if (EXACT_HOSTS.includes(h)) return true;
  if (LOCAL_SUFFIXES.some(suffix => h.endsWith(suffix))) return true;

  const octets = ipv4Octets(h);
  if (octets) return LOCAL_RANGES.some(([base, bits]) => inRange(octets, base, bits));

  // A bare name with no dot is a hostname on this network (ollama, gpu-box),
  // not an internet address.
  if (!h.includes('.') && !h.includes(':')) return true;

  // IPv6 outside ::1 is treated as remote: guessing at ULA prefixes would
  // hide a genuine external endpoint behind a wrong "local" label.
  return false;
}

/** True when a provider URL points inside this network. */
export function isLocalEndpoint(url) {
  return isLocalHost(hostOf(url));
}

/**
 * The distinct local endpoints among the configured providers, in order.
 * Blank and non-URL entries are dropped rather than rendered as holes.
 */
export function localEndpoints(providers) {
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(providers) ? providers : []) {
    const endpoint = String(p?.endpoint || '');
    if (!/^https?:\/\//i.test(endpoint)) continue;
    if (!isLocalEndpoint(endpoint)) continue;
    if (seen.has(endpoint)) continue;
    seen.add(endpoint);
    out.push(endpoint);
  }
  return out;
}
