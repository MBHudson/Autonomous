/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// TOPOLOGY3D / NODES.JS — glowing node meshes, pulses, ripples, nebulas
// ============================================

import * as THREE from 'three';

/** World radius per node type (mirrors the SVG sizes, scaled to the scene). */
export const NODE_RADIUS = { user: 5.6, router: 4.4, agent: 3.6, provider: 3.0, session: 1.6, mcp: 3.4, mcpclient: 3.2 };
export const radiusFor = type => NODE_RADIUS[type] || 3;

const RED = new THREE.Color('#ff3355');

// ---- Shared textures (built once) ----------------------------------------

let _glowTex = null;
/** Soft radial glow used by halos, comets and nebulas. */
export function glowTexture() {
  if (_glowTex) return _glowTex;
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.75)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  _glowTex = new THREE.CanvasTexture(c);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

let _ringTex = null;
function ringTexture() {
  if (_ringTex) return _ringTex;
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, s * 0.36, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  _ringTex = new THREE.CanvasTexture(c);
  return _ringTex;
}

const SPHERE_GEO = new THREE.SphereGeometry(1, 32, 24);
const HIT_GEO = new THREE.SphereGeometry(1, 10, 8);
const ICO_GEO = new THREE.IcosahedronGeometry(1, 1);
const TORUS_GEO = new THREE.TorusGeometry(1, 0.035, 8, 96);

/** Brighten a color past 1.0 so bloom picks it up. */
function hot(color, k) { return color.clone().multiplyScalar(k); }

// ---------------------------------------------------------------------------

export class NodeView {
  /**
   * @param {object} node topology node ({id,type,color,status,...})
   */
  constructor(node) {
    this.id = node.id;
    this.type = node.type;
    this.r = radiusFor(node.type);
    this.group = new THREE.Group();
    this.group.userData.nodeId = node.id;
    this.color = new THREE.Color(node.color || '#00e5ff');
    this.status = node.status || 'idle';
    this.flash = 0;          // arrival pulse 0..1
    this.failFlash = 0;      // red error pulse 0..1
    this.dim = 0;            // hover dimming 0..1 (eased)
    this.dimTarget = 0;
    this.selected = false;
    this.seed = Math.random() * 10;
    this._build();
  }

