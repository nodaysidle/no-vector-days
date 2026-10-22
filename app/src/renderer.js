/**
 * Canvas2D scene renderer: artboard, shapes, Bézier paths, and editing overlays
 * (hover outline, selection handles, smart guides, pen preview, node editing).
 * Everything is redrawn per frame, so keep per-frame work cheap: no shadowBlur or filters.
 */

import { isGradient, solidColor } from './paint.js';

const WORKSPACE = '#1b1c1f';
const ACCENT = '#3d8bfd'; // selection, handles, pen
const GUIDE = '#f2545b'; // smart guides, distinct from selection
const LABEL = '#8b8f98';
const UI_FONT = 'system-ui, sans-serif';

let colorProbe = null;
/** CSS colour + opacity → a colour string canvas accepts in addColorStop. */
function withAlpha(color, opacity) {
  if (opacity === undefined || opacity >= 1) return color;
  colorProbe ??= document.createElement('canvas').getContext('2d');
  colorProbe.fillStyle = '#000000';
  colorProbe.fillStyle = color;
  const c = colorProbe.fillStyle; // normalised to #rrggbb or rgba(...)
  const alpha = Math.max(0, opacity);
  if (c.startsWith('#')) return `rgba(${parseInt(c.slice(1, 3), 16)}, ${parseInt(c.slice(3, 5), 16)}, ${parseInt(c.slice(5, 7), 16)}, ${alpha})`;
  return c.replace(/rgba?\(([^,]+),([^,]+),([^,)]+)(,[^)]*)?\)/, (_m, r, g, b, a) => `rgba(${r},${g},${b},${alpha * (a ? parseFloat(a.slice(1)) : 1)})`);
}

function addStops(gradient, stops) {
  for (const stop of stops) {
    try {
      gradient.addColorStop(Math.min(1, Math.max(0, stop.offset)), withAlpha(stop.color, stop.opacity));
    } catch {
      // An unparsable stop colour is skipped rather than breaking the whole frame.
    }
  }
  return gradient;
}

export class CanvasRenderer {
  static render(
    ctx,
    width,
    height,
    dpr,
    camera,
    scene,
    marqueeBox = null,
    penPreview = null,
    nodeEditState = null,
    penSnapToOrigin = false,
    smartGuides = [],
    hoverElement = null
  ) {
    // 1. Reset transform to DPR and clear full workspace
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = WORKSPACE;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    // 3. Draw the artboard (Centered at origin -w/2, -h/2)
    const artboard = scene.artboard || { width: 1200, height: 800, background: '#ffffff', title: 'Page 1' };
    this.drawArtboard(ctx, artboard, camera.zoom);

    // 4. Render Scene Elements (inside & on artboard)
    for (const el of scene.elements) this.drawElement(ctx, el);

    // 5. Draw Hover Outline (if element under cursor is not selected)
    if (hoverElement && !scene.selectedIds.has(hoverElement.id)) {
      this.drawHoverOutline(ctx, hoverElement, camera.zoom);
    }

    // 6. Render Pen Tool Path Preview
    if (penPreview && penPreview.anchors && penPreview.anchors.length > 0) {
      this.drawPenPreview(ctx, penPreview, camera.zoom, penSnapToOrigin);
    }

    // 7. Render Node Editing Overlays (if in Node Edit Mode)
    if (nodeEditState && nodeEditState.pathElement) {
      this.drawNodeEditOverlay(ctx, nodeEditState.pathElement, nodeEditState.selectedNode, camera.zoom);
    } else {
      // 8. Render selection box & Transformation Handles
      const selected = scene.getSelectedElements();
      for (const el of selected) {
        if (el.type !== 'path') {
          this.drawSelectionOverlay(ctx, el, camera.zoom);
        } else {
          this.drawPathSelectionOverlay(ctx, el, camera.zoom);
        }
      }
    }

    // 9. Draw smart guides
    if (smartGuides && smartGuides.length > 0) {
      this.drawSmartGuides(ctx, smartGuides, artboard, camera.zoom);
    }

    // 10. Render Marquee Box (if dragging on canvas)
    if (marqueeBox) {
      ctx.strokeStyle = ACCENT;
      ctx.fillStyle = 'rgba(61, 139, 253, 0.08)';
      ctx.lineWidth = 1 / camera.zoom;
      ctx.fillRect(marqueeBox.x, marqueeBox.y, marqueeBox.w, marqueeBox.h);
      ctx.strokeRect(marqueeBox.x, marqueeBox.y, marqueeBox.w, marqueeBox.h);
    }

    ctx.restore();
  }

