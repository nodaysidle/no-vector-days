/**
 * VectorStudio desktop shell (Electron / Chromium).
 * Replaces the WebKitGTK wrapper: WebKitGTK 2.54 on Wayland capped canvas updates at ~12-20 fps
 * on Intel Arc, while Chromium on the same machine renders the same page at the display refresh rate.
 *
 *   vectorstudio            run the app
 *   vectorstudio --test     smoke test: boot, exercise the engine, verify the Hyprland window, exit 0/1
 *   VECTORSTUDIO_PROBE=1    keystroke-test mode: seeds 5 layers and mirrors engine state into the window title
 */
const { app, BrowserWindow, dialog, ipcMain, protocol, net } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_ID = 'vectorstudio';
const IS_TEST = process.argv.includes('--test');
const IS_PROBE = process.env.VECTORSTUDIO_PROBE === '1';

function findAssetDir() {
  // Assets next to this file first (repo checkout, install.sh copy or AppImage), so another copy never shadows them.
  const candidates = [
    process.env.VECTORSTUDIO_ASSETS,
    path.join(__dirname, 'app'),
    path.join(os.homedir(), '.local/share/vectorstudio/app'),
    '/usr/share/vectorstudio/app'
  ];
  const dir = candidates.find(c => c && fs.existsSync(path.join(c, 'index.html')));
  if (!dir) throw new Error('Could not locate VectorStudio web assets (index.html)');
  return path.resolve(dir);
}

