import { BezierMath } from './bezier.js';

/**
 * Vector Path Data Model
 * Represents a vector shape composed of Bézier anchors and control handles.
 */
export class VectorPath {
  constructor(options = {}) {
    this.id = options.id || 'path_' + Math.random().toString(36).slice(2, 9);
    this.type = 'path';
    this.anchors = (options.anchors || []).map(copyAnchor);
    this.closed = Boolean(options.closed);
    // Extra outlines of a compound path (holes, separate pieces); node editing works on the main outline.
    this.subpaths = (options.subpaths || []).map(sp => ({ anchors: sp.anchors.map(copyAnchor), closed: Boolean(sp.closed) }));
    if (options.fillRule === 'evenodd') this.fillRule = 'evenodd';
    this.fill = options.fill || 'transparent';
    this.stroke = options.stroke || '#1f2328';
    this.strokeWidth = options.strokeWidth ?? 2;
    this.rotation = options.rotation || 0;
    if (options.opacity !== undefined) this.opacity = options.opacity;

    // Computed bounding box
    this.recomputeBounds();
  }

  addAnchor(x, y, handleIn = null, handleOut = null) {
    this.anchors.push({
      x,
      y,
      handleIn: handleIn ? { ...handleIn } : null,
      handleOut: handleOut ? { ...handleOut } : null
    });
    this.recomputeBounds();
  }

  /** The main outline followed by any subpaths, as { anchors, closed }. */
  outlines() {
    return [{ anchors: this.anchors, closed: this.closed }, ...this.subpaths];
  }

  translate(dx, dy) {
    for (const { anchors } of this.outlines()) {
      for (const a of anchors) {
        a.x += dx;
        a.y += dy;
        if (a.handleIn) { a.handleIn.x += dx; a.handleIn.y += dy; }
        if (a.handleOut) { a.handleOut.x += dx; a.handleOut.y += dy; }
      }
    }
    this.recomputeBounds();
  }

  recomputeBounds() {
    const all = this.outlines().flatMap(o => o.anchors);
    if (all.length === 0) {
      this.x = 0;
      this.y = 0;
      this.width = 0;
      this.height = 0;
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const a of all) {
      minX = Math.min(minX, a.x);
      minY = Math.min(minY, a.y);
      maxX = Math.max(maxX, a.x);
      maxY = Math.max(maxY, a.y);

      if (a.handleIn) {
        minX = Math.min(minX, a.handleIn.x);
        minY = Math.min(minY, a.handleIn.y);
        maxX = Math.max(maxX, a.handleIn.x);
        maxY = Math.max(maxY, a.handleIn.y);
      }
      if (a.handleOut) {
        minX = Math.min(minX, a.handleOut.x);
        minY = Math.min(minY, a.handleOut.y);
        maxX = Math.max(maxX, a.handleOut.x);
        maxY = Math.max(maxY, a.handleOut.y);
      }
    }

    this.x = minX;
    this.y = minY;
    this.width = Math.max(10, maxX - minX);
    this.height = Math.max(10, maxY - minY);
  }

  /**
   * Generates standard SVG Path string 'd'.
   */
  toSVGPath() {
    return this.outlines().map(o => outlineToSVG(o.anchors, o.closed)).filter(Boolean).join(' ');
  }

  /**
   * Hit test for Bézier curves along path segments.
   */
  hitTest(worldX, worldY, tolerance = 8) {
    if (this.anchors.length < 2) return false;
    const reach = Math.max(tolerance, (this.strokeWidth || 2) / 2 + 4);

    for (const { anchors, closed } of this.outlines()) {
      const count = closed ? anchors.length : anchors.length - 1;
      for (let i = 0; i < count; i++) {
        const p0 = anchors[i];
        const p1 = anchors[(i + 1) % anchors.length];
        const cp1 = p0.handleOut || { x: p0.x, y: p0.y };
        const cp2 = p1.handleIn || { x: p1.x, y: p1.y };
        if (BezierMath.distToCubicBezier(worldX, worldY, p0, cp1, cp2, p1) <= reach) return true;
      }
    }

    // Inside test for closed path with fill
    if (this.closed && this.fill && this.fill !== 'transparent') {
      return this.pointInPolygon(worldX, worldY);
    }

    return false;
  }

  /** Even-odd test over every outline's anchor polygon, so holes are not hits. */
  pointInPolygon(px, py) {
    let inside = false;
    for (const { anchors } of this.outlines()) {
      for (let i = 0, j = anchors.length - 1; i < anchors.length; j = i++) {
        const xi = anchors[i].x, yi = anchors[i].y;
        const xj = anchors[j].x, yj = anchors[j].y;
        const intersect = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
    }
    return inside;
  }

  toJSON() {
    return {
      id: this.id,
      type: 'path',
      anchors: this.anchors,
      closed: this.closed,
      ...(this.subpaths.length ? { subpaths: this.subpaths } : {}),
      ...(this.fillRule ? { fillRule: this.fillRule } : {}),
      fill: this.fill,
      stroke: this.stroke,
      strokeWidth: this.strokeWidth,
      opacity: this.opacity,
      rotation: this.rotation,
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height
    };
  }
}

function copyAnchor(a) {
  return { x: a.x, y: a.y, handleIn: a.handleIn ? { ...a.handleIn } : null, handleOut: a.handleOut ? { ...a.handleOut } : null };
}

function outlineToSVG(anchors, closed) {
  if (anchors.length === 0) return '';
  const pt = (p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  const curve = (prev, curr) => ` C ${pt(prev.handleOut || prev)}, ${pt(curr.handleIn || curr)}, ${pt(curr)}`;
  let d = `M ${pt(anchors[0])}`;
  for (let i = 1; i < anchors.length; i++) d += curve(anchors[i - 1], anchors[i]);
  if (closed && anchors.length > 2) d += curve(anchors[anchors.length - 1], anchors[0]) + ' Z';
  return d;
}
