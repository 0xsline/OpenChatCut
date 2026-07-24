// Pure verification of the plug-in package (the first door to install): schema/upper limit/GLSL token/cube dry run/envelope value range.
// No touching of WebGL/DOM - real compilation probe is in install.ts (browser side). tsx can be run, enter npm test.
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
    errors.push(`${at}: name must be 1..${PLUGIN_LIMITS.maxNameLen} string of characters`);
  }
}

function checkProps(errors: string[], at: string, v: unknown): PluginNumberProp[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > PLUGIN_LIMITS.maxProps) {
    errors.push(`${at}: props must be ≤${PLUGIN_LIMITS.maxProps} array of items`);
    return undefined;
  }
  const seen = new Set<string>();
  for (const [i, p] of v.entries()) {
    const where = `${at}.props[${i}]`;
    if (!isObj(p)) { errors.push(`${where}: Must be an object`); continue; }
    if (!isStr(p.key) || !PROP_KEY_RE.test(p.key)) errors.push(`${where}: key illegal(${PROP_KEY_RE})`);
    else if (seen.has(p.key)) errors.push(`${where}: key Repeat ${p.key}`);
    else seen.add(p.key);
    if (!isStr(p.label) || !p.label.trim()) errors.push(`${where}: label Missing`);
    if (!isNum(p.default) || !isNum(p.min) || !isNum(p.max) || p.min > p.max) {
      errors.push(`${where}: default/min/max must be a finite number and min≤max`);
    }
    if (p.step !== undefined && (!isNum(p.step) || p.step <= 0)) errors.push(`${where}: step Must >0`);
  }
  return v as PluginNumberProp[];
}

function checkFrag(errors: string[], at: string, frag: unknown, requiredTokens: string[]): void {
  if (!isStr(frag) || !frag.trim()) { errors.push(`${at}: frag Missing`); return; }
  if (bytes(frag) > PLUGIN_LIMITS.maxFragBytes) errors.push(`${at}: frag exceed ${PLUGIN_LIMITS.maxFragBytes / 1024}KB`);
  for (const token of requiredTokens) {
    if (!frag.includes(token)) errors.push(`${at}: frag Must quote ${token}`);
  }
}

// data:image/* inline (limited length) or origin path/https; other schemes (javascript:, etc.) are rejected
function checkThumb(errors: string[], at: string, v: unknown): void {
  if (v === undefined) return;
  if (!isStr(v) || !v.trim()) { errors.push(`${at}: thumb Must be a non-empty string`); return; }
  if (v.startsWith('data:image/')) {
    if (bytes(v) > PLUGIN_LIMITS.maxThumbBytes) errors.push(`${at}: thumb exceed ${PLUGIN_LIMITS.maxThumbBytes / 1024}KB`);
    return;
  }
  if (!v.startsWith('/') && !v.startsWith('https://') && !v.startsWith('http://')) {
    errors.push(`${at}: thumb only allowed data:image/* or URL(/… | https://…)`);
  }
}

