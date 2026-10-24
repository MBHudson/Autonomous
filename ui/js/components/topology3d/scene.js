/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// TOPOLOGY3D / SCENE.JS — renderer, camera, bloom, starfield, render loop
// ============================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { perfFrame, perfAttachGL, gpuBegin, gpuEnd, gpuPoll } from '../../perf.js?v=321';

/** True when this browser can give us a WebGL context at all. */
export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch { return false; }
}

export const reducedMotion = () =>
  !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const BG = new THREE.Color('#04070c');

// Twinkling starfield: one draw call, per-star phase and size in attributes.
const STAR_VERT = /* glsl */`
  attribute float aSize;
  attribute float aPhase;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vTw;
  void main() {
    vColor = aColor;
    vTw = 0.45 + 0.55 * sin(uTime * (0.6 + aPhase * 0.9) + aPhase * 12.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const STAR_FRAG = /* glsl */`
  varying vec3 vColor;
  varying float vTw;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float a = smoothstep(0.5, 0.0, d);
    a *= a;
    gl_FragColor = vec4(vColor * (0.6 + vTw), a * (0.35 + 0.65 * vTw));
  }
`;

export class SceneCore {
  /**
   * @param {HTMLElement} host element the canvas is appended to
   */
  constructor(host) {
    this.host = host;
    this.clock = new THREE.Clock();
    this.time = 0;
    this.running = false;
    this.onFrame = null;      // (dt, time) => void, set by the owner
    this._raf = 0;
    this._lastInteract = 0;
    this.reduced = reducedMotion();
    // Resource Manager gates (set by the owner from the Config toggles). All
    // default to "do nothing", so the loop runs as it always has.
    this.suspended = false;   // skip drawing (panel covered / unfocused / off-screen)
    this.idleFps = 0;         // 0 = never throttle; >0 = cap fps while idle
    this.idleCheck = null;    // () => boolean, true when nothing is happening
    this._lastRender = 0;

    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(BG, 1);
    this.renderer.domElement.className = 't3d-canvas';
    host.appendChild(this.renderer.domElement);
    perfAttachGL(this.renderer.getContext());

    this.scene = new THREE.Scene();
    this.scene.background = BG;
    this.scene.fog = new THREE.FogExp2(BG, 0.0007);

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.5, 4000);
    this.camera.position.set(0, 70, 230);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.7;
    this.controls.zoomSpeed = 0.9;
    this.controls.minDistance = 25;
    this.controls.maxDistance = 900;
    this.controls.autoRotate = !this.reduced;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.addEventListener('start', () => {
      this._lastInteract = performance.now();
      this.userInteracted = true;
      this.controls.autoRotate = false;
      this.onInteract?.();
    });
    this.controls.addEventListener('end', () => { this._lastInteract = performance.now(); });

    // Bloom: the glow on every node and beam comes from here, not from
    // per-object tricks, so the whole scene shares one consistent light.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 1.05, 0.6, 0.08);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    // Starfield removed by request (background sparkles); _buildStarfield is
    // kept so it can be switched back on with one line.
    this._buildGrid();

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(host);
    this._onVis = () => (document.hidden ? this.stop() : this.start());
    document.addEventListener('visibilitychange', this._onVis);
  }

  _buildStarfield() {
    const N = 1400;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const size = new Float32Array(N);
    const phase = new Float32Array(N);
    const palette = ['#00e5ff', '#ffffff', '#a855f7', '#00ff88', '#7fb7ff'].map(c => new THREE.Color(c));
    for (let i = 0; i < N; i++) {
      // Uniform on a thick shell well outside the graph.
      const r = 450 + Math.random() * 900;
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      pos[i * 3] = r * s * Math.cos(th);
      pos[i * 3 + 1] = r * u;
      pos[i * 3 + 2] = r * s * Math.sin(th);
      const c = palette[(Math.random() * palette.length) | 0];
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      size[i] = 1.2 + Math.random() * Math.random() * 4.5;
      phase[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.starUniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: this.renderer.getPixelRatio() },
    };
    const m = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: this.starUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.stars = new THREE.Points(g, m);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  _buildGrid() {
    // Faint polar grid under the graph: a floor that gives depth cues when
    // the scene rotates, without competing with the nodes.
    const grid = new THREE.PolarGridHelper(220, 12, 8, 96, 0x00e5ff, 0x00e5ff);
    grid.material.transparent = true;
    grid.material.opacity = 0.07;
    grid.material.depthWrite = false;
    grid.position.y = -90;
    this.grid = grid;
    this.scene.add(grid);
  }

  /** Place the floor just under the lowest node. */
  setFloor(y, radius) {
    if (!this.grid) return;
    this.grid.position.y += ((y - 30) - this.grid.position.y) * 0.05;
    const s = Math.max(0.6, (radius + 60) / 220);
    this.grid.scale.setScalar(this.grid.scale.x + (s - this.grid.scale.x) * 0.05);
  }

  resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w < 2 || h < 2) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.onResize?.(w, h);
  }

  get width() { return this.renderer.domElement.clientWidth; }
  get height() { return this.renderer.domElement.clientHeight; }

  start() {
    if (this.running || document.hidden) return;
    this.running = true;
    this.clock.getDelta();
    const loop = () => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      // Hidden panel (mobile drawer closed, 2D mode): skip the GPU work.
      if (this.host.clientWidth < 2 || this.host.offsetParent === null) return;
      // Resource Manager: a covered / unfocused / off-screen panel draws nothing.
      if (this.suspended) return;
      const now = performance.now();
      // Resource Manager: when idle, draw at most idleFps times a second.
      if (this.idleFps > 0 && this.idleCheck && this.idleCheck()
          && (now - this._lastRender) < (1000 / this.idleFps)) return;
      this._lastRender = now;
      const t0 = now;
      const dt = Math.min(this.clock.getDelta(), 0.1);
      this.time += dt;
      if (this.stars) {
        this.starUniforms.uTime.value = this.reduced ? 0 : this.time;
        if (!this.reduced) this.stars.rotation.y += dt * 0.004;
      }
      // Resume the idle drift a while after the operator lets go.
      if (!this.controls.autoRotate && !this.reduced && !this.holdRotate
          && performance.now() - this._lastInteract > 12000) {
        this.controls.autoRotate = true;
      }
      this.onFrame?.(dt, this.time);
      this.controls.update();
      gpuPoll();
      gpuBegin();
      this.composer.render();
      gpuEnd();
      perfFrame(now, performance.now() - t0);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  dispose() {
    this.stop();
    this._ro?.disconnect();
    document.removeEventListener('visibilitychange', this._onVis);
    this.controls.dispose();
    this.composer.dispose?.();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
