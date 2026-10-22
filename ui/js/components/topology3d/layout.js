// ============================================
// TOPOLOGY3D / LAYOUT.JS — small 3D force layout with cluster anchors
// ============================================
//
// Not a general-purpose physics engine; it does exactly what this graph needs:
//   * You sit at the origin, pinned.
//   * Each provider gets an anchor on a Fibonacci sphere around you.
//   * Agents are pulled into a cluster around their provider's anchor.
//   * Sessions hang close to the agent they belong to.
//   * Everything repels everything, so labels and spheres don't pile up.
// Positions survive rebuilds, so adding one agent eases it in rather than
// reshuffling the whole picture.

const REST = { agent: 26, session: 11, provider: 0 };

function fibonacciSphere(i, n, radius) {
  if (n <= 1) return { x: radius, y: 0, z: 0 };
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (i / (n - 1)) * 2;           // 1 .. -1
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const th = golden * i;
  // Flatten vertically: a squat cloud reads better in a wide panel.
  return { x: Math.cos(th) * r * radius, y: y * radius * 0.55, z: Math.sin(th) * r * radius };
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

export class ForceLayout {
  constructor() {
    /** id -> { x,y,z, vx,vy,vz, type, anchor:{x,y,z}|null, anchorId, pinned } */
    this.bodies = new Map();
    this.alpha = 1;
  }

  /**
   * Re-seat the layout on a new node set. Existing bodies keep their place.
   * @param {Array<{id,type,providerId?,agents?}>} nodes
   */
  setNodes(nodes) {
    const keep = new Set(nodes.map(n => n.id));
    for (const id of [...this.bodies.keys()]) if (!keep.has(id)) this.bodies.delete(id);

    const providers = nodes.filter(n => n.type === 'provider');
    const provRadius = 62 + Math.max(0, providers.length - 2) * 9;
    const anchors = new Map();
    providers.forEach((p, i) => anchors.set(p.id, fibonacciSphere(i, providers.length, provRadius)));
    // A single provider: pull it off-centre a little so the cluster and You
    // are not on top of each other.
    if (providers.length === 1) anchors.set(providers[0].id, { x: 46, y: 6, z: 0 });

    const spawn = (near, spread, seed) => ({
      x: near.x + (hash(seed + 'x') - 0.5) * spread,
      y: near.y + (hash(seed + 'y') - 0.5) * spread,
      z: near.z + (hash(seed + 'z') - 0.5) * spread,
    });

    const orphanCount = { n: 0 };
    nodes.forEach(n => {
      let b = this.bodies.get(n.id);
      let anchor = null;
      let anchorId = null;
      if (n.type === 'user') {
        anchor = { x: 0, y: 0, z: 0 };
      } else if (n.type === 'provider') {
        anchor = anchors.get(n.id);
      } else if (n.type === 'agent') {
        anchorId = `provider_${n.providerId}`;
        if (!anchors.has(anchorId)) {
          // No charted provider: ring around You instead.
          anchorId = null;
          anchor = fibonacciSphere(orphanCount.n++, 8, 40);
        }
      } else if (n.type === 'session') {
        anchorId = (n.agents || [])[0] || null;
      }
      if (!b) {
        const near = anchor || (anchorId && (this.bodies.get(anchorId) || anchors.get(anchorId))) || { x: 0, y: 0, z: 0 };
        b = { ...spawn(near, n.type === 'session' ? 8 : 24, n.id), vx: 0, vy: 0, vz: 0 };
        this.bodies.set(n.id, b);
      }
      b.type = n.type;
      b.anchor = anchor;
      b.anchorId = anchorId;
      b.pinned = n.type === 'user';
      if (b.pinned) { b.x = 0; b.y = 0; b.z = 0; }
    });
    this._anchors = anchors;
    this.reheat();
  }

  reheat(a = 1) { this.alpha = Math.max(this.alpha, a); }

  get(id) { return this.bodies.get(id); }

  /** One integration step. Cheap enough to run every frame for ~60 bodies. */
  step(dt) {
    if (this.alpha < 0.002) return false;
    const list = [...this.bodies.values()];
    const k = Math.min(dt, 0.05) * 60; // normalise to ~60fps steps
    const a = this.alpha;

    // Pairwise repulsion
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const q = list[j];
        let dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dz = Math.random() - 0.5; d2 = 0.5; }
        if (d2 > 160 * 160) continue;
        const sessionPair = p.type === 'session' || q.type === 'session';
        const strength = sessionPair ? 60 : 420;
        const f = Math.min(strength / d2, 4) * a;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
        if (!p.pinned) { p.vx += fx; p.vy += fy; p.vz += fz; }
        if (!q.pinned) { q.vx -= fx; q.vy -= fy; q.vz -= fz; }
      }
    }

    // Springs to anchors
    for (const b of list) {
      if (b.pinned) continue;
      let target = b.anchor;
      let rest = 0;
      if (b.anchorId) {
        const other = this.bodies.get(b.anchorId);
        if (other) { target = other; rest = REST[b.type] ?? 20; }
      }
      if (!target) continue;
      const dx = target.x - b.x, dy = target.y - b.y, dz = target.z - b.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
      const stretch = d - rest;
      const kS = b.type === 'provider' ? 0.06 : (b.type === 'session' ? 0.08 : 0.035);
      const f = stretch * kS * a;
      b.vx += (dx / d) * f; b.vy += (dy / d) * f; b.vz += (dz / d) * f;
    }

    // Integrate with damping
    for (const b of list) {
      if (b.pinned) continue;
      b.vx *= 0.82; b.vy *= 0.82; b.vz *= 0.82;
      b.x += b.vx * k; b.y += b.vy * k; b.z += b.vz * k;
    }
    this.alpha *= 0.985;
    return true;
  }

  /** Bounding sphere of every body: { cx,cy,cz, r, minY } */
  bounds() {
    let n = 0, cx = 0, cy = 0, cz = 0, minY = Infinity;
    for (const b of this.bodies.values()) { cx += b.x; cy += b.y; cz += b.z; n++; if (b.y < minY) minY = b.y; }
    if (!n) return { cx: 0, cy: 0, cz: 0, r: 40, minY: 0 };
    cx /= n; cy /= n; cz /= n;
    let r = 0;
    for (const b of this.bodies.values()) {
      r = Math.max(r, Math.hypot(b.x - cx, b.y - cy, b.z - cz));
    }
    return { cx, cy, cz, r: Math.max(r, 30), minY };
  }
}
