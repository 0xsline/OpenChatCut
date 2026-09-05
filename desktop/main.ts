import './chdir-first.ts';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
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
import { installDesktopUpdateIpc } from './update-ipc.ts';
import { supportsDirectDesktopUpdates } from './update-service.ts';
import { installDesktopInferenceIpc } from './native-inference-ipc.ts';
import { detectDesktopHardwareProfile } from './native-hardware-profile.ts';
import { installDirectoryWatchIpc } from './directory-watch-ipc.ts';
import {
  AGENT_IMPORT_ROOTS_KEY,
  importAgentPathsWithGrant,
} from './agent-path-import.ts';
import { getKey, setKeys } from '../server/keystore.ts';
import { AGENT_PATH_IMPORT_CHANNEL } from '../shared/directory-import.ts';
import { AGENT_LOCAL_MEDIA_CHANNEL } from '../shared/agent-local-media.ts';
import { browseLocalMedia } from './agent-local-media.ts';
import { modelCachePath } from '../shared/model-cache-path.ts';
import { isTranscriptWindowPayload, TRANSCRIPT_WINDOW_CHANNELS, type TranscriptWindowPayload } from '../shared/transcript-window.ts';
import {
  assertTrustedDesktopSenderUrl,
  resolveDesktopDevOrigin,
  resolveDesktopPageUrlDecision,
} from './page-origin.ts';
import type { DesktopPageUrlDecision, DesktopPageUrlSurface } from './page-origin.ts';
import { preparePackagedRuntime } from './packaged-runtime.ts';
import { focusExistingWindow } from './single-instance.ts';
import { requestProfileScopedSingleInstanceLock } from './runtime-profile.ts';
import { applyDesktopWindowFrame, desktopWindowFrameOptions } from './window-frame.ts';
import { applyResponsiveWindowScale, DESKTOP_UI_SCALE_MAX, DESKTOP_UI_SCALE_MIN, installResponsiveWindowScale, parseUserUiScale } from './window-scale.ts';
import { resolveInitialDesktopWindowBounds } from './window-scale.ts';
import {
  createExportDirectoryGrant,
  type ExportDirectoryGrantDescriptor,
} from '../server/export-destinations.ts';
import { resolveExportRevealTarget } from './export-reveal.ts';
import {
  persistExportDirectory,
  resolvePersistedExportDestination,
  restorePersistedExportDirectory,
  validatedDirectory,
  validDesktopExportFilename,
} from './export-directory-state.ts';
import { runDesktopSmokeProbe } from './smoke-probe.ts';
import { runtimeProfile } from '../server/runtime-profile.ts';
import {
  applyWindowsGpuCrashFallback,
  installWindowsGpuCrashRecovery,
  installWindowsRendererRecovery,
} from './window-recovery.ts';

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

