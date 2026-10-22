/**
 * Fill values are either a CSS colour string or a gradient:
 *   { type: 'linear', x1, y1, x2, y2, stops }
 *   { type: 'radial', cx, cy, rx, ry, fx, fy, stops }
 * Geometry is in fractions of the element's own box (unrotated frame), so gradients follow
 * moves, resizes and rotation. stops: [{ offset 0..1, color, opacity 0..1 }].
 */

export function isGradient(fill) {
  return Boolean(fill) && typeof fill === 'object' && (fill.type === 'linear' || fill.type === 'radial') && Array.isArray(fill.stops);
}

/** A single colour standing in for the fill where a gradient can't be used (colour picker, line strokes). */
export function solidColor(fill, fallback = '#000000') {
  if (isGradient(fill)) return fill.stops[0]?.color || fallback;
  return fill || fallback;
}
