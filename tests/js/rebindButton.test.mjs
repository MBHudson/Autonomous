/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// rebindOffer tests -- the warning bubble's button, exercised not described.
//
// Usage: node tests/js/rebindButton.test.mjs
//
// The suite has no DOM and no dependencies, and adding a browser environment to
// run one button would be a dependency for every test. A fake element with just
// the methods this module uses is enough to prove the behaviour that matters:
// the button lands in the bubble, a click binds, the bubble reports the result,
// a failure re-arms the button, and a throw cannot leave it disabled forever.

import { offerRebind } from '../../ui/js/components/rebindOffer.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };

console.log('rebind button tests');
console.log('-'.repeat(60));

// --- a fake element with only what the module touches -----------------------
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.style = {};
    this.listeners = {};
    this.disabled = false;
    this.parentNode = null;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  click() {
    for (const fn of this.listeners.click || []) fn({ type: 'click' });
  }
  querySelector(sel) {
    const want = String(sel).replace(/^\./, '');
    const walk = node => {
      for (const child of node.children) {
        if (String(child.className).split(/\s+/).includes(want)) return child;
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this);
  }
}

globalThis.document = { createElement: tag => new FakeEl(tag) };

/** A message bubble shaped like the renderer's: wrapper > body. */
function bubble(text = '⚠ File tools are unavailable') {
  const wrap = new FakeEl('div');
  wrap.className = 'message message-agent';
  wrap.appendChild(new FakeEl('div'));
  const body = new FakeEl('div');
  body.className = 'message-body';
  body.textContent = text;
  wrap.appendChild(body);
  return { wrap, body };
}

// --- the button lands in the bubble -----------------------------------------
{
  const { wrap, body } = bubble();
  const btn = offerRebind(wrap, { bind: () => ({ unbound: [] }), doneText: 'DONE' });
  ok(btn && btn.tagName === 'BUTTON', 'a button is created');
  ok(btn.textContent === 'BIND FILE TOOLS', 'labelled with the action');
  ok(String(btn.className).includes('btn'), 'styled as a button');
  ok(body.children.includes(btn), 'and appended to the bubble body');
  ok(body.textContent.startsWith('⚠'), 'the warning text is left in place until it is fixed');
}

// --- a successful click rewrites the bubble ---------------------------------
{
  const { body } = bubble();
  let boundCalls = 0;
  let bindCalls = 0;
  const btn = offerRebind(body.parentNode, {
    bind: () => { bindCalls++; return { unbound: [] }; },
    doneText: '✓ File tools are bound',
    onBound: () => { boundCalls++; },
  });
  btn.click();
  ok(bindCalls === 1, 'the click runs the binding attempt once');
  ok(body.textContent === '✓ File tools are bound', 'the bubble becomes the confirmation');
  ok(!body.children.includes(btn), 'the button is removed on success');
  ok(btn.disabled === true, 'and disabled, so a stray click cannot rebind twice');
  ok(boundCalls === 1, 'the caller is told the bubble was rewritten');

  btn.click();
  ok(bindCalls === 1, 'a click after success does nothing');
}

// --- a failed click re-arms instead of dead-ending -------------------------
{
  const { wrap, body } = bubble();
  let failed = null;
  let calls = 0;
  const btn = offerRebind(wrap, {
    bind: () => ({ unbound: ['write_file', 'read_file'] }),
    doneText: 'DONE',
    onFail: names => { failed = names; calls++; },
  });
  btn.click();
  ok(Array.isArray(failed) && failed.includes('write_file'), 'the failure names what is left');
  ok(calls === 1, 'and is reported once');
  ok(btn.textContent === 'TRY AGAIN', 'the label invites another attempt');
  ok(btn.disabled === false, 'the button is usable again');
  ok(body.children.includes(btn), 'and stays in the bubble');
}

// --- a later success is still possible -------------------------------------
{
  const { wrap, body } = bubble();
  let attempt = 0;
  const btn = offerRebind(wrap, {
    bind: () => (++attempt === 1 ? { unbound: ['exec'] } : { unbound: [] }),
    doneText: 'BOUND NOW',
  });
  btn.click();
  ok(body.children.includes(btn) && btn.textContent === 'TRY AGAIN', 'first attempt fails');
  btn.click();
  ok(body.textContent === 'BOUND NOW', 'second attempt can still succeed');
  ok(!body.children.includes(btn), 'and the button leaves then');
}

// --- a throwing attempt is a failed attempt --------------------------------
{
  const { wrap, body } = bubble();
  let failed = null;
  const btn = offerRebind(wrap, {
    bind: () => { throw new Error('sandbox unreachable'); },
    doneText: 'DONE',
    onFail: names => { failed = names; },
  });
  btn.click();
  ok(Array.isArray(failed) && failed.join(' ').includes('sandbox unreachable'),
    'a throw is reported, not swallowed');
  ok(btn.textContent === 'TRY AGAIN' && btn.disabled === false,
    'and the button recovers rather than staying dead');
}

// --- nothing to attach to --------------------------------------------------
{
  ok(offerRebind(null, { bind: () => ({ unbound: [] }) }) === null, 'no bubble means no button');
  ok(offerRebind(new FakeEl('div'), { bind: () => ({ unbound: [] }) }) === null,
    'a bubble without a message body means no button');
  const { wrap } = bubble();
  const btn = offerRebind(wrap, { doneText: 'DONE' });
  ok(btn && btn.tagName === 'BUTTON', 'a missing bind function does not stop the button appearing');
  btn.click();
  ok(btn.disabled === true, 'and an absent attempt counts as nothing left to do');
}

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
for (const e of errors) console.log('  ' + e);
process.exit(fail ? 1 : 0);
