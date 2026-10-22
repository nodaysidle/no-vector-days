/**
 * VectorStudio desktop shell (Electron / Chromium).
 * Replaces the WebKitGTK wrapper: WebKitGTK 2.54 on Wayland capped canvas updates at ~12-20 fps
 * on Intel Arc, while Chromium on the same machine renders the same page at the display refresh rate.
 *
 *   vectorstudio            run the app
 *   vectorstudio --test     smoke test: boot, exercise the engine, verify the Hyprland window, exit 0/1
 *   VECTORSTUDIO_PROBE=1    keystroke-test mode: seeds 5 layers and mirrors engine state into the window title
 */
const { app, BrowserWindow, protocol, net } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_ID = 'vectorstudio';
const IS_TEST = process.argv.includes('--test');
const IS_PROBE = process.env.VECTORSTUDIO_PROBE === '1';

function findAssetDir() {
  // Bundled assets first (repo checkout or packaged app), so a stale install never shadows them.
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
const SMOKE_TEST_JS = `(function () {
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

  const ok = added && undone && resized && resizeUndone && cleaned && rotSnapped && toolKept;
  return { ok, added, undone, resized, resizeUndone, cleaned, rotSnapped, toolKept, webgl: !!E.webglPipeline };
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
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
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