function checkItem(errors: string[], item: unknown, index: number): void {
  const at = `items[${index}]`;
  if (!isObj(item)) { errors.push(`${at}: Must be an object`); return; }
  if (!isStr(item.id) || !ITEM_ID_RE.test(item.id)) errors.push(`${at}: id illegal(${ITEM_ID_RE})`);
  checkName(errors, at, item.name);
  if (item.desc !== undefined && (!isStr(item.desc) || item.desc.length > PLUGIN_LIMITS.maxDescLen)) {
    errors.push(`${at}: desc Extra long(≤${PLUGIN_LIMITS.maxDescLen})`);
  }
  checkThumb(errors, at, item.thumb);
  switch (item.type) {
    case 'mg-template': {
      if (!isStr(item.code) || !item.code.trim()) errors.push(`${at}: code Missing`);
      else if (bytes(item.code) > PLUGIN_LIMITS.maxCodeBytes) errors.push(`${at}: code exceed ${PLUGIN_LIMITS.maxCodeBytes / 1024}KB`);
      for (const dim of ['width', 'height'] as const) {
        const v = item[dim];
        if (v !== undefined && (!isNum(v) || v < 16 || v > 8192)) errors.push(`${at}: ${dim} must be in [16, 8192]`);
      }
      if (item.props !== undefined && !isObj(item.props)) errors.push(`${at}: props Must be an object`);
      if (item.propSchema !== undefined) {
        if (!Array.isArray(item.propSchema) || item.propSchema.length > 32) {
          errors.push(`${at}: propSchema must be ≤32 array of items`);
        } else {
          for (const [i, s] of item.propSchema.entries()) {
            if (!isObj(s) || !isStr(s.key) || !isStr(s.type)) {
              errors.push(`${at}.propSchema[${i}]: need key/type string`);
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
      if (d !== undefined && (!isNum(d) || d < 2 || d > 300)) errors.push(`${at}: defaultDurationFrames must be in [2, 300]`);
      return;
    }
    case 'fx': {
      checkFrag(errors, at, item.frag, ['u_input']);
      checkProps(errors, at, item.props);
      if (item.passes !== undefined) {
        if (!Array.isArray(item.passes) || item.passes.length < 1 || item.passes.length > 4) {
          errors.push(`${at}: passes must be 1..4 array of segments`);
        } else {
          for (const [i, pass] of item.passes.entries()) checkFrag(errors, `${at}.passes[${i}]`, pass, []);
        }
      }
      return;
    }
    case 'lut': {
      if (!isStr(item.cube) || !item.cube.trim()) { errors.push(`${at}: cube Missing`); return; }
      if (bytes(item.cube) > PLUGIN_LIMITS.maxCubeBytes) { errors.push(`${at}: cube exceed ${PLUGIN_LIMITS.maxCubeBytes / 1024 / 1024}MB`); return; }
      try {
        parseCube(item.cube);
      } catch (e) {
        errors.push(`${at}: cube Parsing failed — ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    case 'zoom': {
      const env = item.envelope;
      if (!Array.isArray(env) || env.length < PLUGIN_LIMITS.minEnvelopePoints || env.length > PLUGIN_LIMITS.maxEnvelopePoints) {
        errors.push(`${at}: envelope must be ${PLUGIN_LIMITS.minEnvelopePoints}..${PLUGIN_LIMITS.maxEnvelopePoints} point`);
      } else if (!env.every((v) => isNum(v) && v >= 0 && v <= PLUGIN_LIMITS.maxEnvelopeValue)) {
        errors.push(`${at}: envelope value must be within [0, ${PLUGIN_LIMITS.maxEnvelopeValue}]`);
      }
      const mag = item.magnification;
      if (mag !== undefined && (!isNum(mag) || mag < 1 || mag > 16)) errors.push(`${at}: magnification must be in [1, 16]`);
      return;
    }
    default:
      errors.push(`${at}: unknown type ${String(item.type)}`);
  }
}

/** Verify a plug-in package JSON(untrusted input). Return after all passes ok。 */
export function validatePack(v: unknown): ValidateResult {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: ['The plugin package must be JSON object'] };
  if (v.format !== PLUGIN_FORMAT) {
    errors.push(`format must be "${PLUGIN_FORMAT}"(Currently only this version is supported;unknown format Refusal to install)`);
  }
  if (!isStr(v.id) || !PACK_ID_RE.test(v.id)) errors.push(`package id illegal(${PACK_ID_RE})`);
  checkName(errors, 'pack', v.name);
  if (!isStr(v.version) || !/^\d+\.\d+\.\d+$/.test(v.version)) errors.push('version must be x.y.z');
  if (v.author !== undefined && (!isStr(v.author) || v.author.length > PLUGIN_LIMITS.maxNameLen)) errors.push('author Extra long');
  if (v.description !== undefined && (!isStr(v.description) || v.description.length > PLUGIN_LIMITS.maxDescLen)) errors.push('description Extra long');
  if (!Array.isArray(v.items) || v.items.length < 1 || v.items.length > PLUGIN_LIMITS.maxItems) {
    errors.push(`items must be 1..${PLUGIN_LIMITS.maxItems} Article`);
  } else {
    const ids = new Set<string>();
    for (const [i, item] of v.items.entries()) {
      checkItem(errors, item, i);
      const id = isObj(item) && isStr(item.id) ? item.id : null;
      if (id) {
        if (ids.has(id)) errors.push(`items[${i}]: id Repeat ${id}`);
        ids.add(id);
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, pack: { ...v, format: PLUGIN_FORMAT } as unknown as PluginPack };
}

/** Verification of single content(For "Export as plug-in"/Editor built-in stream usage) */
export function validateItem(item: unknown): string[] {
  const errors: string[] = [];
  checkItem(errors, item, 0);
  return errors;
}
