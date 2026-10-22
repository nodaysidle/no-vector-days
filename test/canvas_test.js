import assert from 'node:assert';
import { Camera } from '../app/src/camera.js';
import { SceneGraph } from '../app/src/scene.js';
import { HitTester } from '../app/src/hittest.js';
import { History } from '../app/src/history.js';
import { BezierMath } from '../app/src/bezier.js';
import { VectorPath } from '../app/src/path.js';
import { sceneToSVG } from '../app/src/svg-export.js';
import { parsePathData, parseTransform, arcToCubics, subpathToAnchors, apply } from '../app/src/svg-import.js';

console.log('--- Running Canvas Core & Vector Bézier Engine Tests ---');

// 1. Camera Transformation Tests
console.log('1. Testing Camera coordinate transformations...');
const cam = new Camera(100, 50, 2.0);

const world = cam.screenToWorld(200, 150);
assert.strictEqual(world.x, 50, 'screenToWorld X transformation');
assert.strictEqual(world.y, 50, 'screenToWorld Y transformation');

const screen = cam.worldToScreen(50, 50);
assert.strictEqual(screen.x, 200, 'worldToScreen X transformation');
assert.strictEqual(screen.y, 150, 'worldToScreen Y transformation');

// Test Zoom Anchor Invariance
const pointerScreenX = 400;
const pointerScreenY = 300;
const beforeWorld = cam.screenToWorld(pointerScreenX, pointerScreenY);
cam.zoomAt(1.5, pointerScreenX, pointerScreenY);
const afterWorld = cam.screenToWorld(pointerScreenX, pointerScreenY);

assert.ok(Math.abs(beforeWorld.x - afterWorld.x) < 0.0001, 'Zoom keeps anchor point world X invariant');
assert.ok(Math.abs(beforeWorld.y - afterWorld.y) < 0.0001, 'Zoom keeps anchor point world Y invariant');
console.log('✓ Camera transformations verified.');

// 2. Bézier Curve Mathematical Engine Tests
console.log('2. Testing Bézier Math calculations...');
const p0 = { x: 0, y: 0 };
const cp1 = { x: 0, y: 100 };
const cp2 = { x: 100, y: 100 };
const p1 = { x: 100, y: 0 };

const startPt = BezierMath.evalCubic(p0, cp1, cp2, p1, 0);
assert.strictEqual(startPt.x, 0);
assert.strictEqual(startPt.y, 0);

const endPt = BezierMath.evalCubic(p0, cp1, cp2, p1, 1);
assert.strictEqual(endPt.x, 100);
assert.strictEqual(endPt.y, 0);

const midPt = BezierMath.evalCubic(p0, cp1, cp2, p1, 0.5);
assert.strictEqual(midPt.x, 50);
assert.strictEqual(midPt.y, 75);

// Distance to curve
const distClose = BezierMath.distToCubicBezier(50, 75, p0, cp1, cp2, p1);
assert.ok(distClose < 1.0, 'Point on curve has near-zero distance');

const distFar = BezierMath.distToCubicBezier(200, 200, p0, cp1, cp2, p1);
assert.ok(distFar > 100, 'Point far from curve has large distance');

// Bounding box
const bbox = BezierMath.cubicBoundingBox(p0, cp1, cp2, p1);
assert.ok(bbox.minX <= 0 && bbox.maxX >= 100);
assert.ok(bbox.minY <= 0 && bbox.maxY >= 75);
console.log('✓ Bézier Math verified.');

// 3. Vector Path Tests
console.log('3. Testing Vector Path model & SVG generation...');
const pathEl = new VectorPath({
  stroke: '#38bdf8',
  strokeWidth: 4,
  closed: true
});

pathEl.addAnchor(0, 0, null, { x: 0, y: 50 });
pathEl.addAnchor(100, 50, { x: 50, y: 50 }, { x: 150, y: 50 });
pathEl.addAnchor(100, 0, { x: 100, y: 25 }, null);

assert.strictEqual(pathEl.anchors.length, 3);
assert.ok(pathEl.width >= 100);

const svg = pathEl.toSVGPath();
assert.ok(svg.startsWith('M 0.00 0.00 C'));
assert.ok(svg.endsWith('Z'), 'Closed path ends with Z');

