interface NamedTool {
  readonly name: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function declaredNames(result: Record<string, unknown>): string[] {
  const activated = result.activatedTools;
  return Array.isArray(activated)
    ? activated.filter((name): name is string => typeof name === 'string')
    : [];
}

function searchNames(result: Record<string, unknown>): string[] {
  if (!Array.isArray(result.results)) return [];
  return result.results.flatMap((row) => {
    const candidate = record(row)?.name;
    return typeof candidate === 'string' ? [candidate] : [];
  });
}

function skillText(result: Record<string, unknown>): string {
  const contents = record(result.contents);
  if (!contents) return '';
  return Object.values(contents)
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionedNames(text: string, catalog: readonly NamedTool[]): string[] {
  if (!text) return [];
  return catalog.flatMap((tool) => {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escaped(tool.name)}(?=$|[^A-Za-z0-9_])`);
    return pattern.test(text) ? [tool.name] : [];
  });
}

export function activatedToolNamesForResult(
  toolName: string,
  result: unknown,
  catalog: readonly NamedTool[],
): string[] {
  const shaped = record(result);
  if (!shaped) return [];
  const requested = toolName === 'ToolSearch'
    ? [...declaredNames(shaped), ...searchNames(shaped)]
    : toolName === 'load_skill'
      ? [...declaredNames(shaped), ...mentionedNames(skillText(shaped), catalog)]
      : declaredNames(shaped);
  const allowed = new Set(catalog.map((tool) => tool.name));
  return [...new Set(requested.filter((name) => allowed.has(name)))];
}
