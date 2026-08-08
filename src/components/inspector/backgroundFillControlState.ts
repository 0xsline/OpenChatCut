export function resolveBackgroundFillToggle(
  mixed: boolean,
  checked: boolean,
  strength: number,
  strengthMixed: boolean,
): { enabled: boolean; strength?: number } {
  const enabled = mixed || checked;
  return {
    enabled,
    ...(enabled && !strengthMixed ? { strength } : {}),
  };
}
