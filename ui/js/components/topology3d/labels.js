// ============================================
// TOPOLOGY3D / LABELS.JS — HTML name + ping labels pinned to 3D nodes
// ============================================
//
// HTML rather than sprites: crisp text at any zoom, theme fonts, and CSS can
// style the ping badge. Each frame the node centre is projected to screen and
// the label is moved with a transform (no layout thrash).

import * as THREE from 'three';
import { esc } from '../../utils.js?v=296';
import { fmtMs, latencyTier } from '../../latency.js?v=296';

const _v = new THREE.Vector3();

export class LabelLayer {
  constructor(host) {
    this.el = document.createElement('div');
    this.el.className = 't3d-labels';
    host.appendChild(this.el);
    /** id -> { el, html } */
    this.items = new Map();
  }

  /**
   * Make the label set match the node set and refresh their contents.
   * @param {Array} nodes topology nodes
   * @param {(id:string)=>object} statsFor latency stats per agent id
   */
  sync(nodes, statsFor) {
    const keep = new Set();
    nodes.forEach(n => {
      keep.add(n.id);
      let it = this.items.get(n.id);
      if (!it) {
        const el = document.createElement('div');
        el.className = `t3d-label t3d-label-${n.type}`;
        this.el.appendChild(el);
        it = { el, html: '' };
        this.items.set(n.id, it);
      }
      const html = this._html(n, statsFor);
      if (html !== it.html) { it.el.innerHTML = html; it.html = html; }
      it.el.style.setProperty('--c', n.color || '#00e5ff');
      it.el.classList.toggle('working', n.status === 'thinking' || n.status === 'active');
    });
    for (const [id, it] of this.items) {
      if (!keep.has(id)) { it.el.remove(); this.items.delete(id); }
    }
  }

  _html(n, statsFor) {
    if (n.type === 'session') {
      return `<span class="t3d-name">${esc(String(n.label || 'Session').slice(0, 22))}</span>`;
    }
    let out = `<span class="t3d-name">${esc(n.label || n.id)}</span>`;
    if (n.type === 'agent') {
      const s = statsFor(n.id);
      const shown = s && (s.avg ?? s.last);
      if (Number.isFinite(shown)) {
        out += `<span class="t3d-ping ${latencyTier(shown)}" title="Average response time over the last ${s.okCount} calls">● ${fmtMs(shown)}</span>`;
      } else {
        out += `<span class="t3d-ping none" title="No calls measured yet">● —</span>`;
      }
      if (n.status === 'thinking') out += `<span class="t3d-state">thinking…</span>`;
      else if (n.status === 'active') out += `<span class="t3d-state">working…</span>`;
    }
    return out;
  }

  /**
   * Position every label. `views` maps id -> NodeView (for position + dim).
   */
  place(camera, width, height, views, focusDist = 200) {
    for (const [id, it] of this.items) {
      const v = views.get(id);
      if (!v) { it.el.style.opacity = '0'; continue; }
      v.group.getWorldPosition(_v);
      // Farther labels are fainter (relative to the orbit focus distance, not
      // NDC z, which is ~1 for everything in a perspective projection).
      const ratio = camera.position.distanceTo(_v) / Math.max(1, focusDist);
      const depth = THREE.MathUtils.clamp(1.5 - ratio * 0.55, 0.5, 1);
      // Offset below the sphere in world space, scaled by node size.
      _v.y -= v.r * 1.25;
      _v.project(camera);
      if (_v.z > 1 || _v.z < -1) { it.el.style.opacity = '0'; continue; }
      const x = (_v.x * 0.5 + 0.5) * width;
      const y = (-_v.y * 0.5 + 0.5) * height;
      // Sessions are small and numerous: name them only on hover/selection.
      const sessionFade = v.type === 'session' ? ((v.hovered || v.selected) ? 1 : 0) : 1;
      const op = depth * (1 - v.dim * 0.88) * sessionFade;
      it.el.style.opacity = op.toFixed(3);
      it.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, 0)`;
      it.el.style.zIndex = String(1000 - Math.round(_v.z * 1000));
    }
  }

  dispose() { this.el.remove(); this.items.clear(); }
}
