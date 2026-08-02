import type { BrowserWindow } from 'electron';

export const DESKTOP_MIN_SCALE = 2 / 3;
export const DESKTOP_INITIAL_WINDOW_RATIO = 0.7;
export const DESKTOP_INITIAL_WINDOW_ASPECT_RATIO = 3 / 2;
export const DESKTOP_INITIAL_WINDOW_MAX_HEIGHT_RATIO = 0.9;
// The expanded editor gives Preview 30% of content width. Preserve a complete
// 9:16 preview plus editor/preview headers and four standard Timeline rows.
const DESKTOP_PREVIEW_WIDTH_RATIO = 3 / 10;
const DESKTOP_EDITOR_HEADER_HEIGHT = 41;
const DESKTOP_PREVIEW_HEADER_HEIGHT = 30;
const DESKTOP_TIMELINE_MIN_HEIGHT = 288;

interface DesktopWindowScaleInput {
  baselineContentWidth: number;
  baselineContentHeight: number;
  contentWidth: number;
  contentHeight: number;
  frameWidth?: number;
  frameHeight?: number;
}

interface DesktopWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopWindowBounds extends DesktopWorkArea {}

export interface DesktopWindowScaleResolution {
  zoomFactor: number;
  minimumWindowSize: { width: number; height: number };
}

const validDimension = (value: number): number => Math.max(1, Math.round(value));

export function resolveInitialDesktopWindowBounds(
  workArea: DesktopWorkArea,
): DesktopWindowBounds {
  const workAreaWidth = validDimension(workArea.width);
  const workAreaHeight = validDimension(workArea.height);
  const preferredWidth = Math.round(workAreaWidth * DESKTOP_INITIAL_WINDOW_RATIO);
  const maximumHeight = Math.round(workAreaHeight * DESKTOP_INITIAL_WINDOW_MAX_HEIGHT_RATIO);
  const width = Math.min(
    preferredWidth,
    Math.round(maximumHeight * DESKTOP_INITIAL_WINDOW_ASPECT_RATIO),
  );
  const height = Math.round(width / DESKTOP_INITIAL_WINDOW_ASPECT_RATIO);

  return {
    x: Math.round(workArea.x + (workAreaWidth - width) / 2),
    y: Math.round(workArea.y + (workAreaHeight - height) / 2),
    width,
    height,
  };
}

export function resolveDesktopWindowScale({
  baselineContentWidth,
  baselineContentHeight,
  contentWidth,
  contentHeight,
  frameWidth = 0,
  frameHeight = 0,
}: DesktopWindowScaleInput): DesktopWindowScaleResolution {
  const baselineWidth = validDimension(baselineContentWidth);
  const baselineHeight = validDimension(baselineContentHeight);
  const fittedScale = Math.min(
    1,
    validDimension(contentWidth) / baselineWidth,
    validDimension(contentHeight) / baselineHeight,
  );
  const zoomFactor = fittedScale <= DESKTOP_MIN_SCALE
    ? DESKTOP_MIN_SCALE
    : Math.round(fittedScale * 1_000) / 1_000;

  const portraitPreviewWidth = baselineWidth * DESKTOP_PREVIEW_WIDTH_RATIO;
  const portraitMinimumContentHeight = DESKTOP_EDITOR_HEADER_HEIGHT
    + DESKTOP_PREVIEW_HEADER_HEIGHT
    + DESKTOP_TIMELINE_MIN_HEIGHT
    + Math.ceil(portraitPreviewWidth * 16 / 9);

  return {
    zoomFactor,
    minimumWindowSize: {
      width: Math.ceil(baselineWidth * DESKTOP_MIN_SCALE) + Math.max(0, Math.round(frameWidth)),
      height: Math.ceil(
        Math.max(baselineHeight, portraitMinimumContentHeight) * DESKTOP_MIN_SCALE,
      ) + Math.max(0, Math.round(frameHeight)),
    },
  };
}

/**
 * Scale the complete renderer when the native window becomes smaller than its
 * startup canvas. This keeps panels, dialogs, and timeline controls in the same
 * proportions instead of clipping individual regions.
 */
export function installResponsiveWindowScale(win: BrowserWindow): void {
  const [baselineContentWidth, baselineContentHeight] = win.getContentSize();
  const [initialWindowWidth, initialWindowHeight] = win.getSize();
  const frameWidth = initialWindowWidth - baselineContentWidth;
  const frameHeight = initialWindowHeight - baselineContentHeight;

  const syncScale = () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    const [contentWidth, contentHeight] = win.getContentSize();
    const resolution = resolveDesktopWindowScale({
      baselineContentWidth,
      baselineContentHeight,
      contentWidth,
      contentHeight,
      frameWidth,
      frameHeight,
    });
    win.webContents.setZoomFactor(resolution.zoomFactor);
  };

  const { minimumWindowSize } = resolveDesktopWindowScale({
    baselineContentWidth,
    baselineContentHeight,
    contentWidth: baselineContentWidth,
    contentHeight: baselineContentHeight,
    frameWidth,
    frameHeight,
  });
  win.setMinimumSize(minimumWindowSize.width, minimumWindowSize.height);
  win.on('resize', syncScale);
  win.webContents.on('did-finish-load', syncScale);
}
