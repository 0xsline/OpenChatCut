import type { BackgroundFillPreset } from '../../editor/types';

export function resolveBackgroundFillToggle(
  mixed: boolean,
  checked: boolean,
  preset: BackgroundFillPreset,
  presetMixed: boolean,
): { enabled: boolean; preset?: BackgroundFillPreset } {
  const enabled = mixed || checked;
  return {
    enabled,
    ...(enabled && !presetMixed ? { preset } : {}),
  };
}
