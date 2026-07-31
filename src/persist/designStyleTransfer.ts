import type { DesignStyle } from '../editor/types';

const FORMAT = 'openchatcut.design-style';
const VERSION = 1;
const MAX_TEXT_LENGTH = 20_000;
const MAX_ENTRIES = 100;

export interface DesignStyleRecipe {
  format: typeof FORMAT;
  version: typeof VERSION;
  name: string;
  style: DesignStyle;
  scenarios?: string[];
  thumbnailUrl?: string;
}

export function buildDesignStyleRecipe(
  name: string,
  style: DesignStyle,
  metadata: { scenarios?: string[]; thumbnailUrl?: string } = {},
): DesignStyleRecipe {
  return normalizeRecipe({ format: FORMAT, version: VERSION, ...metadata, name, style });
}

export function parseDesignStyleRecipe(text: string): DesignStyleRecipe {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('配方文件不是有效的 JSON');
  }
  return normalizeRecipe(value);
}

function normalizeRecipe(value: unknown): DesignStyleRecipe {
  if (!value || typeof value !== 'object') throw new Error('配方文件结构无效');
  const recipe = value as Partial<DesignStyleRecipe>;
  if (recipe.format !== FORMAT || recipe.version !== VERSION) throw new Error('配方文件版本不受支持');
  const name = normalizedText(recipe.name, '配方名称');
  const style = normalizeStyle(recipe.style);
  const scenarios = normalizeScenarios(recipe.scenarios);
  const thumbnailUrl = optionalText(recipe.thumbnailUrl, '缩略图地址');
  return {
    format: FORMAT,
    version: VERSION,
    name,
    style,
    ...(scenarios ? { scenarios } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

function normalizeStyle(value: unknown): DesignStyle {
  if (!value || typeof value !== 'object') throw new Error('配方缺少风格内容');
  const style = value as Partial<DesignStyle>;
  if (!Array.isArray(style.colors) || !Array.isArray(style.fonts)) throw new Error('配方风格结构无效');
  if (style.colors.length > MAX_ENTRIES || style.fonts.length > MAX_ENTRIES) throw new Error('配方内容过多');
  const colors = style.colors.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('配方颜色结构无效');
    return {
      role: normalizedText((entry as { role?: unknown }).role, '颜色角色'),
      value: normalizedText((entry as { value?: unknown }).value, '颜色值'),
    };
  });
  const fonts = style.fonts.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('配方字体结构无效');
    return {
      role: normalizedText((entry as { role?: unknown }).role, '字体角色'),
      family: normalizedText((entry as { family?: unknown }).family, '字体名称'),
    };
  });
  const styleGuide = optionalText(style.styleGuide, '工程创作指引');
  return { colors, fonts, ...(styleGuide ? { styleGuide } : {}) };
}

function normalizeScenarios(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw new Error('适用场景结构无效');
  const scenarios = [...new Set(value.map((entry) => normalizedText(entry, '适用场景')))];
  return scenarios.length > 0 ? scenarios : undefined;
}

function normalizedText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}无效`);
  const result = value.trim();
  if (!result || result.length > MAX_TEXT_LENGTH) throw new Error(`${label}无效`);
  return result;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  return normalizedText(value, label);
}
