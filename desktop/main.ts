import './chdir-first.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  shell,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import { buildTextContextMenuTemplate } from './context-menu.ts';
import { startEmbeddedServer } from './embedded-server.ts';
import { createTransparentMovProxy, importLocalMedia } from './local-media-import.ts';
import {
  createLocalMediaImportHandler,
  LOCAL_MEDIA_IMPORT_CHANNEL,
} from './local-media-bridge.ts';
import { installProjectStoreIpc } from './project-store-ipc.ts';
import { installEditorAuthIpc } from './editor-auth-ipc.ts';
import {
  assertTrustedDesktopSenderUrl,
  resolveDesktopDevOrigin,
  resolveDesktopPageUrlDecision,
} from './page-origin.ts';
import type { DesktopPageUrlDecision, DesktopPageUrlSurface } from './page-origin.ts';
import { preparePackagedRuntime } from './packaged-runtime.ts';
import { focusExistingWindow } from './single-instance.ts';
import { applyDesktopWindowFrame, desktopWindowFrameOptions } from './window-frame.ts';
import { installResponsiveWindowScale, resolveInitialDesktopWindowBounds } from './window-scale.ts';
import {
  createExportDirectoryGrant,
  type ExportDirectoryGrantDescriptor,
} from '../server/export-destinations.ts';
import { resolveExportRevealTarget } from './export-reveal.ts';
import { externalMcpToken } from '../server/editor-auth.ts';

// Electron main process entry. dev mode: esbuild hits desktop-dist/main.mjs,dist/ in the codebase root;
// Packaging form: dist/, resonance-bundle, chrome-headless-shell use extraResources.
const DIST_DIR = app.isPackaged
  ? join(process.resourcesPath, 'dist')
  : join(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const PRELOAD_PATH = join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs');

// Remotion renders export frames inside this process (main + headless tabs).
// Raise the V8 heap ceiling so large/4K exports don't die with "out of memory"
// (issue #40). Must run before app 'ready'; js-flags apply to every V8 instance.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=6144');

// CC_SMOKE=1: No window smoke - start the embedded server, load the page, explore /api/keys, and return the code 0/1 according to the result.
// CC_SMOKE_RENDER=1 adds a true rendering probe (packaged version acceptance: pre-bundled + full browser link included in the package).
const SMOKE = process.env.CC_SMOKE === '1';
const SMOKE_RENDER = process.env.CC_SMOKE_RENDER === '1';
const SMOKE_TIMEOUT_MS = SMOKE_RENDER ? 240_000 : 90_000;
let mainWindow: BrowserWindow | null = null;

interface StoredExportDirectory {
  version: 2;
  currentDestinationId: string;
  destinations: Array<{
    destinationId: string;
    path: string;
  }>;
}

interface ExportDirectoryState {
  currentPath: string | null;
  destinations: StoredExportDirectory['destinations'];
}

const DESKTOP_DESTINATION_ID = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_STORED_EXPORT_DESTINATIONS = 256;
const MAX_EXPORT_DESTINATION_STATE_BYTES = 512 * 1_024;
const INVALID_DESKTOP_EXPORT_FILENAME = /[/\\:*?"<>|]/;
const RESERVED_DESKTOP_EXPORT_FILENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

type DesktopIpcHandler = Parameters<typeof ipcMain.handle>[1];

function trustedDesktopHandler(
  trustedOrigin: string,
  handler: DesktopIpcHandler,
): DesktopIpcHandler {
  return (event, ...args) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    return handler(event, ...args);
  };
}

function handOffExternalUrl(decision: DesktopPageUrlDecision): void {
  if (decision.action !== 'open-external') return;
  void shell.openExternal(decision.url).catch((error: unknown) => {
    console.error('[desktop] failed to open external URL:', error);
  });
}

function installDesktopPageGuards(win: BrowserWindow, trustedOrigin: string): void {
  const guardNavigation = (surface: Extract<DesktopPageUrlSurface, 'navigation' | 'redirect'>) => (
    event: { preventDefault(): void },
    requestedUrl: string,
  ): void => {
    const decision = resolveDesktopPageUrlDecision(requestedUrl, trustedOrigin, surface);
    if (decision.action === 'allow') return;
    event.preventDefault();
    handOffExternalUrl(decision);
  };

  win.webContents.on('will-navigate', guardNavigation('navigation'));
  win.webContents.on('will-redirect', guardNavigation('redirect'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    const decision = resolveDesktopPageUrlDecision(url, trustedOrigin, 'popup');
    handOffExternalUrl(decision);
    return { action: 'deny' };
  });
}

async function validatedDirectory(value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || !isAbsolute(value)) return null;
  const path = await realpath(value).catch(() => null);
  if (!path) return null;
  const info = await stat(path).catch(() => null);
  return info?.isDirectory() ? path : null;
}

