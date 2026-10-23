// ============================================
// TOPOLOGY3D / INDEX.JS — 3D cluster topology (Three.js)
// ============================================
//
// Extends the SVG TopologyGraph rather than replacing it, which buys three
// things for free:
//   * the exact same store events, node model and flow lifecycle
//     (active → traffic → fading), so both views always agree;
//   * the notification bell, unchanged;
//   * a 2D mode that is literally the old renderer — used when the operator
//     picks it, when WebGL is unavailable, or if the 3D scene fails to start.
//
// What this layer adds: a WebGL scene (bloom, starfield, provider nebulas), a
// 3D cluster layout, beams that show direction with marching dashes + comets
// + arrowheads, HTML name/ping labels, and a click-to-open metrics card.

import * as THREE from 'three';
import { TopologyGraph } from '../topology.js?v=300';
import { store } from '../../store.js?v=300';
import { k, K } from '../../storage.js?v=300';
import { latency } from '../../latency.js?v=300';
import { SceneCore, webglAvailable } from './scene.js?v=300';
import { ForceLayout } from './layout.js?v=300';
import { NodeView, Nebula } from './nodes.js?v=300';
import { Beam } from './beams.js?v=300';
import { LabelLayer } from './labels.js?v=300';
import { PopupCard } from './popup.js?v=300';

const MODE_KEY = k('topoMode');
const HISTORY_MAX = 80;
/** A remembered "thinking" that never got its "idle" is dropped after this. */
const STATUS_MEMO_TTL = 10 * 60 * 1000;

