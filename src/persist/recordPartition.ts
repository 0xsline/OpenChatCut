// Boundary validation on read must not become deletion on write.
//
// Every list-shaped store here validates persisted entries before use — right,
// because persisted data is untrusted. But "this build cannot parse it" is NOT
// the same as "it is garbage": the common case is data written by a NEWER
// build (a version snapshot carrying a future ProjectDoc, an export record
// with a field this build predates). Reading with a filter and then writing
// the filtered array back destroys those entries permanently, which the
// release data-safety rule forbids ("新写旧读必须安全降级 … 不允许覆盖旧数据").
//
// So: filter for DISPLAY, and carry the unparsed entries through every write.

export interface PartitionedRecords<T> {
  /** Entries this build understands, in stored order. */
  readonly valid: T[];
  /** Entries it does not — preserved verbatim, never inspected. */
  readonly opaque: readonly unknown[];
}

export function partitionRecords<T>(
  raw: unknown,
  parse: (value: unknown) => T | null,
): PartitionedRecords<T> {
  if (!Array.isArray(raw)) return { valid: [], opaque: [] };
  const valid: T[] = [];
  const opaque: unknown[] = [];
  for (const entry of raw) {
    const parsed = parse(entry);
    if (parsed === null) opaque.push(entry);
    else valid.push(parsed);
  }
  return { valid, opaque };
}

/** The array to persist: this build's entries plus every entry it could not
 * read, so a newer build still finds its own data intact. */
export function withPreservedRecords<T>(next: readonly T[], opaque: readonly unknown[]): unknown[] {
  return opaque.length ? [...next, ...opaque] : [...next];
}
