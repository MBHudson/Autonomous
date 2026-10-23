// ============================================
// ALWAYSON.JS — Autonomous agents and direct asks
// ============================================
//
// Two features over the same runtime:
//
//   A. An agent with a standing goal re-prompts itself on an interval until it
//      calls declare_goal_complete, a cap trips, or you switch it off.
//   B. Any agent can be questioned on its own, outside a fan-out.
//
// Everything runs in the page and reuses Chat._callAgent, so the tool loop,
// memory, sandbox and agent comms all behave exactly as they do in a normal
// turn. There is no server-side runner: this stops when the tab closes, which
// is why it is cheap to reason about.

import { store } from './store.js?v=297';
import { persistence } from './persistence.js?v=297';
import { ALWAYS_ON_TOOLS } from './tools.js?v=297';

export class AlwaysOn {
  /**
   * @param {import('./components/chat.js').Chat} chat
   */
  constructor(chat) {
    this.chat = chat;
    this.timer = null;
    // agentIds -> { iterations, startedAt }. Counters for the current run.
    this.runs = new Map();
    // agentIds with a turn in flight right now.
    this.running = new Set();
    // agentIds the user has stopped by hand. Held agents are excluded from
    // ticks entirely, so a manual stop is definitive rather than "pauses until
    // the next timer fire" — which read as the agent starting again.
    this.held = new Set();
    this.aborters = new Map();
    this.lastTickAt = 0;
    this.log = [];
  }

  // --- configuration ---

  get settings() {
    return store.get('settings') || {};
  }

  enabled() {
    return !!this.settings.alwaysOn;
  }

  intervalSec() {
    const raw = parseInt(this.settings.alwaysOnIntervalSec, 10);
    // Floor of 10s. Below that an agent is effectively continuous, and one
    // iteration costs real money every few seconds.
    const v = Number.isFinite(raw) ? raw : 30;
    return Math.max(10, Math.min(3600, v));
  }

  /** Agents with a standing goal, opted in, switched on, and not held. */
  eligible() {
    return (store.get('agents') || []).filter(
      a => a && a.alwaysOn && a.active && String(a.alwaysOnGoal || '').trim()
        && !this.held.has(a.id)
    );
  }

  isHeld(agentId) {
    return this.held.has(agentId);
  }

  // --- lifecycle ---

  init() {
    this._restoreHeld();
    this.start();

    // An agent deleted or renamed elsewhere must not leave a held id behind:
    // it would sit in the saved list forever and come back if an id were ever
    // reused. Pruned whenever the roster changes.
    store.on('agents:changed', () => this._pruneHeld());

    // Clicking the ALWAYS ON badge on an agent card stops that one run. The
    // agent's always-on setting is deliberately untouched: it is a pause, not
    // a switch-off, so the next tick picks the same goal back up.
    store.on('alwaysOn:stop', ({ agentId } = {}) => {
      if (!agentId) return;
      this.toggleHold(agentId);
    });

    // Re-pacing on any settings or roster change keeps the timer honest
    // without every caller having to remember to restart it.
    store.on('settings:changed', () => {
      // Master off kills in-flight autonomous turns too, not just future
      // ticks: an "off" that leaves work running is not off. Holds survive
      // (only stopAll releases those, deliberately).
      if (!this.enabled()) this.abortAll('always-on switched off');
      this.start();
    });
    store.on('agents:changed', () => { this.start(); this.render(); });

    // Backgrounded tabs do not tick unless explicitly allowed to: nobody is
    // watching the transcript, and each iteration is billed. This matches how
    // cross-device polling already treats a hidden tab.
    document.addEventListener?.('visibilitychange', () => {
      if (document.hidden) this.abortAll('tab hidden');
      this.start();
    });
  }

