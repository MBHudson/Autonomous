/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// TOPOLOGY3D / BEAMS.JS — animated, directed message beams
// ============================================
//
// One beam per flow record from TopologyGraph (same lifecycle: active →
// traffic → fading → removed). Direction of travel is shown three ways at
// once, so it is unambiguous even where beams cross:
//   1. dashes in the tube shader march from sender to receiver
//   2. a glowing comet with a fading tail rides the arc the same way
//   3. an arrowhead sits at the receiving end
// Plain messages and responses are drawn in the sender's color; delegation
// and agent-to-agent traffic blend from the sender's color to the receiver's.

import * as THREE from 'three';
import { glowTexture } from './nodes.js?v=350';

const SEGMENTS = 56;
const RADIAL = 6;
const TAIL = 5;

/** Per-kind dash pattern (dashes along the arc, duty cycle, march speed). */
const KIND_STYLE = {
  message:  { dash: 14, duty: 0.55, speed: 1.0 },
  response: { dash: 14, duty: 0.55, speed: 1.0 },
  delegate: { dash: 26, duty: 0.28, speed: 0.75 },
  agent:    { dash: 10, duty: 0.62, speed: 0.85 },
  tell:     { dash: 10, duty: 0.62, speed: 0.85 },
};

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FRAG = /* glsl */`
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uDash;
  uniform float uDuty;
  uniform float uSpeed;
  uniform float uHead;
  uniform float uLive;
  varying vec2 vUv;
  void main() {
    float t = vUv.x;
    vec3 col = mix(uColorA, uColorB, t);
    // Marching dashes: features move toward t = 1 (the receiver) over time.
    float d = fract(t * uDash - uTime * uSpeed * uDash * 0.45);
    float dash = smoothstep(0.0, 0.06, d) * (1.0 - smoothstep(uDuty, uDuty + 0.06, d));
    // The dashes keep marching for the whole life of the beam. Once it settles
    // to a "this happened" record they just drop to a lower contrast instead of
    // flattening into a solid line, which looked like the motion had died.
    float dashAmt = mix(0.5, 1.0, uLive);
    float body = mix(0.16, 1.0, dash * dashAmt);
    // Bright travelling head, shared with the comet sprite.
    float head = exp(-pow((t - uHead) * 16.0, 2.0)) * uLive;
    // Taper both ends so the beam emerges from / sinks into the spheres.
    float ends = smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.95, 1.0, t));
    float a = (body * 0.85 + head * 1.6) * uOpacity * ends;
    gl_FragColor = vec4(col * (1.15 + head * 2.2), a);
  }
`;

const ARROW_GEO = new THREE.ConeGeometry(1, 2.6, 14);
ARROW_GEO.translate(0, -1.3, 0); // tip at the origin, pointing +Y