  static drawArtboard(ctx, artboard, zoom) {
    const w = artboard.width;
    const h = artboard.height;
    const x = -w / 2;
    const y = -h / 2;

    ctx.save();
    ctx.fillStyle = artboard.background || '#ffffff';
    ctx.fillRect(x, y, w, h);
    // Hairline edge so dark page colours stay visible against the workspace.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(x, y, w, h);

    ctx.font = `500 ${12 / zoom}px ${UI_FONT}`;
    ctx.fillStyle = LABEL;
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${artboard.title || 'Page 1'}  ${w} × ${h}`, x, y - 6 / zoom);
    ctx.restore();
  }

  static drawElement(ctx, el) {
    if (el.type === 'path') this.drawPathElement(ctx, el);
    else this.drawBasicElement(ctx, el);
  }

  static drawBasicElement(ctx, el) {
    ctx.save();
    if (el.opacity !== undefined) {
      ctx.globalAlpha = Math.max(0, Math.min(1, el.opacity));
    }

    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;

    ctx.translate(cx, cy);
    if (el.rotation) ctx.rotate(el.rotation);
    ctx.translate(-cx, -cy);

    ctx.strokeStyle = el.stroke || 'transparent';
    ctx.lineWidth = el.strokeWidth || 0;

    const w = el.width;
    const h = el.height;

    if (el.type === 'circle') {
      ctx.beginPath();
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      this.fillShape(ctx, el, '#d0d4db');
      if (el.strokeWidth > 0) ctx.stroke();
    } else if (el.type === 'triangle') {
      ctx.beginPath();
      ctx.moveTo(cx, el.y);
      ctx.lineTo(el.x + w, el.y + h);
      ctx.lineTo(el.x, el.y + h);
      ctx.closePath();
      this.fillShape(ctx, el, '#d0d4db');
      if (el.strokeWidth > 0) ctx.stroke();
    } else if (el.type === 'star') {
      this.drawStarShape(ctx, cx, cy, 5, w / 2, w / 4);
      this.fillShape(ctx, el, '#d0d4db');
      if (el.strokeWidth > 0) ctx.stroke();
    } else if (el.type === 'line' || el.type === 'arrow') {
      ctx.beginPath();
      ctx.moveTo(el.x, cy);
      ctx.lineTo(el.x + w, cy);
      ctx.strokeStyle = el.stroke || solidColor(el.fill, '#1f2328');
      ctx.lineWidth = Math.max(2, el.strokeWidth || 3);
      ctx.lineCap = 'round';
      ctx.stroke();

      if (el.type === 'arrow') {
        const arrowSize = Math.max(8, (el.strokeWidth || 3) * 2.5);
        ctx.beginPath();
        ctx.moveTo(el.x + w, cy);
        ctx.lineTo(el.x + w - arrowSize, cy - arrowSize / 1.5);
        ctx.lineTo(el.x + w - arrowSize, cy + arrowSize / 1.5);
        ctx.closePath();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
      }
    } else if (el.type === 'text') {
      const weight = el.fontWeight || (el.fontSize > 24 ? '700' : '500');
      ctx.font = `${weight} ${el.fontSize || 20}px ${UI_FONT}`;
      ctx.fillStyle = this.paintFor(ctx, el, '#1f2328');
      ctx.textBaseline = 'top';

      // Support multi-line text
      const lines = String(el.text || 'Text').split('\n');
      const lineHeight = (el.fontSize || 20) * 1.25;
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], el.x, el.y + (i * lineHeight));
      }
    } else {
      // Rectangle / Card (with configurable corner radius)
      const radius = Math.min(el.radius ?? 0, w / 2, h / 2);
      ctx.beginPath();
      ctx.roundRect(el.x, el.y, w, h, radius);
      this.fillShape(ctx, el, '#d0d4db');
      if (el.strokeWidth > 0) ctx.stroke();
    }

    ctx.restore();
  }

  static drawStarShape(ctx, cx, cy, spikes, outerRadius, innerRadius) {
    let rot = Math.PI / 2 * 3;
    let step = Math.PI / spikes;

    ctx.beginPath();
    ctx.moveTo(cx, cy - outerRadius);
    for (let i = 0; i < spikes; i++) {
      let x = cx + Math.cos(rot) * outerRadius;
      let y = cy + Math.sin(rot) * outerRadius;
      ctx.lineTo(x, y);
      rot += step;

      x = cx + Math.cos(rot) * innerRadius;
      y = cy + Math.sin(rot) * innerRadius;
      ctx.lineTo(x, y);
      rot += step;
    }
    ctx.lineTo(cx, cy - outerRadius);
    ctx.closePath();
  }

  /**
   * Fills the current path with el.fill. Gradients are placed in the element's box; a radial
   * gradient is drawn in a scaled space so it can be elliptical like SVG's.
   */
  static fillShape(ctx, el, fallback, rule = 'nonzero') {
    const fill = el.fill;
    if (!isGradient(fill)) {
      ctx.fillStyle = fill || fallback;
      ctx.fill(rule);
      return;
    }
    const { x, y, width: w, height: h } = el;
    if (fill.type === 'radial') {
      const rx = Math.max(fill.rx, 1e-6);
      const ry = Math.max(fill.ry, 1e-6);
      ctx.save();
      ctx.translate(x + fill.cx * w, y + fill.cy * h);
      ctx.scale(Math.max(rx * w, 1e-6), Math.max(ry * h, 1e-6));
      ctx.fillStyle = addStops(ctx.createRadialGradient((fill.fx - fill.cx) / rx, (fill.fy - fill.cy) / ry, 0, 0, 0, 1), fill.stops);
      ctx.fill(rule);
      ctx.restore();
      return;
    }
    ctx.fillStyle = this.paintFor(ctx, el, fallback);
    ctx.fill(rule);
  }

  /** A fillStyle without changing the transform (used for text); radial gradients become circular here. */
  static paintFor(ctx, el, fallback) {
    const fill = el.fill;
    if (!isGradient(fill)) return fill || fallback;
    const { x, y, width: w, height: h } = el;
    if (fill.type === 'linear') {
      return addStops(ctx.createLinearGradient(x + fill.x1 * w, y + fill.y1 * h, x + fill.x2 * w, y + fill.y2 * h), fill.stops);
    }
    const r = Math.sqrt(Math.max(fill.rx * w * fill.ry * h, 0));
    return addStops(ctx.createRadialGradient(x + fill.fx * w, y + fill.fy * h, 0, x + fill.cx * w, y + fill.cy * h, Math.max(r, 1e-6)), fill.stops);
  }

  static drawPathElement(ctx, el) {
    if (!el.anchors || el.anchors.length < 2) return;

    ctx.save();
    if (el.opacity !== undefined) {
      ctx.globalAlpha = Math.max(0, Math.min(1, el.opacity));
    }

    ctx.beginPath();
    const curve = (prev, curr) => {
      const cp1 = prev.handleOut || prev;
      const cp2 = curr.handleIn || curr;
      ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, curr.x, curr.y);
    };
    for (const { anchors, closed } of el.outlines()) {
      if (anchors.length === 0) continue;
      ctx.moveTo(anchors[0].x, anchors[0].y);
      for (let i = 1; i < anchors.length; i++) curve(anchors[i - 1], anchors[i]);
      if (closed && anchors.length > 2) {
        curve(anchors[anchors.length - 1], anchors[0]);
        ctx.closePath();
      }
    }

    if (el.fill && el.fill !== 'transparent' && el.closed) {
      this.fillShape(ctx, el, 'transparent', el.fillRule || 'nonzero');
    }

    if (el.stroke && el.stroke !== 'transparent') {
      ctx.strokeStyle = el.stroke;
      ctx.lineWidth = el.strokeWidth || 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    ctx.restore();
  }

  /** Applies the element's rotation about its centre so overlays follow rotated shapes. */
  static rotateAbout(ctx, el) {
    if (!el.rotation || el.type === 'path') return;
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate(el.rotation);
    ctx.translate(-cx, -cy);
  }

  static drawHoverOutline(ctx, el, zoom) {
    ctx.save();
    this.rotateAbout(ctx, el);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(el.x, el.y, el.width, el.height);
    ctx.restore();
  }

  static drawSelectionOverlay(ctx, el, zoom) {
    ctx.save();
    this.rotateAbout(ctx, el);
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;

    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(el.x, el.y, el.width, el.height);

    // Rotation handle sits where HitTester.hitTestHandles looks for 'rot' (24px above the top edge).
    const rotY = el.y - 24 / zoom;
    ctx.beginPath();
    ctx.moveTo(cx, el.y);
    ctx.lineTo(cx, rotY);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, rotY, 4 / zoom, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.stroke();

    // Square resize handles on corners and edge midpoints.
    const size = 8 / zoom;
    const points = [
      [el.x, el.y], [cx, el.y], [el.x + el.width, el.y],
      [el.x, cy], [el.x + el.width, cy],
      [el.x, el.y + el.height], [cx, el.y + el.height], [el.x + el.width, el.y + el.height]
    ];
    for (const [px, py] of points) {
      ctx.fillRect(px - size / 2, py - size / 2, size, size);
      ctx.strokeRect(px - size / 2, py - size / 2, size, size);
    }
    ctx.restore();

    // Size readout stays upright, below the rotated box and clear of the rotation handle.
    ctx.save();
    const rot = el.type === 'path' ? 0 : el.rotation || 0;
    const halfH = (Math.abs(el.width * Math.sin(rot)) + Math.abs(el.height * Math.cos(rot))) / 2;
    const handleY = cy - (el.height / 2 + 24 / zoom) * Math.cos(rot) + 4 / zoom;
    const dimText = `${Math.round(el.width)} × ${Math.round(el.height)}`;
    ctx.font = `500 ${11 / zoom}px ${UI_FONT}`;
    const padX = 5 / zoom;
    const dimW = ctx.measureText(dimText).width + padX * 2;
    const dimH = 16 / zoom;
    const dimY = Math.max(cy + halfH, handleY) + 8 / zoom;
    ctx.fillStyle = ACCENT;
    ctx.fillRect(cx - dimW / 2, dimY, dimW, dimH);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(dimText, cx, dimY + dimH / 2);
    ctx.restore();
  }

  static drawPathSelectionOverlay(ctx, el, zoom) {
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(el.x, el.y, el.width, el.height);
    ctx.restore();
  }

  static drawSmartGuides(ctx, smartGuides, artboard, zoom) {
    ctx.save();
    ctx.strokeStyle = GUIDE;
    ctx.fillStyle = GUIDE;
    ctx.lineWidth = 1 / zoom;

    for (const guide of smartGuides) {
      if (guide.type === 'x') {
        ctx.beginPath();
        ctx.moveTo(guide.value, -artboard.height);
        ctx.lineTo(guide.value, artboard.height);
        ctx.stroke();
        if (guide.snapY !== undefined) this.drawDiamondMarker(ctx, guide.value, guide.snapY, 3 / zoom);
      } else if (guide.type === 'y') {
        ctx.beginPath();
        ctx.moveTo(-artboard.width, guide.value);
        ctx.lineTo(artboard.width, guide.value);
        ctx.stroke();
        if (guide.snapX !== undefined) this.drawDiamondMarker(ctx, guide.snapX, guide.value, 3 / zoom);
      }
    }

    ctx.restore();
  }

  static drawDiamondMarker(ctx, x, y, size) {
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x + size, y);
    ctx.lineTo(x, y + size);
    ctx.lineTo(x - size, y);
    ctx.closePath();
    ctx.fill();
  }

  static drawPenPreview(ctx, preview, zoom, snapToOrigin = false) {
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = preview.strokeWidth || 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    this.drawPathElement(ctx, preview);

    for (let i = 0; i < preview.anchors.length; i++) {
      const a = preview.anchors[i];
      const size = 7 / zoom;

      if (i === 0) {
        ctx.fillStyle = snapToOrigin ? ACCENT : '#ffffff';
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = (snapToOrigin ? 2.5 : 1.5) / zoom;
        const s = snapToOrigin ? size * 1.5 : size;
        ctx.beginPath();
        ctx.rect(a.x - s / 2, a.y - s / 2, s, s);
        ctx.fill();
        ctx.stroke();

        if (snapToOrigin) {
          ctx.beginPath();
          ctx.arc(a.x, a.y, 11 / zoom, 0, Math.PI * 2);
          ctx.strokeStyle = ACCENT;
          ctx.lineWidth = 1.5 / zoom;
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5 / zoom;
        ctx.beginPath();
        ctx.rect(a.x - size / 2, a.y - size / 2, size, size);
        ctx.fill();
        ctx.stroke();
      }

      if (a.handleOut) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.handleOut.x, a.handleOut.y);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1 / zoom;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(a.handleOut.x, a.handleOut.y, 4 / zoom, 0, Math.PI * 2);
        ctx.fillStyle = ACCENT;
        ctx.fill();
      }
    }

    ctx.restore();
  }

  static drawNodeEditOverlay(ctx, pathEl, selectedNode, zoom) {
    ctx.save();
    const handleRadius = 4.5 / zoom;
    const anchorSize = 7.5 / zoom;

    for (let i = 0; i < pathEl.anchors.length; i++) {
      const a = pathEl.anchors[i];
      const isAnchorSelected = selectedNode && selectedNode.target === 'anchor' && selectedNode.index === i;

      if (a.handleIn) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.handleIn.x, a.handleIn.y);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1 / zoom;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(a.handleIn.x, a.handleIn.y, handleRadius, 0, Math.PI * 2);
        ctx.fillStyle = (selectedNode && selectedNode.target === 'handleIn' && selectedNode.index === i) ? '#ffffff' : ACCENT;
        ctx.fill();
        ctx.stroke();
      }

      if (a.handleOut) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.handleOut.x, a.handleOut.y);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1 / zoom;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(a.handleOut.x, a.handleOut.y, handleRadius, 0, Math.PI * 2);
        ctx.fillStyle = (selectedNode && selectedNode.target === 'handleOut' && selectedNode.index === i) ? '#ffffff' : ACCENT;
        ctx.fill();
        ctx.stroke();
      }

      ctx.fillStyle = isAnchorSelected ? ACCENT : '#ffffff';
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.75 / zoom;
      ctx.fillRect(a.x - anchorSize / 2, a.y - anchorSize / 2, anchorSize, anchorSize);
      ctx.strokeRect(a.x - anchorSize / 2, a.y - anchorSize / 2, anchorSize, anchorSize);
    }

    ctx.restore();
  }
}