// Vector Hit Testing
assert.strictEqual(pathEl.hitTest(0, 0, 5), true, 'Hits anchor');
assert.strictEqual(pathEl.hitTest(50, 50, 8), true, 'Hits Bézier curve segment');
assert.strictEqual(pathEl.hitTest(500, 500, 5), false, 'Misses outside');

// Path Node hit testing
const nodeHit = HitTester.hitTestPathNodes(100, 50, pathEl, 1.0);
assert.deepStrictEqual(nodeHit, { target: 'anchor', index: 1 }, 'Hit second anchor');

const handleHit = HitTester.hitTestPathNodes(150, 50, pathEl, 1.0);
assert.deepStrictEqual(handleHit, { target: 'handleOut', index: 1 }, 'Hit handleOut of second anchor');
console.log('✓ Vector Path model & node hit testing verified.');

// 4. Scene Graph Serialization with Vector Paths
console.log('4. Testing Scene Graph serialization with Paths...');
const scene = new SceneGraph();
scene.addElement(pathEl);
scene.addElement({ type: 'rect', x: 200, y: 200, width: 80, height: 80 });

const json = scene.toJSON();
const restored = new SceneGraph();
restored.fromJSON(json);

assert.strictEqual(restored.elements.length, 2);
const restoredPath = restored.elements[0];
assert.strictEqual(restoredPath.type, 'path');
assert.strictEqual(restoredPath.anchors.length, 3);
assert.ok(typeof restoredPath.hitTest === 'function', 'Restored path maintains VectorPath methods');
console.log('✓ Scene Graph with Paths verified.');

// 5. History Command Stack Tests
console.log('5. Testing History Command Stack...');
const history = new History();
let val = 10;

history.push({
  undo: () => { val = 10; },
  redo: () => { val = 20; }
});
val = 20;

assert.strictEqual(history.canUndo(), true);
history.undo();
assert.strictEqual(val, 10, 'Undo restores state');
assert.strictEqual(history.canRedo(), true);
history.redo();
assert.strictEqual(val, 20, 'Redo reapplies state');
console.log('✓ History stack verified.');

// SVG Export
console.log('Testing SVG export...');
const svgScene = new SceneGraph();
svgScene.addElement({ type: 'text', x: 0, y: 0, width: 100, height: 40, text: 'A & <b>\nline2', fill: '#000000"><script>' });
svgScene.addElement({ type: 'rect', x: 0, y: 0, width: 100, height: 50, rotation: Math.PI / 2, radius: 8 });
svgScene.addElement({ type: 'star', x: 0, y: 0, width: 100, height: 100 });
svgScene.addElement({ type: 'arrow', x: 0, y: 0, width: 100, height: 20, strokeWidth: 2 });
const svgPath = new VectorPath({ closed: false, opacity: 0.5 });
svgPath.addAnchor(0, 0);
svgPath.addAnchor(10, 10);
svgScene.addElement(svgPath);
const exported = sceneToSVG(svgScene);
assert.ok(exported.includes('A &amp; &lt;b&gt;'), 'text content is escaped');
assert.ok(!exported.includes('<script>'), 'attribute values are escaped');
assert.strictEqual((exported.match(/<tspan/g) || []).length, 2, 'multi-line text becomes tspans');
assert.ok(exported.includes('transform="rotate(90 50 25)"'), 'rotation is exported');
assert.ok(exported.includes('rx="8"'), 'rect corner radius is exported');
assert.strictEqual((exported.match(/<polygon/g) || []).length, 2, 'star and arrow head export as polygons');
assert.ok(exported.includes('fill="none"') && exported.includes('opacity="0.5"'), 'open path has no fill and keeps opacity');
assert.strictEqual(new VectorPath(svgPath.toJSON()).opacity, 0.5, 'path opacity survives JSON round-trip');
console.log('✓ SVG export verified.');