const _up = new THREE.Vector3(0, 1, 0);
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpC = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Beam {
  /**
   * @param {object} flow   {id, from, to, kind, phase}
   * @param {THREE.Color} cFrom sender color
   * @param {THREE.Color} cTo   receiver color
   * @param {boolean} [blendOverride] force blend (agent↔agent) on/off
   */
  constructor(flow, cFrom, cTo, blendOverride) {
    this.flow = flow;
    this.id = flow.id;
    this.kind = flow.kind || 'message';
    this.group = new THREE.Group();
    this.opacity = 0;       // eased toward targetOpacity
    this.radius = 0.32;
    this.headT = 0;
    this.born = performance.now();
    this._lastKey = '';
    this.onArrive = null;

    // Callers may pre-resolve whether the two colors blend (agent-to-agent) or
    // the beam is a solid model color (user <-> model). Fall back to the kind.
    const blend = blendOverride ?? (this.kind === 'delegate' || this.kind === 'agent' || this.kind === 'tell');
    const style = KIND_STYLE[this.kind] || KIND_STYLE.message;
    this.colorA = cFrom.clone();
    this.colorB = blend ? cTo.clone() : cFrom.clone();

    this.uniforms = {
      uColorA: { value: this.colorA },
      uColorB: { value: this.colorB },
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uDash: { value: style.dash },
      uDuty: { value: style.duty },
      uSpeed: { value: style.speed },
      uHead: { value: -1 },
      uLive: { value: 1 },
    };
    this.tubeMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.tube = new THREE.Mesh(new THREE.BufferGeometry(), this.tubeMat);
    this.tube.frustumCulled = false;
    this.group.add(this.tube);

    // Comet head + tail sprites.
    this.comet = [];
    for (let i = 0; i <= TAIL; i++) {
      const m = new THREE.SpriteMaterial({
        map: glowTexture(), color: this.colorA.clone(), transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      });
      const s = new THREE.Sprite(m);
      s.renderOrder = 2;
      this.group.add(s);
      this.comet.push(s);
    }

    // Arrowhead at the receiver, colored like the end of the beam.
    this.arrowMat = new THREE.MeshBasicMaterial({
      color: this.colorB.clone().multiplyScalar(1.6), transparent: true, opacity: 0, toneMapped: false,
    });
    this.arrow = new THREE.Mesh(ARROW_GEO, this.arrowMat);
    this.group.add(this.arrow);

    this.curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3());
  }

  get live() { return this.flow.phase === 'active'; }

  /** Recompute the arc between two node centres, trimmed to their surfaces. */
  setEnds(a, b, rA, rB) {
    _tmpA.copy(b).sub(a);
    const len = _tmpA.length() || 1;
    const dir = _tmpA.divideScalar(len);
    const p0 = this.curve.v0.copy(a).addScaledVector(dir, rA + 1.2);
    const p2 = this.curve.v2.copy(b).addScaledVector(dir, -(rB + 2.2));
    // Lift the arc sideways; the cross product flips with direction, so a
    // reply arcs on the opposite side from the message that caused it.
    _tmpB.crossVectors(dir, _up);
    if (_tmpB.lengthSq() < 1e-4) _tmpB.set(1, 0, 0);
    _tmpB.normalize();
    _tmpC.copy(p0).add(p2).multiplyScalar(0.5)
      .addScaledVector(_tmpB, len * 0.18)
      .addScaledVector(_up, len * 0.12);
    this.curve.v1.copy(_tmpC);
    this.length = len;

    // Only rebuild the tube when something actually moved. Endpoints keep their
    // 0.1-unit step; the radius is now quantised to 0.1 too, because it eases on
    // every phase change, and a 2-decimal key rebuilt the entire tube (allocate +
    // full GPU upload) nearly every frame to express a 0.16-unit difference.
    const key = `${p0.x.toFixed(1)},${p0.y.toFixed(1)},${p0.z.toFixed(1)}|${p2.x.toFixed(1)},${p2.y.toFixed(1)},${p2.z.toFixed(1)}|${Math.round(this.radius * 10)}`;
    if (key !== this._lastKey) {
      this._lastKey = key;
      const geo = new THREE.TubeGeometry(this.curve, SEGMENTS, this.radius, RADIAL, false);
      // Reuse the existing buffers: a tube with this segment count always has
      // the same vertex count, so copying in place turns a dispose + new
      // geometry + new GPU buffers into an attribute update.
      const cur = this.tube.geometry;
      const same = cur && cur.attributes.position
        && cur.attributes.position.count === geo.attributes.position.count;
      if (same) {
        ['position', 'normal', 'uv'].forEach(name => {
          const dst = cur.attributes[name];
          const src = geo.attributes[name];
          if (!dst || !src || dst.array.length !== src.array.length) return;
          dst.array.set(src.array);
          dst.needsUpdate = true;
        });
        geo.dispose();
      } else {
        cur?.dispose();
        this.tube.geometry = geo;
      }
    }
  }

  tick(dt, t, reduced) {
    const phase = this.flow.phase;
    const live = phase === 'active';
    const target = phase === 'fading' ? 0 : (live ? 1 : 0.54);
    this.opacity += (target - this.opacity) * Math.min(1, dt * (phase === 'fading' ? 5 : 6));
    const radiusTarget = live ? 0.34 : 0.18;
    this.radius += (radiusTarget - this.radius) * Math.min(1, dt * 5);

    this.uniforms.uTime.value = reduced ? 0 : t;
    this.uniforms.uOpacity.value = this.opacity;
    this.uniforms.uLive.value += ((live ? 1 : 0) - this.uniforms.uLive.value) * Math.min(1, dt * 5);

    // Comet: constant world speed, so a long hop takes visibly longer.
    const travel = THREE.MathUtils.clamp((this.length || 60) / 70, 0.7, 2.6);
    const prev = this.headT;
    this.headT = reduced ? 0.5 : (this.headT + dt / travel) % 1;
    if (live && !reduced && this.headT < prev) this.onArrive?.(this);
    this.uniforms.uHead.value = live ? this.headT : -1;

    const cometOn = live ? this.opacity : 0;
    this.comet.forEach((s, i) => {
      const tt = this.headT - i * 0.025;
      if (tt < 0 || cometOn < 0.01) { s.material.opacity = 0; return; }
      this.curve.getPoint(tt, s.position);
      const fall = 1 - i / (TAIL + 1);
      s.scale.setScalar((i === 0 ? 5.5 : 3.2) * fall + 0.6);
      s.material.opacity = cometOn * fall * (i === 0 ? 1 : 0.6);
    });

    // Arrowhead
    this.curve.getPoint(1, this.arrow.position);
    this.curve.getTangent(0.98, _tmpA);
    _q.setFromUnitVectors(_up, _tmpA.normalize());
    this.arrow.quaternion.copy(_q);
    this.arrow.scale.setScalar(live ? 1.05 : 0.6);
    this.arrowMat.opacity = Math.min(1, this.opacity * 1.2);
  }

  dispose() {
    this.tube.geometry.dispose();
    this.tubeMat.dispose();
    this.comet.forEach(s => s.material.dispose());
    this.arrowMat.dispose();
    this.group.removeFromParent();
  }
}
