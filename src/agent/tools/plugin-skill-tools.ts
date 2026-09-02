export { PLUGIN_SKILL_TOOL_SCHEMAS, PLUGIN_SKILL_TOOL_NAMES } from './schemas/plugin-skill-tools';
import { PLUGIN_SKILLS, readPluginSkillFile } from '../skills/plugin-skills';
import { allCreativeSkills } from '../skills/skills-catalog';
import { detectSkillDependencies } from '../skills/skill-deps';
import type { AgentContext } from '../context';
import type { HarnessToolExecutionContext } from '../harness-context';

const MAX_SKILL_RESULT_CHARS = 64_000;
const MAX_REQUESTED_FILES = 64;
const DEFAULT_PAGE_CHARS = 48_000;
const MAX_PAGE_CHARS = 48_000;

export interface SkillToolSource {
  readonly skill: string;
  readonly contents: Readonly<Record<string, string>>;
  readonly skillDir?: string;
  readonly custom?: boolean;
}

export interface PluginSkillLoadSuccess {
  readonly skill: string;
  readonly file: string;
  readonly files: readonly string[];
  readonly contents: Readonly<Record<string, string>>;
  readonly omittedFiles: readonly string[];
  readonly dependencyCheck: readonly string[];
  readonly skillDir?: string;
  readonly note: string;
  readonly offset?: number;
  readonly nextOffset?: number | null;
  readonly totalChars?: number;
}

export type PluginSkillLoadResult = PluginSkillLoadSuccess | {
  readonly error: string;
  readonly availableFiles?: readonly string[];
  readonly available?: readonly string[];
  readonly creativeModes?: readonly string[];
  /** A concrete corrected call, so a rejection is never re-sent unchanged. */
  readonly retry?: string;
};

const comparePath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const orderedPaths = (paths: readonly string[]): string[] => [...paths].sort((a, b) => {
  if (a === 'SKILL.md') return -1;
  if (b === 'SKILL.md') return 1;
  return comparePath(a, b);
});

function isSafeRelativePath(path: string): boolean {
  if (path.length < 1 || path.length > 512 || path !== path.trim()) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes(':')) return false;
  for (const char of path) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
function resultBudgetError(resultBudgetChars: number): PluginSkillLoadResult | null {
  return Number.isSafeInteger(resultBudgetChars) && resultBudgetChars >= 1
    && resultBudgetChars <= MAX_SKILL_RESULT_CHARS
    ? null
    : { error: `result budget must be 1-${MAX_SKILL_RESULT_CHARS} UTF-16 characters.` };
}

function validatedSkillSource(
  source: SkillToolSource,
): { readonly available: string[] } | { readonly error: string } {
  const available = orderedPaths(Object.keys(source.contents));
  const unsafe = available.find((path) => !isSafeRelativePath(path));
  if (unsafe) return { error: `Skill contains an unsafe file path: ${unsafe}` };
  if (typeof source.contents['SKILL.md'] !== 'string') return { error: 'Skill is missing SKILL.md.' };
  return { available };
}

function wholeRequestError(request: readonly string[] | undefined): PluginSkillLoadResult | null {
  if (request === undefined) return null;
  if (request.length < 1 || request.length > MAX_REQUESTED_FILES) {
    return { error: `files must contain 1-${MAX_REQUESTED_FILES} paths.` };
  }
  const unsafe = request.find((path) => !isSafeRelativePath(path));
  if (unsafe) return { error: `Unsafe skill file path: ${unsafe}` };
  return new Set(request).size === request.length
    ? null
    : { error: 'files must not contain duplicates.' };
}


type SkillRequest = { readonly kind: 'initial' }
  | { readonly kind: 'whole'; readonly files: readonly string[] }
  | { readonly kind: 'page'; readonly file: string; readonly offset: number; readonly limit: number }
  | { readonly error: string };

const isBlankString = (value: unknown): boolean => (
  typeof value === 'string' && value.trim() === ''
);

/** Drop filler while preserving wrong-typed values so validation still reports them. */
function usableFile(value: unknown): unknown {
  return value === null || isBlankString(value) ? undefined : value;
}

function usableFiles(value: unknown): unknown {
  if (value === null) return undefined;
  if (!Array.isArray(value)) return value;
  const paths = value.filter((path) => (
    path !== null && path !== undefined && !isBlankString(path)
  ));
  return paths.length === 0 ? undefined : paths;
}

