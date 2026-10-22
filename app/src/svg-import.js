/**
 * SVG import. Turns an SVG document into editable scene elements: rect/circle/ellipse stay
 * shapes when their transform is a plain rotate/scale/translate, everything else becomes paths.
 * The page centre is the world origin, so coordinates are shifted by the viewBox centre.
 */

import { VectorPath } from './path.js';

const KAPPA = 0.5522847498;
const INHERITED = ['fill', 'fill-rule', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity', 'font-size', 'font-weight', 'visibility', 'color', 'dominant-baseline'];
const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'marker', 'pattern', 'filter', 'linearGradient', 'radialGradient', 'style', 'title', 'desc', 'metadata', 'script']);
// Elements a viewer would notice missing; reported back so the user knows.
const UNSUPPORTED = new Set(['image', 'foreignObject']);

// ── Matrices: [a, b, c, d, e, f] as in SVG ───────────────────────────
export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}

export function apply(m, p) {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function parseTransform(str) {
  let m = IDENTITY;
  if (!str) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(str))) {
    const v = numbers(match[2]);
    let t = IDENTITY;
    switch (match[1]) {
      case 'matrix': if (v.length === 6) t = v; break;
      case 'translate': t = [1, 0, 0, 1, v[0] || 0, v[1] || 0]; break;
      case 'scale': t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const a = ((v[0] || 0) * Math.PI) / 180;
        const r = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        const [cx = 0, cy = 0] = v.slice(1);
        t = multiply(multiply([1, 0, 0, 1, cx, cy], r), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case 'skewX': t = [1, 0, Math.tan(((v[0] || 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(((v[0] || 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = multiply(m, t);
  }
  return m;
}

function numbers(str) {
  return (String(str).match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || []).map(Number);
}

const num = (v, fallback = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

// ── Path data ────────────────────────────────────────────────────────
const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Tokenises path data; arc flags may be written without separators ("a1 1 0 00 5 5"). */
function tokenize(d) {
  const out = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  let cmd = null;
  let argIndex = 0;
  let i = 0;
  while (i < d.length) {
    const ch = d[i];
    if (/[\s,]/.test(ch)) { i++; continue; }
    // Arc flags (4th and 5th arguments) are single characters.
    if (cmd && cmd.toUpperCase() === 'A' && (argIndex % 7 === 3 || argIndex % 7 === 4) && (ch === '0' || ch === '1')) {
      out.push(Number(ch));
      argIndex++;
      i++;
      continue;
    }
    re.lastIndex = i;
    const m = re.exec(d);
    if (!m || m.index !== i) throw new Error(`Bad path data near "${d.slice(i, i + 12)}"`);
    if (m[1]) { cmd = m[1]; argIndex = 0; out.push(cmd); } else { out.push(Number(m[2])); argIndex++; }
    i = re.lastIndex;
  }
  return out;
}

/**
 * Parses SVG path data into absolute subpaths: { start, segs: [{ c1, c2, p }], closed }.
 * Straight segments have null controls, matching VectorPath's "no handle" convention.
 */
export function parsePathData(d) {
  const tokens = tokenize(d || '');
  const subpaths = [];
  let sub = null;
  let cur = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  let lastCubic = null;
  let lastQuad = null;
  let i = 0;
  let cmd = null;

  const lineTo = (p) => { sub.segs.push({ c1: null, c2: null, p }); cur = p; };
  const cubicTo = (c1, c2, p) => { sub.segs.push({ c1, c2, p }); cur = p; };

  while (i < tokens.length) {
    if (typeof tokens[i] === 'string') cmd = tokens[i++];
    else if (!cmd) throw new Error('Path data must start with a command');
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    const n = ARGS[upper];
    const args = tokens.slice(i, i + n);
    if (args.length < n || args.some(a => typeof a !== 'number')) {
      if (upper === 'Z') args.length = 0; else break; // truncated data: keep what parsed
    }
    i += n;
    const ox = rel ? cur.x : 0;
    const oy = rel ? cur.y : 0;
    let cubicCtrl = null;
    let quadCtrl = null;

    if (upper !== 'M' && !sub) {
      sub = { start: { ...cur }, segs: [], closed: false };
      subpaths.push(sub);
    }

    switch (upper) {
      case 'M':
        cur = { x: ox + args[0], y: oy + args[1] };
        start = cur;
        sub = { start: cur, segs: [], closed: false };
        subpaths.push(sub);
        cmd = rel ? 'l' : 'L'; // further pairs are implicit line-tos
        break;
      case 'L': lineTo({ x: ox + args[0], y: oy + args[1] }); break;
      case 'H': lineTo({ x: ox + args[0], y: cur.y }); break;
      case 'V': lineTo({ x: cur.x, y: oy + args[0] }); break;
      case 'C': {
        const c2 = { x: ox + args[2], y: oy + args[3] };
        cubicTo({ x: ox + args[0], y: oy + args[1] }, c2, { x: ox + args[4], y: oy + args[5] });
        cubicCtrl = c2;
        break;
      }
      case 'S': {
        const c1 = lastCubic ? { x: 2 * cur.x - lastCubic.x, y: 2 * cur.y - lastCubic.y } : { ...cur };
        const c2 = { x: ox + args[0], y: oy + args[1] };
        cubicTo(c1, c2, { x: ox + args[2], y: oy + args[3] });
        cubicCtrl = c2;
        break;
      }
      case 'Q':
      case 'T': {
        const q = upper === 'Q'
          ? { x: ox + args[0], y: oy + args[1] }
          : lastQuad ? { x: 2 * cur.x - lastQuad.x, y: 2 * cur.y - lastQuad.y } : { ...cur };
        const p = upper === 'Q' ? { x: ox + args[2], y: oy + args[3] } : { x: ox + args[0], y: oy + args[1] };
        cubicTo(
          { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) },
          { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) },
          p
        );
        quadCtrl = q;
        break;
      }
      case 'A': {
        const p = { x: ox + args[5], y: oy + args[6] };
        for (const seg of arcToCubics(cur, args[0], args[1], args[2], args[3], args[4], p)) cubicTo(seg.c1, seg.c2, seg.p);
        cur = p;
        break;
      }
      case 'Z':
        sub.closed = true;
        cur = start;
        sub = null;
        break;
    }
    lastCubic = cubicCtrl;
    lastQuad = quadCtrl;
  }
  return subpaths.filter(s => s.segs.length > 0);
}

/** Endpoint arc to cubic Béziers (SVG 1.1 implementation notes, F.6.5), at most 90° per piece. */
export function arcToCubics(p0, rx, ry, angleDeg, largeArc, sweep, p) {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (p0.x === p.x && p0.y === p.y) return [];
  if (!rx || !ry) return [{ c1: null, c2: null, p }];
  const phi = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0.x - p.x) / 2;
  const dy = (p0.y - p.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num2 / den));
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0.x + p.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0.y + p.y) / 2;
  const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  const pieces = Math.ceil(Math.abs(delta) / (Math.PI / 2));
  const step = delta / pieces;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (t) => ({
    x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
    y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos
  });
  const deriv = (t) => ({
    x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
    y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos
  });
  const out = [];
  for (let i = 0; i < pieces; i++) {
    const t1 = theta1 + i * step;
    const t2 = t1 + step;
    const a = point(t1);
    const b = i === pieces - 1 ? p : point(t2);
    const da = deriv(t1);
    const db = deriv(t2);
    out.push({ c1: { x: a.x + k * da.x, y: a.y + k * da.y }, c2: { x: b.x - k * db.x, y: b.y - k * db.y }, p: b });
  }
  return out;
}

/** One subpath → VectorPath anchors, with the matrix applied. A closing anchor on the start point is merged. */
export function subpathToAnchors(sub, m) {
  const t = (p) => (p ? apply(m, p) : null);
  const anchors = [{ ...t(sub.start), handleIn: null, handleOut: null }];
  for (const seg of sub.segs) {
    anchors[anchors.length - 1].handleOut = t(seg.c1);
    anchors.push({ ...t(seg.p), handleIn: t(seg.c2), handleOut: null });
  }
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (sub.closed && anchors.length > 2 && Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) {
    first.handleIn = last.handleIn;
    anchors.pop();
  }
  return anchors;
}

// ── Styles ───────────────────────────────────────────────────────────
function parseDeclarations(text) {
  const out = {};
  for (const part of String(text || '').split(';')) {
    const idx = part.indexOf(':');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).replace(/!important/, '').trim();
  }
  return out;
}

/** Collects simple `.class`, `#id` and tag rules from <style> blocks (no combinators). */
function parseStylesheets(doc) {
  const rules = [];
  for (const style of doc.getElementsByTagName('style')) {
    const css = style.textContent.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const decls = parseDeclarations(m[2]);
      for (const sel of m[1].split(',').map(s => s.trim())) {
        if (/^[.#]?[\w-]+$/.test(sel)) rules.push({ sel, decls });
      }
    }
  }
  return rules;
}

function selectorMatches(sel, node, classes, id) {
  if (sel[0] === '.') return classes.includes(sel.slice(1));
  if (sel[0] === '#') return sel.slice(1) === id;
  return sel === node.localName;
}

function ownStyle(node, rules) {
  const style = {};
  const classes = (node.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  const id = node.getAttribute('id');
  for (const { sel, decls } of rules) {
    if (selectorMatches(sel, node, classes, id)) Object.assign(style, decls);
  }
  for (const key of [...INHERITED, 'opacity', 'display']) {
    const v = node.getAttribute(key);
    if (v !== null) style[key] = v;
  }
  return Object.assign(style, parseDeclarations(node.getAttribute('style')));
}

// ── Import ───────────────────────────────────────────────────────────
/**
 * @param {Document} doc parsed SVG document (DOMParser, image/svg+xml)
 * @returns {{ artboard: object, elements: object[], skipped: Record<string, number> }}
 */
export function importSVG(doc) {
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg') throw new Error('Not an SVG file');

  const vb = numbers(root.getAttribute('viewBox') || '');
  const hasViewBox = vb.length === 4 && vb[2] > 0 && vb[3] > 0;
  const width = hasViewBox ? vb[2] : num(root.getAttribute('width'), 1200);
  const height = hasViewBox ? vb[3] : num(root.getAttribute('height'), 800);
  const minX = hasViewBox ? vb[0] : 0;
  const minY = hasViewBox ? vb[1] : 0;
  const rootMatrix = [1, 0, 0, 1, -(minX + width / 2), -(minY + height / 2)];

  const rules = parseStylesheets(doc);
  const byId = (id) => doc.getElementById ? doc.getElementById(id) : doc.querySelector(`[id="${id}"]`);
  const artboard = { width: Math.round(width), height: Math.round(height), title: 'Page 1' };
  const elements = [];
  const skipped = {};
  const skip = (name) => { skipped[name] = (skipped[name] || 0) + 1; };

  const paint = (value, style) => {
    if (!value || value === 'none' || value === 'transparent') return 'transparent';
    if (value === 'currentColor') return style.color || '#000000';
    const ref = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(value);
    if (ref) {
      // Flat stand-in (kept for strokes); fills are upgraded to real gradients in addElement.
      // Stops may live on a gradient this one links to.
      let grad = byId(ref[1]);
      for (let hops = 0; grad && grad.localName !== 'pattern' && !grad.getElementsByTagName('stop').length && hops < 5; hops++) {
        const link = hrefOf(grad);
        grad = link && link[0] === '#' ? byId(link.slice(1)) : null;
      }
      if (grad?.localName === 'pattern') {
        // Patterns are approximated by the colour of their first painted shape.
        const shape = [...grad.getElementsByTagName('*')].find(el => el.getAttribute('fill') || /fill\s*:/.test(el.getAttribute('style') || ''));
        const fill = shape && (parseDeclarations(shape.getAttribute('style')).fill || shape.getAttribute('fill'));
        return fill && !fill.startsWith('url(') ? paint(fill, style) : '#808080';
      }
      const stop = grad?.getElementsByTagName('stop')[0];
      if (!stop) return '#808080';
      return parseDeclarations(stop.getAttribute('style'))['stop-color'] || stop.getAttribute('stop-color') || '#000000';
    }
    return value;
  };

  /** The gradient a fill references, following href links for inherited attributes and stops. */
  function gradientChain(value) {
    const ref = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(value || '');
    const chain = [];
    for (let node = ref && byId(ref[1]); node && chain.length < 6; ) {
      chain.push(node);
      const link = hrefOf(node);
      node = link && link[0] === '#' ? byId(link.slice(1)) : null;
    }
    const kind = chain[0]?.localName;
    return kind === 'linearGradient' || kind === 'radialGradient' ? chain : null;
  }

  /**
   * Converts an SVG gradient into the editor's form: geometry as fractions of the final element
   * box in its unrotated frame. box is the source shape's bounding box in its own user space
   * (for objectBoundingBox units), m the shape's full transform, el the element as built.
   */
  function gradientFor(chain, box, m, el) {
    const attrOf = (name) => chain.find(node => node.hasAttribute(name))?.getAttribute(name) ?? null;
    const stopHolder = chain.find(node => node.getElementsByTagName('stop').length);
    if (!stopHolder) return null;
    let last = 0;
    const stops = [...stopHolder.getElementsByTagName('stop')].map(stop => {
      const css = parseDeclarations(stop.getAttribute('style'));
      const off = stop.getAttribute('offset') || '0';
      last = Math.max(last, Math.min(1, Math.max(0, off.trim().endsWith('%') ? parseFloat(off) / 100 : num(off))));
      const opacity = num(css['stop-opacity'] ?? stop.getAttribute('stop-opacity'), 1);
      const color = css['stop-color'] || stop.getAttribute('stop-color') || '#000000';
      return { offset: last, color: color === 'currentColor' ? '#000000' : color, ...(opacity < 1 ? { opacity } : {}) };
    });

    const userSpace = attrOf('gradientUnits') === 'userSpaceOnUse';
    // Percentages are of the box (objectBoundingBox) or of the page (userSpaceOnUse).
    const val = (name, fallback, ref) => {
      const v = attrOf(name);
      if (v === null) return fallback;
      return v.trim().endsWith('%') ? (parseFloat(v) / 100) * (userSpace ? ref : 1) : num(v, fallback);
    };
    const toShape = userSpace ? IDENTITY : [box.w, 0, 0, box.h, box.x, box.y];
    const full = multiply(m, multiply(toShape, parseTransform(attrOf('gradientTransform'))));
    const cxEl = el.x + el.width / 2;
    const cyEl = el.y + el.height / 2;
    const cos = Math.cos(-(el.rotation || 0));
    const sin = Math.sin(-(el.rotation || 0));
    const local = (p) => {
      const w = apply(full, p);
      const dx = w.x - cxEl;
      const dy = w.y - cyEl;
      return { x: cxEl + dx * cos - dy * sin, y: cyEl + dx * sin + dy * cos };
    };
    const fx = (p) => (p.x - el.x) / el.width;
    const fy = (p) => (p.y - el.y) / el.height;
    const W = userSpace ? width : 1;
    const H = userSpace ? height : 1;

    if (chain[0].localName === 'linearGradient') {
      const a = local({ x: val('x1', 0, W), y: val('y1', 0, H) });
      const b = local({ x: val('x2', userSpace ? W : 1, W), y: val('y2', 0, H) });
      return { type: 'linear', x1: fx(a), y1: fy(a), x2: fx(b), y2: fy(b), stops };
    }
    const diag = Math.sqrt((W * W + H * H) / 2);
    const cx = val('cx', userSpace ? W / 2 : 0.5, W);
    const cy = val('cy', userSpace ? H / 2 : 0.5, H);
    const r = val('r', userSpace ? diag / 2 : 0.5, diag);
    const c = local({ x: cx, y: cy });
    const f = local({ x: val('fx', cx, W), y: val('fy', cy, H) });
    const ax = local({ x: cx + r, y: cy });
    const ay = local({ x: cx, y: cy + r });
    // shortcut: a rotated elliptical gradient keeps its extent along x and y but loses its tilt.
    const rx = Math.hypot(ax.x - c.x, ay.x - c.x) / el.width;
    const ry = Math.hypot(ax.y - c.y, ay.y - c.y) / el.height;
    return { type: 'radial', cx: fx(c), cy: fy(c), rx, ry, fx: fx(f), fy: fy(f), stops };
  }

  /** Adds an element; a gradient fill is converted once the element's box is known. */
  function addElement(el, style, box, m) {
    const chain = el.fill !== 'transparent' && gradientChain(style.fill);
    if (chain) {
      const frame = el.type === 'path' ? new VectorPath(el) : el;
      const gradient = gradientFor(chain, box, m, { x: frame.x, y: frame.y, width: frame.width, height: frame.height, rotation: el.rotation || 0 });
      if (gradient) el.fill = gradient;
    }
    elements.push(el);
  }

  function paintProps(style, m, opacity) {
    const fill = paint(style.fill ?? '#000000', style);
    const strokeOn = style.stroke && style.stroke !== 'none';
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    const fillOpacity = fill !== 'transparent' ? num(style['fill-opacity'], 1) : num(style['stroke-opacity'], 1);
    const total = opacity * fillOpacity;
    return {
      fill,
      stroke: strokeOn ? paint(style.stroke, style) : 'transparent',
      strokeWidth: strokeOn ? num(style['stroke-width'], 1) * scale : 0,
      ...(total < 1 ? { opacity: +total.toFixed(3) } : {})
    };
  }

  /** One SVG shape → one path layer; extra subpaths (holes, separate pieces) stay in the same layer. */
  function pushPaths(subpaths, style, m, opacity) {
    const props = paintProps(style, m, opacity);
    // SVG fills open subpaths as if closed; VectorPath only fills closed ones.
    const fillsOpen = props.fill !== 'transparent' && props.stroke === 'transparent';
    const outlines = subpaths
      .map(sub => ({ anchors: subpathToAnchors(sub, m), closed: sub.closed || fillsOpen }))
      .filter(o => o.anchors.length >= 2);
    if (!outlines.length) return;
    const [main, ...rest] = outlines;
    addElement({
      type: 'path', anchors: main.anchors, closed: main.closed,
      ...(rest.length ? { subpaths: rest } : {}),
      ...(style['fill-rule'] === 'evenodd' ? { fillRule: 'evenodd' } : {}),
      ...props, strokeWidth: props.strokeWidth || 2
    }, style, subpathBox(subpaths), m);
  }

  /** rect/ellipse keep their type when m is rotation + positive scale (no skew, no mirror). */
  function pushBox(type, x, y, w, h, rx, style, m, opacity) {
    if (!(w > 0 && h > 0)) return;
    const sx = Math.hypot(m[0], m[1]);
    const sy = Math.hypot(m[2], m[3]);
    const plain = Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-9 && m[0] * m[3] - m[1] * m[2] > 0;
    if (!plain) {
      const sub = type === 'circle' ? ellipseSubpath(x + w / 2, y + h / 2, w / 2, h / 2) : rectSubpath(x, y, w, h);
      pushPaths([sub], style, m, opacity);
      return;
    }
    const c = apply(m, { x: x + w / 2, y: y + h / 2 });
    const W = w * sx;
    const H = h * sy;
    addElement({
      type, x: c.x - W / 2, y: c.y - H / 2, width: W, height: H,
      rotation: Math.atan2(m[1], m[0]),
      ...(type === 'rect' ? { radius: rx * sx } : {}),
      ...paintProps(style, m, opacity)
    }, style, { x, y, w, h }, m);
  }

  function pushText(node, style, m, opacity) {
    const size = num(style['font-size'], 16);
    // Inline <tspan>s continue the line; a <tspan> with its own y or dy starts a new one.
    const raw = [''];
    for (const child of node.childNodes) {
      const positioned = child.nodeType === 1 && (child.hasAttribute('y') || child.hasAttribute('dy'));
      if (positioned && raw[raw.length - 1].trim()) raw.push('');
      raw[raw.length - 1] += child.textContent;
    }
    const lines = raw.map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!lines.length) return;
    const span = node.getElementsByTagName('tspan')[0];
    const x = numbers(node.getAttribute('x') ?? span?.getAttribute('x') ?? '0')[0] || 0;
    const y = numbers(node.getAttribute('y') ?? span?.getAttribute('y') ?? '0')[0] || 0;
    const hanging = /hanging|text-before-edge/.test(style['dominant-baseline'] || '');
    const scale = Math.hypot(m[0], m[1]) || 1;
    const fontSize = size * scale;
    // The editor draws text from its top edge; SVG text sits on its baseline by default.
    const top = apply(m, { x, y: hanging ? y : y - size * 0.8 });
    const weight = style['font-weight'] === 'bold' ? '700' : style['font-weight'];
    const longest = Math.max(...lines.map(l => l.length));
    addElement({
      type: 'text', x: top.x, y: top.y,
      width: longest * fontSize * 0.55, height: lines.length * fontSize * 1.25,
      rotation: Math.atan2(m[1], m[0]),
      text: lines.join('\n'), fontSize, ...(weight ? { fontWeight: weight } : {}),
      ...paintProps(style, m, opacity), strokeWidth: 0
    }, style, { x, y: hanging ? y : y - size * 0.8, w: longest * size * 0.55, h: lines.length * size * 1.25 }, m);
  }

  function walk(node, inherited, m, opacity, depth) {
    if (depth > 50) return;
    const name = node.localName;
    if (SKIP.has(name)) return;
    if (UNSUPPORTED.has(name)) { skip(name); return; }

    const own = ownStyle(node, rules);
    if (own.display === 'none') return;
    const style = { ...inherited };
    for (const key of INHERITED) if (own[key] !== undefined) style[key] = own[key];
    const op = opacity * num(own.opacity, 1);
    let matrix = multiply(m, parseTransform(node.getAttribute('transform')));
    const hidden = style.visibility === 'hidden' || style.visibility === 'collapse';
    const attr = (k) => num(node.getAttribute(k));

    switch (name) {
      case 'svg':
        if (node !== root) matrix = multiply(matrix, [1, 0, 0, 1, attr('x'), attr('y')]);
      // falls through
      case 'g':
      case 'a':
      case 'switch':
        for (const child of node.children) walk(child, style, matrix, op, depth + 1);
        return;
      case 'use': {
        const href = hrefOf(node);
        const target = href && href[0] === '#' ? byId(href.slice(1)) : null;
        if (!target) return;
        const placed = multiply(matrix, [1, 0, 0, 1, attr('x'), attr('y')]);
        if (target.localName === 'symbol') {
          for (const child of target.children) walk(child, style, placed, op, depth + 1);
        } else {
          walk(target, style, placed, op, depth + 1);
        }
        return;
      }
    }
    if (hidden) return;

    switch (name) {
      case 'rect': {
        const w = attr('width');
        const h = attr('height');
        const rxAttr = node.getAttribute('rx') ?? node.getAttribute('ry');
        const rx = Math.min(num(rxAttr), w / 2, h / 2);
        pushBox('rect', attr('x'), attr('y'), w, h, rx, style, matrix, op);
        break;
      }
      case 'circle': {
        const r = attr('r');
        pushBox('circle', attr('cx') - r, attr('cy') - r, 2 * r, 2 * r, 0, style, matrix, op);
        break;
      }
      case 'ellipse': {
        const rx = attr('rx');
        const ry = attr('ry');
        pushBox('circle', attr('cx') - rx, attr('cy') - ry, 2 * rx, 2 * ry, 0, style, matrix, op);
        break;
      }
      case 'line':
        pushPaths([{ start: { x: attr('x1'), y: attr('y1') }, segs: [{ c1: null, c2: null, p: { x: attr('x2'), y: attr('y2') } }], closed: false }],
          { ...style, fill: 'none' }, matrix, op);
        break;
      case 'polyline':
      case 'polygon': {
        const v = numbers(node.getAttribute('points') || '');
        if (v.length < 4) break;
        const segs = [];
        for (let i = 2; i + 1 < v.length; i += 2) segs.push({ c1: null, c2: null, p: { x: v[i], y: v[i + 1] } });
        pushPaths([{ start: { x: v[0], y: v[1] }, segs, closed: name === 'polygon' }], style, matrix, op);
        break;
      }
      case 'path':
        pushPaths(parsePathData(node.getAttribute('d')), style, matrix, op);
        break;
      case 'text':
        pushText(node, style, matrix, op);
        break;
      default:
        if (node.children.length === 0 && node.namespaceURI === 'http://www.w3.org/2000/svg') skip(name);
    }
  }

  walk(root, {}, rootMatrix, 1, 0);

  // A first rect covering the whole page (as VectorStudio exports it) becomes the page background.
  const bg = elements[0];
  if (bg && bg.type === 'rect' && !bg.rotation && !bg.radius && bg.fill !== 'transparent' && bg.opacity === undefined &&
      Math.abs(bg.x + width / 2) < 0.5 && Math.abs(bg.y + height / 2) < 0.5 && Math.abs(bg.width - width) < 0.5 && Math.abs(bg.height - height) < 0.5) {
    artboard.background = bg.fill;
    elements.shift();
  } else {
    artboard.background = '#ffffff';
  }
  return { artboard, elements, skipped };
}

/** Bounding box of subpaths (anchors and control points) in their own user space. */
function subpathBox(subpaths) {
  const pts = subpaths.flatMap(sp => [sp.start, ...sp.segs.flatMap(seg => [seg.c1, seg.c2, seg.p])]).filter(Boolean);
  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x || 1, h: Math.max(...ys) - y || 1 };
}

function hrefOf(node) {
  return node.getAttribute('href') || node.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href') || node.getAttribute('xlink:href');
}

function rectSubpath(x, y, w, h) {
  // shortcut: rounded corners are dropped when a rect has a skew/mirror transform; rare in practice.
  return {
    start: { x, y },
    segs: [{ x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }].map(p => ({ c1: null, c2: null, p })),
    closed: true
  };
}

function ellipseSubpath(cx, cy, rx, ry) {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return {
    start: { x: cx + rx, y: cy },
    segs: [
      { c1: { x: cx + rx, y: cy + ky }, c2: { x: cx + kx, y: cy + ry }, p: { x: cx, y: cy + ry } },
      { c1: { x: cx - kx, y: cy + ry }, c2: { x: cx - rx, y: cy + ky }, p: { x: cx - rx, y: cy } },
      { c1: { x: cx - rx, y: cy - ky }, c2: { x: cx - kx, y: cy - ry }, p: { x: cx, y: cy - ry } },
      { c1: { x: cx + kx, y: cy - ry }, c2: { x: cx + rx, y: cy - ky }, p: { x: cx + rx, y: cy } }
    ],
    closed: true
  };
}