function agentImportPickerDefaultPath(requestedPath: string): string {
  try {
    return existsSync(requestedPath) && statSync(requestedPath).isDirectory()
      ? requestedPath
      : dirname(requestedPath);
  } catch {
    return dirname(requestedPath);
  }
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
  let transcriptWindow: BrowserWindow | null = null;
  let transcriptPayload: TranscriptWindowPayload | null = null;
  const openTranscriptWindow = (payload: TranscriptWindowPayload): void => {
    transcriptPayload = payload;
    if (transcriptWindow && !transcriptWindow.isDestroyed()) {
      transcriptWindow.webContents.send(TRANSCRIPT_WINDOW_CHANNELS.update, payload);
      transcriptWindow.show();
      transcriptWindow.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 420,
      height: 560,
      minWidth: 300,
      minHeight: 220,
      backgroundColor: '#16161a',
      title: '文字稿',
      show: false,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        // The editor bridge heartbeat is a timer-driven long poll; without
        // this, Electron throttles background windows and the MCP bridge
        // drops offline (connected:false) while the window is minimized.
        backgroundThrottling: false,
      },
    });
    transcriptWindow = win;
    const uninstallRendererRecovery = installWindowsRendererRecovery(win);
    win.once('closed', () => {
      uninstallRendererRecovery();
      if (transcriptWindow === win) {
        transcriptWindow = null;
        transcriptPayload = null;
      }
    });
    installDesktopPageGuards(win, trustedOrigin);
    win.webContents.on('did-finish-load', () => {
      if (win.isDestroyed() || !transcriptPayload) return;
      win.webContents.send(TRANSCRIPT_WINDOW_CHANNELS.update, transcriptPayload);
      win.show();
    });
    void win.loadURL(`${trustedOrigin}/?transcript-window=1`);
  };
  // Pull path for the floating window: the did-finish-load push races the
  // page's IPC subscription (React mounts after locale/chunk loads), and a
  // lost push left the window permanently blank — the v0.2.12 Windows smoke
  // caught it as "transcript payload timed out".
  ipcMain.handle(TRANSCRIPT_WINDOW_CHANNELS.request, trustedDesktopHandler(trustedOrigin, () => transcriptPayload));
  ipcMain.handle(TRANSCRIPT_WINDOW_CHANNELS.open, trustedDesktopHandler(trustedOrigin, (_event, value: unknown) => {
    if (!isTranscriptWindowPayload(value)) throw new Error('invalid transcript window payload');
    openTranscriptWindow(value);
  }));
  ipcMain.handle('openchatcut:window-action', trustedDesktopHandler(trustedOrigin, (event, action: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof action !== 'string') return;
    if (action === 'close') win.close();
    else if (action === 'minimize') win.minimize();
    else if (action === 'toggle-maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'apply-ui-scale') {
      applyResponsiveWindowScale(win);
    }
  }));
  // Zoom accelerators (issue #85): step the saved UI scale and re-apply.
  ipcMain.handle('openchatcut:zoom-step', trustedDesktopHandler(trustedOrigin, async (event, step: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (step !== 'reset' && (typeof step !== 'number' || step === 0)) throw new Error('invalid zoom step');
    const current = parseUserUiScale(getKey('UI_SCALE' as never));
    const next = step === 'reset'
      ? 1
      : Math.min(DESKTOP_UI_SCALE_MAX, Math.max(DESKTOP_UI_SCALE_MIN, Math.round((current + step) * 100) / 100));
    await setKeys({ UI_SCALE: String(next) });
    applyResponsiveWindowScale(win);
    win.webContents.send('openchatcut:ui-scale-changed', next);
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
  installDesktopUpdateIpc(origin, {
    enabled: supportsDirectDesktopUpdates({
      packaged: app.isPackaged,
      smoke: SMOKE,
      platform: process.platform,
    }),
  });
  installDirectoryWatchIpc(origin);
  ipcMain.handle(AGENT_LOCAL_MEDIA_CHANNEL, trustedDesktopHandler(origin,
    async (_event, request: unknown) => browseLocalMedia(request)));
  ipcMain.handle(AGENT_PATH_IMPORT_CHANNEL, trustedDesktopHandler(origin, async (event, request: unknown) => {
    const value = request as { paths?: unknown; projectId?: unknown; knownHashes?: unknown };
    const paths = Array.isArray(value?.paths)
      ? value.paths.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0 && entry.length < 4096)
      : [];
    const knownHashes = Array.isArray(value?.knownHashes)
      ? value.knownHashes.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 128)
      : [];
    if (!paths.length || paths.length > 100 || paths.length !== (value.paths as unknown[]).length
      || typeof value?.projectId !== 'string') {
      throw new Error('invalid agent path import request');
    }
    return importAgentPathsWithGrant({ paths, projectId: value.projectId, knownHashes }, {
      chooseRoot: async (requestedPath) => {
        const parent = BrowserWindow.fromWebContents(event.sender);
        const options: OpenDialogOptions = {
          title: '选择允许 Agent 访问的素材文件夹',
          defaultPath: agentImportPickerDefaultPath(requestedPath),
          properties: ['openDirectory'],
        };
        const selected = parent
          ? await dialog.showOpenDialog(parent, options)
          : await dialog.showOpenDialog(options);
        return selected.canceled ? null : (selected.filePaths[0] ?? null);
      },
      readRoots: () => getKey(AGENT_IMPORT_ROOTS_KEY as never),
      writeRoots: (roots) => setKeys({ [AGENT_IMPORT_ROOTS_KEY]: roots }),
    });
  }));
  const hardware = await detectDesktopHardwareProfile(app);
  const desktopInference = installDesktopInferenceIpc(
    origin,
    modelCachePath(app.getPath('home')),
    hardware,
  );
  app.once('before-quit', () => desktopInference.dispose());
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
      // Same heartbeat reasoning as the transcript window above.
      backgroundThrottling: false,
    },
  });
  applyDesktopWindowFrame(win);
  installResponsiveWindowScale(win);
  const uninstallRendererRecovery = installWindowsRendererRecovery(win);
  mainWindow = win;
  win.once('closed', () => {
    uninstallRendererRecovery();
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
    await runDesktopSmokeProbe(origin, win, SMOKE_RENDER);
    console.log('SMOKE-OK');
    exitSmoke(0);
  }
}

