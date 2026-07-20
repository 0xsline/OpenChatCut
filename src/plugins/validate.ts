// 插件包纯校验(安装第一道门):schema/上限/GLSL token/cube 干跑/包络值域。
// 不碰 WebGL/DOM — 真编译探针在 install.ts(浏览器侧)。tsx 可跑,进 npm test。
import { parseCube } from '../gl/fx/cube';
import {
  ITEM_ID_RE, PACK_ID_RE, PLUGIN_FORMAT, PLUGIN_LIMITS, PROP_KEY_RE,
  type PluginNumberProp, type PluginPack,
} from './types';

export type ValidateResult =
  | { ok: true; pack: PluginPack }
  | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const bytes = (s: string): number => new TextEncoder().encode(s).length;

function checkName(errors: string[], at: string, v: unknown): void {
  if (!isStr(v) || !v.trim() || v.length > PLUGIN_LIMITS.maxNameLen) {
    errors.push(`${at}: name 必须是 1..${PLUGIN_LIMITS.maxNameLen} 字符的字符串`);
  }
}

function checkProps(errors: string[], at: string, v: unknown): PluginNumberProp[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > PLUGIN_LIMITS.maxProps) {
    errors.push(`${at}: props 必须是 ≤${PLUGIN_LIMITS.maxProps} 项的数组`);
    return undefined;
  }
  const seen = new Set<string>();
  for (const [i, p] of v.entries()) {
    const where = `${at}.props[${i}]`;
    if (!isObj(p)) { errors.push(`${where}: 必须是对象`); continue; }
    if (!isStr(p.key) || !PROP_KEY_RE.test(p.key)) errors.push(`${where}: key 非法(${PROP_KEY_RE})`);
    else if (seen.has(p.key)) errors.push(`${where}: key 重复 ${p.key}`);
    else seen.add(p.key);
    if (!isStr(p.label) || !p.label.trim()) errors.push(`${where}: label 缺失`);
    if (!isNum(p.default) || !isNum(p.min) || !isNum(p.max) || p.min > p.max) {
      errors.push(`${where}: default/min/max 必须是有限数且 min≤max`);
    }
    if (p.step !== undefined && (!isNum(p.step) || p.step <= 0)) errors.push(`${where}: step 必须 >0`);
  }
  return v as PluginNumberProp[];
}

function checkFrag(errors: string[], at: string, frag: unknown, requiredTokens: string[]): void {
  if (!isStr(frag) || !frag.trim()) { errors.push(`${at}: frag 缺失`); return; }
  if (bytes(frag) > PLUGIN_LIMITS.maxFragBytes) errors.push(`${at}: frag 超过 ${PLUGIN_LIMITS.maxFragBytes / 1024}KB`);
  for (const token of requiredTokens) {
    if (!frag.includes(token)) errors.push(`${at}: frag 必须引用 ${token}`);
  }
}

// data:image/* 内联(限长)或 同源路径/https;其余 scheme(javascript: 等)一律拒
function checkThumb(errors: string[], at: string, v: unknown): void {
  if (v === undefined) return;
  if (!isStr(v) || !v.trim()) { errors.push(`${at}: thumb 必须是非空字符串`); return; }
  if (v.startsWith('data:image/')) {
    if (bytes(v) > PLUGIN_LIMITS.maxThumbBytes) errors.push(`${at}: thumb 超过 ${PLUGIN_LIMITS.maxThumbBytes / 1024}KB`);
    return;
  }
  if (!v.startsWith('/') && !v.startsWith('https://') && !v.startsWith('http://')) {
    errors.push(`${at}: thumb 只允许 data:image/* 或 URL(/… | https://…)`);
  }
}

