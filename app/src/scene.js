import { VectorPath } from './path.js';

/**
 * Scene Graph & Data Store
 * Ordered collection of shape primitives with z-index sorting and serialization.
 */
export class SceneGraph {
  constructor(initialElements = [], artboard = null) {
    this.elements = [];
    this.selectedIds = new Set();
    this.artboard = artboard || {
      width: 1200,
      height: 800,
      background: '#ffffff',
      title: 'Page 1'
    };
    for (const el of initialElements) {
      this.addElement(el);
    }
  }

  setArtboard(props = {}) {
    this.artboard = { ...this.artboard, ...props };
  }

  addElement(element) {
    if (element instanceof VectorPath) {
      this.elements.push(element);
      return element;
    }

    if (element.type === 'path') {
      const pathEl = new VectorPath(element);
      this.elements.push(pathEl);
      return pathEl;
    }

    const el = {
      id: element.id || 'el_' + Math.random().toString(36).slice(2, 9),
      type: element.type || 'rect', // 'rect' | 'circle' | 'text' | 'path'
      x: element.x ?? 0,
      y: element.y ?? 0,
      width: Math.max(10, element.width ?? 100),
      height: Math.max(10, element.height ?? 100),
      rotation: element.rotation ?? 0,
      fill: element.fill || '#d0d4db',
      stroke: element.stroke || '#1f2328',
      strokeWidth: element.strokeWidth ?? 0,
      text: element.text || '',
      fontSize: element.fontSize ?? 18,
      ...element
    };
    this.elements.push(el);
    return el;
  }

  removeElement(id) {
    const idx = this.elements.findIndex(e => e.id === id);
    if (idx !== -1) {
      const removed = this.elements.splice(idx, 1)[0];
      this.selectedIds.delete(id);
      return removed;
    }
    return null;
  }

  getElementById(id) {
    return this.elements.find(e => e.id === id) || null;
  }

  getSelectedElements() {
    return this.elements.filter(e => this.selectedIds.has(e.id));
  }

  select(id, multi = false) {
    if (!multi) this.selectedIds.clear();
    if (id) this.selectedIds.add(id);
  }

  clearSelection() {
    this.selectedIds.clear();
  }

  bringForward(id) {
    const idx = this.elements.findIndex(e => e.id === id);
    if (idx !== -1 && idx < this.elements.length - 1) {
      const [el] = this.elements.splice(idx, 1);
      this.elements.splice(idx + 1, 0, el);
    }
  }

  sendBackward(id) {
    const idx = this.elements.findIndex(e => e.id === id);
    if (idx > 0) {
      const [el] = this.elements.splice(idx, 1);
      this.elements.splice(idx - 1, 0, el);
    }
  }

  bringToFront(id) {
    const idx = this.elements.findIndex(e => e.id === id);
    if (idx !== -1 && idx < this.elements.length - 1) {
      const [el] = this.elements.splice(idx, 1);
      this.elements.push(el);
    }
  }

  sendToBack(id) {
    const idx = this.elements.findIndex(e => e.id === id);
    if (idx > 0) {
      const [el] = this.elements.splice(idx, 1);
      this.elements.unshift(el);
    }
  }

  duplicate(id, offset = 24) {
    const original = this.getElementById(id);
    if (!original) return null;

    if (original instanceof VectorPath) {
      const clone = new VectorPath(original.toJSON());
      clone.id = 'path_' + Math.random().toString(36).slice(2, 9);
      clone.translate(offset, offset);
      this.addElement(clone);
      this.select(clone.id);
      return clone;
    }

    const cloneData = {
      ...original,
      id: 'el_' + Math.random().toString(36).slice(2, 9),
      x: original.x + offset,
      y: original.y + offset
    };
    const added = this.addElement(cloneData);
    this.select(added.id);
    return added;
  }

  toJSON() {
    const plainElements = this.elements.map(e => (typeof e.toJSON === 'function' ? e.toJSON() : e));
    return JSON.stringify({
      artboard: this.artboard,
      elements: plainElements
    }, null, 2);
  }

  fromJSON(jsonStr) {
    const parsed = JSON.parse(jsonStr);
    this.elements = [];
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        this.addElement(item);
      }
    } else if (parsed && typeof parsed === 'object') {
      if (parsed.artboard) {
        this.artboard = { ...this.artboard, ...parsed.artboard };
      }
      if (Array.isArray(parsed.elements)) {
        for (const item of parsed.elements) {
          this.addElement(item);
        }
      }
    }
    this.selectedIds.clear();
  }
}