/**
 * On Windows, after forced renderer crashes, BOTH in-process exits have been
 * observed to wedge: app.exit() (v0.2.12 CI run 3) and even process.exit
 * following it (same run — the process survived to the external 420s kill).
 * So: arm an EXTERNAL kill on failure codes first, then process.exit
 * directly — app.exit posts through Chromium's message loop, which is
 * exactly the thing that deadlocks, and a smoke process has nothing worth a
 * graceful quit. The CI step treats a printed SMOKE-OK as the pass signal,
 * so a post-success wedge cannot fail the build.
 */
function exitSmoke(code: number): void {
  // Failure only: taskkill terminates with its own nonzero status, which
  // must never be able to turn a SMOKE-OK exit 0 into a failure.
  if (code !== 0 && process.platform === 'win32') {
    try {
      spawn('taskkill', ['/T', '/F', '/PID', String(process.pid)], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } catch {
      // process.exit below remains the only path.
    }
  }
  process.exit(code);
}

app.on('window-all-closed', () => app.quit());

const hasSingleInstanceLock = requestProfileScopedSingleInstanceLock(app, runtimeProfile());
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  applyWindowsGpuCrashFallback(app);
  installWindowsGpuCrashRecovery(app, () => BrowserWindow.getAllWindows());
  app.on('second-instance', () => {
    if (mainWindow) focusExistingWindow(mainWindow);
  });
}

if (SMOKE) {
  // No .unref(): in the Electron main process an unref'd timer is not
  // guaranteed to ever fire — Node's loop is polled through Chromium's message
  // pump, and with no ref'd handles the poll can starve. The v0.2.12 Windows
  // smoke hung for 105 minutes on a 240s watchdog that never fired. A ref'd
  // timer does not block app.exit(0) on the success path, so there is nothing
  // to unref for.
  setTimeout(() => {
    console.error(`smoke timed out after ${SMOKE_TIMEOUT_MS}ms`);
    exitSmoke(2);
  }, SMOKE_TIMEOUT_MS);
  // Pre-armed EXTERNAL watchdog: the Windows main process has wedged so hard
  // during smoke (crashed-renderer teardown) that timers, microtasks, and
  // both in-process exits all stopped — the setTimeout above never even
  // logged. A detached helper is immune to that. On a clean exit our PID is
  // gone before the helper fires and the kill is a no-op; CI reaps the
  // helper as an orphan.
  if (process.platform === 'win32') {
    try {
      const graceSeconds = Math.ceil(SMOKE_TIMEOUT_MS / 1000) + 60;
      const helper = spawn('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Start-Sleep -Seconds ${graceSeconds}; taskkill /T /F /PID ${process.pid}`,
      ], { detached: true, stdio: 'ignore' });
      helper.unref();
      // The pid line is diagnostic: run 6's helper never fired and this says
      // whether it even spawned.
      console.log(`[smoke] external watchdog armed: helper pid ${helper.pid ?? 'SPAWN FAILED'}, fires in ${graceSeconds}s`);
    } catch (error) {
      console.error('[smoke] external watchdog spawn failed:', error instanceof Error ? error.message : String(error));
    }
  }
}

if (hasSingleInstanceLock) {
  boot().catch((err) => {
    console.error('[desktop] boot failed:', err instanceof Error ? err.stack ?? err.message : err);
    if (SMOKE) exitSmoke(1);
    else app.exit(1);
  });
}
