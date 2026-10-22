/**
 * Canvas interaction engine
 * - Artboard viewport management with auto-centering and Fit-to-Screen
 * - Direct in-canvas inline text editing (no modal prompt)
 * - Smart guides (magnetic snapping to artboard center/edges and neighbor elements)
 * - Comprehensive transformation handles: 4 corners, 4 edges, rotation stalk
 * - Double-click path node editing, multi-element alignment, duplicate, and layer reordering
 * - 120Hz high-DPI Wayland rendering loop
 */

import { Camera } from './camera.js';
import { SceneGraph } from './scene.js';
import { HitTester } from './hittest.js';
import { History } from './history.js';
import { CanvasRenderer } from './renderer.js';
import { VectorPath } from './path.js';
import { WebGLShaderPipeline } from './webgl-pipeline.js';
import { solidColor } from './paint.js';

// Tools that place one element of their type where the canvas is clicked.
export const SHAPE_TOOLS = { RECT: 'rect', CIRCLE: 'circle', TRIANGLE: 'triangle', STAR: 'star', LINE: 'line', ARROW: 'arrow', TEXT: 'text' };

export class CanvasEngine {
  constructor(canvasElement, glCanvasElement = null) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.glCanvas = glCanvasElement;

    // WebGL Multi-pass shader pipeline
    this.webglPipeline = glCanvasElement ? new WebGLShaderPipeline(glCanvasElement) : null;
    if (this.webglPipeline && !this.webglPipeline.isSupported) this.disableWebGL();
    if (this.glCanvas) {
      this.glCanvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.disableWebGL();
      });
    }

    this.camera = new Camera();
    this.scene = new SceneGraph();
    this.history = new History();

    // Interaction Modes: 'IDLE' | 'DRAGGING' | 'RESIZING' | 'ROTATING' | 'PANNING' | 'MARQUEE' | 'PEN_DRAW' | 'NODE_DRAG'
    this.mode = 'IDLE';
    this.activeTool = 'SELECT'; // 'SELECT' | 'NODE_EDIT' | 'PEN' | any key of SHAPE_TOOLS

    // Drag & transform tracking
    this.dragStart = { x: 0, y: 0 };
    this.dragWorldStart = { x: 0, y: 0 };
    this.activeHandle = null;
    this.initialTransformState = null;
    this.marqueeBox = null;
    this.isSpacePressed = false;

    // Smart guides
    this.smartGuides = [];
    this.hoverElement = null;

    // Bézier Pen Tool State
    this.currentPath = null;
    this.activeAnchorIndex = -1;
    this.penSnapToOrigin = false;

    // Node Editing Tool State
    this.editingPath = null;
    this.selectedNode = null;
    this.initialNodeState = null;

    // Inline Text Editor
    this._inlineEditor = null;
    this._initializedCamera = false;

    // State change callback for UI
    this.onStateChange = null;

    this.bindEvents();
    this.resize();
  }

  setTool(tool) {
    this.activeTool = tool;

    if (tool !== 'PEN' && this.currentPath) {
      this.finishCurrentPath();
    }

    if (tool !== 'NODE_EDIT') {
      this.editingPath = null;
      this.selectedNode = null;
    }

    if (this.mode !== 'IDLE') {
      this.mode = 'IDLE';
    }

    this.notifyState();
    this.requestRender();
  }

  /** Drops the shader overlay so the plain 2D canvas is shown (WebGL unavailable, lost, or failing). */
  disableWebGL() {
    this.webglPipeline = null;
    if (this.glCanvas) this.glCanvas.style.display = 'none';
    this.requestRender();
  }

  setShaderPreset(presetName) {
    if (this.webglPipeline) {
      this.webglPipeline.setPreset(presetName);
      this.notifyState();
      this.requestRender();
    }
  }

  setShaderParam(name, value) {
    if (this.webglPipeline && this.webglPipeline.params[name] !== undefined) {
      this.webglPipeline.params[name] = value;
      this.requestRender();
    }
  }

  fitToScreen() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.camera.fitToArtboard(this.scene.artboard, w, h, 80);
    this.notifyState();
    this.requestRender();
  }

  bindEvents() {
    this.canvas.addEventListener('pointerdown', this.onPointerDown.bind(this));
    window.addEventListener('pointermove', this.onPointerMove.bind(this));
    window.addEventListener('pointerup', this.onPointerUp.bind(this));
    this.canvas.addEventListener('dblclick', this.onDoubleClick.bind(this));
    this.canvas.addEventListener('wheel', this.onWheel.bind(this), { passive: false });
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());

    // Window blur event to prevent stuck spacebar / pan mode on workspace switch
    window.addEventListener('blur', () => {
      this.isSpacePressed = false;
      if (this.mode === 'PANNING') {
        this.mode = 'IDLE';
        this.canvas.style.cursor = 'default';
        this.requestRender();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (this._inlineEditor) return;

      if (e.code === 'Space') {
        this.isSpacePressed = true;
        if (this.mode === 'IDLE') this.canvas.style.cursor = 'grab';
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
          this.deleteSelected();
          e.preventDefault();
        }
      }

      if (e.key === 'Escape' || e.key === 'Enter') {
        if (this.activeTool === 'PEN') {
          this.finishCurrentPath();
        } else if (e.key === 'Escape' && this.activeTool !== 'SELECT') {
          this.setTool('SELECT');
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) this.redo();
        else this.undo();
        e.preventDefault();
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        this.redo();
        e.preventDefault();
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        this.duplicateSelected();
        e.preventDefault();
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === '0' || e.key === '=' || e.key === '+')) {
        this.fitToScreen();
        e.preventDefault();
      }

      if (!e.ctrlKey && !e.metaKey && !e.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        if (e.key.toLowerCase() === 'v') this.setTool('SELECT');
        if (e.key.toLowerCase() === 'a') this.setTool('NODE_EDIT');
        if (e.key.toLowerCase() === 'p') this.setTool('PEN');
        if (e.key.toLowerCase() === 'r') this.setTool('RECT');
        if (e.key.toLowerCase() === 'o') this.setTool('CIRCLE');
        if (e.key.toLowerCase() === 't') this.setTool('TEXT');
        if (e.key.toLowerCase() === 'l') this.setTool('LINE');
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.isSpacePressed = false;
        if (this.mode === 'IDLE') this.canvas.style.cursor = 'default';
      }
    });

    window.addEventListener('resize', () => this.resize());
    // Layout changes (drawer toggle, window snap) resize the canvas without a window resize event.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.resize()).observe(this.canvas);
    }
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;

    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);

    if (this.glCanvas) {
      this.glCanvas.width = Math.round(w * dpr);
      this.glCanvas.height = Math.round(h * dpr);
      if (this.webglPipeline) {
        this.webglPipeline.resize(Math.round(w * dpr), Math.round(h * dpr));
      }
    }

    if (!this._initializedCamera && w > 0 && h > 0) {
      this._initializedCamera = true;
      this.camera.fitToArtboard(this.scene.artboard, w, h, 80);
    }

    this.requestRender();
  }

  onDoubleClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const world = this.camera.screenToWorld(screenX, screenY);

    const hit = HitTester.hitTestScene(world.x, world.y, this.scene.elements);
    if (hit) {
      if (hit.type === 'text') {
        this.startInlineTextEdit(hit);
      } else if (hit.type === 'path') {
        this.setTool('NODE_EDIT');
        this.editingPath = hit;
        this.scene.select(hit.id);
        this.notifyState();
        this.requestRender();
      }
    }
  }

  startInlineTextEdit(textEl) {
    if (!textEl || textEl.type !== 'text') return;

    if (this._inlineEditor) {
      this._inlineEditor.remove();
      this._inlineEditor = null;
    }

    const screenPos = this.camera.worldToScreen(textEl.x, textEl.y);

    const textarea = document.createElement('textarea');
    textarea.className = 'canva-inline-text-editor';
    textarea.value = textEl.text || '';
    textarea.style.position = 'absolute';
    textarea.style.left = `${screenPos.x}px`;
    textarea.style.top = `${screenPos.y}px`;
    textarea.style.minWidth = `${Math.max(160, textEl.width * this.camera.zoom)}px`;
    textarea.style.minHeight = `${Math.max(48, textEl.height * this.camera.zoom)}px`;
    textarea.style.fontSize = `${(textEl.fontSize || 24) * this.camera.zoom}px`;
    textarea.style.color = solidColor(textEl.fill, '#1f2328');
    textarea.style.fontFamily = 'system-ui, sans-serif';
    textarea.style.fontWeight = textEl.fontWeight || (textEl.fontSize > 24 ? '700' : '500');
    textarea.style.background = this.scene.artboard.background || '#ffffff';
    textarea.style.border = '1px solid #3d8bfd';
    textarea.style.borderRadius = '2px';
    textarea.style.padding = '0';
    textarea.style.lineHeight = '1.25';
    textarea.style.resize = 'none';
    textarea.style.zIndex = '100';
    textarea.style.outline = 'none';

    const commit = () => {
      if (!this._inlineEditor) return;
      const oldText = textEl.text;
      const newText = textarea.value.trim() || 'Text';
      textEl.text = newText;
      textEl.width = Math.max(60, textarea.offsetWidth / this.camera.zoom);
      textEl.height = Math.max(30, textarea.offsetHeight / this.camera.zoom);

      if (oldText !== newText) {
        this.history.push({
          undo: () => { textEl.text = oldText; this.requestRender(); },
          redo: () => { textEl.text = newText; this.requestRender(); }
        });
      }

      textarea.remove();
      this._inlineEditor = null;
      this.notifyState();
      this.requestRender();
    };

    textarea.addEventListener('blur', commit);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        textarea.blur();
      }
      if (e.key === 'Escape') {
        textarea.value = textEl.text;
        textarea.blur();
      }
    });

    this.canvas.parentElement.appendChild(textarea);
    textarea.focus();
    textarea.select();
    this._inlineEditor = textarea;
  }

  onPointerDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const world = this.camera.screenToWorld(screenX, screenY);

    this.dragStart = { x: screenX, y: screenY };
    this.dragWorldStart = { x: world.x, y: world.y };

    if (e.button === 1 || e.button === 2 || this.isSpacePressed) {
      this.mode = 'PANNING';
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    if (this.activeTool === 'PEN') {
      this.handlePenPointerDown(world);
      return;
    }

    if (this.activeTool === 'NODE_EDIT') {
      this.handleNodeEditPointerDown(world);
      return;
    }

    if (SHAPE_TOOLS[this.activeTool]) {
      const el = this.addElement(SHAPE_TOOLS[this.activeTool]);
      // Centre on the click; the undo entry holds this same object, so redo keeps the position.
      el.x = world.x - el.width / 2;
      el.y = world.y - el.height / 2;
      this.setTool('SELECT');
      this.scene.select(el.id);
      return;
    }

    // Check transformation handles on selected element
    const selected = this.scene.getSelectedElements()[0];
    if (selected && selected.type !== 'path') {
      const handle = HitTester.hitTestHandles(world.x, world.y, selected, this.camera.zoom);
      if (handle) {
        this.mode = handle === 'rot' ? 'ROTATING' : 'RESIZING';
        this.activeHandle = handle;
        this.initialTransformState = {
          x: selected.x,
          y: selected.y,
          width: selected.width,
          height: selected.height,
          rotation: selected.rotation || 0
        };
        return;
      }
    }

    // Hit test scene objects
    const hit = HitTester.hitTestScene(world.x, world.y, this.scene.elements);
    if (hit) {
      // Clicking an already-selected layer keeps the selection so the whole group drags.
      if (e.shiftKey || !this.scene.selectedIds.has(hit.id)) this.scene.select(hit.id, e.shiftKey);
      this.mode = 'DRAGGING';
      this.dragLead = hit;
      this.dragOrigins = this.scene.getSelectedElements().map(el => ({ el, x: el.x, y: el.y }));
      this.initialTransformState = { x: hit.x, y: hit.y };
      this.canvas.style.cursor = 'move';
      if (hit.type === 'path') {
        this.editingPath = hit;
      }
    } else {
      if (!e.shiftKey) this.scene.clearSelection();
      this.marqueeBaseSelection = new Set(this.scene.selectedIds);
      this.mode = 'MARQUEE';
      this.marqueeBox = { x: world.x, y: world.y, w: 0, h: 0 };
    }

    this.notifyState();
    this.requestRender();
  }

  handlePenPointerDown(world) {
    if (!this.currentPath) {
      this.currentPath = new VectorPath({
        stroke: '#1f2328',
        strokeWidth: 2,
        closed: false
      });
      this.currentPath.addAnchor(world.x, world.y);
      this.activeAnchorIndex = 0;
      this.mode = 'PEN_DRAW';
    } else {
      const firstAnchor = this.currentPath.anchors[0];
      const distToFirst = Math.hypot(world.x - firstAnchor.x, world.y - firstAnchor.y);
      const closeTol = 14 / this.camera.zoom;

      if (this.currentPath.anchors.length >= 2 && distToFirst <= closeTol) {
        this.currentPath.closed = true;
        this.finishCurrentPath();
        return;
      }

      this.currentPath.addAnchor(world.x, world.y);
      this.activeAnchorIndex = this.currentPath.anchors.length - 1;
      this.mode = 'PEN_DRAW';
    }

    this.requestRender();
  }

  handleNodeEditPointerDown(world) {
    if (!this.editingPath) {
      const hit = HitTester.hitTestScene(world.x, world.y, this.scene.elements);
      if (hit && hit.type === 'path') {
        this.editingPath = hit;
        this.scene.select(hit.id);
      } else {
        return;
      }
    }

    const nodeHit = HitTester.hitTestPathNodes(world.x, world.y, this.editingPath, this.camera.zoom);
    if (nodeHit) {
      this.selectedNode = nodeHit;
      this.mode = 'NODE_DRAG';
      const a = this.editingPath.anchors[nodeHit.index];
      this.initialNodeState = {
        anchor: { ...a },
        handleIn: a.handleIn ? { ...a.handleIn } : null,
        handleOut: a.handleOut ? { ...a.handleOut } : null
      };
      this.requestRender();
      return;
    }

    this.selectedNode = null;
    this.requestRender();
  }

  onPointerMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const world = this.camera.screenToWorld(screenX, screenY);

    const dx = (screenX - this.dragStart.x) / this.camera.zoom;
    const dy = (screenY - this.dragStart.y) / this.camera.zoom;

    if (this.mode === 'PANNING') {
      this.camera.pan(screenX - this.dragStart.x, screenY - this.dragStart.y);
      this.dragStart = { x: screenX, y: screenY };
      this.requestRender();
      return;
    }

    if (this.mode === 'PEN_DRAW' && this.currentPath) {
      const a = this.currentPath.anchors[this.activeAnchorIndex];
      if (a) {
        a.handleOut = { x: world.x, y: world.y };
        const mirrorDx = a.x - world.x;
        const mirrorDy = a.y - world.y;
        a.handleIn = { x: a.x + mirrorDx, y: a.y + mirrorDy };
        this.currentPath.recomputeBounds();
        this.requestRender();
      }
      return;
    }

    // Check Pen Tool Origin Snap Hover
    if (this.activeTool === 'PEN' && this.currentPath && this.currentPath.anchors.length >= 2) {
      const firstAnchor = this.currentPath.anchors[0];
      const dist = Math.hypot(world.x - firstAnchor.x, world.y - firstAnchor.y);
      const closeTol = 14 / this.camera.zoom;
      const shouldSnap = dist <= closeTol;
      if (shouldSnap !== this.penSnapToOrigin) {
        this.penSnapToOrigin = shouldSnap;
        this.requestRender();
      }
    } else if (this.penSnapToOrigin) {
      this.penSnapToOrigin = false;
      this.requestRender();
    }

    if (this.mode === 'NODE_DRAG' && this.editingPath && this.selectedNode) {
      const idx = this.selectedNode.index;
      const target = this.selectedNode.target;
      const anchor = this.editingPath.anchors[idx];

      if (target === 'anchor') {
        const deltaX = world.x - anchor.x;
        const deltaY = world.y - anchor.y;
        anchor.x = world.x;
        anchor.y = world.y;
        if (anchor.handleIn) { anchor.handleIn.x += deltaX; anchor.handleIn.y += deltaY; }
        if (anchor.handleOut) { anchor.handleOut.x += deltaX; anchor.handleOut.y += deltaY; }
      } else if (target === 'handleOut') {
        anchor.handleOut = { x: world.x, y: world.y };
      } else if (target === 'handleIn') {
        anchor.handleIn = { x: world.x, y: world.y };
      }

      this.editingPath.recomputeBounds();
      this.requestRender();
      return;
    }

    if (this.mode === 'DRAGGING') {
      if (this.dragLead) {
        // Snap the layer under the cursor to page and neighbour edges, then move the rest of the selection by the same offset.
        const start = this.initialTransformState;
        const snap = this.computeSnap(this.dragLead, start.x + dx, start.y + dy);
        this.smartGuides = snap.guides;
        for (const o of this.dragOrigins) {
          this.moveElementTo(o.el, o.x + snap.x - start.x, o.y + snap.y - start.y);
        }
        this.requestRender();
      }
      return;
    }

    if (this.mode === 'RESIZING') {
      const selected = this.scene.getSelectedElements()[0];
      if (selected && this.initialTransformState) {
        const init = this.initialTransformState;
        // Handle direction per axis: -1 = left/top edge, +1 = right/bottom edge, 0 = untouched.
        const h = this.activeHandle;
        const sx = h.includes('l') ? -1 : h.includes('r') ? 1 : 0;
        const sy = h.includes('t') ? -1 : h.includes('b') ? 1 : 0;

        // Work in the element's rotated frame so handles follow the box, then keep the opposite edge fixed.
        const cos = Math.cos(init.rotation);
        const sin = Math.sin(init.rotation);
        const localDx = dx * cos + dy * sin;
        const localDy = -dx * sin + dy * cos;
        const width = Math.max(20, init.width + sx * localDx);
        const height = Math.max(20, init.height + sy * localDy);
        const shiftX = (sx * (width - init.width)) / 2;
        const shiftY = (sy * (height - init.height)) / 2;
        const cx = init.x + init.width / 2 + shiftX * cos - shiftY * sin;
        const cy = init.y + init.height / 2 + shiftX * sin + shiftY * cos;

        selected.width = width;
        selected.height = height;
        selected.x = cx - width / 2;
        selected.y = cy - height / 2;
        this.requestRender();
      }
      return;
    }

    if (this.mode === 'ROTATING') {
      const selected = this.scene.getSelectedElements()[0];
      if (selected) {
        const cx = selected.x + selected.width / 2;
        const cy = selected.y + selected.height / 2;
        let angle = Math.atan2(world.y - cy, world.x - cx) + Math.PI / 2;
        if (e.shiftKey) {
          const step = Math.PI / 12; // 15°
          angle = Math.round(angle / step) * step;
        }
        selected.rotation = angle;
        this.requestRender();
      }
      return;
    }

    if (this.mode === 'MARQUEE') {
      this.marqueeBox = {
        x: Math.min(this.dragWorldStart.x, world.x),
        y: Math.min(this.dragWorldStart.y, world.y),
        w: Math.abs(world.x - this.dragWorldStart.x),
        h: Math.abs(world.y - this.dragWorldStart.y)
      };

      // Rebuild from the pre-drag selection so shrinking the box deselects again.
      this.scene.selectedIds = new Set(this.marqueeBaseSelection);
      for (const el of this.scene.elements) {
        const inside = (
          el.x >= this.marqueeBox.x &&
          el.x + el.width <= this.marqueeBox.x + this.marqueeBox.w &&
          el.y >= this.marqueeBox.y &&
          el.y + el.height <= this.marqueeBox.y + this.marqueeBox.h
        );
        if (inside) this.scene.select(el.id, true);
      }
      this.requestRender();
      return;
    }

    // Hover Cursor & Element Feedback
    if (this.mode === 'IDLE') {
      const hit = HitTester.hitTestScene(world.x, world.y, this.scene.elements);
      if (hit !== this.hoverElement) {
        this.hoverElement = hit;
        this.requestRender();
      }

      if (this.activeTool === 'PEN') {
        this.canvas.style.cursor = this.penSnapToOrigin ? 'pointer' : 'crosshair';
      } else if (this.activeTool === 'NODE_EDIT') {
        this.canvas.style.cursor = 'pointer';
      } else {
        const selected = this.scene.getSelectedElements()[0];
        if (selected && selected.type !== 'path') {
          const handle = HitTester.hitTestHandles(world.x, world.y, selected, this.camera.zoom);
          if (handle) {
            if (handle === 'rot') this.canvas.style.cursor = 'crosshair';
            else if (handle === 'r' || handle === 'l') this.canvas.style.cursor = 'ew-resize';
            else if (handle === 't' || handle === 'b') this.canvas.style.cursor = 'ns-resize';
            else this.canvas.style.cursor = 'nwse-resize';
            return;
          }
        }
        this.canvas.style.cursor = hit ? 'move' : (this.isSpacePressed ? 'grab' : 'default');
      }
    }
  }

  /** Moves an element's top-left to (x, y); paths translate their anchors since their bounds derive from them. */
  moveElementTo(el, x, y) {
    if (el.type === 'path' && el.anchors) {
      el.translate(x - el.x, y - el.y);
    } else {
      el.x = x;
      el.y = y;
    }
  }

  computeSnap(selected, targetX, targetY) {
    const snapTol = 8 / this.camera.zoom;
    const artboard = this.scene.artboard;
    const guides = [];

    let snappedX = targetX;
    let snappedY = targetY;

    const w = selected.width;
    const h = selected.height;
    const cx = targetX + w / 2;
    const cy = targetY + h / 2;
    const r = targetX + w;
    const b = targetY + h;

    // Snapping Targets
    const xTargets = [
      { val: 0, desc: 'center' },
      { val: -artboard.width / 2, desc: 'left' },
      { val: artboard.width / 2, desc: 'right' }
    ];
    const yTargets = [
      { val: 0, desc: 'center' },
      { val: -artboard.height / 2, desc: 'top' },
      { val: artboard.height / 2, desc: 'bottom' }
    ];

    for (const el of this.scene.elements) {
      if (this.scene.selectedIds.has(el.id)) continue; // selected layers move together
      xTargets.push({ val: el.x, desc: 'el_left' });
      xTargets.push({ val: el.x + el.width / 2, desc: 'el_center' });
      xTargets.push({ val: el.x + el.width, desc: 'el_right' });

      yTargets.push({ val: el.y, desc: 'el_top' });
      yTargets.push({ val: el.y + el.height / 2, desc: 'el_center' });
      yTargets.push({ val: el.y + el.height, desc: 'el_bottom' });
    }

    for (const t of xTargets) {
      if (Math.abs(cx - t.val) <= snapTol) {
        snappedX = t.val - w / 2;
        guides.push({ type: 'x', value: t.val, snapY: cy });
        break;
      }
      if (Math.abs(targetX - t.val) <= snapTol) {
        snappedX = t.val;
        guides.push({ type: 'x', value: t.val, snapY: cy });
        break;
      }
      if (Math.abs(r - t.val) <= snapTol) {
        snappedX = t.val - w;
        guides.push({ type: 'x', value: t.val, snapY: cy });
        break;
      }
    }

    for (const t of yTargets) {
      if (Math.abs(cy - t.val) <= snapTol) {
        snappedY = t.val - h / 2;
        guides.push({ type: 'y', value: t.val, snapX: cx });
        break;
      }
      if (Math.abs(targetY - t.val) <= snapTol) {
        snappedY = t.val;
        guides.push({ type: 'y', value: t.val, snapX: cx });
        break;
      }
      if (Math.abs(b - t.val) <= snapTol) {
        snappedY = t.val - h;
        guides.push({ type: 'y', value: t.val, snapX: cx });
        break;
      }
    }

    return { x: snappedX, y: snappedY, guides };
  }

  onPointerUp() {
    this.smartGuides = [];

    if (this.mode === 'PEN_DRAW') {
      this.mode = 'IDLE';
      this.requestRender();
      return;
    }

    if (this.mode === 'NODE_DRAG' && this.editingPath && this.selectedNode && this.initialNodeState) {
      const idx = this.selectedNode.index;
      const oldState = { ...this.initialNodeState };
      const newState = {
        anchor: { ...this.editingPath.anchors[idx] },
        handleIn: this.editingPath.anchors[idx].handleIn ? { ...this.editingPath.anchors[idx].handleIn } : null,
        handleOut: this.editingPath.anchors[idx].handleOut ? { ...this.editingPath.anchors[idx].handleOut } : null
      };

      const pathRef = this.editingPath;
      this.history.push({
        undo: () => {
          Object.assign(pathRef.anchors[idx], oldState.anchor);
          pathRef.anchors[idx].handleIn = oldState.handleIn;
          pathRef.anchors[idx].handleOut = oldState.handleOut;
          pathRef.recomputeBounds();
          this.requestRender();
        },
        redo: () => {
          Object.assign(pathRef.anchors[idx], newState.anchor);
          pathRef.anchors[idx].handleIn = newState.handleIn;
          pathRef.anchors[idx].handleOut = newState.handleOut;
          pathRef.recomputeBounds();
          this.requestRender();
        }
      });
      this.initialNodeState = null;
    }

    const selected = this.scene.getSelectedElements()[0];
    if (this.mode === 'DRAGGING' && this.dragOrigins) {
      const moves = this.dragOrigins
        .map(o => ({ el: o.el, from: { x: o.x, y: o.y }, to: { x: o.el.x, y: o.el.y } }))
        .filter(m => m.from.x !== m.to.x || m.from.y !== m.to.y);
      if (moves.length) {
        this.history.push({
          undo: () => { for (const m of moves) this.moveElementTo(m.el, m.from.x, m.from.y); this.requestRender(); },
          redo: () => { for (const m of moves) this.moveElementTo(m.el, m.to.x, m.to.y); this.requestRender(); }
        });
      }
    }

    if ((this.mode === 'RESIZING' || this.mode === 'ROTATING') && selected && this.initialTransformState) {
      const before = this.initialTransformState;
      const after = { x: selected.x, y: selected.y, width: selected.width, height: selected.height, rotation: selected.rotation || 0 };
      if (Object.keys(after).some((k) => after[k] !== before[k])) {
        this.history.push({
          undo: () => { Object.assign(selected, before); this.requestRender(); },
          redo: () => { Object.assign(selected, after); this.requestRender(); }
        });
      }
    }

    this.mode = 'IDLE';
    this.activeHandle = null;
    this.marqueeBox = null;
    this.initialTransformState = null;
    this.dragLead = null;
    this.dragOrigins = null;
    this.notifyState();
    this.requestRender();
  }

  onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY < 0 ? 1.12 : 0.88;
      this.camera.zoomAt(factor, screenX, screenY);
    } else {
      this.camera.pan(-e.deltaX, -e.deltaY);
    }

    this.notifyState();
    this.requestRender();
  }

  finishCurrentPath() {
    if (this.currentPath && this.currentPath.anchors.length >= 2) {
      const pathToAdd = this.currentPath;
      this.scene.addElement(pathToAdd);
      this.scene.select(pathToAdd.id);
      this.editingPath = pathToAdd;

      this.history.push({
        undo: () => { this.scene.removeElement(pathToAdd.id); this.requestRender(); },
        redo: () => { this.scene.addElement(pathToAdd); this.scene.select(pathToAdd.id); this.requestRender(); }
      });
    }

    this.currentPath = null;
    this.activeAnchorIndex = -1;
    this.penSnapToOrigin = false;
    this.setTool('SELECT');
    this.notifyState();
    this.requestRender();
  }

  addElement(type, props = {}) {
    const ink = '#1f2328';
    const defaults = {
      rect: { width: 200, height: 120, fill: '#d0d4db', stroke: ink, strokeWidth: 0, radius: 0 },
      circle: { width: 140, height: 140, fill: '#d0d4db', stroke: ink, strokeWidth: 0 },
      triangle: { width: 160, height: 140, fill: '#d0d4db', stroke: ink, strokeWidth: 0 },
      star: { width: 140, height: 140, fill: '#d0d4db', stroke: ink, strokeWidth: 0 },
      line: { width: 200, height: 20, fill: ink, stroke: ink, strokeWidth: 2 },
      arrow: { width: 200, height: 20, fill: ink, stroke: ink, strokeWidth: 2 },
      text: { width: 240, height: 40, text: 'Text', fill: ink, fontSize: 32, fontWeight: '600' }
    };

    const def = defaults[type] || defaults.rect;
    const x = props.x ?? (-def.width / 2);
    const y = props.y ?? (-def.height / 2);

    const el = this.scene.addElement({
      type,
      x,
      y,
      ...def,
      ...props
    });

    this.scene.select(el.id);
    this.history.push({
      undo: () => { this.scene.removeElement(el.id); this.requestRender(); },
      redo: () => { this.scene.addElement(el); this.scene.select(el.id); this.requestRender(); }
    });

    this.notifyState();
    this.requestRender();
    return el;
  }

  duplicateSelected() {
    const selected = this.scene.getSelectedElements();
    if (selected.length === 0) return;
    const clones = selected.map(el => this.scene.duplicate(el.id, 30)).filter(Boolean);
    const selectClones = () => {
      this.scene.clearSelection();
      for (const c of clones) this.scene.select(c.id, true);
    };
    selectClones();
    this.history.push({
      undo: () => { for (const c of clones) this.scene.removeElement(c.id); this.requestRender(); },
      redo: () => { for (const c of clones) this.scene.addElement(c); selectClones(); this.requestRender(); }
    });
    this.notifyState();
    this.requestRender();
  }

  deleteSelected() {
    const selected = this.scene.getSelectedElements();
    if (selected.length === 0) return;

    const order = [...this.scene.elements];
    const removed = [];
    for (const el of selected) {
      this.scene.removeElement(el.id);
      removed.push(el);
    }

    this.history.push({
      undo: () => {
        // Restore the full stack so deleted layers return to their old depth, not the top.
        this.scene.elements = [...order];
        this.requestRender();
      },
      redo: () => {
        for (const el of removed) this.scene.removeElement(el.id);
        this.requestRender();
      }
    });

    this.notifyState();
    this.requestRender();
  }

  alignSelected(direction) {
    const selected = this.scene.getSelectedElements();
    if (selected.length === 0) return;

    const { width: aw, height: ah } = this.scene.artboard;
    const commit = this.beginEdit();
    for (const el of selected) {
      let { x, y } = el;
      if (direction === 'left') x = -aw / 2;
      else if (direction === 'center') x = -el.width / 2;
      else if (direction === 'right') x = aw / 2 - el.width;
      else if (direction === 'top') y = -ah / 2;
      else if (direction === 'middle') y = -el.height / 2;
      else if (direction === 'bottom') y = ah / 2 - el.height;
      this.moveElementTo(el, x, y);
    }
    commit();
    this.requestRender();
  }

  /**
   * Snapshots the selection's properties and the z-order. Call the returned function after
   * mutating; it records one undo step if anything changed.
   */
  beginEdit() {
    const els = this.scene.getSelectedElements();
    const snap = () => ({ order: [...this.scene.elements], states: els.map(el => JSON.stringify(el)) });
    const before = snap();
    return () => {
      const after = snap();
      const same = after.states.every((st, i) => st === before.states[i]) && after.order.every((el, i) => el === before.order[i]);
      if (same) return;
      const apply = (state) => {
        this.scene.elements = [...state.order];
        els.forEach((el, i) => {
          Object.assign(el, JSON.parse(state.states[i]));
          if (typeof el.recomputeBounds === 'function') el.recomputeBounds();
        });
        this.notifyState();
        this.requestRender();
      };
      this.history.push({ undo: () => apply(before), redo: () => apply(after) });
      this.notifyState();
    };
  }

  bringForward() {
    const selected = this.scene.getSelectedElements()[0];
    if (selected) {
      const commit = this.beginEdit();
      this.scene.bringForward(selected.id);
      commit();
      this.requestRender();
    }
  }

  sendBackward() {
    const selected = this.scene.getSelectedElements()[0];
    if (selected) {
      const commit = this.beginEdit();
      this.scene.sendBackward(selected.id);
      commit();
      this.requestRender();
    }
  }

  bringToFront() {
    const selected = this.scene.getSelectedElements()[0];
    if (selected) {
      const commit = this.beginEdit();
      this.scene.bringToFront(selected.id);
      commit();
      this.requestRender();
    }
  }

  sendToBack() {
    const selected = this.scene.getSelectedElements()[0];
    if (selected) {
      const commit = this.beginEdit();
      this.scene.sendToBack(selected.id);
      commit();
      this.requestRender();
    }
  }

  undo() {
    if (this.history.undo()) {
      this.notifyState();
      this.requestRender();
    }
  }

  redo() {
    if (this.history.redo()) {
      this.notifyState();
      this.requestRender();
    }
  }

  /** Renders only the artboard and its elements (no workspace, overlays, or preview effect). */
  exportPNG(scale = 2) {
    const { width, height, background } = this.scene.artboard;
    const out = document.createElement('canvas');
    out.width = Math.round(width * scale);
    out.height = Math.round(height * scale);
    const ctx = out.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, (width / 2) * scale, (height / 2) * scale);
    ctx.fillStyle = background || '#ffffff';
    ctx.fillRect(-width / 2, -height / 2, width, height);
    for (const el of this.scene.elements) CanvasRenderer.drawElement(ctx, el);
    return out.toDataURL('image/png');
  }

  exportJSON() {
    return this.scene.toJSON();
  }

  loadJSON(jsonStr) {
    this.scene.fromJSON(jsonStr);
    this.history.clear();
    this.fitToScreen();
    this.notifyState();
    this.requestRender();
  }

  notifyState() {
    if (this.onStateChange) {
      this.onStateChange({
        activeTool: this.activeTool,
        selectedCount: this.scene.selectedIds.size,
        selectedElement: this.scene.getSelectedElements()[0] || null,
        canUndo: this.history.canUndo(),
        canRedo: this.history.canRedo(),
        zoom: Math.round(this.camera.zoom * 100),
        artboard: this.scene.artboard,
        shaderPreset: this.webglPipeline ? this.webglPipeline.preset : 'none'
      });
    }
  }

  requestRender() {
    if (this._anim) return;
    this._anim = requestAnimationFrame(() => {
      this._anim = null;
      const dpr = window.devicePixelRatio || 1;

      CanvasRenderer.render(
        this.ctx,
        this.canvas.clientWidth,
        this.canvas.clientHeight,
        dpr,
        this.camera,
        this.scene,
        this.marqueeBox,
        this.currentPath,
        this.activeTool === 'NODE_EDIT' && this.editingPath ? { pathElement: this.editingPath, selectedNode: this.selectedNode } : null,
        this.penSnapToOrigin,
        this.smartGuides,
        this.hoverElement
      );

      // WebGL Multi-Pass Post-Processing
      if (this.webglPipeline && this.glCanvas) {
        // A hidden overlay stops a stale last frame from covering the live 2D canvas.
        const active = this.webglPipeline.preset !== 'none';
        this.glCanvas.style.display = active ? 'block' : 'none';
        if (active) {
          try {
            this.webglPipeline.process(this.canvas);
          } catch (err) {
            console.warn(`[canvas] shader pass failed, falling back to 2D: ${err.message}`);
            this.disableWebGL();
          }
        }
      }
    });
  }
}
