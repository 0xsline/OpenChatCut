// Rebase a saved UI scale when the shipped base density changes.
//
// UI_SCALE is stored relative to the base the desktop ships with (window-scale.ts). When
// that base moves — 1 → 1.1, so the 110% everyone chose became the default — a value
// saved under the old base would render 10% larger than the user set it. This runs once
// per base change: the saved value is converted so the window keeps its size, snapped to
// a Settings step so the dropdown can show it, and the base it is now relative to is
// recorded. Users who never saved a scale get the new default on purpose.
import {
  DESKTOP_UI_SCALE_BASE,
  DESKTOP_UI_SCALE_KEY,
  DESKTOP_UI_SCALE_MAX,
  DESKTOP_UI_SCALE_MIN,
} from './window-scale.ts';

/** Which base the saved UI_SCALE is relative to; absent means the original base of 1. */
export const DESKTOP_UI_SCALE_BASE_KEY = 'UI_SCALE_BASE';
/** The steps Settings offers (settingsSchema.ts); a rebased value lands on one of them. */
export const DESKTOP_UI_SCALE_STEPS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

export function rebaseUiScale(stored: number, fromBase: number, toBase: number): number {
  const relative = (stored * fromBase) / toBase;
  const clamped = Math.min(DESKTOP_UI_SCALE_MAX, Math.max(DESKTOP_UI_SCALE_MIN, relative));
  return DESKTOP_UI_SCALE_STEPS.reduce((best, step) => (
    Math.abs(step - clamped) < Math.abs(best - clamped) ? step : best
  ));
}

export interface UiScaleStore {
  /** '' when the key is unset. */
  getKey(name: string): string;
  setKeys(patch: Record<string, string>): Promise<unknown>;
}

export interface UiScaleRebase {
  readonly from: number;
  readonly to: number;
}

/** Null when nothing user-visible changed (already current, or no scale was saved). */
export async function migrateUiScaleBase(store: UiScaleStore): Promise<UiScaleRebase | null> {
  const recorded = Number(store.getKey(DESKTOP_UI_SCALE_BASE_KEY));
  const fromBase = Number.isFinite(recorded) && recorded > 0 ? recorded : 1;
  if (fromBase === DESKTOP_UI_SCALE_BASE) return null;
  const raw = store.getKey(DESKTOP_UI_SCALE_KEY).trim();
  const stored = Number(raw);
  const patch: Record<string, string> = { [DESKTOP_UI_SCALE_BASE_KEY]: String(DESKTOP_UI_SCALE_BASE) };
  let rebase: UiScaleRebase | null = null;
  if (raw && Number.isFinite(stored) && stored > 0) {
    const to = rebaseUiScale(stored, fromBase, DESKTOP_UI_SCALE_BASE);
    patch[DESKTOP_UI_SCALE_KEY] = String(to);
    rebase = { from: stored, to };
  }
  await store.setKeys(patch);
  return rebase;
}
