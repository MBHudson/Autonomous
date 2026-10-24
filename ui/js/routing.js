// ============================================
// ROUTING.JS — "/CODE ..." and "/ROLE ..." addressing
// ============================================
//
// Without this, every message fans out to every activated agent. That is the
// right default for a general question and wasteful for a targeted one: two
// coders both burning tokens on an instruction meant for the other one.
//
// Two addressing forms, because two different questions come up:
//
//   /5RYD2F audit the auth module          -> exactly that agent, by code
//   /CODE   audit the auth module          -> every agent with that role
//   /ALL    audit the auth module          -> every activated agent (explicit)
//
// Codes are the permanent 6-character handle (utils.js makeAgentCode). Roles
// are free text, because "Custom…" lets an agent be called anything.
//
// Both forms are case-insensitive and tolerate a leading @ or #, because
// people type what they expect. The matched prefix is stripped before the
// prompt reaches the model, so the agent is never told its own routing syntax.
//
// If a target matches nothing, this returns an error rather than silently
// falling back to "everyone" -- quietly answering with four agents when you
// addressed one is worse than telling you the code was wrong.

import { agentCode } from './utils.js?v=312';

/** Roles that address the whole group regardless of their spelling. */
const ALL_WORDS = new Set(['all', 'every', 'everyone', 'any']);

const norm = s => String(s || '').trim().replace(/^[@#]+/, '');

/**
 * Parse an outgoing message into a routing decision.
 *
 * @param {string} raw   the composer text
 * @param {Array}  agents every configured agent
 * @returns {{mode:'all'|'none', agents:Array, prompt:string, raw:string,
 *            addressed:string|null, reason:string|null}}
 */
export function parseRoute(raw, agents) {
  const text = String(raw || '');
  const list = agents || [];

  // A leading /, @ or # all mean "address someone". Plain text is a broadcast.
  if (!/^\s*[/@#]/.test(text)) {
    return { mode: 'all', agents: list.filter(a => a.active), prompt: text,
      raw: text, addressed: null, reason: null };
  }

  const active = list.filter(a => a.active);

  // A multi-word agent name cannot be split on whitespace: "/Coder One do A"
  // would address an agent called "Coder". So match the LONGEST agent name that
  // prefixes the text first, and only fall back to a single token otherwise.
  const afterMarker = text.replace(/^\s*[/@#]\s*/, '');
  const lowerAfter = afterMarker.toLowerCase();
  const named = active
    .map(a => ({ a, n: String(a.name || '').trim() }))
    .filter(x => x.n
      && (lowerAfter === x.n.toLowerCase() || lowerAfter.startsWith(x.n.toLowerCase() + ' ')
        || lowerAfter.startsWith(x.n.toLowerCase() + '\t')))
    .sort((x, y) => y.n.length - x.n.length)[0];

  if (named) {
    const prompt = afterMarker.slice(named.n.length).trim();
    // Addressed but said nothing: report it rather than send an empty prompt,
    // which would burn a call and produce a meaningless reply.
    if (!prompt) {
      return { mode: 'none', agents: [], prompt: '', raw: text,
        addressed: '/' + named.a.name,
        reason: `You addressed ${named.a.name} but gave it nothing to do.` };
    }
    return { mode: 'name', agents: [named.a], prompt, raw: text,
      addressed: '/' + named.a.name, reason: null };
  }

  // Split the target token from the remainder: "/CODE some words here"
  const m = /^\s*[/@#]\s*([^\s]+)([\s\S]*)$/.exec(text);
  if (!m) {
    return { mode: 'none', agents: [], prompt: text, raw: text,
      addressed: null, reason: 'That looked like a command but had nothing after the "/".' };
  }

  const target = norm(m[1]);
  const rest = m[2].trim();
  const prompt = rest || text;      // nothing left after the token: keep the whole thing

  if (!target) {
    return { mode: 'none', agents: [], prompt, raw: text,
      addressed: null, reason: 'Type "/" followed by an agent code or a role.' };
  }

  // /ALL -- an explicit spelling of the default.
  if (ALL_WORDS.has(target.toLowerCase())) {
    return { mode: 'all', agents: list.filter(a => a.active), prompt, raw: text,
      addressed: '/ALL', reason: null };
  }

  const upper = target.toUpperCase();

  // 1. Agent code -- the unambiguous form, and the one to reach for when two
  //    agents share a role.
  // agentCode() renders as "#YLAUX4" -- with the hash. norm() strips a leading
  // @ or # from what the user typed, so BOTH sides must be normalised or the
  // comparison never matches and every /CODE would come back "no such agent".
  const byCode = active.filter(a =>
    norm(String(agentCode(a) || '')).toUpperCase() === upper);
  if (byCode.length) {
    return { mode: 'code', agents: byCode, prompt, raw: text,
      addressed: upper, reason: null };
  }

  // 2. Role -- matches the stored role text in either direction, so /code and
  //    /Code both find an agent whose role is literally "code".
  const lower = target.toLowerCase();
  const byRole = active.filter(a => String(a.role || '').trim().toLowerCase() === lower);
  if (byRole.length) {
    return { mode: 'role', agents: byRole, prompt, raw: text,
      addressed: '/' + target, reason: null };
  }

  // 3. Agent name -- so "/Memory ..." works without knowing the code.
  const byName = active.filter(a => String(a.name || '').trim().toLowerCase() === lower);
  if (byName.length) {
    return { mode: 'name', agents: byName, prompt, raw: text,
      addressed: '/' + target, reason: null };
  }

  // Nothing matched. Say so, and list what WOULD have worked, because a bare
  // "unknown target" makes the user guess at codes.
  const known = [];
  active.forEach(a => {
    known.push(`${agentCode(a)} (${a.name}${a.role ? ' / ' + a.role : ''})`);
  });
  return {
    mode: 'none',
    agents: [],
    prompt,
    raw: text,
    addressed: '/' + target,
    reason: `No active agent matches "${target}".`
      + (known.length ? ` Active: ${known.join(', ')}.` : ' No agents are active.'),
  };
}

/** Short help line for the composer placeholder / a "/?" reply. */
export function routingHelp(agents) {
  const active = (agents || []).filter(a => a.active);
  const codes = active.map(a => `${agentCode(a)}=${a.name}`).join('  ');
  return 'Address one agent with /CODE, a whole role with /ROLE, or everyone with /ALL. '
    + 'No slash = everyone.'
    + (codes ? '  Active: ' + codes : '  No agents are active, so nothing would answer.');
}
