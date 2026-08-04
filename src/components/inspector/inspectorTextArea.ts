export function resolveInspectorTextAreaRows(value: unknown): 1 | 2 {
  return /[\r\n]/.test(String(value ?? '')) ? 2 : 1;
}