// Exercises the real engine: add/undo, drag-resize through pointer events, shift-rotate snapping, Ctrl+A.
const SMOKE_TEST_JS = `(async function () {
  const E = window.__engine;
  const before = E.scene.elements.length;
  E.addElement('rect', {});
  const added = E.scene.elements.length === before + 1;
  E.undo();
  const undone = E.scene.elements.length === before;

  const canvas = document.getElementById('vector-canvas');
  const box = canvas.getBoundingClientRect();
  const el = E.addElement('rect', { x: -100, y: -50, width: 200, height: 100, rotation: 0 });
  const from = E.camera.worldToScreen(100, 50);
  const fire = (type, target, x, y, extra = {}) => target.dispatchEvent(new PointerEvent(type, { clientX: box.left + x, clientY: box.top + y, bubbles: true, pointerId: 1, button: 0, ...extra }));
  fire('pointerdown', canvas, from.x, from.y);
  fire('pointermove', window, from.x + 40 * E.camera.zoom, from.y + 20 * E.camera.zoom);
  fire('pointerup', window, from.x + 40 * E.camera.zoom, from.y + 20 * E.camera.zoom);
  const resized = Math.round(el.width) === 240 && Math.round(el.height) === 120;
  E.undo();
  const resizeUndone = Math.round(el.width) === 200;
  E.undo();
  const cleaned = E.scene.elements.length === before;

  const rotEl = E.addElement('rect', { x: -100, y: -50, width: 200, height: 100, rotation: 0 });
  const rotFrom = E.camera.worldToScreen(0, -50 - 24 / E.camera.zoom);
  const rotTo = E.camera.worldToScreen(100, -20);
  fire('pointerdown', canvas, rotFrom.x, rotFrom.y);
  fire('pointermove', window, rotTo.x, rotTo.y, { shiftKey: true });
  fire('pointerup', window, rotTo.x, rotTo.y);
  const step = Math.PI / 12;
  const rotSnapped = rotEl.rotation !== 0 && Math.abs(rotEl.rotation / step - Math.round(rotEl.rotation / step)) < 1e-9;
  E.undo();
  E.undo();

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
  const toolKept = E.activeTool === 'SELECT';

  // Multi-selection: dragging either layer moves both, duplicate copies both, undo restores depth.
  const base = E.scene.elements.length;
  const a = E.addElement('rect', { x: -300, y: 200, width: 60, height: 60 });
  const b = E.addElement('rect', { x: -150, y: 200, width: 60, height: 60 });
  const c = E.addElement('rect', { x: 0, y: 200, width: 60, height: 60 });
  E.scene.select(a.id); E.scene.select(c.id, true);
  const grabC = E.camera.worldToScreen(30, 230);
  fire('pointerdown', canvas, grabC.x, grabC.y);
  fire('pointermove', window, grabC.x + 37 * E.camera.zoom, grabC.y + 41 * E.camera.zoom);
  fire('pointerup', window, grabC.x + 37 * E.camera.zoom, grabC.y + 41 * E.camera.zoom);
  const multiDrag = Math.round(a.x) === -263 && Math.round(c.x) === 37 && Math.round(a.y) === 241 && b.x === -150;
  E.undo();
  const multiDragUndone = a.x === -300 && c.x === 0;
  E.duplicateSelected();
  const multiDup = E.scene.elements.length === base + 5 && E.scene.selectedIds.size === 2;
  E.undo();
  E.scene.select(a.id); E.scene.select(b.id, true);
  const orderBefore = E.scene.elements.map(e => e.id).join();
  E.deleteSelected();
  E.undo();
  const deleteOrderKept = E.scene.elements.map(e => e.id).join() === orderBefore;
  E.undo(); E.undo(); E.undo();

  const desktopBridge = typeof window.vectorstudio?.saveFile === 'function';

  // SVG import: our own export round-trips, and a foreign file maps groups, transforms, <use>, classes and gradients.
  const { SceneGraph } = await import('./src/scene.js');
  const { sceneToSVG } = await import('./src/svg-export.js');
  const { importSVG } = await import('./src/svg-import.js');
  const parse = (text) => importSVG(new DOMParser().parseFromString(text, 'image/svg+xml'));
  const close = (x, y) => Math.abs(x - y) < 0.01;
  const src = new SceneGraph();
  src.setArtboard({ width: 800, height: 600, background: '#fafafa' });
  src.addElement({ type: 'rect', x: -100, y: -50, width: 200, height: 100, rotation: Math.PI / 6, radius: 12, fill: '#3d8bfd' });
  src.addElement({ type: 'circle', x: 50, y: 60, width: 80, height: 40, fill: '#f2c94c', stroke: '#1f2328', strokeWidth: 3 });
  src.addElement({ type: 'text', x: -300, y: -250, text: 'Hello\\nWorld', fontSize: 30, fill: '#1f2328' });
  const back = parse(sceneToSVG(src));
  const [br, bc, bt] = back.elements;
  const svgRoundTrip = back.artboard.width === 800 && back.artboard.background === '#fafafa' && back.elements.length === 3 &&
    br.type === 'rect' && close(br.x, -100) && close(br.width, 200) && close(br.rotation, Math.PI / 6) && close(br.radius, 12) &&
    bc.type === 'circle' && close(bc.x, 50) && close(bc.height, 40) && bc.strokeWidth === 3 &&
    bt.type === 'text' && bt.text === 'Hello\\nWorld' && close(bt.y, -250) && close(bt.fontSize, 30);
  const foreign = parse('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="400">' +
    '<style>.st0{fill:#ff0000}</style>' +
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#00ff00"/></linearGradient><path id="tri" d="M0 0L10 0L5 8Z"/></defs>' +
    '<g transform="translate(50 50)"><rect class="st0" x="-10" y="-10" width="20" height="20"/></g>' +
    '<circle cx="10" cy="10" r="5" fill="url(#g)"/>' +
    '<use xlink:href="#tri" x="80" y="80" fill="blue"/>' +
    '<path d="M0 90 Q 10 80 20 90" stroke="black" fill="none"/>' +
    '<rect width="10" height="10" transform="skewX(20)"/>' +
    '<image href="x.png" width="10" height="10"/>' +
    '<g style="display:none"><rect width="5" height="5"/></g></svg>');
  const f = foreign.elements;
  const svgForeign = foreign.artboard.width === 100 && f.length === 5 && foreign.skipped.image === 1 &&
    f[0].type === 'rect' && close(f[0].x, -10) && f[0].fill === '#ff0000' &&
    f[1].type === 'circle' && f[1].fill.type === 'linear' && f[1].fill.stops[0].color === '#00ff00' && close(f[1].x, -45) &&
    f[2].type === 'path' && f[2].fill === 'blue' && f[2].closed && close(f[2].anchors[0].x, 30) &&
    f[3].type === 'path' && !f[3].closed && f[3].fill === 'transparent' && f[3].stroke === 'black' &&
    f[4].type === 'path' && f[4].anchors.length === 4;
  // Gradients: export → import keeps type, geometry and stops (in element-box fractions).
  const grad = new SceneGraph();
  grad.addElement({ type: 'rect', x: -100, y: -50, width: 200, height: 100, rotation: 0.4, fill: { type: 'linear', x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.7, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff', opacity: 0.5 }] } });
  grad.addElement({ type: 'circle', x: 0, y: 0, width: 120, height: 60, fill: { type: 'radial', cx: 0.4, cy: 0.5, rx: 0.6, ry: 0.3, fx: 0.3, fy: 0.5, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] } });
  const [gl, gr] = parse(sceneToSVG(grad)).elements;
  const svgGradients = gl.fill.type === 'linear' && close(gl.fill.x1, 0.1) && close(gl.fill.y2, 0.7) && gl.fill.stops[1].opacity === 0.5 &&
    gr.fill.type === 'radial' && close(gr.fill.cx, 0.4) && close(gr.fill.rx, 0.6) && close(gr.fill.ry, 0.3) && close(gr.fill.fx, 0.3);
  E.loadJSON(JSON.stringify(foreign));
  const svgLoaded = E.scene.elements.length === 5;

  const ok = added && undone && resized && resizeUndone && cleaned && rotSnapped && toolKept && multiDrag && multiDragUndone && multiDup && deleteOrderKept && desktopBridge && svgRoundTrip && svgForeign && svgGradients && svgLoaded;
  return { ok, desktopBridge, svgRoundTrip, svgForeign, svgGradients, svgLoaded, added, undone, resized, resizeUndone, cleaned, rotSnapped, toolKept, multiDrag, multiDragUndone, multiDup, deleteOrderKept, webgl: !!E.webglPipeline };
})()`;