// SVG import helpers (the DOM walk itself is covered by the desktop smoke test)
console.log('Testing SVG import...');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);
const sq = parsePathData('M10 10h20v20H10z m5 5 l1 1');
assert.strictEqual(sq.length, 2, 'z then m starts a second subpath');
assert.strictEqual(sq[0].closed, true);
assert.deepStrictEqual(sq[1].start, { x: 15, y: 15 }, 'relative m after z is relative to the subpath start');
assert.deepStrictEqual(parsePathData('M0 0 1 1 2 0')[0].segs.map(s => s.p), [{ x: 1, y: 1 }, { x: 2, y: 0 }], 'extra M pairs are line-tos');
assert.deepStrictEqual(parsePathData('M1.5.5-2-3')[0].start, { x: 1.5, y: 0.5 }, 'compact numbers');
const arc = parsePathData('M0 0a10 10 0 00 20 0')[0];
assert.strictEqual(arc.segs.length, 2, 'half circle with compact flags becomes two cubics');
near(arc.segs[1].p.x, 20, 'arc ends at its endpoint');
const half = arcToCubics({ x: 0, y: 0 }, 10, 10, 0, 0, 1, { x: 20, y: 0 });
near(half[0].p.x, 10, 'sweep=1 arc passes x=10');
near(half[0].p.y, -10, 'sweep=1 arc goes up in SVG coordinates');
const qd = parsePathData('M0 0Q10 10 20 0T40 0')[0].segs;
near(qd[0].c1.x, 20 / 3, 'quadratic converts to cubic');
near(qd[1].c1.y, -20 / 3, 'T reflects the previous control point');
const m = parseTransform('translate(10 5) rotate(90) scale(2)');
const pt = apply(m, { x: 1, y: 0 });
near(pt.x, 10, 'transforms compose left to right');
near(pt.y, 7, 'transforms compose left to right');
const closedAnchors = subpathToAnchors(parsePathData('M0 0C5 -5 15 -5 20 0L10 10L0 0Z')[0], [1, 0, 0, 1, 0, 0]);
assert.strictEqual(closedAnchors.length, 3, 'closing point on the start is merged');
assert.throws(() => parsePathData('M0 0 L x'), /Bad path data/);
const square = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]].map(([px, py]) => ({ x: px, y: py }));
const ring = new VectorPath({ anchors: square(0, 0, 100), closed: true, fill: '#000000', subpaths: [{ anchors: square(25, 25, 50), closed: true }], fillRule: 'evenodd' });
assert.strictEqual(ring.hitTest(10, 50), true, 'compound path: the band is a hit');
assert.strictEqual(ring.hitTest(50, 50), false, 'compound path: the hole is not a hit');
assert.strictEqual((ring.toSVGPath().match(/M/g) || []).length, 2, 'compound path exports both outlines');
ring.translate(10, 5);
assert.deepStrictEqual([ring.subpaths[0].anchors[0].x, ring.subpaths[0].anchors[0].y, ring.x], [35, 30, 10], 'translate moves every outline and the bounds');
const ringCopy = new VectorPath(JSON.parse(JSON.stringify(ring.toJSON())));
assert.strictEqual(ringCopy.subpaths.length, 1, 'subpaths survive a JSON round trip');
assert.strictEqual(ringCopy.fillRule, 'evenodd', 'fill rule survives a JSON round trip');
const ringScene = new SceneGraph();
ringScene.addElement(ring);
assert.ok(sceneToSVG(ringScene).includes('fill-rule="evenodd"'), 'fill rule is exported');
const gradScene = new SceneGraph();
gradScene.addElement({ type: 'rect', x: 0, y: 0, width: 200, height: 100, fill: { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff', opacity: 0.5 }] } });
gradScene.addElement({ type: 'circle', x: 0, y: 0, width: 100, height: 50, fill: { type: 'radial', cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, fx: 0.5, fy: 0.5, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] } });
gradScene.addElement({ type: 'arrow', x: 0, y: 0, width: 100, height: 20, stroke: '', fill: { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ offset: 0, color: '#00ff00' }] } });
const gradSvg = sceneToSVG(gradScene);
assert.ok(gradSvg.includes('<linearGradient id="grad1" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="200" y2="0">'), 'linear gradient exported in user space');
assert.ok(gradSvg.includes('stop-opacity="0.5"'), 'stop opacity exported');
assert.ok(gradSvg.includes('fill="url(#grad1)"') && gradSvg.includes('fill="url(#grad2)"'), 'shapes reference their gradients');
assert.ok(gradSvg.includes('gradientTransform="translate(50 25) scale(50 25)"'), 'radial gradient keeps its ellipse');
assert.ok(gradSvg.includes('stroke="#00ff00"'), 'lines fall back to the first stop colour');
assert.strictEqual(JSON.parse(gradScene.toJSON()).elements[0].fill.stops.length, 2, 'gradient fills survive JSON');
console.log('✓ SVG import helpers verified.');

console.log('\nAll Canvas Core & Vector Bézier Engine tests passed successfully!\n');
