import type { BrowserWindow } from 'electron';
import { getKey } from '../server/keystore.ts';

export const DESKTOP_MIN_SCALE = 2 / 3;
/** User-set UI scale bounds (issue #85). 1 = the pre-feature behavior. */
export const DESKTOP_UI_SCALE_MIN = 0.8;
export const DESKTOP_UI_SCALE_MAX = 1.5;
export const DESKTOP_UI_SCALE_KEY = 'UI_SCALE';

/** Parse the saved UI scale, clamping to the supported range. */
export function parseUserUiScale(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(DESKTOP_UI_SCALE_MAX, Math.max(DESKTOP_UI_SCALE_MIN, parsed));
}

export function currentUserUiScale(): number {
  try {
    return parseUserUiScale(getKey(DESKTOP_UI_SCALE_KEY as never));
  } catch {
    return 1;
  }
}
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
  /** User-set UI scale multiplier (default 1 preserves existing behavior). */
  userScale?: number;
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
  userScale = 1,
}: DesktopWindowScaleInput): DesktopWindowScaleResolution {
  const baselineWidth = validDimension(baselineContentWidth);
  const baselineHeight = validDimension(baselineContentHeight);
  const fittedScale = Math.min(
    1,
    validDimension(contentWidth) / baselineWidth,
    validDimension(contentHeight) / baselineHeight,
  );
  const clampedFitted = fittedScale <= DESKTOP_MIN_SCALE ? DESKTOP_MIN_SCALE : fittedScale;
  // The user scale composes on top of shrink-to-fit: enlarging the window
  // never passes 100% fitted, so a >1 user scale is the only way to grow.
  // Keep the exact floor value at the default scale (pre-feature behavior).
  const zoomFactor = userScale === 1 && clampedFitted === DESKTOP_MIN_SCALE
    ? DESKTOP_MIN_SCALE
    : Math.round(userScale * clampedFitted * 1_000) / 1_000;

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
const windowScaleState = new WeakMap<BrowserWindow, DesktopWindowScaleInput>();

/** Re-apply the composed scale (user scale × shrink-to-fit). Called on
 *  resize and after the saved UI scale changes (settings / shortcuts). */
export function applyResponsiveWindowScale(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  const state = windowScaleState.get(win);
  if (!state) return;
  const [contentWidth, contentHeight] = win.getContentSize();
  const resolution = resolveDesktopWindowScale({
    ...state,
    contentWidth,
    contentHeight,
    userScale: currentUserUiScale(),
  });
  win.webContents.setZoomFactor(resolution.zoomFactor);
}

export function installResponsiveWindowScale(win: BrowserWindow): void {
  const [baselineContentWidth, baselineContentHeight] = win.getContentSize();
  const [initialWindowWidth, initialWindowHeight] = win.getSize();
  const frameWidth = initialWindowWidth - baselineContentWidth;
  const frameHeight = initialWindowHeight - baselineContentHeight;
  windowScaleState.set(win, {
    baselineContentWidth,
    baselineContentHeight,
    contentWidth: baselineContentWidth,
    contentHeight: baselineContentHeight,
    frameWidth,
    frameHeight,
  });

  const syncScale = () => applyResponsiveWindowScale(win);

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