/**
 * Models routinely emit both selectors in one call — a blank `file` beside a real `files`
 * array, `files: []` beside a real `file`, or paging numbers with no `file` at all — because
 * a result carrying both `omittedFiles` and `nextOffset` reads as one combined next step.
 * Normalizing that filler away keeps a recoverable call recoverable instead of rejecting it
 * before the skill is ever read. Paging numbers select the single-file path; otherwise the
 * whole-file batch wins, and paging numbers never survive without a `file` to page.
 */
export function normalizeSkillArgs(args: Record<string, unknown>): Record<string, unknown> {
  const file = usableFile(args.file);
  const files = usableFiles(args.files);
  const paging = args.offset !== undefined || args.limit !== undefined;
  const keepFile = file !== undefined && (files === undefined || paging);
  const keepFiles = files !== undefined && !keepFile;
  return Object.fromEntries(Object.entries({
    ...args,
    file: keepFile ? file : undefined,
    files: keepFiles ? files : undefined,
    offset: keepFile ? args.offset : undefined,
    limit: keepFile ? args.limit : undefined,
  }).filter(([, value]) => value !== undefined));
}

function parseSkillRequest(rawArgs: Record<string, unknown>): SkillRequest {
  // Normalization guarantees file and files are mutually exclusive and that offset/limit
  // only survive beside a file, so neither combination needs rejecting here.
  const args = normalizeSkillArgs(rawArgs);
  if (args.files !== undefined) {
    if (!Array.isArray(args.files) || args.files.length < 1
      || args.files.length > MAX_REQUESTED_FILES
      || args.files.some((file) => typeof file !== 'string' || !isSafeRelativePath(file))) {
      return { error: `files must contain 1-${MAX_REQUESTED_FILES} safe relative paths.` };
    }
    const files = orderedPaths(args.files);
    return new Set(files).size === files.length
      ? { kind: 'whole', files }
      : { error: 'files must not contain duplicates.' };
  }
  if (args.file === undefined) return { kind: 'initial' };
  if (typeof args.file !== 'string' || !isSafeRelativePath(args.file)) {
    return { error: 'file must be a safe relative skill path.' };
  }
  const offset = args.offset ?? 0;
  const limit = args.limit ?? DEFAULT_PAGE_CHARS;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0
    || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_PAGE_CHARS) {
    return { error: `offset must be a non-negative integer and limit must be 1-${MAX_PAGE_CHARS}.` };
  }
  return { kind: 'page', file: args.file, offset: Number(offset), limit: Number(limit) };
}

function selectedContents(
  source: SkillToolSource,
  selected: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(
    orderedPaths([...selected]).map((path) => [path, source.contents[path]!]),
  );
}

function loadResult(
  source: SkillToolSource,
  selected: ReadonlySet<string>,
  desired: readonly string[],
  dependencies: readonly string[],
): PluginSkillLoadSuccess {
  const contents = selectedContents(source, selected);
  const files = Object.keys(contents);
  const omittedFiles = desired.filter((path) => !selected.has(path));
  // One selector per call: naming both paths in a single sentence is what makes models
  // merge them into one rejected request.
  const selectors = 'One selector per call. To load whole omitted files, send files=[…] and no other selector. To page a single file, send file=… with offset and no files=[…].';
  const note = source.custom
    ? `Custom skill files loaded within the active context budget. ${selectors} Run scripts locally with run_skill_script(skill=…, command="bash scripts/…").`
    : `Skill files loaded within the active context budget. ${selectors}`;
  return {
    skill: source.skill,
    file: files[0] ?? desired[0] ?? 'SKILL.md',
    files,
    contents,
    omittedFiles,
    dependencyCheck: dependencies,
    ...(source.skillDir ? { skillDir: source.skillDir } : {}),
    note,
  };
}
function unknownFileResult(
  path: string,
  availableFiles: readonly string[],
  resultBudgetChars = MAX_SKILL_RESULT_CHARS,
): PluginSkillLoadResult {
  const result = { error: `Unknown skill file: ${path}`, availableFiles };
  return JSON.stringify(result).length <= resultBudgetChars
    ? result
    : { error: `Unknown skill file: ${path}` };
}