function checkItem(errors: string[], item: unknown, index: number): void {
  const at = `items[${index}]`;
  if (!isObj(item)) { errors.push(`${at}: 必须是对象`); return; }
  if (!isStr(item.id) || !ITEM_ID_RE.test(item.id)) errors.push(`${at}: id 非法(${ITEM_ID_RE})`);
  checkName(errors, at, item.name);
  if (item.desc !== undefined && (!isStr(item.desc) || item.desc.length > PLUGIN_LIMITS.maxDescLen)) {
    errors.push(`${at}: desc 超长(≤${PLUGIN_LIMITS.maxDescLen})`);
  }
  checkThumb(errors, at, item.thumb);
  switch (item.type) {
    case 'mg-template': {
      if (!isStr(item.code) || !item.code.trim()) errors.push(`${at}: code 缺失`);
      else if (bytes(item.code) > PLUGIN_LIMITS.maxCodeBytes) errors.push(`${at}: code 超过 ${PLUGIN_LIMITS.maxCodeBytes / 1024}KB`);
      for (const dim of ['width', 'height'] as const) {
        const v = item[dim];
        if (v !== undefined && (!isNum(v) || v < 16 || v > 8192)) errors.push(`${at}: ${dim} 必须在 [16, 8192]`);
      }
      if (item.props !== undefined && !isObj(item.props)) errors.push(`${at}: props 必须是对象`);
      if (item.propSchema !== undefined) {
        if (!Array.isArray(item.propSchema) || item.propSchema.length > 32) {
          errors.push(`${at}: propSchema 必须是 ≤32 项的数组`);
        } else {
          for (const [i, s] of item.propSchema.entries()) {
            if (!isObj(s) || !isStr(s.key) || !isStr(s.type)) {
              errors.push(`${at}.propSchema[${i}]: 需要 key/type 字符串`);
            }
          }
        }
      }
      return;
    }
    case 'transition': {
      checkFrag(errors, at, item.frag, ['u_outgoing', 'u_incoming', 'u_progress']);
      checkProps(errors, at, item.props);
      const d = item.defaultDurationFrames;
      if (d !== undefined && (!isNum(d) || d < 2 || d > 300)) errors.push(`${at}: defaultDurationFrames 必须在 [2, 300]`);
      return;
    }
    case 'fx': {
      checkFrag(errors, at, item.frag, ['u_input']);
      checkProps(errors, at, item.props);
      if (item.passes !== undefined) {
        if (!Array.isArray(item.passes) || item.passes.length < 1 || item.passes.length > 4) {
          errors.push(`${at}: passes 必须是 1..4 段的数组`);
        } else {
          for (const [i, pass] of item.passes.entries()) checkFrag(errors, `${at}.passes[${i}]`, pass, []);
        }
      }
      return;
    }
    case 'lut': {
      if (!isStr(item.cube) || !item.cube.trim()) { errors.push(`${at}: cube 缺失`); return; }
      if (bytes(item.cube) > PLUGIN_LIMITS.maxCubeBytes) { errors.push(`${at}: cube 超过 ${PLUGIN_LIMITS.maxCubeBytes / 1024 / 1024}MB`); return; }
      try {
        parseCube(item.cube);
      } catch (e) {
        errors.push(`${at}: cube 解析失败 — ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    case 'zoom': {
      const env = item.envelope;
      if (!Array.isArray(env) || env.length < PLUGIN_LIMITS.minEnvelopePoints || env.length > PLUGIN_LIMITS.maxEnvelopePoints) {
        errors.push(`${at}: envelope 必须是 ${PLUGIN_LIMITS.minEnvelopePoints}..${PLUGIN_LIMITS.maxEnvelopePoints} 个点`);
      } else if (!env.every((v) => isNum(v) && v >= 0 && v <= PLUGIN_LIMITS.maxEnvelopeValue)) {
        errors.push(`${at}: envelope 值必须在 [0, ${PLUGIN_LIMITS.maxEnvelopeValue}]`);
      }
      const mag = item.magnification;
      if (mag !== undefined && (!isNum(mag) || mag < 1 || mag > 16)) errors.push(`${at}: magnification 必须在 [1, 16]`);
      return;
    }
    default:
      errors.push(`${at}: 未知 type ${String(item.type)}`);
  }
}

/** 校验一份插件包 JSON(不可信输入)。全部通过才返回 ok。 */
export function validatePack(v: unknown): ValidateResult {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: ['插件包必须是 JSON 对象'] };
  if (v.format !== PLUGIN_FORMAT) {
    errors.push(`format 必须是 "${PLUGIN_FORMAT}"(当前仅支持该版本;未知 format 拒装)`);
  }
  if (!isStr(v.id) || !PACK_ID_RE.test(v.id)) errors.push(`包 id 非法(${PACK_ID_RE})`);
  checkName(errors, 'pack', v.name);
  if (!isStr(v.version) || !/^\d+\.\d+\.\d+$/.test(v.version)) errors.push('version 必须是 x.y.z');
  if (v.author !== undefined && (!isStr(v.author) || v.author.length > PLUGIN_LIMITS.maxNameLen)) errors.push('author 超长');
  if (v.description !== undefined && (!isStr(v.description) || v.description.length > PLUGIN_LIMITS.maxDescLen)) errors.push('description 超长');
  if (!Array.isArray(v.items) || v.items.length < 1 || v.items.length > PLUGIN_LIMITS.maxItems) {
    errors.push(`items 必须是 1..${PLUGIN_LIMITS.maxItems} 条`);
  } else {
    const ids = new Set<string>();
    for (const [i, item] of v.items.entries()) {
      checkItem(errors, item, i);
      const id = isObj(item) && isStr(item.id) ? item.id : null;
      if (id) {
        if (ids.has(id)) errors.push(`items[${i}]: id 重复 ${id}`);
        ids.add(id);
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, pack: { ...v, format: PLUGIN_FORMAT } as unknown as PluginPack };
}

/** 单条内容的校验(供「导出为插件」/编辑器内建流使用) */
export function validateItem(item: unknown): string[] {
  const errors: string[] = [];
  checkItem(errors, item, 0);
  return errors;
}
