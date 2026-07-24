import './chdir-first.ts';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import { startEmbeddedServer } from './embedded-server.ts';
import { preparePackagedRuntime } from './packaged-runtime.ts';

// Electron 主进程入口。dev 形态:esbuild 打到 desktop-dist/main.mjs,dist/ 在仓库根;
// 打包形态:dist/、remotion-bundle、chrome-headless-shell 走 extraResources。
const DIST_DIR = app.isPackaged
  ? join(process.resourcesPath, 'dist')
  : join(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const PRELOAD_PATH = join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs');

// CC_SMOKE=1:无窗冒烟——起内嵌 server、加载页面、探 /api/keys,按结果退码 0/1。
// CC_SMOKE_RENDER=1 追加真渲染探针(打包版验收:预打 bundle + 随包浏览器全链)。
const SMOKE = process.env.CC_SMOKE === '1';
const SMOKE_RENDER = process.env.CC_SMOKE_RENDER === '1';
const SMOKE_TIMEOUT_MS = SMOKE_RENDER ? 240_000 : 90_000;

function registerDesktopHandlers(): void {
  ipcMain.handle('openchatcut:select-directory', async (event, requestedPath: unknown) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const requested = typeof requestedPath === 'string' && isAbsolute(requestedPath)
      ? requestedPath
      : app.getPath('videos');
    const options: OpenDialogOptions = {
      title: '选择素材保存目录',
      defaultPath: requested,
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}

async function smokeProbe(origin: string, win: BrowserWindow): Promise<void> {
  const res = await fetch(`${origin}/api/keys`);
  if (!res.ok) throw new Error(`/api/keys → HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body !== 'object' || body === null) throw new Error('/api/keys returned non-object');
  const mcp = await fetch(`${origin}/api/external-mcp/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'desktop-smoke', version: '1' } },
    }),
  });
  if (!mcp.ok || !(await mcp.text()).includes('"name":"openchatcut"')) {
    throw new Error(`/api/external-mcp/mcp → HTTP ${mcp.status}`);
  }
  console.log('[smoke] external MCP endpoint ok');
  const pickerType = await win.webContents.executeJavaScript(
    'typeof window.openChatCutDesktop?.selectDirectory',
  ) as unknown;
  if (pickerType !== 'function') throw new Error('desktop directory picker preload is unavailable');
  console.log('[smoke] desktop directory picker preload ok');
  if (SMOKE_RENDER) {
    const state = { fps: 30, width: 640, height: 360, items: [], selectedId: null };
    const r = await fetch(`${origin}/render-still`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, frames: [0] }),
    });
    if (!r.ok) throw new Error(`/render-still → HTTP ${r.status}: ${await r.text()}`);
    const rendered = (await r.json()) as { frames?: Array<{ base64?: string }> };
    if (!rendered.frames?.[0]?.base64) throw new Error('/render-still returned no frame');
    console.log(`[smoke] render-still ok, base64 ${rendered.frames[0].base64.length}B`);
    // Remotion can emit late DevTools protocol callbacks after the response.
    // Give its browser cleanup a short drain window before Electron exits.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function boot(): Promise<void> {
  await app.whenReady();
  registerDesktopHandlers();
  if (app.isPackaged) {
    await preparePackagedRuntime({
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData'),
      version: app.getVersion(),
    });
  }
  const { origin } = await startEmbeddedServer(DIST_DIR);
  console.log(`[desktop] embedded server at ${origin}`);

  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    show: !SMOKE,
    backgroundColor: '#111111',
    title: 'OpenChatCut',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  await win.loadURL(`${origin}/`);

  if (SMOKE) {
    await smokeProbe(origin, win);
    console.log('SMOKE-OK');
    app.exit(0);
  }
}

app.on('window-all-closed', () => app.quit());

if (SMOKE) {
  setTimeout(() => {
    console.error('smoke timed out');
    app.exit(2);
  }, SMOKE_TIMEOUT_MS).unref();
}

boot().catch((err) => {
  console.error('[desktop] boot failed:', err instanceof Error ? err.stack ?? err.message : err);
  app.exit(1);
});
