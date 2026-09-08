// Model-emitted load_skill selectors arrive with filler: blank strings, nulls, empty
// arrays, string-typed numbers, a single path on the array key, both selectors at once.
// This module has no dependencies so the invocation boundary — which server code also
// imports — can normalize before JSON-schema validation without pulling the bundled
// skill corpus into its module graph.

const isBlankString = (value: unknown): boolean => (
  typeof value === 'string' && value.trim() === ''
);
const isFiller = (value: unknown): boolean => (
  value === undefined || value === null || isBlankString(value)
);

/** Integer-looking strings become numbers; filler becomes absent; anything else is left for validation. */
function usableInteger(value: unknown): unknown {
  if (isFiller(value)) return undefined;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return value;
}

/** A bare string is a one-element batch; blank entries are dropped; wrong types survive for validation. */
function usablePaths(value: unknown): unknown {
  if (isFiller(value)) return undefined;
  if (typeof value === 'string') return [value.trim()];
  if (!Array.isArray(value)) return value;
  const paths = value
    .filter((path) => !isFiller(path))
    .map((path) => (typeof path === 'string' ? path.trim() : path));
  return paths.length === 0 ? undefined : paths;
}

/** A one-element array on `file` is one file; a longer one is a batch that landed on the wrong key. */
function usableFile(value: unknown): { readonly file?: unknown; readonly files?: unknown } {
  if (isFiller(value)) return {};
  if (!Array.isArray(value)) return { file: typeof value === 'string' ? value.trim() : value };
  const paths = usablePaths(value);
  if (paths === undefined) return {};
  return Array.isArray(paths) && paths.length === 1 ? { file: paths[0] } : { files: paths };
}

/**
 * Models routinely emit both selectors in one call — a blank `file` beside a real `files`
 * array, `files: []` beside a real `file`, or paging numbers with no `file` at all — because
 * a result carrying both `omittedFiles` and `nextOffset` reads as one combined next step.
 * Dropping that filler keeps a recoverable call recoverable instead of rejecting it before
 * the skill is ever read. Wrong-typed values are preserved so validation still reports them.
 *
 * When both selectors survive, only a non-zero offset is a continuation worth preserving over
 * the batch: offset 0 on a file repeats what an earlier call already returned, so the batch is
 * the useful request. Paging numbers never survive without a `file` to page.
 */
export function normalizeSkillArgs(args: Record<string, unknown>): Record<string, unknown> {
  const fromFile = usableFile(args.file);
  const file = fromFile.file;
  const files = usablePaths(args.files) ?? fromFile.files;
  const offset = usableInteger(args.offset);
  const limit = usableInteger(args.limit);
  const paging = typeof offset === 'number' && offset > 0;
  const keepFile = file !== undefined && (files === undefined || paging);
  const keepFiles = files !== undefined && !keepFile;
  return Object.fromEntries(Object.entries({
    ...args,
    file: keepFile ? file : undefined,
    files: keepFiles ? files : undefined,
    offset: keepFile ? offset : undefined,
    limit: keepFile ? limit : undefined,
  }).filter(([, value]) => value !== undefined));
}
