import type { DesignStyle } from '../editor/types';
import { isDesignStyle } from './migrations/normalize';
import { kvGet, kvSet } from './sharedKv';

const OWNED_STYLES_KEY = 'design-styles:owned';

export interface OwnedStyle {
  id: string;
  name: string;
  style: DesignStyle;
  /** UI-only cover for style pickers. It is not a generation reference. */
  thumbnailUrl?: string;
  /** Free-form use cases such as "product", "podcast", or "education". */
  scenarios?: string[];
}

export interface OwnedStyleMetadata {
  thumbnailUrl?: string | null;
  scenarios?: string[];
}

export interface OwnedStyleUpdate extends OwnedStyleMetadata {
  name?: string;
  style?: DesignStyle;
}

function isOwnedStyle(value: unknown): value is OwnedStyle {
  if (!value || typeof value !== 'object') return false;
  const style = value as Partial<OwnedStyle>;
  return typeof style.id === 'string'
    && typeof style.name === 'string'
    && isDesignStyle(style.style)
    && (style.thumbnailUrl === undefined || typeof style.thumbnailUrl === 'string')
    && (style.scenarios === undefined
      || (Array.isArray(style.scenarios) && style.scenarios.every((scenario) => typeof scenario === 'string')));
}

function normalizeScenarios(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function uniqueOwnedStyleName(requested: string, styles: OwnedStyle[], exceptId?: string): string {
  const base = requested.trim() || '未命名风格';
  const names = new Set(styles.filter((style) => style.id !== exceptId).map((style) => style.name));
  if (!names.has(base)) return base;
  let suffix = 2;
  while (names.has(`${base} (${suffix})`)) suffix += 1;
  return `${base} (${suffix})`;
}

function newOwnedStyleId(): string {
  const timestamp = Date.now();
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `p_${timestamp.toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** The user's saved style library. Corrupt/partial persisted data is dropped. */
export async function loadOwnedStyles(): Promise<OwnedStyle[]> {
  try {
    const raw = await kvGet<unknown>(OWNED_STYLES_KEY);
    return Array.isArray(raw) ? raw.filter(isOwnedStyle) : [];
  } catch {
    return [];
  }
}

export async function saveOwnedStyle(
  name: string,
  style: DesignStyle,
  metadata: OwnedStyleMetadata = {},
): Promise<OwnedStyle> {
  const trimmed = name.trim() || '未命名风格';
  const current = await loadOwnedStyles();
  const existing = current.find((entry) => entry.name === trimmed);
  const thumbnailUrl = metadata.thumbnailUrl === undefined
    ? existing?.thumbnailUrl
    : metadata.thumbnailUrl?.trim() || undefined;
  const scenarios = metadata.scenarios === undefined
    ? existing?.scenarios
    : normalizeScenarios(metadata.scenarios);
  const entry: OwnedStyle = {
    id: existing?.id ?? newOwnedStyleId(),
    name: trimmed,
    style,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(scenarios ? { scenarios } : {}),
  };
  const next = existing
    ? current.map((owned) => (owned.id === entry.id ? entry : owned))
    : [...current, entry];
  try {
    await kvSet(OWNED_STYLES_KEY, next);
  } catch {
    /* ignore persist failures; caller still gets the entry back for in-session use */
  }
  return entry;
}

export async function updateOwnedStyle(
  id: string,
  update: OwnedStyleUpdate,
): Promise<OwnedStyle | undefined> {
  const current = await loadOwnedStyles();
  const existing = current.find((style) => style.id === id);
  if (!existing) return undefined;
  const name = update.name === undefined
    ? existing.name
    : uniqueOwnedStyleName(update.name, current, existing.id);
  const thumbnailUrl = update.thumbnailUrl === undefined
    ? existing.thumbnailUrl
    : update.thumbnailUrl?.trim() || undefined;
  const scenarios = update.scenarios === undefined
    ? existing.scenarios
    : normalizeScenarios(update.scenarios);
  const next: OwnedStyle = {
    id: existing.id,
    name,
    style: update.style ?? existing.style,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(scenarios ? { scenarios } : {}),
  };
  try {
    await kvSet(OWNED_STYLES_KEY, current.map((style) => (style.id === id ? next : style)));
  } catch {
    /* ignore persist failures; caller still gets the updated in-session value */
  }
  return next;
}

export async function deleteOwnedStyle(id: string): Promise<void> {
  try {
    const current = await loadOwnedStyles();
    await kvSet(OWNED_STYLES_KEY, current.filter((style) => style.id !== id));
  } catch {
    /* ignore */
  }
}