function sourceDependencies(source: SkillToolSource, available: readonly string[]): string[] {
  return detectSkillDependencies(
    available.map((path) => source.contents[path]).join('\n'),
  ).map((dependency) => dependency.service);
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

function safePageEnd(text: string, offset: number, requestedEnd: number): number {
  let end = Math.min(text.length, Math.max(offset, requestedEnd));
  if (end > offset && end < text.length
    && isHighSurrogate(text.charCodeAt(end - 1))
    && isLowSurrogate(text.charCodeAt(end))) end -= 1;
  return end;
}

function pageResult(
  source: SkillToolSource,
  file: string,
  offset: number,
  end: number,
  dependencies: readonly string[],
): PluginSkillLoadSuccess {
  const totalChars = source.contents[file]!.length;
  return {
    skill: source.skill,
    file,
    files: [file],
    contents: { [file]: source.contents[file]!.slice(offset, end) },
    omittedFiles: [],
    dependencyCheck: dependencies,
    ...(source.skillDir ? { skillDir: source.skillDir } : {}),
    note: 'Paged skill file loaded within the active context budget. Continue with the same file and offset=nextOffset until nextOffset is null. Send only file and offset on those calls; adding files=[…] is not a paging continuation.',
    offset,
    nextOffset: end < totalChars ? end : null,
    totalChars,
  };
}
function largestPageEnd(
  source: SkillToolSource,
  file: string,
  offset: number,
  minimumEnd: number,
  maximumEnd: number,
  dependencies: readonly string[],
  resultBudgetChars: number,
): number {
  const text = source.contents[file]!;
  let low = minimumEnd;
  let high = maximumEnd;
  let best = offset;
  while (low <= high) {
    const midpoint = low + Math.floor((high - low) / 2);
    const end = Math.max(minimumEnd, safePageEnd(text, offset, midpoint));
    if (JSON.stringify(pageResult(source, file, offset, end, dependencies)).length
      <= resultBudgetChars) {
      best = end;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}
function pageRequestError(
  text: string,
  offset: number,
  limit: number,
): { readonly error: string } | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_CHARS) {
    return { error: `offset must be 0-${text.length} and limit must be 1-${MAX_PAGE_CHARS}.` };
  }
  if (offset > 0 && offset < text.length
    && isHighSurrogate(text.charCodeAt(offset - 1))
    && isLowSurrogate(text.charCodeAt(offset))) {
    return { error: 'offset must not split a UTF-16 surrogate pair.' };
  }
  return undefined;
}



/** Explicit single-file paging; boundaries never split a UTF-16 surrogate pair. */
export function buildPagedSkillResult(
  source: SkillToolSource,
  file: string,
  offset = 0,
  limit = DEFAULT_PAGE_CHARS,
  resultBudgetChars = MAX_SKILL_RESULT_CHARS,
): PluginSkillLoadResult {
  if (!isSafeRelativePath(file)) return { error: `Unsafe skill file path: ${file}` };
  const validated = validatedSkillSource(source);
  if ('error' in validated) return validated;
  const { available } = validated;
  const budgetError = resultBudgetError(resultBudgetChars);
  if (budgetError) return budgetError;
  if (!available.includes(file)) return unknownFileResult(file, available, resultBudgetChars);
  const text = source.contents[file]!;
  const rangeError = pageRequestError(text, offset, limit);
  if (rangeError) return rangeError;
  const dependencies = sourceDependencies(source, available);
  if (offset === text.length) {
    const emptyPage = pageResult(source, file, offset, offset, dependencies);
    return JSON.stringify(emptyPage).length <= resultBudgetChars
      ? emptyPage
      : { error: 'Skill-file metadata exceeds the active result budget.' };
  }
  const minimumEnd = isHighSurrogate(text.charCodeAt(offset))
    && isLowSurrogate(text.charCodeAt(offset + 1)) ? offset + 2 : offset + 1;
  const requestedEnd = Math.min(text.length, offset + limit);
  if (minimumEnd > requestedEnd) {
    return { error: 'limit must not split the first UTF-16 surrogate pair in a page.' };
  }
  const best = largestPageEnd(
    source,
    file,
    offset,
    minimumEnd,
    requestedEnd,
    dependencies,
    resultBudgetChars,
  );
  return best === offset
    ? { error: 'One skill-file character plus metadata exceeds the active result budget.' }
    : pageResult(source, file, offset, best, dependencies);
}


/** Load exact whole requested support files; initial SKILL.md pages only when it cannot fit. */
export function buildBoundedSkillResult(
  source: SkillToolSource,
  request?: readonly string[],
  resultBudgetChars = MAX_SKILL_RESULT_CHARS,
): PluginSkillLoadResult {
  const budgetError = resultBudgetError(resultBudgetChars);
  if (budgetError) return budgetError;
  const requestError = wholeRequestError(request);
  if (requestError) return requestError;
  const validated = validatedSkillSource(source);
  if ('error' in validated) return validated;
  const { available } = validated;
  const desired = request === undefined ? available : orderedPaths(request);
  const unknown = desired.find((path) => !available.includes(path));
  if (unknown) return unknownFileResult(unknown, available, resultBudgetChars);
  const dependencies = sourceDependencies(source, available);
  const selected = new Set<string>(request === undefined ? ['SKILL.md'] : []);
  const initial = loadResult(source, selected, desired, dependencies);
  if (JSON.stringify(initial).length > resultBudgetChars) {
    const rootPage = buildPagedSkillResult(
      source, 'SKILL.md', 0, DEFAULT_PAGE_CHARS, resultBudgetChars,
    );
    if ('error' in rootPage) return rootPage;
    return {
      ...rootPage,
      omittedFiles: available.filter((path) => path !== 'SKILL.md'),
      // The only result carrying both nextOffset and omittedFiles, so it must spell out that
      // they are two sequential calls rather than one combined selector.
      note: 'SKILL.md was paged to the active context budget. Finish it first with file="SKILL.md" and offset=nextOffset until nextOffset is null, sending no files=[…] on those calls. Only then request omittedFiles in a separate call with files=[…] and no file/offset.',
    };
  }
  if (request === undefined) return initial;
  for (const path of desired) {
    if (selected.has(path)) continue;
    selected.add(path);
    if (JSON.stringify(loadResult(source, selected, desired, dependencies)).length
      > resultBudgetChars) selected.delete(path);
  }
  return loadResult(source, selected, desired, dependencies);
}

function builtInSource(slug: string): SkillToolSource | undefined {
  const skill = PLUGIN_SKILLS.find((candidate) => candidate.slug === slug);
  if (!skill) return undefined;
  const support = skill.files.flatMap((file) => {
    const content = readPluginSkillFile(slug, file);
    return content === undefined ? [] : [[file, content] as const];
  });
  return { skill: slug, contents: { 'SKILL.md': skill.body, ...Object.fromEntries(support) } };
}

function creativeSource(slug: string): SkillToolSource | undefined {
  const skill = allCreativeSkills().find((candidate) => (
    candidate.slug === slug || candidate.id === slug
  ));
  if (!skill) return undefined;
  const existing = skill.fileContents ?? {};
  return {
    skill: skill.slug,
    contents: { ...existing, 'SKILL.md': existing['SKILL.md'] ?? skill.body },
    skillDir: `~/.openchatcut/skills/${skill.slug}`,
    custom: true,
  };
}

/**
 * Naming a concrete corrected call is what stops a model re-sending rejected arguments
 * verbatim; the tool itself stays pure, so it cannot count attempts across calls.
 */
function selectorRetryHint(slug: string, source: SkillToolSource): string {
  const support = orderedPaths(Object.keys(source.contents))
    .filter((path) => path !== 'SKILL.md');
  const batch = support.length > 0
    ? ` or load_skill(name="${slug}", files=["${support[0]}"]) for one whole support file`
    : '';
  return `Do not re-send these arguments unchanged. Send exactly one selector: load_skill(name="${slug}") for SKILL.md${batch}. Never send file and files together, and never send an empty string or an empty array.`;
}

/** Attach the hint only when it fits, so budgeted error results stay within budget. */
function withRetryHint(
  result: PluginSkillLoadResult,
  hint: string,
  resultBudgetChars: number,
): PluginSkillLoadResult {
  if (!('error' in result)) return result;
  const hinted = { ...result, retry: hint };
  return JSON.stringify(hinted).length <= resultBudgetChars ? hinted : result;
}

export function execPluginSkillTool(
  name: string,
  args: Record<string, unknown>,
  _ctx?: AgentContext,
  harness?: HarnessToolExecutionContext,
): PluginSkillLoadResult {
  if (name !== 'load_skill') return { error: `unknown tool ${name}` };
  const slug = typeof args.name === 'string' ? args.name.trim() : '';
  if (!slug) return { error: 'name must be a non-empty skill id.' };
  const source = builtInSource(slug) ?? creativeSource(slug);
  if (!source) {
    const creativeModes = allCreativeSkills()
      .filter((skill) => skill.source === 'custom')
      .map((skill) => skill.slug)
      .sort(comparePath);
    return {
      error: `no such skill "${slug}"`,
      available: PLUGIN_SKILLS.map((skill) => skill.slug).sort(comparePath),
      creativeModes,
    };
  }
  const resultBudgetChars = harness?.loadSkillResultBudgetChars ?? MAX_SKILL_RESULT_CHARS;
  const hint = selectorRetryHint(slug, source);
  const request = parseSkillRequest(args);
  if ('error' in request) return withRetryHint(request, hint, resultBudgetChars);
  const result = request.kind === 'page'
    ? buildPagedSkillResult(source, request.file, request.offset, request.limit, resultBudgetChars)
    : buildBoundedSkillResult(
      source,
      request.kind === 'whole' ? request.files : undefined,
      resultBudgetChars,
    );
  return withRetryHint(result, hint, resultBudgetChars);
}
