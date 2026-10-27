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
import { perf, perfFrame, perfAttachGL, gpuBegin, gpuEnd, gpuPoll } from '../../perf.js?v=353';

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
// Fog colour is deliberately lighter than the void: at these scene distances a
// fog that matched the background was invisible (and the old density produced
// ~2% fog at 400 units). A lighter haze is what makes the modes read.
const HAZE = new THREE.Color('#16324e');

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
    // Camera drift is a setting of its own (Desktop -> Slow auto-rotate): the
    // owner pushes it in through setAutoRotate().
    this.autoRotateAllowed = true;
    // Resource Manager gates (set by the owner from the Config toggles). All
    // default to "do nothing", so the loop runs as it always has.
    this.suspended = false;   // skip drawing (panel covered / unfocused / off-screen)
    this.idleFps = 0;         // 0 = never throttle; >0 = cap fps while idle
    this.idleCheck = null;    // () => boolean, true when nothing is happening
    this._lastRender = 0;

    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    // Cap the supersample. On the desktop skin the map is full-screen behind
    // the panels, so 2x device-pixel-ratio means 4x the pixels for the scene,
    // the bloom pass and every backdrop-filter composited over it -- the single
    // biggest cost, and what pinned weaker GPUs near 100%.
    this.maxPixelRatio = 1.5;
    this.basePixelRatio = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(BG, 1);
    this.renderer.domElement.className = 't3d-canvas';
    host.appendChild(this.renderer.domElement);
    perfAttachGL(this.renderer.getContext());

    this.scene = new THREE.Scene();
    // Drawn before the scene, stretched over the viewport in screen space: the
    // fog neither orbits nor zooms, and it reaches the top of the map.
    this.hazeTex = this._hazeTexture();
    this.scene.background = this.hazeTex;
    // Fog modes (Desktop → Fog). Default "background only": a linear haze that
    // begins past the polar grid and below the graph, so only the floor fades
    // into the distance and the clusters stay crisp -- which reads as depth.
    // "full" is the old exponential fog over everything; "off" removes it.
    this._bgFogNear = 220;
    this._bgFogFar = 1300;
    this.nodesFogged = false;
    this.fogMode = 'bg';
    this.setFogMode('bg');
    // Hard frame cap (Desktop → Topography FPS). 0 = uncapped.
    this.maxFps = 0;
    this._lastFrame = 0;

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

    // Render scale: the map's internal resolution as a share of the pixel-ratio
    // cap. This used to step itself down whenever a frame ran long, which on a
    // slower machine meant the map visibly lost sharpness a few seconds after
    // load, a step at a time, and never reliably came back. It is now a plain
    // setting (Desktop -> Map detail) that holds whatever the operator picks.
    this._scales = [1, 0.85, 0.7, 0.55, 0.42];
    this._si = 0;

    // Fixed floor (Desktop -> Fix floor in place): the polar grid can be held in
    // camera space so it stays put on screen instead of swinging with an orbit.
    this.gridFixed = false;
    this._fixDist = 1400;                    // far enough behind the graph
    this._fixPitch = (74 * Math.PI) / 180;   // off the view plane, like the DOM floor
    this._floorTarget = { y: -90, s: 1 };    // last world pose, to come back to
    this._pt = new THREE.Vector3();

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

  /**
   * The background haze, painted as the scene background.
   *
   * It used to be a vast plane lying on the ground, fogged into the distance.
   * Because that plane lived in the world, an orbit carried it around and a zoom
   * slid it up and down the screen, so the haze read as attached to the nodes
   * rather than as the backdrop behind them -- and its far edge could only ever
   * reach the horizon, leaving the top of the panel black.
   *
   * The scene background is drawn by three before anything else and never
   * depth-tested, and for a plain Texture it is stretched across the viewport in
   * screen space. So this is camera-independent by construction and always
   * reaches the top of the map.
   *
   * Opaque stops mixed over the void colour, not alpha: the background is drawn
   * first and nothing shows through it, so it needs no blending.
   * y = 0 is the TOP of the panel. Strongest there, easing out to nothing above
   * the grid, which keeps the faint lower edge the operator liked.
   */
  _hazeTexture() {
    const w = 2;
    const h = 512;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = BG.getStyle();
    g.fillRect(0, 0, w, h);
    // 'rgb(r, g, b)' -> 'rgba(r, g, b, ' so a stop only has to supply the alpha.
    const haze = HAZE.getStyle().replace('rgb(', 'rgba(').replace(')', ', ');
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0.00, haze + '0.92)');
    grad.addColorStop(0.34, haze + '0.80)');
    grad.addColorStop(0.62, haze + '0.40)');
    grad.addColorStop(0.80, haze + '0.13)');
    grad.addColorStop(0.94, haze + '0.00)');
    grad.addColorStop(1.00, haze + '0.00)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Place the floor just under the lowest node. */
  setFloor(y, radius) {
    if (!this.grid) return;
    const gy = y - 30;
    const gs = Math.max(0.6, (radius + 60) / 220);
    this._floorTarget = { y: gy, s: gs };
    // Pinned: _pinGrid() owns the grid's transform, so the follow lerp would
    // only fight it. The target is still recorded for when it is released.
    if (this.gridFixed) return;
    this.grid.position.y += (gy - this.grid.position.y) * 0.05;
    this.grid.scale.setScalar(this.grid.scale.x + (gs - this.grid.scale.x) * 0.05);

  }

  /**
   * Fog mode for the map.
   *   'off'  - no fog at all
   *   'bg'   - linear haze that starts past the polar grid, so only the floor
   *            and the far background fade (nodes stay crisp)
   *   'full' - exponential fog over everything
   * The owner also reads `nodesFogged` to keep node materials in step.
   */
  setFogMode(mode) {
    this.fogMode = ['off', 'bg', 'full'].includes(mode) ? mode : 'bg';
    if (this.fogMode === 'off') {
      this.scene.fog = null;
      // No haze at all: back to the flat void colour.
      this.scene.background = BG;
      this.nodesFogged = false;
    } else if (this.fogMode === 'full') {
      this.scene.fog = new THREE.FogExp2(HAZE.getHex(), 0.0022);
      this.scene.background = this.hazeTex;
      this.nodesFogged = true;
    } else {
      this.scene.fog = new THREE.Fog(HAZE.getHex(), this._bgFogNear, this._bgFogFar);
      this.scene.background = this.hazeTex;
      this.nodesFogged = false;
    }
    // The floor/grid is the thing we WANT fogged in every mode except off.
    // A pinned grid sits a fixed distance from the camera, so fogging it would
    // just dim it evenly and could erase it entirely; only fog a world floor.
    this._setGridFog(this.fogMode !== 'off' && !this.gridFixed);
  }

  /** Hard cap on map redraws per second (0 = uncapped). */
  setMaxFps(fps) {
    const n = Number(fps);
    this.maxFps = Number.isFinite(n) && n > 0 ? Math.min(120, Math.max(1, n)) : 0;
  }

  resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w < 2 || h < 2) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    // The composer sizes every pass (bloom's mip chain included) from its own
    // pixel ratio. Sizing bloom again here fought that and rebuilt its render
    // targets a second time on every resize.
    this.onResize?.(w, h);
  }

  /**
   * Map detail: an explicit render scale, in percent of the pixel-ratio cap
   * (100 / 85 / 70 / 55 / 42, the nearest step wins). Manual only -- nothing
   * changes this behind the operator's back.
   */
  setQuality(pct) {
    const n = Number(pct);
    const want = Number.isFinite(n) && n > 0 ? Math.min(1, Math.max(this._scales[this._scales.length - 1], n / 100)) : 1;
    let best = 0;
    for (let i = 1; i < this._scales.length; i++) {
      if (Math.abs(this._scales[i] - want) < Math.abs(this._scales[best] - want)) best = i;
    }
    if (best !== this._si) this._setScale(best);
  }

  /** Current render scale as a percentage, for the Desktop control. */
  get quality() { return Math.round(this._scales[this._si] * 100); }

  _setScale(i) {
    this._si = i;
    const ratio = this.basePixelRatio * this._scales[i];
    this.renderer.setPixelRatio(ratio);
    // EffectComposer caches the renderer's pixel ratio at construction and only
    // refreshes it in reset()/setPixelRatio(). Without this the scene, the bloom
    // mips and every pass would keep rendering at the ORIGINAL resolution and
    // only the final blit would shrink, so a lower detail setting would cost
    // exactly as much GPU as full detail.
    this.composer.setPixelRatio(ratio);
    this.resize();
  }

  /** Cap the device pixel ratio (1.5 = supersampled default, 1 = native). */
  setPixelCap(cap) {
    const n = Number(cap);
    this.maxPixelRatio = Number.isFinite(n) && n > 0 ? Math.min(2, Math.max(0.5, n)) : 1.5;
    const want = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    if (Math.abs(want - this.basePixelRatio) < 0.01) return;
    this.basePixelRatio = want;
    this._setScale(this._si);
  }

  /** Bloom is a post pass: off keeps the emissive colours, drops the mip chain. */
  setBloom(on) {
    if (this.bloom) this.bloom.enabled = on !== false;
  }

  /** Let the idle camera drift re-arm itself; off parks the view until touched. */
  setAutoRotate(allow) {
    this.autoRotateAllowed = allow !== false;
    if (!this.autoRotateAllowed) this.controls.autoRotate = false;
  }

  /** Show/hide the in-scene polar grid (the DOM floor replaces it while on). */
  setGridVisible(visible) {
    if (this.grid) this.grid.visible = !!visible;
  }

  /**
   * Pin the polar grid to the view.
   *
   * As a world object the grid is a real floor at a real height, so orbiting
   * swings it around the graph and a low angle flattens it into a line. Pinned,
   * it is measured in camera space instead: the same disc in the same place at
   * every orbit angle and every zoom, while the graph itself stays fully
   * orbitable, pannable and zoomable. Size and pitch match the DOM floor, so
   * switching between the two reads as the same floor holding still.
   */
  setGridFixed(on) {
    const want = on === true;
    if (!this.grid || want === this.gridFixed) return;
    this.gridFixed = want;
    if (want) {
      this._pinGrid();
    } else {
      // Back to a world floor: drop the camera-space transform, then land on
      // the pose the follow lerp would have reached rather than sliding there.
      this.grid.quaternion.identity();
      this.grid.position.set(0, this._floorTarget.y, 0);
      this.grid.scale.setScalar(this._floorTarget.s);
    }
    this._setGridFog(this.fogMode !== 'off' && !this.gridFixed);
  }

  /**
   * Fog is a compile-time define, not a uniform: assigning `.fog` alone left the
   * old shader in place, which is why the grid kept (or kept ignoring) fog
   * after the setting changed. Recompile only when the flag really moves.
   */
  _setGridFog(on) {
    const mat = this.grid && this.grid.material;
    if (!mat || mat.fog === on) return;
    mat.fog = on;
    mat.needsUpdate = true;
  }

  /**
   * Place the grid in camera space: a 150vmax disc, centred 10% below the middle
   * of the view, pitched like the DOM floor. The disc is clamped so its near
   * edge stays well in front of the camera -- at 74deg, 96% of its radius comes
   * back toward the viewer, and geometry behind the near plane is what tears.
   */
  _pinGrid() {
    const g = this.grid;
    const cam = this.camera;
    const d = this._fixDist;
    const halfH = Math.tan((cam.fov * Math.PI) / 360) * d;
    const hostW = Math.max(1, this.host.clientWidth || 1);
    const hostH = Math.max(1, this.host.clientHeight || 1);
    const vmax = Math.max(hostW, hostH);
    const wantR = (0.75 * vmax / hostH) * 2 * halfH * 0.5;   // half of a 150vmax disc
    const maxR = (d - Math.max(0.35 * d, 1)) / Math.sin(this._fixPitch);
    g.scale.setScalar(Math.min(wantR, maxR) / 220);          // PolarGridHelper's radius
    cam.getWorldDirection(this._pt);
    g.position.copy(cam.position).addScaledVector(this._pt, d);
    this._pt.set(0, -0.2 * halfH, 0).applyQuaternion(cam.quaternion);
    g.position.add(this._pt);
    g.quaternion.copy(cam.quaternion);
    g.rotateX(Math.PI / 2 - this._fixPitch);
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
      // Desktop → Topography FPS: a hard cap on redraws per second.
      if (this.maxFps > 0 && (now - this._lastFrame) < (1000 / this.maxFps - 0.5)) return;
      this._lastFrame = now;
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
          && this.autoRotateAllowed !== false
          && performance.now() - this._lastInteract > 12000) {
        this.controls.autoRotate = true;
      }
      this.onFrame?.(dt, this.time);
      this.controls.update();
      // Pinned floor: re-place it after the camera has moved, before drawing.
      if (this.gridFixed) this._pinGrid();
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