// Seeds a known scene and reports "probe:<layers>:<tool>:<selected>" in the title after each key release.
const PROBE_JS = `(function () {
  const E = window.__engine;
  for (let i = 0; i < 5; i++) E.scene.addElement({ type: 'rect', x: i * 40, y: 0, width: 30, height: 30 });
  E.scene.select(E.scene.elements[0].id);
  const report = () => setTimeout(() => {
    document.title = 'probe:' + E.scene.elements.length + ':' + E.activeTool + ':' + E.scene.selectedIds.size;
  }, 0);
  window.addEventListener('keyup', report);
  report();
})()`;

if (IS_TEST || IS_PROBE) {
  // Fresh profile so autosave from real use never leaks into tests (and vice versa).
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'vectorstudio-test-')));
}
app.setName(APP_ID);
app.setDesktopName(`${APP_ID}.desktop`);
app.commandLine.appendSwitch('class', APP_ID);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForEngine(win) {
  for (let i = 0; i < 50; i++) {
    if (await win.webContents.executeJavaScript('!!window.__engine')) return true;
    await sleep(100);
  }
  return false;
}

// The compositor may resize a new window just after it maps; pointer checks need a settled canvas and camera.
async function waitForStableLayout(win) {
  const probe = `(() => { const r = document.getElementById('vector-canvas').getBoundingClientRect(); return [r.width, r.height, window.__engine.camera.zoom].join(); })()`;
  let last = null;
  let stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    const now = await win.webContents.executeJavaScript(probe);
    stable = now === last ? stable + 1 : 0;
    last = now;
    await sleep(100);
  }
}

