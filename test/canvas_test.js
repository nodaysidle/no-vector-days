import assert from 'node:assert';
import { Camera } from '../app/src/camera.js';
import { SceneGraph } from '../app/src/scene.js';
import { HitTester } from '../app/src/hittest.js';
import { History } from '../app/src/history.js';
import { BezierMath } from '../app/src/bezier.js';
import { VectorPath } from '../app/src/path.js';
import { sceneToSVG } from '../app/src/svg-export.js';

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

console.log('\nAll Canvas Core & Vector Bézier Engine tests passed successfully!\n');
