import type { BrowserWindowConstructorOptions } from 'electron';

type DesktopWindowFrameOptions = Pick<BrowserWindowConstructorOptions, 'titleBarStyle'>;

interface WindowButtonVisibilityHost {
  setWindowButtonVisibility(visible: boolean): void;
}

export function desktopWindowFrameOptions(
  platform: NodeJS.Platform = process.platform,
): DesktopWindowFrameOptions {
  return platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {};
}

export function applyDesktopWindowFrame(
  win: WindowButtonVisibilityHost,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'darwin') win.setWindowButtonVisibility(false);
}
