// Camera-log → Rec.709 LUT catalog, split out of effects.ts (which re-exports
// it, so no import site changes).

import lutFrag from './lut.frag?raw';
import lookTealOrangeFrag from './look-teal-orange.frag?raw';
import lookMonoFrag from './look-mono.frag?raw';
import lookWarmFrag from './look-warm.frag?raw';
import lookCoolFrag from './look-cool.frag?raw';
import lookSunsetFrag from './look-sunset.frag?raw';
import lookCyberFrag from './look-cyber.frag?raw';
import lookBleachFrag from './look-bleach.frag?raw';
import lookFujiChromeFrag from './look-fuji-chrome.frag?raw';
import lookFujiPortraFrag from './look-fuji-portra.frag?raw';
import lookFujiVelviaFrag from './look-fuji-velvia.frag?raw';
import lookRicohGrFrag from './look-ricoh-gr.frag?raw';
import lookKodakGoldFrag from './look-kodak-gold.frag?raw';
import lookDisposableFrag from './look-disposable.frag?raw';
import lookCinestillFrag from './look-cinestill.frag?raw';
import type { FxDef } from './uniforms';

// LUTs: camera-log → Rec.709 color transforms. Kept
// separate from FX so the library shows them under their own LUT tab, but they
// render through the same per-clip GL pipeline. intensity mixes original↔graded
// through propertyOverrides.intensity.
export const LUT_EFFECTS: Record<string, FxDef> = {
  'builtin:slog3-s709': {
    id: 'builtin:slog3-s709',
    name: 'Sony S-Log3 → s709',
    desc: 'Sony S-Log3 / S-Gamut3.Cine → Rec.709。.cube 三维查找表（Sony_Slog3_s709.cube, 33³）+ 通用 lut.frag（sampler3D，BT.709 编解码包夹）',
    frag: lutFrag,
    cube: '/luts/Sony_Slog3_s709.cube',
    props: [{ key: 'intensity', label: '强度', default: 1, min: 0, max: 1, step: 0.01 }],
  },
  'builtin:canon-log3-709': {
    id: 'builtin:canon-log3-709',
    name: 'Canon Log 3 → BT.709',
    desc: 'Canon Cinema Gamut / Canon Log 3 → Canon 709。.cube 三维查找表（CinemaGamut_CanonLog3-to-Canon709_33_Ver.1.0.cube, 33³）+ 通用 lut.frag',
    frag: lutFrag,
    cube: '/luts/CinemaGamut_CanonLog3-to-Canon709_33_Ver.1.0.cube',
    props: [{ key: 'intensity', label: '强度', default: 1, min: 0, max: 1, step: 0.01 }],
  },
  // creative looks (formula grades — not camera-log cubes)
  'builtin:look-teal-orange': {
    id: 'builtin:look-teal-orange',
    name: '青橙电影感',
    desc: '阴影偏青、高光偏橙的好莱坞调色。',
    frag: lookTealOrangeFrag,
    props: [
      { key: 'intensity', label: '强度', default: 0.85, min: 0, max: 1, step: 0.01 },
      { key: 'contrast', label: '对比', default: 1.1, min: 0.6, max: 1.8, step: 0.02 },
    ],
  },
  'builtin:look-mono': {
    id: 'builtin:look-mono',
    name: '黑白胶片',
    desc: '高对比黑白 + 轻微动态颗粒。',
    frag: lookMonoFrag,
    props: [
      { key: 'intensity', label: '强度', default: 1, min: 0, max: 1, step: 0.01 },
      { key: 'contrast', label: '对比', default: 1.25, min: 0.6, max: 2.2, step: 0.02 },
      { key: 'grain', label: '颗粒', default: 0.08, min: 0, max: 0.4, step: 0.01 },
    ],
  },
  'builtin:look-warm': {
    id: 'builtin:look-warm',
    name: '暖调复古',
    desc: '偏暖色温与轻度褪色，复古质感。',
    frag: lookWarmFrag,
    props: [
      { key: 'intensity', label: '强度', default: 0.9, min: 0, max: 1, step: 0.01 },
      { key: 'temperature', label: '色温', default: 0.7, min: 0, max: 1.5, step: 0.02 },
      { key: 'fade', label: '褪色', default: 0.35, min: 0, max: 1, step: 0.01 },
    ],
  },
  'builtin:look-cool': {
    id: 'builtin:look-cool',
    name: '冷调青蓝',
    desc: '偏冷色温，阴影加压蓝。',
    frag: lookCoolFrag,
    props: [
      { key: 'intensity', label: '强度', default: 0.85, min: 0, max: 1, step: 0.01 },
      { key: 'temperature', label: '冷度', default: 0.75, min: 0, max: 1.5, step: 0.02 },
      { key: 'shadows', label: '阴影蓝', default: 0.55, min: 0, max: 1, step: 0.01 },
    ],
  },
  'builtin:look-sunset': {
    id: 'builtin:look-sunset',
    name: '日落暖金',
    desc: '高光偏金、阴影压暖的黄昏感。',
    frag: lookSunsetFrag,
    props: [
      { key: 'intensity', label: '强度', default: 0.9, min: 0, max: 1, step: 0.01 },
      { key: 'warmth', label: '暖度', default: 1, min: 0, max: 1.5, step: 0.02 },
    ],
  },
  'builtin:look-cyber': {
    id: 'builtin:look-cyber',
    name: '赛博霓虹',
    desc: '阴影青蓝、高光品红的霓虹科幻调。',
    frag: lookCyberFrag,
    props: [
      { key: 'intensity', label: '强度', default: 0.85, min: 0, max: 1, step: 0.01 },
      { key: 'contrast', label: '对比', default: 1.2, min: 0.6, max: 2, step: 0.02 },
    ],
  },
  'builtin:look-bleach': {
    id: 'builtin:look-bleach',
    name: '漂白旁路',
    desc: '低饱和 + 抬黑的漂白旁路电影感。',
    frag: lookBleachFrag,
    props: [
      { key: 'intensity', label: '强度', default: 0.9, min: 0, max: 1, step: 0.01 },
      { key: 'fade', label: '褪色', default: 0.45, min: 0, max: 1, step: 0.01 },
    ],
  },
  // ── film / camera aesthetics (formula looks, not licensed cubes) ─────────
  'builtin:look-fuji-chrome': {
    id: 'builtin:look-fuji-chrome',
    name: '富士 Classic Chrome',
    desc: '低饱和、柔和对比、中灰偏冷——旅行/街拍纪录片感（灵感自富士胶片模拟，非官方 LUT）。',
    frag: lookFujiChromeFrag,
    props: [
      { key: 'intensity', label: '强度', default: 0.92, min: 0, max: 1, step: 0.01 },
      { key: 'fade', label: '褪色', default: 0.4, min: 0, max: 1, step: 0.01 },
      { key: 'grain', label: '颗粒', default: 0.06, min: 0, max: 0.35, step: 0.01 },
    ],
  },
  'builtin:look-fuji-portra': {
    id: 'builtin:look-fuji-portra',
    name: '富士人像 Pro Neg',
    desc: '奶油肤色、粉柔高光、抬黑阴影——人像/生活感（灵感自 Portra / Pro Neg）。',
    frag: lookFujiPortraFrag,
    props: [
      { key: 'intensity', label: '强度', default: 0.9, min: 0, max: 1, step: 0.01 },
      { key: 'warmth', label: '暖度', default: 0.85, min: 0, max: 1.5, step: 0.02 },
      { key: 'softness', label: '柔和', default: 0.7, min: 0, max: 1, step: 0.02 },
      { key: 'grain', label: '颗粒', default: 0.05, min: 0, max: 0.3, step: 0.01 },
    ],
  },
  'builtin:look-fuji-velvia': {
    id: 'builtin:look-fuji-velvia',
    name: '富士 Velvia 风光',
    desc: '高饱和绿/蓝、通透对比——景区/自然风光（灵感自 Velvia 反转片）。',
    frag: lookFujiVelviaFrag,
    props: [
      { key: 'intensity', label: '强度', default: 0.88, min: 0, max: 1, step: 0.01 },
      { key: 'saturation', label: '饱和', default: 1.1, min: 0.4, max: 1.8, step: 0.02 },
      { key: 'contrast', label: '对比', default: 1.15, min: 0.7, max: 1.8, step: 0.02 },
      { key: 'grain', label: '颗粒', default: 0.04, min: 0, max: 0.25, step: 0.01 },
    ],
  },
  'builtin:look-ricoh-gr': {
    id: 'builtin:look-ricoh-gr',
    name: '理光 GR 街拍',
    desc: '硬一点对比、冷中性灰、城市纪实——GR 随手拍感（灵感自理光街拍审美）。',
    frag: lookRicohGrFrag,
    props: [
      { key: 'intensity', label: '强度', default: 0.9, min: 0, max: 1, step: 0.01 },
      { key: 'contrast', label: '对比', default: 1.22, min: 0.8, max: 1.8, step: 0.02 },
      { key: 'cool', label: '冷调', default: 0.75, min: 0, max: 1.5, step: 0.02 },
      { key: 'grain', label: '颗粒', default: 0.07, min: 0, max: 0.35, step: 0.01 },
    ],
  },
  'builtin:look-kodak-gold': {
    id: 'builtin:look-kodak-gold',
    name: '柯达金 Gold',
    desc: '暖黄绿怀旧、软对比——千禧年随手拍 / 家庭相册感（灵感自 Kodak Gold）。',
    frag: lookKodakGoldFrag,
    props: [
      { key: 'intensity', label: '强度', default: 0.9, min: 0, max: 1, step: 0.01 },
      { key: 'yellow', label: '金黄', default: 1, min: 0, max: 1.5, step: 0.02 },
      { key: 'fade', label: '褪色', default: 0.4, min: 0, max: 1, step: 0.01 },
      { key: 'grain', label: '颗粒', default: 0.08, min: 0, max: 0.4, step: 0.01 },
    ],
  },
  'builtin:look-disposable': {
    id: 'builtin:look-disposable',
    name: '拍立得 / 一次性',
    desc: '软糊、绿偏、粗颗粒、暗角——拍立得与一次性相机那味。',
    frag: lookDisposableFrag,
    props: [
      { key: 'intensity', label: '强度', default: 0.92, min: 0, max: 1, step: 0.01 },
      { key: 'cast', label: '偏色', default: 0.9, min: 0, max: 1.5, step: 0.02 },
      { key: 'grain', label: '颗粒', default: 0.16, min: 0, max: 0.5, step: 0.01 },
      { key: 'vignette', label: '暗角', default: 0.45, min: 0, max: 1, step: 0.01 },
    ],
  },
  'builtin:look-cinestill': {
    id: 'builtin:look-cinestill',
    name: 'CineStill 夜景',
    desc: '钨丝灯冷青、高光微溢——夜街/霓虹（灵感自 CineStill 800T）。',
    frag: lookCinestillFrag,
    props: [
      { key: 'intensity', label: '强度', default: 0.88, min: 0, max: 1, step: 0.01 },
      { key: 'cyan', label: '青冷', default: 0.95, min: 0, max: 1.5, step: 0.02 },
      { key: 'contrast', label: '对比', default: 1.18, min: 0.7, max: 1.8, step: 0.02 },
      { key: 'grain', label: '颗粒', default: 0.09, min: 0, max: 0.4, step: 0.01 },
    ],
  },
};
export const LUT_ORDER = [
  'builtin:slog3-s709',
  'builtin:canon-log3-709',
  // film / camera aesthetics first for the library tab
  'builtin:look-fuji-chrome',
  'builtin:look-fuji-portra',
  'builtin:look-fuji-velvia',
  'builtin:look-ricoh-gr',
  'builtin:look-kodak-gold',
  'builtin:look-disposable',
  'builtin:look-cinestill',
  'builtin:look-teal-orange',
  'builtin:look-mono',
  'builtin:look-warm',
  'builtin:look-cool',
  'builtin:look-sunset',
  'builtin:look-cyber',
  'builtin:look-bleach',
] as const;
export const LUT_IDS = [
  ...LUT_ORDER.filter((id) => id in LUT_EFFECTS),
  ...Object.keys(LUT_EFFECTS).filter((id) => !(LUT_ORDER as readonly string[]).includes(id)),
];
