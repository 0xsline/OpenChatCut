import type { ProjectDoc } from '../editor/types';

function visitObjects(value: unknown, visit: (record: Record<string, unknown>) => boolean): boolean {
  if (!value || typeof value !== 'object') return false;
  const seen = new WeakSet<object>();
  const stack: object[] = [value];
  let matched = false;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const child of current) {
        if (child && typeof child === 'object') stack.push(child);
      }
      continue;
    }
    const record = current as Record<string, unknown>;
    matched = visit(record) || matched;
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return matched;
}

/** True when a ProjectDoc still carries desktop-only source paths. */
export function projectDocHasOriginalFilePath(doc: ProjectDoc): boolean {
  return visitObjects(doc, (record) => Object.hasOwn(record, 'originalFilePath'));
}

/** Deep-copy a ProjectDoc for a portable boundary without exposing desktop source paths. */
export function sanitizePortableProjectDoc(doc: ProjectDoc): ProjectDoc {
  const portable = structuredClone(doc);
  visitObjects(portable, (record) => {
    if (!Object.hasOwn(record, 'originalFilePath')) return false;
    delete record.originalFilePath;
    return true;
  });
  return portable;
}