const ease = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class Topology3D extends TopologyGraph {
  constructor() {
    super();
    let saved = null;
    try { saved = localStorage.getItem(MODE_KEY); } catch { /* private mode */ }
    this.mode = saved === '2d' ? '2d' : '3d';
    this.history = [];
    this.views = new Map();
    this.beams = new Map();
    this.nebulas = new Map();
    this.links = [];
    this._statusMemo = new Map();
    this._nodeSig = '';
    this._hoverId = null;
    this._selectedId = null;
    this._camTween = null;
    this._pointer = { x: 0, y: 0, dirty: false, inside: false };
    this.ready3d = false;
    try { this.sessionId = localStorage.getItem(K.CURRENT_SESSION) || null; } catch { this.sessionId = null; }
  }

  // ==================== lifecycle ====================

  init() {
    this.containerEl = document.getElementById('topologyContainer');
    this.svgEl = document.getElementById('topoSvg');

    if (this.mode === '3d') {
      if (!webglAvailable() || !this._init3D()) this.mode = '2d';
    }
    this._applyMode();

    // Events, notifications, flow listeners and the first refresh.
    super.init();

    store.on('session:changed', (d) => {
      if (d && d.sessionId) this.sessionId = d.sessionId;
      this.history = [];
      this.popup?.refresh();
    });
    store.on('flow:fail', (d) => {
      if (!d?.to) return;
      this._historyPush({ from: null, to: d.to, kind: 'fail' });
      this.views.get(d.to)?.fail();
    });
    store.on('latency:changed', () => this._queueInfoRefresh());
    store.on('metrics:changed', (d) => { if (d?.sessionId) this.sessionId = d.sessionId; this._queueInfoRefresh(); });

    document.getElementById('topoModeBtn')?.addEventListener('click', () => {
      this.setMode(this.mode === '3d' ? '2d' : '3d');
    });
    document.getElementById('topoResetBtn')?.addEventListener('click', () => this.resetView());

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.popup?.isOpen) return;
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      e.__topoHandled = true;
      this._select(null);
    }, true);
  }

  /** Build the WebGL scene once. Returns false (and logs) if it can't. */
  _init3D() {
    if (this.ready3d) return true;
    try {
      this.root = document.createElement('div');
      this.root.className = 't3d-root';
      this.containerEl.appendChild(this.root);

      this.core = new SceneCore(this.root);
      this.layout = new ForceLayout();
      this.labels = new LabelLayer(this.root);
      this.popup = new PopupCard(this.root, {
        nodeById: id => this.nodes.find(n => n.id === id),
        nodes: () => this.nodes,
        history: () => this.history,
        sessionId: () => this.sessionId,
        onClose: () => this._select(null, true),
      });

      const hint = document.createElement('div');
      hint.className = 't3d-hint-bar';
      hint.textContent = 'drag to orbit · scroll to zoom · right-drag to pan · click a node for metrics · double-click to reset';
      this.root.appendChild(hint);

      this.nodeLayer = new THREE.Group();
      this.beamLayer = new THREE.Group();
      this.nebulaLayer = new THREE.Group();
      this.core.scene.add(this.nebulaLayer, this.nodeLayer, this.beamLayer);

      // Static structure lines (agent→provider, You→agent): one draw call.
      this.linkGeo = new THREE.BufferGeometry();
      this.linkMat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 1,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      });
      this.linkLines = new THREE.LineSegments(this.linkGeo, this.linkMat);
      this.linkLines.frustumCulled = false;
      this.core.scene.add(this.linkLines);

      this.raycaster = new THREE.Raycaster();
      this._wirePointer(this.core.renderer.domElement);

      this.core.onFrame = (dt, t) => this._frame(dt, t);
      this.ready3d = true;
      return true;
    } catch (err) {
      console.warn('[topology3d] WebGL scene failed to start; using the 2D chart.', err);
      try { this.core?.dispose(); } catch { /* ignore */ }
      this.root?.remove();
      this.root = null;
      this.core = null;
      return false;
    }
  }

  setMode(mode) {
    if (mode === this.mode) return;
    if (mode === '3d' && !(webglAvailable() && this._init3D())) {
      store.emit('toast', { message: '3D view unavailable in this browser (no WebGL) — staying on 2D', type: 'warning' });
      return;
    }
    this._select(null);
    this.mode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
    this._applyMode();
    this.refresh();
  }

  _applyMode() {
    const is3d = this.mode === '3d' && this.ready3d;
    this.containerEl?.classList.toggle('t3d-on', is3d);
    if (this.root) this.root.hidden = !is3d;
    if (is3d) {
      // Stop the SVG's SMIL animations from burning CPU behind the canvas.
      if (this.svgEl) this.svgEl.innerHTML = '';
      this.core.resize();
      this.core.start();
    } else {
      this.core?.stop();
    }
    const btn = document.getElementById('topoModeBtn');
    if (btn) {
      btn.textContent = is3d ? '2D' : '3D';
      btn.title = is3d ? 'Switch to the flat 2D chart' : 'Switch to the 3D cluster view';
    }
    const reset = document.getElementById('topoResetBtn');
    if (reset) reset.hidden = !is3d;
  }

  get is3d() { return this.mode === '3d' && this.ready3d; }

  // ==================== overrides of the SVG renderer ====================

  _buildLocalTopology() {
    super._buildLocalTopology();
    // The base rebuild resets every agent to idle, and metrics:changed fires
    // mid-turn (every tool round records usage), so a thinking agent used to
    // drop its rings halfway through its turn. Re-apply what we were told.
    const now = Date.now();
    this.nodes.forEach(n => {
      if (n.type !== 'agent') return;
      const m = this._statusMemo.get(n.id);
      if (!m) return;
      if (now - m.at > STATUS_MEMO_TTL) { this._statusMemo.delete(n.id); return; }
      if (n.status === 'idle') n.status = m.status;
    });
  }

  _calculatePositions() {
    if (!this.is3d) return super._calculatePositions();
    // The force layout owns positions in 3D.
  }

  _render() {
    if (!this.is3d) return super._render();
    this._sync3D();
  }

  _renderFlows() {
    if (!this.is3d) return super._renderFlows();
    this._syncBeams();
  }

  _updateDimensions() {
    if (!this.is3d) return super._updateDimensions();
    this.core.resize();
  }

  updateNodeStatus(agentId, status) {
    if (status && status !== 'idle') this._statusMemo.set(agentId, { status, at: Date.now() });
    else this._statusMemo.delete(agentId);
    if (!this.is3d) return super.updateNodeStatus(agentId, status);
    const node = this.nodes.find(n => n.id === agentId);
    if (!node) return;
    node.status = status;
    this.views.get(agentId)?.update(node);
    this._linksDirty = true;
    this._queueInfoRefresh();
  }

  _flowAdd(opts = {}) {
    const flow = super._flowAdd(opts);
    if (flow) this._historyPush({ from: opts.from, to: opts.to, kind: opts.kind || 'message' });
    return flow;
  }

  _historyPush(h) {
    this.history.push({ ...h, at: Date.now() });
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    this.popup?.refresh();
  }

  _queueInfoRefresh() {
    if (this._infoQueued) return;
    this._infoQueued = true;
    requestAnimationFrame(() => {
      this._infoQueued = false;
      if (!this.is3d) return;
      this.labels.sync(this.nodes, id => latency.stats(id));
      this.popup.refresh();
    });
  }

  // ==================== scene sync ====================

  _sync3D() {
    // Layout only re-seats when the node SET changes, so a status flip or a
    // metrics tick never reshuffles the picture.
    const sig = this.nodes.map(n => `${n.id}:${n.type}:${n.providerId || ''}:${(n.agents || [])[0] || ''}`).join('|');
    if (sig !== this._nodeSig) {
      this._nodeSig = sig;
      this.layout.setNodes(this.nodes);
      if (!this.core.userInteracted) this._fitBoost = 1;
    }

    const keep = new Set();
    this.nodes.forEach(n => {
      keep.add(n.id);
      let v = this.views.get(n.id);
      if (!v) {
        v = new NodeView(n);
        const b = this.layout.get(n.id);
        if (b) v.group.position.set(b.x, b.y, b.z);
        this.nodeLayer.add(v.group);
        this.views.set(n.id, v);
      } else {
        v.update(n);
      }
    });
    for (const [id, v] of this.views) {
      if (!keep.has(id)) { v.dispose(); this.views.delete(id); }
    }

    // One nebula per provider that has agents; tinted by its agents' colors.
    const clusters = new Map();
    this.nodes.forEach(n => {
      if (n.type !== 'agent' || !n.providerId) return;
      const pid = `provider_${n.providerId}`;
      if (!this.views.has(pid)) return;
      if (!clusters.has(pid)) clusters.set(pid, []);
      clusters.get(pid).push(n);
    });
    for (const [pid, neb] of this.nebulas) {
      if (!clusters.has(pid)) { neb.dispose(); this.nebulas.delete(pid); }
    }
    clusters.forEach((members, pid) => {
      let neb = this.nebulas.get(pid);
      if (!neb) {
        neb = new Nebula(pid);
        const b = this.layout.get(pid);
        if (b) neb.group.position.set(b.x, b.y, b.z);
        this.nebulaLayer.add(neb.group);
        this.nebulas.set(pid, neb);
      }
      const c = new THREE.Color(0, 0, 0);
      members.forEach(m => c.add(new THREE.Color(m.color || '#00e5ff')));
      c.multiplyScalar(1 / members.length);
      neb.setColor(c);
      neb.members = [pid, ...members.map(m => m.id)];
    });

    // Structure links
    this.links = [];
    this.nodes.forEach(n => {
      if (n.type !== 'agent') return;
      const pid = `provider_${n.providerId}`;
      if (this.views.has(pid)) this.links.push({ from: n.id, to: pid, w: 0.5 });
      this.links.push({ from: 'user', to: n.id, w: 0.2 });
    });
    this._linksDirty = true;

    this.labels.sync(this.nodes, id => latency.stats(id));
    this._applyFocus();
    this._syncBeams();
    this.popup.refresh();
  }

  _syncBeams() {
    if (!this.ready3d) return;
    const ids = new Set();
    this.flows.forEach(f => {
      ids.add(f.id);
      let beam = this.beams.get(f.id);
      if (beam) { beam.flow = f; return; }
      const vFrom = this.views.get(f.from);
      const vTo = this.views.get(f.to);
      if (!vFrom || !vTo) return; // endpoint not charted; retried next sync
      beam = new Beam(f, vFrom.color, vTo.color);
      beam.onArrive = () => this.views.get(f.to)?.pulse(0.35);
      this.beamLayer.add(beam.group);
      this.beams.set(f.id, beam);
      vFrom.pulse(0.6);
    });
    for (const [id, beam] of this.beams) {
      if (!ids.has(id)) { beam.dispose(); this.beams.delete(id); }
    }
    if (this._hoverId || this._selectedId) this._applyFocus();
  }

  // ==================== focus / hover / selection ====================

  _focusSet(id) {
    const keep = new Set([id, 'user']);
    this.edges.forEach(e => {
      if (e.from === id) keep.add(e.to);
      if (e.to === id) keep.add(e.from);
    });
    this.flows.forEach(f => {
      if (f.from === id) keep.add(f.to);
      if (f.to === id) keep.add(f.from);
    });
    const node = this.nodes.find(n => n.id === id);
    if (node?.type === 'agent' && node.providerId) keep.add(`provider_${node.providerId}`);
    if (node?.type === 'provider') {
      this.nodes.forEach(n => { if (n.type === 'agent' && `provider_${n.providerId}` === id) keep.add(n.id); });
    }
    if (node?.type === 'session') (node.agents || []).forEach(a => keep.add(a));
    this.nodes.forEach(n => { if (n.type === 'session' && (n.agents || []).includes(id)) keep.add(n.id); });
    return keep;
  }

  _applyFocus() {
    const focus = this._hoverId || this._selectedId;
    const keep = focus ? this._focusSet(focus) : null;
    for (const [id, v] of this.views) {
      v.dimTarget = keep && !keep.has(id) ? 1 : 0;
      v.hovered = id === this._hoverId;
      v.selected = id === this._selectedId;
    }
    this._focusKeep = keep;
    this._linksDirty = true;
  }

  _wirePointer(canvas) {
    const setPtr = (e) => {
      const r = canvas.getBoundingClientRect();
      this._pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this._pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    };
    canvas.addEventListener('pointermove', (e) => {
      setPtr(e);
      this._pointer.dirty = true;
      this._pointer.inside = true;
    });
    canvas.addEventListener('pointerleave', () => {
      this._pointer.inside = false;
      this._pointer.dirty = true;
    });
    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 600;
      down = null;
      if (moved > 5 || !quick || e.button !== 0) return;
      setPtr(e);
      const id = this._pick();
      if (id) this._select(id);
      else if (this.popup.isOpen) this._select(null);
    });
    canvas.addEventListener('dblclick', (e) => {
      setPtr(e);
      if (!this._pick()) this.resetView();
    });
  }

  _pick() {
    this.raycaster.setFromCamera(this._pointer, this.core.camera);
    const hits = [];
    for (const v of this.views.values()) hits.push(v.hit);
    const res = this.raycaster.intersectObjects(hits, false);
    return res.length ? res[0].object.userData.nodeId : null;
  }

  _select(id, fromPopup = false) {
    if (this._selectedId === id) return;
    this._selectedId = id;
    if (!this.ready3d) return;
    if (id) {
      this.popup.open(id);
      this.core.holdRotate = true;
      this.core.controls.autoRotate = false;
      this._focusCamera(id);
    } else {
      if (!fromPopup) this.popup.close();
      this.core.holdRotate = false;
    }
    this._applyFocus();
  }

  /** Glide the camera so the node sits centred at a comfortable distance. */
  _focusCamera(id) {
    const v = this.views.get(id);
    if (!v) return;
    const cam = this.core.camera;
    const dir = _v.copy(cam.position).sub(this.core.controls.target).normalize();
    // Providers frame their whole cluster; everything else gets a close-up
    // that still leaves the neighbours in view.
    let dist = THREE.MathUtils.clamp(v.r * 30, 95, 170);
    if (v.type === 'provider') {
      const neb = this.nebulas.get(id);
      dist = THREE.MathUtils.clamp((neb ? neb.radius : 30) * 3.2, 110, 260);
    }
    // In a wide view, park the node left of centre so the card (which opens
    // to its right) doesn't sit on top of the scene's middle.
    const target = v.group.position.clone();
    const w = this.core.width;
    if (w > 640) {
      const halfW = dist * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.aspect;
      _v2.setFromMatrixColumn(cam.matrixWorld, 0).normalize();
      target.addScaledVector(_v2, halfW * 0.28);
    }
    this._camTween = {
      t: 0, dur: 0.9,
      fromTarget: this.core.controls.target.clone(),
      toTarget: target,
      fromPos: cam.position.clone(),
      toPos: target.clone().addScaledVector(dir, dist),
    };
    this._followId = id;
    this._followLast = v.group.position.clone();
    this.core.userInteracted = true;
  }

  resetView() {
    this._select(null);
    this._camTween = null;
    this.core.userInteracted = false;
    this.core.holdRotate = false;
    if (!this.core.reduced) this.core.controls.autoRotate = true;
    this._fitBoost = 1;
  }

  // ==================== per-frame ====================

  _frame(dt, t) {
    const reduced = this.core.reduced;
    const moving = this.layout.step(dt);

    // Nodes follow their bodies; sessions orbit theirs.
    for (const [id, v] of this.views) {
      const b = this.layout.get(id);
      if (!b) continue;
      if (v.type === 'session' && !reduced) {
        const w = t * 0.35 + v.seed;
        _v.set(b.x + Math.cos(w) * 3.2, b.y + Math.sin(w * 1.3) * 1.4, b.z + Math.sin(w) * 3.2);
        v.group.position.lerp(_v, Math.min(1, dt * 6));
      } else {
        v.group.position.set(b.x, b.y, b.z);
      }
      v.tick(dt, t, reduced);
    }

    // Nebulas wrap their clusters.
    for (const neb of this.nebulas.values()) {
      _v.set(0, 0, 0);
      let n = 0;
      (neb.members || []).forEach(id => { const v = this.views.get(id); if (v) { _v.add(v.group.position); n++; } });
      if (!n) continue;
      _v.multiplyScalar(1 / n);
      let r = 12;
      (neb.members || []).forEach(id => { const v = this.views.get(id); if (v) r = Math.max(r, v.group.position.distanceTo(_v) + 8); });
      const dimmed = this._focusKeep && !(neb.members || []).some(id => this._focusKeep.has(id)) ? 1 : 0;
      neb.tick(dt, t, _v, r, reduced, dimmed);
    }

    if (moving || this._linksDirty) this._updateLinks();

    // Beams track their (moving) endpoints.
    for (const beam of this.beams.values()) {
      const a = this.views.get(beam.flow.from);
      const b = this.views.get(beam.flow.to);
      if (!a || !b) { beam.group.visible = false; continue; }
      beam.group.visible = true;
      beam.setEnds(a.group.position, b.group.position, a.r, b.r);
      beam.tick(dt, t, reduced);
      const dimmed = this._focusKeep && !(this._focusKeep.has(beam.flow.from) && this._focusKeep.has(beam.flow.to));
      beam.uniforms.uOpacity.value *= dimmed ? 0.15 : 1;
    }

    this._updateCamera(dt);

    // Hover picking, at most once per frame.
    if (this._pointer.dirty) {
      this._pointer.dirty = false;
      const id = this._pointer.inside ? this._pick() : null;
      if (id !== this._hoverId) {
        this._hoverId = id;
        this.core.renderer.domElement.style.cursor = id ? 'pointer' : '';
        this._applyFocus();
      }
    }

    const w = this.core.width, h = this.core.height;
    const cam = this.core.camera;
    this.labels.place(cam, w, h, this.views, cam.position.distanceTo(this.core.controls.target));
    if (this.popup.isOpen) {
      const v = this.views.get(this._selectedId);
      if (v) {
        // Screen radius of the node's glow, so the card clears it.
        _v2.setFromMatrixColumn(cam.matrixWorld, 0).multiplyScalar(v.r * 2.4).add(v.group.position).project(cam);
        _v.copy(v.group.position).project(cam);
        const sx = (_v.x * 0.5 + 0.5) * w;
        const sy = (-_v.y * 0.5 + 0.5) * h;
        const rad = Math.abs((_v2.x * 0.5 + 0.5) * w - sx);
        this.popup.place(sx, sy, w, h, rad);
      }
    }
  }

  _updateLinks() {
    this._linksDirty = false;
    const n = this.links.length;
    const pos = new Float32Array(n * 6);
    const col = new Float32Array(n * 6);
    const c = new THREE.Color();
    this.links.forEach((l, i) => {
      const a = this.views.get(l.from);
      const b = this.views.get(l.to);
      if (!a || !b) return;
      pos.set([a.group.position.x, a.group.position.y, a.group.position.z,
        b.group.position.x, b.group.position.y, b.group.position.z], i * 6);
      const working = a.working || b.working;
      const dim = this._focusKeep && !(this._focusKeep.has(l.from) && this._focusKeep.has(l.to)) ? 0.12 : 1;
      const k = l.w * (working ? 1.8 : 1.2) * dim;
      c.copy(a.color).multiplyScalar(k);
      col.set([c.r, c.g, c.b], i * 6);
      c.copy(b.color).multiplyScalar(k);
      col.set([c.r, c.g, c.b], i * 6 + 3);
    });
    this.linkGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.linkGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.linkGeo.computeBoundingSphere();
  }

  _updateCamera(dt) {
    const core = this.core;
    const ctl = core.controls;
    const cam = core.camera;

    // How far the followed node moved this frame (layout still settling).
    const fv = this._selectedId && this._followId === this._selectedId && this.views.get(this._followId);
    if (fv) {
      _v2.copy(fv.group.position).sub(this._followLast);
      this._followLast.copy(fv.group.position);
    } else {
      _v2.set(0, 0, 0);
    }

    if (this._camTween) {
      const tw = this._camTween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const e = ease(tw.t);
      tw.toTarget.add(_v2);
      tw.toPos.add(_v2);
      ctl.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
      cam.position.lerpVectors(tw.fromPos, tw.toPos, e);
      if (tw.t >= 1) this._camTween = null;
      return;
    }

    // Keep the selected node where we parked it while the layout moves it.
    if (fv) {
      ctl.target.add(_v2);
      cam.position.add(_v2);
      return;
    }

    // Auto-fit until the operator takes the camera.
    if (!core.userInteracted) {
      const b = this.layout.bounds();
      _v.set(b.cx, b.cy, b.cz);
      const k = Math.min(1, dt * (this._fitBoost ? 2.5 : 1));
      ctl.target.lerp(_v, k);
      const vfov = THREE.MathUtils.degToRad(cam.fov);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect);
      const fov = Math.min(vfov, hfov);
      const want = THREE.MathUtils.clamp((b.r + 8) / Math.sin(fov / 2) * 0.9, 60, 800);
      _v2.copy(cam.position).sub(ctl.target);
      const d = _v2.length() || 1;
      _v2.multiplyScalar((d + (want - d) * k) / d);
      cam.position.copy(ctl.target).add(_v2);
      core.setFloor(b.minY, b.r);
      if (this._fitBoost) this._fitBoost = Math.max(0, this._fitBoost - dt * 0.5);
    }
  }

  destroy() {
    super.destroy?.();
    this.beams.forEach(b => b.dispose());
    this.views.forEach(v => v.dispose());
    this.nebulas.forEach(n => n.dispose());
    this.labels?.dispose();
    this.popup?.dispose();
    this.core?.dispose();
  }
}

export default Topology3D;