  _build() {
    const r = this.r;
    const c = this.color;

    // Core: an emissive-looking sphere. Basic material + values above 1.0
    // means the bloom pass turns it into a light source.
    this.coreMat = new THREE.MeshBasicMaterial({ color: hot(c, 1.6), transparent: true, toneMapped: false });
    this.core = new THREE.Mesh(SPHERE_GEO, this.coreMat);
    this.core.scale.setScalar(r * 0.62);
    this.group.add(this.core);

    // Shell: a translucent fresnel-ish outer sphere, rendered back-face so
    // the core shows through.
    this.shellMat = new THREE.MeshBasicMaterial({
      color: c.clone(), transparent: true, opacity: 0.16, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.BackSide, toneMapped: false,
    });
    this.shell = new THREE.Mesh(SPHERE_GEO, this.shellMat);
    this.shell.scale.setScalar(r);
    this.group.add(this.shell);

    // Halo sprite: the soft corona.
    this.haloMat = new THREE.SpriteMaterial({
      map: glowTexture(), color: c.clone(), transparent: true, opacity: 0.55,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.halo = new THREE.Sprite(this.haloMat);
    this.halo.scale.setScalar(r * 5.2);
    this.group.add(this.halo);

    // Type-specific ornaments.
    if (this.type === 'provider') {
      this.cageMat = new THREE.MeshBasicMaterial({
        color: hot(c, 1.2), wireframe: true, transparent: true, opacity: 0.55, toneMapped: false,
      });
      this.cage = new THREE.Mesh(ICO_GEO, this.cageMat);
      this.cage.scale.setScalar(r * 1.65);
      this.group.add(this.cage);
    } else if (this.type === 'user') {
      this.orbitMat = new THREE.MeshBasicMaterial({ color: hot(c, 1.4), transparent: true, opacity: 0.7, toneMapped: false });
      this.orbits = [0, 1].map(i => {
        const m = new THREE.Mesh(TORUS_GEO, this.orbitMat);
        m.scale.setScalar(r * (1.7 + i * 0.45));
        m.rotation.set(Math.PI / 2 + (i ? 0.6 : -0.4), i ? 0.5 : 0, 0);
        this.group.add(m);
        return m;
      });
    }

    // Ripple rings for working agents (billboarded each frame).
    if (this.type === 'agent' || this.type === 'user') {
      this.rings = [0, 1, 2].map(() => {
        const mat = new THREE.SpriteMaterial({
          map: ringTexture(), color: c.clone(), transparent: true, opacity: 0,
          depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
        });
        const s = new THREE.Sprite(mat);
        s.visible = false;
        this.group.add(s);
        return s;
      });
    }

    // Invisible, generous hit target so small nodes are still easy to click.
    this.hit = new THREE.Mesh(HIT_GEO, new THREE.MeshBasicMaterial({ visible: false }));
    this.hit.scale.setScalar(Math.max(this.r * 1.9, 4));
    this.hit.userData.nodeId = this.id;
    this.group.add(this.hit);
  }

  /** Refresh from a rebuilt node record (color/status may have changed). */
  update(node) {
    this.status = node.status || 'idle';
    if (node.color && ('#' + this.color.getHexString()) !== String(node.color).toLowerCase()) {
      this.color.set(node.color);
      this.coreMat.color.copy(hot(this.color, 1.6));
      this.shellMat.color.copy(this.color);
      this.haloMat.color.copy(this.color);
      if (this.cageMat) this.cageMat.color.copy(hot(this.color, 1.2));
      if (this.orbitMat) this.orbitMat.color.copy(hot(this.color, 1.4));
      this.rings?.forEach(s => s.material.color.copy(this.color));
    }
  }

  /** Toggle scene fog on this node's materials (fog modes on the map). */
  setFog(on) {
    const flag = !!on;
    const mats = [this.coreMat, this.shellMat, this.haloMat, this.cageMat, this.orbitMat];
    this.rings?.forEach(s => mats.push(s.material));
    mats.forEach(m => {
      if (m && m.fog !== flag) { m.fog = flag; m.needsUpdate = true; }
    });
  }

  get working() { return this.status === 'thinking' || this.status === 'active'; }

  pulse(strength = 1) { this.flash = Math.min(1.4, this.flash + strength); }
  fail() { this.failFlash = 1; }

  /** Per-frame animation. */
  tick(dt, t, reduced) {
    const r = this.r;
    const working = this.working;
    const thinking = this.status === 'thinking';

    this.dim += (this.dimTarget - this.dim) * Math.min(1, dt * 8);
    this.flash = Math.max(0, this.flash - dt * 1.8);
    this.failFlash = Math.max(0, this.failFlash - dt * 0.9);
    const vis = 1 - this.dim * 0.85;

    // Breathing: slow when idle, quicker while working.
    const speed = reduced ? 0 : (thinking ? 5.2 : (working ? 3.6 : 1.6));
    const breathe = reduced ? 0 : Math.sin(t * speed + this.seed);
    const scale = 1 + breathe * (working ? 0.09 : 0.05) + this.flash * 0.25 + (this.selected ? 0.08 : 0);
    this.core.scale.setScalar(r * 0.62 * scale);
    this.shell.scale.setScalar(r * (1 + breathe * 0.04 + this.flash * 0.15));

    // Idle nodes carry much less halo so their wireframe/geometric structure
    // reads instead of being smothered in fuzz; working ones keep the full glow.
    const glow = (working ? 0.85 : 0.3) + breathe * 0.12 + this.flash * 0.6 + (this.selected ? 0.25 : 0);
    this.haloMat.opacity = Math.max(0, glow) * vis;
    this.halo.scale.setScalar(r * ((working ? 5.2 : 4.2) + this.flash * 3 + (working ? 1.2 : 0) + this.failFlash * 4));
    this.shellMat.opacity = (0.14 + (working ? 0.08 : 0) + this.flash * 0.15) * vis;
    this.coreMat.opacity = vis;

    // Error pulse tints the halo red, then lets it return to the agent color.
    if (this.failFlash > 0) this.haloMat.color.copy(this.color).lerp(RED, this.failFlash);
    else if (this._wasFailing) this.haloMat.color.copy(this.color);
    this._wasFailing = this.failFlash > 0;

    if (this.cage) {
      this.cage.rotation.x += dt * 0.25;
      this.cage.rotation.y += dt * 0.4;
      this.cageMat.opacity = (0.45 + breathe * 0.1) * vis;
    }
    if (this.orbits) {
      this.orbits[0].rotation.z += dt * 0.6;
      this.orbits[1].rotation.z -= dt * 0.45;
      this.orbitMat.opacity = 0.65 * vis;
    }

    // Ripples: three staggered rings expanding outward while working.
    if (this.rings) {
      const on = working && !reduced;
      const period = thinking ? 1.8 : 2.4;
      this.rings.forEach((s, i) => {
        if (!on) { s.visible = false; return; }
        const p = ((t / period) + i / 3) % 1;
        s.visible = true;
        s.scale.setScalar(r * (2 + p * 9));
        s.material.opacity = (1 - p) * 0.55 * vis;
      });
    }
  }

  dispose() {
    this.group.traverse(o => {
      if (o.material && o.material !== this.orbitMat) o.material.dispose?.();
    });
    this.orbitMat?.dispose();
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------------------

/**
 * Nebula: a soft colored cloud plus slowly orbiting dust around one
 * provider's cluster. Purely decorative; never hit-tested.
 */
export class Nebula {
  constructor(id) {
    this.id = id;
    this.group = new THREE.Group();
    this.color = new THREE.Color('#00ff88');
    this.mat = new THREE.SpriteMaterial({
      map: glowTexture(), color: this.color, transparent: true, opacity: 0.08,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
    });
    this.cloud = new THREE.Sprite(this.mat);
    this.group.add(this.cloud);

    const N = 90;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const rr = Math.cbrt(Math.random());
      const s = Math.sqrt(1 - u * u);
      pos[i * 3] = rr * s * Math.cos(th);
      pos[i * 3 + 1] = rr * u * 0.6;
      pos[i * 3 + 2] = rr * s * Math.sin(th);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dustMat = new THREE.PointsMaterial({
      map: glowTexture(), color: this.color, size: 1.1, transparent: true, opacity: 0.35,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, toneMapped: false,
    });
    this.dust = new THREE.Points(g, this.dustMat);
    // Sparkle dust disabled by request; the soft cloud alone marks the cluster.
    this.dust.visible = false;
    this.group.add(this.dust);
    this.radius = 30;
    this.seed = Math.random() * 10;
  }

  setColor(c) { this.color.copy(c); }

  /** Ease toward the cluster's centre/radius. */
  tick(dt, t, center, radius, reduced, dim) {
    this.group.position.lerp(center, Math.min(1, dt * 3));
    this.radius += (radius - this.radius) * Math.min(1, dt * 2);
    const breathe = reduced ? 0 : Math.sin(t * 0.8 + this.seed);
    // Cluster fog trimmed ~40% in opacity and ~12% in radius: still a soft
    // marker, but the geometric wirework inside is visible from further out.
    this.cloud.scale.setScalar(this.radius * (2.8 + breathe * 0.12));
    this.mat.opacity = (0.024 + breathe * 0.0048) * (1 - dim * 0.7);
    this.dust.scale.setScalar(this.radius * 1.25);
    if (!reduced) this.dust.rotation.y += dt * 0.05;
    this.dustMat.opacity = 0.32 * (1 - dim * 0.7);
  }

  dispose() {
    this.mat.dispose();
    this.dustMat.dispose();
    this.dust.geometry.dispose();
    this.group.removeFromParent();
  }
}
