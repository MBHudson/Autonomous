/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// commsAll tests -- ask_agent / tell_agent with name "ALL".
//
// Usage: node tests/js/commsAll.test.mjs
//
// DOM-free like the other comms tests: bindAgentComms takes a plain bridge
// object, so a fake roster + recording ask/post is enough to prove one call
// briefs the whole roster. Each case is a real operator request: telling
// every agent the same thing without repeating the call once per agent.

import { bindAgentComms, TOOL_REGISTRY } from '../../ui/js/tools.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };

console.log('commsAll tests');
console.log('-'.repeat(60));

// A three-agent roster plus the caller, with recording ask/post.
const setup = () => {
  const roster = [
    { id: 'a1', name: 'Worker', role: 'Code', model: 'm1', active: true },
    { id: 'a2', name: 'Scout', role: 'Research', model: 'm2', active: true },
    { id: 'a3', name: 'Critic', role: 'Review', model: 'm3', active: true },
  ];
  const asked = [], posted = [];
  bindAgentComms({
    roster: () => roster,
    ask: async (id, question) => { asked.push([id, question]); return `reply-from-${id}`; },
    post: (id, from, message) => { posted.push([id, from, message]); },
    mailbox: () => [],
    consume: () => {},
  });
  return { roster, asked, posted };
};

// --- tell_agent ALL -----------------------------------------------------------
{
  const { asked, posted } = setup();
  const res = await TOOL_REGISTRY.tell_agent.run(
    { name: 'ALL', message: 'stand down' }, null, { agentId: 'boss' });
  ok(asked.length === 0, 'tell ALL asks nobody');
  ok(posted.length === 3, 'tell ALL posts to every other agent');
  ok(posted.every(p => p[1] === 'boss' && p[2] === 'stand down'),
    'tell ALL keeps the sender and the message on each post');
  ok(res.includes('Worker') && res.includes('Scout') && res.includes('Critic'),
    'tell ALL names who was briefed');
}

// --- ask_agent ALL ------------------------------------------------------------
{
  const { asked, posted } = setup();
  const res = await TOOL_REGISTRY.ask_agent.run(
    { name: 'everyone', question: 'status?' }, null, { agentId: 'boss' });
  ok(posted.length === 0, 'ask ALL posts nothing');
  ok(asked.length === 3, 'ask ALL asks every other agent');
  ok(res.includes('Worker: reply-from-a1') && res.includes('Scout: reply-from-a2')
    && res.includes('Critic: reply-from-a3'),
    'ask ALL labels each reply with its agent');
}

// --- case-insensitivity and the bare-string form -------------------------------
{
  const { asked } = setup();
  // Bare-string form: the name is the arg, the text is the note.
  await TOOL_REGISTRY.ask_agent.run('All', 'q?', { agentId: 'boss' });
  ok(asked.length === 3, 'mixed-case string-form ALL fans out too');
}
{
  const { asked: asked2, posted } = setup();
  // Bare-string form: the name is the arg, the text is the note.
  const res = TOOL_REGISTRY.tell_agent.run('aLl', 'halt', { agentId: 'boss' });
  ok(posted.length === 3 && asked2.length === 0, 'lowercase bare-string ALL still fans out');
  ok(String(res).includes('every other agent'), 'fan-out reply says who got it');
}

// --- an agent actually named "All" keeps its name -----------------------------
{
  const asked = [], posted = [];
  bindAgentComms({
    roster: () => [
      { id: 'a1', name: 'All', role: 'Code', model: 'm1', active: true },
      { id: 'a2', name: 'Worker', role: 'Code', model: 'm2', active: true },
    ],
    ask: async (id, question) => { asked.push([id, question]); return `reply-from-${id}`; },
    post: (id, from, message) => { posted.push([id, from, message]); },
    mailbox: () => [],
    consume: () => {},
  });
  const res = await TOOL_REGISTRY.ask_agent.run(
    { name: 'ALL', question: 'you?' }, null, { agentId: 'boss' });
  ok(asked.length === 1 && asked[0][0] === 'a1',
    'exact name "All" wins over the keyword');
  ok(!String(res).includes('every other agent'), 'single-target reply, not a fan-out');
}

// --- nobody else around --------------------------------------------------------
{
  bindAgentComms({
    roster: () => [],
    ask: async () => 'unreached',
    post: () => { throw new Error('unreached'); },
    mailbox: () => [],
    consume: () => {},
  });
  const askRes = await TOOL_REGISTRY.ask_agent.run(
    { name: 'ALL', question: 'anyone?' }, null, { agentId: 'boss' });
  ok(askRes === 'There are no other agents to ask.', 'ask ALL with an empty roster says so');
  const tellRes = TOOL_REGISTRY.tell_agent.run(
    { name: 'ALL', message: 'hi' }, null, { agentId: 'boss' });
  ok(tellRes === 'There are no other agents to brief.', 'tell ALL with an empty roster says so');
}

// --- single-agent behaviour is untouched ---------------------------------------
{
  const { asked, posted } = setup();
  const res = await TOOL_REGISTRY.ask_agent.run(
    { name: 'scout', question: 'found it?' }, null, { agentId: 'boss' });
  ok(asked.length === 1 && asked[0][0] === 'a2', 'naming one agent still reaches just them');
  ok(String(res) === 'reply-from-a2', 'single reply comes back unwrapped');
  ok(posted.length === 0, 'no stray posts');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (errors.length) { console.log(errors.join('\n')); process.exit(1); }
