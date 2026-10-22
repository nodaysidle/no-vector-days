/**
 * Hit Testing Engine
 * Calculates whether a point in World Space hits an element, handles, or vector path nodes.
 */

export class HitTester {
  /**
   * Transforms a world point into the element's local unrotated coordinate space.
   */
  static worldToLocal(worldX, worldY, el) {
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const rad = el.rotation || 0;

    const dx = worldX - cx;
    const dy = worldY - cy;

    const cos = Math.cos(-rad);
    const sin = Math.sin(-rad);

    return {
      x: cx + (dx * cos - dy * sin),
      y: cy + (dx * sin + dy * cos)
    };
  }

  /**
   * Checks if a point hits an element's bounding geometry or path curve.
   */
  static hitTestElement(worldX, worldY, el) {
    if (el.type === 'path' && typeof el.hitTest === 'function') {
      return el.hitTest(worldX, worldY);
    }

    const local = this.worldToLocal(worldX, worldY, el);
    return (
      local.x >= el.x &&
      local.x <= el.x + el.width &&
      local.y >= el.y &&
      local.y <= el.y + el.height
    );
  }

  /**
   * Finds the topmost element hit by a world coordinate (reverse z-order).
   */
  static hitTestScene(worldX, worldY, elements) {
    for (let i = elements.length - 1; i >= 0; i--) {
      if (this.hitTestElement(worldX, worldY, elements[i])) {
        return elements[i];
      }
    }
    return null;
  }

  /**
   * Checks if a point hits one of the selected element's transformation handles.
   * Handles: 'tl', 'tr', 'br', 'bl', 'rot'
   */
  static hitTestHandles(worldX, worldY, el, zoom, handleRadius = 8) {
    const tol = handleRadius / zoom;
    const local = this.worldToLocal(worldX, worldY, el);
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;

    const handles = {
      tl: { x: el.x, y: el.y },
      tr: { x: el.x + el.width, y: el.y },
      br: { x: el.x + el.width, y: el.y + el.height },
      bl: { x: el.x, y: el.y + el.height },
      t: { x: cx, y: el.y },
      b: { x: cx, y: el.y + el.height },
      l: { x: el.x, y: cy },
      r: { x: el.x + el.width, y: cy },
      rot: { x: cx, y: el.y - 24 / zoom }
    };

    for (const [key, pos] of Object.entries(handles)) {
      const dist = Math.hypot(local.x - pos.x, local.y - pos.y);
      if (dist <= tol) {
        return key;
      }
    }

    return null;
  }

  /**
   * Checks if a point hits any anchor or Bézier control handle in a vector path.
   */
  static hitTestPathNodes(worldX, worldY, pathEl, zoom, handleRadius = 7) {
    if (!pathEl || pathEl.type !== 'path' || !pathEl.anchors) return null;
    const tol = handleRadius / zoom;

    // Check handles first (higher priority for fine tuning)
    for (let i = 0; i < pathEl.anchors.length; i++) {
      const a = pathEl.anchors[i];
      if (a.handleIn && Math.hypot(worldX - a.handleIn.x, worldY - a.handleIn.y) <= tol) {
        return { target: 'handleIn', index: i };
      }
      if (a.handleOut && Math.hypot(worldX - a.handleOut.x, worldY - a.handleOut.y) <= tol) {
        return { target: 'handleOut', index: i };
      }
    }

    // Check anchors
    for (let i = 0; i < pathEl.anchors.length; i++) {
      const a = pathEl.anchors[i];
      if (Math.hypot(worldX - a.x, worldY - a.y) <= tol) {
        return { target: 'anchor', index: i };
      }
    }

    return null;
  }
}
