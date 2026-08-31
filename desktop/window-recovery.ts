import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App, BrowserWindow } from 'electron';

const GPU_CRASH_MARKER = 'gpu-crash-recovery.json';
const RELOAD_DELAY_MS = 100;
const RECOVERY_WINDOW_MS = 30_000;
const MAX_RECOVERIES_PER_WINDOW = 2;

type RecoveryApp = Pick<App, 'disableHardwareAcceleration' | 'getPath' | 'on' | 'off'>;
type ChildProcessGone = { type: string; reason: string; exitCode: number };
type RendererGone = { reason: string; exitCode: number };

interface RecoveryState {
  attempts: number;
  startedAt: number;
  pending: boolean;
}

const recoveryStates = new WeakMap<BrowserWindow, RecoveryState>();

function markerPath(app: Pick<App, 'getPath'>): string {
  return join(app.getPath('userData'), GPU_CRASH_MARKER);
}

function scheduleReload(win: BrowserWindow, source: string): void {
  if (win.isDestroyed()) return;
  const now = Date.now();
  const existing = recoveryStates.get(win);
  const state = !existing || now - existing.startedAt > RECOVERY_WINDOW_MS
    ? { attempts: 0, startedAt: now, pending: false }
    : existing;
  recoveryStates.set(win, state);
  if (state.pending || state.attempts >= MAX_RECOVERIES_PER_WINDOW) return;
  state.pending = true;
  state.attempts += 1;
  setTimeout(() => {
    state.pending = false;
    if (win.isDestroyed()) return;
    console.warn(`[desktop] reloading window after ${source}`);
    win.webContents.reload();
  }, RELOAD_DELAY_MS);
}

/** Consume a one-session Windows software-rendering fallback before app ready. */
export function applyWindowsGpuCrashFallback(
  app: RecoveryApp,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32' || !existsSync(markerPath(app))) return false;
  app.disableHardwareAcceleration();
  try { unlinkSync(markerPath(app)); } catch { /* retry fallback on the next launch */ }
  console.warn('[desktop] previous GPU crash detected; using software rendering for this session');
  return true;
}

/** Persist a Windows GPU failure for the next launch and repaint open windows now. */
export function installWindowsGpuCrashRecovery(
  app: RecoveryApp,
  getWindows: () => BrowserWindow[],
  platform: NodeJS.Platform = process.platform,
): () => void {
  if (platform !== 'win32') return () => {};
  const onGone = (_event: unknown, details: ChildProcessGone): void => {
    if (details.type !== 'GPU' || details.reason === 'clean-exit') return;
    try {
      writeFileSync(markerPath(app), JSON.stringify({
        reason: details.reason,
        exitCode: details.exitCode,
        at: new Date().toISOString(),
      }));
    } catch (error) {
      console.error('[desktop] failed to persist GPU recovery marker:', error);
    }
    for (const win of getWindows()) scheduleReload(win, `GPU process ${details.reason}`);
  };
  app.on('child-process-gone', onGone);
  return () => app.off('child-process-gone', onGone);
}

export function installWindowsRendererRecovery(
  win: BrowserWindow,
  platform: NodeJS.Platform = process.platform,
): () => void {
  if (platform !== 'win32' && process.env.CC_SMOKE_RENDERER_RECOVERY !== '1') return () => {};
  const onGone = (_event: unknown, details: RendererGone): void => {
    if (details.reason === 'clean-exit') return;
    console.error(`[desktop] renderer process gone: ${details.reason} (${details.exitCode})`);
    scheduleReload(win, `renderer ${details.reason}`);
  };
  win.webContents.on('render-process-gone', onGone);
  return () => {
    // The disposer runs from the window's own 'closed' handler, and by then
    // the window is destroyed: Electron's webContents getter THROWS
    // "Object has been destroyed" — an uncaught main-process exception that
    // pops a modal error dialog on every Windows window close (shipped in
    // v0.2.12; also the modal that deadlocked the CI smoke's teardown). A
    // destroyed window's listeners die with it, so there is nothing to
    // detach.
    if (!win.isDestroyed()) win.webContents.off('render-process-gone', onGone);
  };
}
