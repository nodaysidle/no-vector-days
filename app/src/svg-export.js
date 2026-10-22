/**
 * SVG export. Geometry mirrors CanvasRenderer so the file matches what is on screen.
 */

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v) => +Number(v).toFixed(2);

function attrs(map) {
  return Object.entries(map)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
}

function starPoints(cx, cy, outer, inner, spikes = 5) {
  const pts = [];
  const step = Math.PI / spikes;
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI / 2) * 3 + i * step;
    pts.push(`${n(cx + Math.cos(a) * r)},${n(cy + Math.sin(a) * r)}`);
  }
  return pts.join(' ');
}

function elementToSVG(el) {
  const common = { opacity: el.opacity !== undefined && el.opacity < 1 ? el.opacity : undefined };

  if (el.type === 'path') {
    if (!el.anchors || el.anchors.length < 2) return '';
    const filled = el.closed && el.fill && el.fill !== 'transparent';
    return `<path${attrs({
      d: el.toSVGPath(),
      fill: filled ? el.fill : 'none',
      'fill-rule': el.fillRule,
      stroke: el.stroke && el.stroke !== 'transparent' ? el.stroke : undefined,
      'stroke-width': el.strokeWidth || 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      ...common
    })}/>`;
  }

  const { x, y, width: w, height: h } = el;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const transform = el.rotation ? `rotate(${n((el.rotation * 180) / Math.PI)} ${n(cx)} ${n(cy)})` : undefined;
  const paint = {
    fill: el.fill,
    stroke: el.strokeWidth > 0 ? el.stroke : undefined,
    'stroke-width': el.strokeWidth > 0 ? el.strokeWidth : undefined,
    transform,
    ...common
  };

  switch (el.type) {
    case 'circle':
      return `<ellipse${attrs({ cx: n(cx), cy: n(cy), rx: n(w / 2), ry: n(h / 2), ...paint })}/>`;
    case 'triangle':
      return `<polygon${attrs({ points: `${n(cx)},${n(y)} ${n(x + w)},${n(y + h)} ${n(x)},${n(y + h)}`, ...paint })}/>`;
    case 'star':
      return `<polygon${attrs({ points: starPoints(cx, cy, w / 2, w / 4), ...paint })}/>`;
    case 'line':
    case 'arrow': {
      const color = el.stroke || el.fill;
      const width = Math.max(2, el.strokeWidth || 3);
      let out = `<line${attrs({ x1: n(x), y1: n(cy), x2: n(x + w), y2: n(cy), stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', transform, ...common })}/>`;
      if (el.type === 'arrow') {
        const s = Math.max(8, (el.strokeWidth || 3) * 2.5);
        out += `<polygon${attrs({ points: `${n(x + w)},${n(cy)} ${n(x + w - s)},${n(cy - s / 1.5)} ${n(x + w - s)},${n(cy + s / 1.5)}`, fill: color, transform, ...common })}/>`;
      }
      return out;
    }
    case 'text': {
      const size = el.fontSize || 20;
      const lines = String(el.text || 'Text').split('\n');
      const spans = lines.map((line, i) => `<tspan${attrs({ x: n(x), y: n(y + i * size * 1.25) })}>${esc(line)}</tspan>`).join('');
      return `<text${attrs({
        'font-family': 'system-ui, sans-serif',
        'font-size': size,
        'font-weight': el.fontWeight || (size > 24 ? '700' : '500'),
        'dominant-baseline': 'hanging',
        fill: el.fill,
        transform,
        ...common
      })}>${spans}</text>`;
    }
    default: {
      const r = Math.min(el.radius ?? 0, w / 2, h / 2);
      return `<rect${attrs({ x: n(x), y: n(y), width: n(w), height: n(h), rx: r > 0 ? n(r) : undefined, ...paint })}/>`;
    }
  }
}

export function sceneToSVG(scene) {
  const { width: w, height: h, background } = scene.artboard;
  const body = scene.elements.map(elementToSVG).filter(Boolean).map(s => `  ${s}`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(-w / 2)} ${n(-h / 2)} ${w} ${h}" width="${w}" height="${h}">
  <rect${attrs({ x: n(-w / 2), y: n(-h / 2), width: w, height: h, fill: background || '#ffffff' })}/>
${body}
</svg>
`;
}
