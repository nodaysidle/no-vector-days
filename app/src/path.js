import { BezierMath } from './bezier.js';

/**
 * Vector Path Data Model
 * Represents a vector shape composed of Bézier anchors and control handles.
 */
export class VectorPath {
  constructor(options = {}) {
    this.id = options.id || 'path_' + Math.random().toString(36).slice(2, 9);
    this.type = 'path';
    this.anchors = options.anchors ? options.anchors.map(a => ({
      x: a.x,
      y: a.y,
      handleIn: a.handleIn ? { ...a.handleIn } : null,
      handleOut: a.handleOut ? { ...a.handleOut } : null
    })) : [];
    this.closed = Boolean(options.closed);
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

  recomputeBounds() {
    if (this.anchors.length === 0) {
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

    for (let i = 0; i < this.anchors.length; i++) {
      const a = this.anchors[i];
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
    if (this.anchors.length === 0) return '';
    let d = `M ${this.anchors[0].x.toFixed(2)} ${this.anchors[0].y.toFixed(2)}`;

    for (let i = 1; i < this.anchors.length; i++) {
      const prev = this.anchors[i - 1];
      const curr = this.anchors[i];
      const cp1 = prev.handleOut || { x: prev.x, y: prev.y };
      const cp2 = curr.handleIn || { x: curr.x, y: curr.y };

      d += ` C ${cp1.x.toFixed(2)} ${cp1.y.toFixed(2)}, ${cp2.x.toFixed(2)} ${cp2.y.toFixed(2)}, ${curr.x.toFixed(2)} ${curr.y.toFixed(2)}`;
    }

    if (this.closed && this.anchors.length > 2) {
      const prev = this.anchors[this.anchors.length - 1];
      const curr = this.anchors[0];
      const cp1 = prev.handleOut || { x: prev.x, y: prev.y };
      const cp2 = curr.handleIn || { x: curr.x, y: curr.y };
      d += ` C ${cp1.x.toFixed(2)} ${cp1.y.toFixed(2)}, ${cp2.x.toFixed(2)} ${cp2.y.toFixed(2)}, ${curr.x.toFixed(2)} ${curr.y.toFixed(2)} Z`;
    }

    return d;
  }

  /**
   * Hit test for Bézier curves along path segments.
   */
  hitTest(worldX, worldY, tolerance = 8) {
    if (this.anchors.length < 2) return false;

    const count = this.closed ? this.anchors.length : this.anchors.length - 1;
    for (let i = 0; i < count; i++) {
      const p0 = this.anchors[i];
      const p1 = this.anchors[(i + 1) % this.anchors.length];
      const cp1 = p0.handleOut || { x: p0.x, y: p0.y };
      const cp2 = p1.handleIn || { x: p1.x, y: p1.y };

      const dist = BezierMath.distToCubicBezier(worldX, worldY, p0, cp1, cp2, p1);
      if (dist <= Math.max(tolerance, (this.strokeWidth || 2) / 2 + 4)) {
        return true;
      }
    }

    // Inside test for closed path with fill
    if (this.closed && this.fill && this.fill !== 'transparent') {
      return this.pointInPolygon(worldX, worldY);
    }

    return false;
  }

  pointInPolygon(px, py) {
    let inside = false;
    for (let i = 0, j = this.anchors.length - 1; i < this.anchors.length; j = i++) {
      const xi = this.anchors[i].x, yi = this.anchors[i].y;
      const xj = this.anchors[j].x, yj = this.anchors[j].y;
      const intersect = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  toJSON() {
    return {
      id: this.id,
      type: 'path',
      anchors: this.anchors,
      closed: this.closed,
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