function validDesktopExportFilename(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || value === '.' || value === '..' || basename(value) !== value) return false;
  if (new TextEncoder().encode(value).byteLength > 240
    || INVALID_DESKTOP_EXPORT_FILENAME.test(value)
    || /[. ]$/.test(value)
    || RESERVED_DESKTOP_EXPORT_FILENAME.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

async function readExportDirectoryState(statePath: string): Promise<ExportDirectoryState | null> {
  try {
    const info = await stat(statePath);
    if (!info.isFile() || info.size > MAX_EXPORT_DESTINATION_STATE_BYTES) {
      throw new Error('invalid export destination state');
    }
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as unknown;
    if (typeof stored !== 'object' || stored === null) throw new Error('invalid export destination');
    const version = 'version' in stored ? stored.version : undefined;
    if (version === 1) {
      const legacyPath = 'path' in stored ? stored.path : undefined;
      return {
        currentPath: typeof legacyPath === 'string' ? legacyPath : null,
        destinations: [],
      };
    }
    const currentDestinationId = 'currentDestinationId' in stored
      ? stored.currentDestinationId
      : undefined;
    const rawDestinations = 'destinations' in stored ? stored.destinations : undefined;
    if (version !== 2 || typeof currentDestinationId !== 'string'
      || !Array.isArray(rawDestinations)) {
      throw new Error('unsupported export destination version');
    }
    const destinations = rawDestinations.flatMap((entry): StoredExportDirectory['destinations'] => {
      if (!entry || typeof entry !== 'object') return [];
      const destinationId = 'destinationId' in entry ? entry.destinationId : undefined;
      const path = 'path' in entry ? entry.path : undefined;
      if (typeof destinationId !== 'string'
        || !DESKTOP_DESTINATION_ID.test(destinationId)
        || typeof path !== 'string'
        || !isAbsolute(path)) return [];
      return [{ destinationId, path }];
    }).slice(0, MAX_STORED_EXPORT_DESTINATIONS);
    const currentPath = destinations.find(
      (entry) => entry.destinationId === currentDestinationId,
    )?.path ?? null;
    return { currentPath, destinations };
  } catch {
    return null;
  }
}

async function persistExportDirectory(
  statePath: string,
  path: string,
  destinationId: string,
  previousState?: ExportDirectoryState | null,
): Promise<void> {
  if (!DESKTOP_DESTINATION_ID.test(destinationId)) throw new Error('invalid export destination identity');
  const prior = previousState ?? await readExportDirectoryState(statePath);
  const destinations = [
    { destinationId, path },
    ...(prior?.destinations ?? []).filter((entry) => entry.destinationId !== destinationId),
  ].slice(0, MAX_STORED_EXPORT_DESTINATIONS);
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  const value: StoredExportDirectory = { version: 2, currentDestinationId: destinationId, destinations };
  await mkdir(dirname(statePath), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, statePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function restorePersistedExportDirectory(
  statePath: string,
): Promise<{ directory: string; state: ExportDirectoryState } | null> {
  const state = await readExportDirectoryState(statePath);
  if (!state?.currentPath) return null;
  const directory = await validatedDirectory(state.currentPath);
  return directory ? { directory, state } : null;
}

async function resolvePersistedExportDestination(
  statePath: string,
  destinationId: string,
): Promise<string | null> {
  if (!DESKTOP_DESTINATION_ID.test(destinationId)) return null;
  const state = await readExportDirectoryState(statePath);
  const storedPath = state?.destinations.find((entry) => entry.destinationId === destinationId)?.path;
  return storedPath ? validatedDirectory(storedPath) : null;
}

function registerDesktopHandlers(trustedOrigin: string): void {
  ipcMain.handle('openchatcut:select-directory', trustedDesktopHandler(trustedOrigin, async (event, requestedPath: unknown) => {
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
  }));
  const exportStatePath = join(app.getPath('userData'), 'export-destination.json');
  let activeExportDirectory: {
    directory: string;
    grant: ExportDirectoryGrantDescriptor;
  } | null = null;
  ipcMain.handle('openchatcut:select-export-directory', trustedDesktopHandler(trustedOrigin, async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: '选择导出目录',
      defaultPath: app.getPath('videos'),
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const directory = await validatedDirectory(result.filePaths[0]);
    if (!directory) throw new Error('所选导出目录不可用');
    const grant = createExportDirectoryGrant(directory);
    activeExportDirectory = { directory, grant };
    await persistExportDirectory(exportStatePath, directory, grant.grantId);
    return grant;
  }));
  ipcMain.handle('openchatcut:select-export-file', trustedDesktopHandler(trustedOrigin, async (
    event,
    suggestedFilename: unknown,
  ) => {
    if (!validDesktopExportFilename(suggestedFilename)) {
      throw new Error('invalid export filename');
    }
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: SaveDialogOptions = {
      title: '选择导出文件',
      defaultPath: join(app.getPath('videos'), suggestedFilename),
    };
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    const filename = basename(result.filePath);
    if (!validDesktopExportFilename(filename)) throw new Error('导出文件名无效');
    const directory = await validatedDirectory(dirname(result.filePath));
    if (!directory) throw new Error('所选导出目录不可用');
    const grant = createExportDirectoryGrant(directory);
    activeExportDirectory = { directory, grant };
    await persistExportDirectory(exportStatePath, directory, grant.grantId);
    return { ...grant, label: filename, filename };
  }));
  ipcMain.handle('openchatcut:restore-export-directory', trustedDesktopHandler(trustedOrigin, async () => {
    const restored = await restorePersistedExportDirectory(exportStatePath);
    if (!restored) return null;
    if (activeExportDirectory?.directory === restored.directory) {
      return activeExportDirectory.grant;
    }
    const grant = createExportDirectoryGrant(restored.directory);
    activeExportDirectory = { directory: restored.directory, grant };
    await persistExportDirectory(exportStatePath, restored.directory, grant.grantId, restored.state);
    return grant;
  }));
  ipcMain.handle(
    LOCAL_MEDIA_IMPORT_CHANNEL,
    trustedDesktopHandler(trustedOrigin, createLocalMediaImportHandler(importLocalMedia)),
  );
  ipcMain.handle('openchatcut:transparent-mov-proxy', trustedDesktopHandler(trustedOrigin, async (_event, storedName: unknown) => {
    if (typeof storedName !== 'string') throw new Error('invalid local media name');
    return createTransparentMovProxy(storedName);
  }));
  ipcMain.handle('openchatcut:window-action', trustedDesktopHandler(trustedOrigin, (event, action: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof action !== 'string') return;
    if (action === 'close') win.close();
    else if (action === 'minimize') win.minimize();
    else if (action === 'toggle-maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  }));
  ipcMain.handle('openchatcut:reveal-export', trustedDesktopHandler(trustedOrigin, async (
    _event,
    destinationId: unknown,
    filename: unknown,
  ) => {
    const target = await resolveExportRevealTarget(
      destinationId,
      filename,
      (identity) => resolvePersistedExportDestination(exportStatePath, identity),
    );
    if (!target) throw new Error('export destination is unavailable');
    if (target.candidate && existsSync(target.candidate)) {
      shell.showItemInFolder(target.candidate);
      return;
    }
    const error = await shell.openPath(target.directory);
    if (error) throw new Error(error);
  }));
}

async function smokeProbe(origin: string, win: BrowserWindow): Promise<void> {
  const res = await fetch(`${origin}/api/keys`);
  if (!res.ok) throw new Error(`/api/keys → HTTP ${res.status}`);
  const mcp = await fetch(`${origin}/api/external-mcp/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${externalMcpToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
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
  if (app.isPackaged) {
    await preparePackagedRuntime({
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData'),
      version: app.getVersion(),
    });
  }
  const devOrigin = resolveDesktopDevOrigin({
    configuredDevUrl: process.env.CC_DESKTOP_DEV_URL,
    packaged: app.isPackaged,
    smoke: SMOKE,
  });
  const origin = devOrigin ?? (await startEmbeddedServer(DIST_DIR)).origin;
  registerDesktopHandlers(origin);
  installProjectStoreIpc(origin);
  installEditorAuthIpc(origin);
  console.log(`[desktop] ${devOrigin ? 'live source' : 'embedded server'} at ${origin}`);

  const initialBounds = resolveInitialDesktopWindowBounds(screen.getPrimaryDisplay().workArea);
  const win = new BrowserWindow({
    ...initialBounds,
    show: !SMOKE,
    backgroundColor: '#111111',
    title: 'OpenChatCut',
    ...desktopWindowFrameOptions(),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  applyDesktopWindowFrame(win);
  installResponsiveWindowScale(win);
  mainWindow = win;
  win.once('closed', () => {
    mainWindow = null;
  });
  installDesktopPageGuards(win, origin);
  win.webContents.on('context-menu', (_event, params) => {
    const template = buildTextContextMenuTemplate(params);
    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
  await win.loadURL(`${origin}/`);

  if (SMOKE) {
    await smokeProbe(origin, win);
    console.log('SMOKE-OK');
    app.exit(0);
  }
}

app.on('window-all-closed', () => app.quit());

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) focusExistingWindow(mainWindow);
  });
}

if (SMOKE) {
  setTimeout(() => {
    console.error('smoke timed out');
    app.exit(2);
  }, SMOKE_TIMEOUT_MS).unref();
}

if (hasSingleInstanceLock) {
  boot().catch((err) => {
    console.error('[desktop] boot failed:', err instanceof Error ? err.stack ?? err.message : err);
    app.exit(1);
  });
}