function hyprWindow() {
  try {
    const clients = JSON.parse(execFileSync('hyprctl', ['clients', '-j'], { encoding: 'utf8', timeout: 1500 }));
    return clients.find(c => c.class === APP_ID || c.initialClass === APP_ID) || null;
  } catch {
    return null;
  }
}

async function runSmokeTest(win, errors) {
  const engineReady = await waitForEngine(win);
  if (engineReady) await waitForStableLayout(win);
  const result = engineReady
    ? await win.webContents.executeJavaScript(SMOKE_TEST_JS).catch(err => ({ ok: false, reason: err.message }))
    : { ok: false, reason: 'engine missing' };
  result.errors = errors;

  let client = null;
  for (let i = 0; i < 30 && !client; i++) {
    client = hyprWindow();
    if (!client) await sleep(150);
  }
  console.log(`[VectorStudio] JS smoke test: ${JSON.stringify(result)}`);
  if (client) console.log(`[VectorStudio] Verified window mapped in Hyprland: class=${client.class} xwayland=${client.xwayland}`);

  const passed = result.ok && errors.length === 0 && client && !client.xwayland;
  console.log(passed
    ? '[VectorStudio] TEST PASSED: native Wayland window mapped in Hyprland and engine smoke test passed.'
    : `[VectorStudio] TEST FAILED (mapped=${!!client}, xwayland=${client?.xwayland}, smoke_ok=${result.ok}, errors=${errors.length}).`);
  app.exit(passed ? 0 : 1);
}

const JSON_FILTERS = [{ name: 'VectorStudio design', extensions: ['json'] }];

// The renderer may only write back to files the user picked in one of these dialogs.
function registerFileHandlers(win) {
  const granted = new Set();
  ipcMain.handle('file:open', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      filters: [{ name: 'Designs and SVG', extensions: ['json', 'svg'] }, ...JSON_FILTERS, { name: 'SVG image', extensions: ['svg'] }],
      properties: ['openFile']
    });
    if (canceled || !filePaths.length) return null;
    granted.add(filePaths[0]);
    return { path: filePaths[0], text: await fs.promises.readFile(filePaths[0], 'utf8') };
  });
  ipcMain.handle('file:save', async (_e, text, filePath) => {
    if (typeof text !== 'string') throw new Error('Document must be text');
    let target = granted.has(filePath) ? filePath : null;
    if (!target) {
      const { canceled, filePath: chosen } = await dialog.showSaveDialog(win, { defaultPath: 'design.json', filters: JSON_FILTERS });
      if (canceled || !chosen) return null;
      target = chosen;
      granted.add(target);
    }
    await fs.promises.writeFile(target, text, 'utf8');
    return target;
  });
}

app.whenReady().then(() => {
  const assets = findAssetDir();
  protocol.handle('app', (request) => {
    const file = path.resolve(assets, '.' + decodeURIComponent(new URL(request.url).pathname));
    if (!file.startsWith(assets + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'VectorStudio',
    backgroundColor: '#1b1c1f',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'vectorstudio.svg'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') }
  });
  registerFileHandlers(win);
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const errors = [];
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(e.message);
  });
  win.webContents.on('render-process-gone', (_e, details) => errors.push(`renderer gone: ${details.reason}`));

  if (IS_TEST) {
    setTimeout(() => {
      console.log('[VectorStudio] TEST FAILED: timed out.');
      app.exit(1);
    }, 15000);
    win.webContents.once('did-finish-load', () => runSmokeTest(win, errors));
  }
  if (IS_PROBE) {
    win.webContents.once('did-finish-load', async () => {
      if (await waitForEngine(win)) win.webContents.executeJavaScript(PROBE_JS);
    });
  }

  win.loadURL('app://vectorstudio/index.html');
});

app.on('window-all-closed', () => app.quit());
