/**
 * Pure Mathematical Bézier Curve Engine
 * Cubic and Quadratic Bézier evaluation, bounding boxes, and hit detection.
 */

export class BezierMath {
  /**
   * Evaluates a point on a cubic Bézier curve at parameter t [0, 1].
   */
  static evalCubic(p0, cp1, cp2, p1, t) {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    const t2 = t * t;
    const t3 = t2 * t;

    return {
      x: mt3 * p0.x + 3 * mt2 * t * cp1.x + 3 * mt * t2 * cp2.x + t3 * p1.x,
      y: mt3 * p0.y + 3 * mt2 * t * cp1.y + 3 * mt * t2 * cp2.y + t3 * p1.y
    };
  }

  /**
   * Evaluates a point on a quadratic Bézier curve at parameter t [0, 1].
   */
  static evalQuad(p0, cp, p1, t) {
    const mt = 1 - t;
    return {
      x: mt * mt * p0.x + 2 * mt * t * cp.x + t * t * p1.x,
      y: mt * mt * p0.y + 2 * mt * t * cp.y + t * t * p1.y
    };
  }

  /**
   * Distance from point (px, py) to a line segment (x1, y1) -> (x2, y2).
   */
  static distToSegment(px, py, x1, y1, x2, y2) {
    const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
  }

  /**
   * Distance from point (px, py) to a cubic Bézier curve via adaptive sampling.
   */
  static distToCubicBezier(px, py, p0, cp1, cp2, p1, samples = 20) {
    let minDist = Infinity;
    let prev = p0;

    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      const curr = this.evalCubic(p0, cp1, cp2, p1, t);
      const d = this.distToSegment(px, py, prev.x, prev.y, curr.x, curr.y);
      if (d < minDist) minDist = d;
      prev = curr;
    }
    return minDist;
  }

  /**
   * Computes tight bounding box for a cubic Bézier segment.
   */
  static cubicBoundingBox(p0, cp1, cp2, p1) {
    let minX = Math.min(p0.x, p1.x);
    let maxX = Math.max(p0.x, p1.x);
    let minY = Math.min(p0.y, p1.y);
    let maxY = Math.max(p0.y, p1.y);

    // Derivative roots for extrema
    const getRoots = (v0, v1, v2, v3) => {
      const a = 3 * (-v0 + 3 * v1 - 3 * v2 + v3);
      const b = 6 * (v0 - 2 * v1 + v2);
      const c = 3 * (v1 - v0);
      const roots = [];
      if (Math.abs(a) < 1e-6) {
        if (Math.abs(b) > 1e-6) {
          const t = -c / b;
          if (t > 0 && t < 1) roots.push(t);
        }
      } else {
        const disc = b * b - 4 * a * c;
        if (disc >= 0) {
          const sq = Math.sqrt(disc);
          const t1 = (-b + sq) / (2 * a);
          const t2 = (-b - sq) / (2 * a);
          if (t1 > 0 && t1 < 1) roots.push(t1);
          if (t2 > 0 && t2 < 1) roots.push(t2);
        }
      }
      return roots;
    };

    const xRoots = getRoots(p0.x, cp1.x, cp2.x, p1.x);
    for (const t of xRoots) {
      const p = this.evalCubic(p0, cp1, cp2, p1, t);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }

    const yRoots = getRoots(p0.y, cp1.y, cp2.y, p1.y);
    for (const t of yRoots) {
      const p = this.evalCubic(p0, cp1, cp2, p1, t);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }

    return { minX, minY, maxX, maxY };
  }
}