  start() {
    this.stop();
    if (!this.enabled()) return;
    this.timer = setInterval(() => this.tick(), this.intervalSec() * 1000);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // --- the tick ---

  /**
   * One iteration for every eligible agent. Skipped rather than queued while
   * the tab is hidden, and agents already answering something are left alone.
   *
   * Agents run in parallel but tick() waits for them, so "the tick finished"
   * is a real moment rather than a hopeful one.
   *
   * @returns {Promise<number>} how many agents were started.
   */
  /**
   * Note that a user turn just finished.
   *
   * Called from the chat component once a dispatched turn settles. The delay
   * before the next autonomous tick is what stops the agent from answering the
   * same message twice in a row.
   */
  noteUserTurn() {
    this.lastUserTurnAt = Date.now();
  }

  async tick() {
    if (!this.enabled()) return 0;
    if (document.hidden && !this.settings.alwaysOnRunHidden) return 0;

    const agents = this.eligible();
    if (!agents.length) return 0;

    // A user turn owns the session while it is in flight. Autonomous work
    // steps aside rather than interleaving with what you are reading.
    if (this.chat.aborter) return 0;

    // ...and for a moment afterwards too. Without this the tick that was due
    // while you were typing started the instant your turn ended, so the agent
    // answered you, your turn released the session, and the autonomous pass
    // immediately answered the same thing again a second or two later. It read
    // as a duplicate reply to a message that had already been answered.
    const grace = Math.max(0, parseInt(this.settings.alwaysOnGraceSec, 10) || 0);
    if (grace && Date.now() - (this.lastUserTurnAt || 0) < grace * 1000) return 0;

    this.lastTickAt = Date.now();
    const started = [];
    for (const agent of agents) {
      if (this.running.has(agent.id)) continue;   // still working from a prior tick
      if (this.chat._busy.has(agent.id)) continue;

      // Re-checked HERE, not only at the top of tick(). That check was a
      // check-then-act with a model call in between, so a message sent during
      // the tick started a second run for the same agent -- two replies, the
      // second cut off mid-word because both were painting the same live node.
      if (this.chat.aborter) break;
      if (this.chat._busy.has(agent.id)) continue;
      started.push(
        this._runFor(agent).catch((err) => {
          this._note(agent, `tick failed: ${err && err.message ? err.message : err}`);
        })
      );
    }
    if (!started.length) return 0;
    await Promise.allSettled(started);
    return started.length;
  }

  /** Build the autonomous prompt and run one turn. */
  async _runFor(agent) {
    const goal = String(agent.alwaysOnGoal || '').trim();
    if (!goal) return;

    const run = this.runs.get(agent.id) || { iterations: 0, startedAt: Date.now() };
    run.iterations += 1;
    run.startedAt = run.startedAt || Date.now();
    this.runs.set(agent.id, run);

    // Caps. Both default to 0, which means "no cap" — the agent is expected
    // to stop itself. Set one if you do not trust that.
    const maxIters = parseInt(this.settings.alwaysOnMaxIterations, 10) || 0;
    if (maxIters && run.iterations > maxIters) {
      // Parked rather than merely stopped: a cap that reset its own counter
      // every time would fire again on the next tick and stop nothing.
      this.hold(agent.id, `stopped after ${run.iterations - 1} iterations (cap reached)`);
      this.render();
      return;
    }
    const maxMinutes = parseInt(this.settings.alwaysOnMaxMinutes, 10) || 0;
    if (maxMinutes && (Date.now() - run.startedAt) > maxMinutes * 60000) {
      this.hold(agent.id, `stopped after ${maxMinutes} minute(s) (cap reached)`);
      this.render();
      return;
    }

    this.running.add(agent.id);
    store.emit('alwaysOn:running', { agentId: agent.id, running: true });
    store.emit('agent:status', { agentId: agent.id, status: 'thinking' });

    // Last chance to stand down. Between the guard in tick() and here sits
    // bookkeeping, which is enough time for a user turn to start.
    if (this.chat.aborter || this.chat._busy.has(agent.id)) {
      this._note(agent, 'skipped - the user is mid-turn');
      this.running.delete(agent.id);
      store.emit('alwaysOn:running', { agentId: agent.id, running: false });
      return;
    }

    const prompt = this.buildPrompt(agent, run);
    // A controller per agent so one agent's tick can be stopped without
    // touching the user's turn or another agent's.
    const ac = new AbortController();
    this.aborters.set(agent.id, ac);

    try {
      const reply = await this.chat._callAgent(
        prompt, agent, ac.signal, this.chat._makeLiveNode?.(agent), null, { autonomous: true },
      );
      const text = (reply && reply.content) || '';

      // The turn itself is posted by _callAgent's caller normally; here the
      // scheduler owns the transcript so an unattended reply still shows up.
      this.chat._addMessage?.({
        role: 'agent', content: text, agentId: agent.id,
        timestamp: Date.now(), autonomous: true,
      });

      if (reply && reply.completed) {
        this._note(agent, `goal declared complete after ${run.iterations} iteration(s)`);
        this.stopAgent(agent.id);
      } else if (!text.trim()) {
        // The tool loop already says what happened; do not pile another
        // failure message on top of it.
        this._note(agent, 'empty reply, will try again next tick');
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        this._note(agent, 'stopped');
      } else {
        this._note(agent, `error: ${err && err.message ? err.message : err}`);
      }
    } finally {
      this.running.delete(agent.id);
      this.aborters.delete(agent.id);
      store.emit('alwaysOn:running', { agentId: agent.id, running: false });
      // Idle either way: between ticks (or held) the agent is not working,
      // and the indicator must say so. Marking tick-end 'active' left the
      // blink on forever, which read as "still running" although the
      // scheduler was doing nothing.
      store.emit('agent:status', { agentId: agent.id, status: 'idle' });
    }
  }

  /**
   * The prompt for one iteration.
   *
   * Kept short on purpose: it is re-sent every tick, and the agent's own prior
   * work is already in its memory, so restating context would only cost tokens
   * and dilute the instruction.
   */
  buildPrompt(agent, run) {
    const goal = String(agent.alwaysOnGoal || '').trim();
    return [
      `You are working on this on your own. No one is waiting for a reply.`,
      ``,
      `Standing goal:`,
      goal,
      ``,
      `Iteration ${run.iterations}. Make concrete progress now using your tools.`,
      `When the goal is met, call declare_goal_complete with a short summary of what you finished.`,
      `If you are blocked, say clearly what you need and try the next most useful thing.`,
    ].join('\n');
  }

  // --- control ---

  /**
   * Stop one agent's autonomous work completely.
   *
   * Aborts the turn in flight, drops the counters, and removes it from the
   * busy set so nothing can still be routed to it. The transcript is left
   * alone on purpose: that is the record of what it actually did.
   */
  stopAgent(agentId, reason = '') {
    const ac = this.aborters.get(agentId);
    if (ac) { try { ac.abort(); } catch { /* already gone */ } }
    this.runs.delete(agentId);
    this.running.delete(agentId);
    this.aborters.delete(agentId);
    // If another agent had asked this one a question, that reservation would
    // otherwise linger and block it from being asked again.
    try { this.chat._busy?.delete(agentId); } catch { /* no chat */ }
    store.emit('alwaysOn:running', { agentId, running: false });
    store.emit('agent:status', { agentId, status: 'idle' });
    if (reason) this.log.unshift({ agentId, at: Date.now(), text: reason });
  }

  /** Park an agent: stopped, and excluded from ticks until released. */
  /**
   * Held agents survive a reload.
   *
   * This used to be a bare in-memory Set, so every refresh silently released
   * every held agent and they all started working again -- which read as the
   * toggle not sticking rather than as lost state. Held is a decision, so it
   * is saved with the rest of the settings and restored on boot.
   */
  _persistHeld() {
    const settings = { ...(store.get('settings') || {}), alwaysOnHeld: Array.from(this.held) };
    store.set('settings', settings);
    try { persistence.set('settings', settings); } catch { /* storage full / private mode */ }
  }

  _restoreHeld() {
    const saved = (store.get('settings') || {}).alwaysOnHeld;
    if (!Array.isArray(saved)) return;
    const live = new Set((store.get('agents') || []).map(a => a.id));
    // Only restore ids for agents that still exist, so a saved list from
    // before an agent was deleted cannot resurrect a phantom hold.
    const restored = saved.filter(id => live.has(id));
    this.held = new Set(restored);
    // Send the WHOLE list, not a bare notification. The sidebar keeps its own
    // mirror of this set and treats a payload-less event as "clear all", so a
    // bare emit here would have wiped the state being restored.
    store.emit('alwaysOn:held', { agentIds: Array.from(this.held) });
  }

  /** Drop held ids for agents that no longer exist. */
  _pruneHeld() {
    const live = new Set((store.get('agents') || []).map(a => a.id));
    let changed = false;
    for (const id of Array.from(this.held)) {
      if (!live.has(id)) { this.held.delete(id); changed = true; }
    }
    if (changed) {
      this._persistHeld();
      store.emit('alwaysOn:held', { agentIds: Array.from(this.held) });
    }
  }

  hold(agentId, reason) {
    this.held.add(agentId);
    this._persistHeld();
    store.emit('alwaysOn:held', { agentId, held: true });
    this.stopAgent(agentId, reason);
  }

  /** Let a held agent tick again. */
  release(agentId) {
    if (!this.held.delete(agentId)) return false;
    this._persistHeld();
    store.emit('alwaysOn:held', { agentId, held: false });
    return true;
  }

  /**
   * The badge's action: stop if it is working or would tick again, release if
   * it is already stopped.
   *
   * Holding is what makes the stop stick. Without it the agent stayed eligible,
   * so the next interval simply picked it back up and it looked like the stop
   * had not worked.
   */
  toggleHold(agentId) {
    const agent = (store.get('agents') || []).find(a => a.id === agentId);
    const name = agent ? agent.name : 'Agent';

    if (this.held.has(agentId)) {
      this.release(agentId);
      this._note(agent || { id: agentId, name }, 'released — it will pick the goal up again');
      store.emit('toast', { message: `${name} released — resumes next tick`, type: 'info' });
      this.render();
      return false;
    }

    this.hold(agentId, `${name} stopped and held`);
    store.emit('toast', {
      message: `${name} stopped — click ALWAYS ON again to release it`,
      type: 'info',
    });
    this.render();
    return true;
  }

  /** The master switch, and the kill button behind it. */
  stopAll(reason = 'switched off') {
    for (const id of Array.from(this.running)) this.stopAgent(id, reason);
    // Switching the master off releases everyone, so turning it back on does
    // not silently leave agents stopped. Persisted, because losing the hold
    // list on the next reload would bring every held agent back to life.
    this.held.clear();
    this._persistHeld();
    store.emit('alwaysOn:held', { agentIds: [] });
    store.emit('alwaysOn:log', {});
    this.stop();
  }

  abortAll(reason) {
    for (const id of Array.from(this.running)) this.stopAgent(id, reason);
  }

  /** Small in-memory note of why an agent stopped, for the UI to show. */
  _note(agent, text) {
    this.log.unshift({ agentId: agent.id, name: agent.name, at: Date.now(), text });
    if (this.log.length > 40) this.log.length = 40;
    store.emit('alwaysOn:log', { agentId: agent.id, text });
  }

  isRunning(agentId) {
    return this.running.has(agentId);
  }

  render() {
    store.emit('alwaysOn:log', { log: this.log });
  }
}

export default AlwaysOn;