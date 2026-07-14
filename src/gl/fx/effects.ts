import lumaKeyFrag from './luma-key.frag?raw';
import localMosaicFrag from './local-mosaic.frag?raw';
import magnifyFrag from './magnify.frag?raw';
import rectMaskFrag from './rect-mask.frag?raw';
import circleMaskFrag from './circle-mask.frag?raw';
import crtFrag from './crt.frag?raw';
import cameraShakeFrag from './camera-shake.frag?raw';
import tiltShiftPass1Frag from './tilt-shift-pass1.frag?raw';
import tiltShiftPass2Frag from './tilt-shift-pass2.frag?raw';
import asciiRainFrag from './ascii-rain.frag?raw';
import asciiRainBlurFrag from './ascii-rain-blur.frag?raw';
import asciiRainCompositeFrag from './ascii-rain-composite.frag?raw';
import slog3Frag from './slog3-s709.frag?raw';
import canonLog3Frag from './canon-log3-709.frag?raw';
import chromaKeyFrag from './chroma-key.frag?raw';
import type { FxDef } from './uniforms';
import type { FxPass } from '../runtime';

// invert is a boolean in the source (helper oJ); modeled here as a 0/1 slider.
const INVERT = { key: 'invert', label: '反转', default: 0, min: 0, max: 1, step: 1 };

// Per-clip WebGL effects — faithful to the source's builtin:fx-* processors
// (entry.js: single-input renderPass, u_input + gn(name,default,min,max)
// uniforms, premultiplied-alpha out). Each effect's fragment shader is copied
// verbatim; `props` mirror the source's gn() defaults/ranges and drive both the
// uniform values and the inspector sliders. u_width/u_height/u_resolution are
// supplied by the runtime (canvas size), not user properties.

export type { FxDef, FxProperty } from './uniforms';
export { fxUniform, fxUniforms } from './uniforms';

export const FX_EFFECTS: Record<string, FxDef> = {
  'builtin:fx-luma-key': {
    id: 'builtin:fx-luma-key',
    name: '黑底叠加（Screen）',
    desc: '把黑色背景变透明、保留亮部，像 Screen 混合——叠加火焰/烟雾/漏光/粒子等黑底素材。源站 builtin:fx-luma-key',
    frag: lumaKeyFrag,
    props: [
      { key: 'intensity', label: '强度', default: 1, min: 0, max: 3, step: 0.05 },
      { key: 'threshold', label: '阈值', default: 0.03, min: 0, max: 0.2, step: 0.005 },
      { key: 'softness', label: '柔和', default: 0.3, min: 0.05, max: 0.8, step: 0.01 },
      { key: 'gamma', label: 'Gamma', default: 0.7, min: 0.3, max: 2, step: 0.05 },
    ],
  },
  'builtin:fx-local-mosaic': {
    id: 'builtin:fx-local-mosaic',
    name: '局部马赛克',
    desc: '对矩形区域打码，可调位置/尺寸/块大小/羽化。源站 builtin:fx-local-mosaic',
    frag: localMosaicFrag,
    props: [
      { key: 'center_x', label: '中心 X', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'center_y', label: '中心 Y', default: 0.3, min: 0, max: 1, step: 0.01 },
      { key: 'width_ratio', label: '宽度', default: 0.2, min: 0, max: 1, step: 0.01 },
      { key: 'height_ratio', label: '高度', default: 0.2, min: 0, max: 1, step: 0.01 },
      { key: 'block_size', label: '块大小', default: 20, min: 1, max: 200, step: 1 },
      { key: 'feather', label: '羽化', default: 4, min: 0, max: 100, step: 1 },
    ],
  },
  'builtin:fx-magnify': {
    id: 'builtin:fx-magnify',
    name: '放大镜',
    desc: '在指定圆心加一个放大镜头，可调半径/倍率/边框。源站 builtin:fx-magnify',
    frag: magnifyFrag,
    props: [
      { key: 'center_x', label: '中心 X', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'center_y', label: '中心 Y', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'radius', label: '半径', default: 0.15, min: 0.01, max: 1, step: 0.01 },
      { key: 'magnification', label: '倍率', default: 2, min: 1, max: 8, step: 0.1 },
      { key: 'border_width', label: '边框', default: 4, min: 0, max: 20, step: 1 },
    ],
  },
  'builtin:fx-rect-mask': {
    id: 'builtin:fx-rect-mask',
    name: '矩形遮罩',
    desc: '把画面裁成圆角矩形，可调位置/尺寸/圆角/羽化/反转。源站 builtin:fx-rect-mask',
    frag: rectMaskFrag,
    props: [
      { key: 'center_x', label: '中心 X', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'center_y', label: '中心 Y', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'width', label: '宽度', default: 0.5, min: 0, max: 1, step: 0.01, uniform: 'u_rect_width' },
      { key: 'height', label: '高度', default: 0.5, min: 0, max: 1, step: 0.01, uniform: 'u_rect_height' },
      { key: 'corner_radius', label: '圆角', default: 0, min: 0, max: 1000, step: 1 },
      { key: 'feather', label: '羽化', default: 2, min: 0, max: 200, step: 1 },
      INVERT,
    ],
  },
  'builtin:fx-circle-mask': {
    id: 'builtin:fx-circle-mask',
    name: '圆形遮罩',
    desc: '把画面裁成柔边圆形，可调圆心/半径/羽化/反转。源站 builtin:fx-circle-mask',
    frag: circleMaskFrag,
    props: [
      { key: 'center_x', label: '中心 X', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'center_y', label: '中心 Y', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'radius', label: '半径', default: 0.3, min: 0, max: 1, step: 0.01 },
      { key: 'feather', label: '羽化', default: 2, min: 0, max: 200, step: 1 },
      INVERT,
    ],
  },
  'builtin:fx-crt': {
    id: 'builtin:fx-crt',
    name: 'CRT 复古',
    desc: '模拟 CRT 显像管：扫描线/屏幕弯曲/RGB 偏移/噪点/暗角。动画。源站 builtin:fx-crt',
    frag: crtFrag,
    props: [
      { key: 'scanlineIntensity', label: '扫描线', default: 0.4, min: 0, max: 1, step: 0.01 },
      { key: 'curvature', label: '弯曲', default: 0.15, min: 0, max: 1, step: 0.01 },
      { key: 'noiseAmount', label: '噪点', default: 0.05, min: 0, max: 1, step: 0.01 },
      { key: 'rgbShift', label: 'RGB 偏移', default: 0.002, min: 0, max: 0.05, step: 0.001 },
      { key: 'brightness', label: '亮度', default: 1.1, min: 0, max: 3, step: 0.05 },
    ],
  },
  'builtin:fx-ascii-rain': {
    id: 'builtin:fx-ascii-rain',
    name: 'ASCII Rain',
    desc: '在视频亮部生成蓝色发光 ASCII 字符雨。源站 builtin:fx-ascii-rain',
    frag: asciiRainFrag,
    pipeline: (uniforms) => {
      const blurRadius = typeof uniforms.u_blurRadius === 'number' ? uniforms.u_blurRadius : 2;
      const passes: FxPass[] = [
        { frag: asciiRainFrag, uniforms },
        { frag: asciiRainBlurFrag, uniforms: { u_direction: [blurRadius, 0] } },
        { frag: asciiRainBlurFrag, uniforms: { u_direction: [0, blurRadius] } },
        { frag: asciiRainCompositeFrag, inputFrom: 0, samplers: { u_bloom: 2 }, uniforms },
      ];
      return passes;
    },
    props: [
      { key: 'gridSize', label: '字符大小', default: 8, min: 4, max: 32, step: 1 },
      { key: 'glow', label: '发光强度', default: 1.5, min: 0, max: 4, step: 0.1 },
      { key: 'blurRadius', label: '泛光范围', default: 2, min: 0, max: 8, step: 0.5 },
      { key: 'color', label: '字符颜色', kind: 'color', default: [0, 0.7490196078431373, 1], uniform: 'u_color' },
    ],
  },
  'builtin:fx-shake': {
    id: 'builtin:fx-shake',
    name: '手持镜头抖动',
    desc: 'fbm 噪声抖动 + 旋转/缩放/呼吸，模拟手持相机运动。动画。源站 builtin:fx-shake',
    frag: cameraShakeFrag,
    props: [
      { key: 'strength', label: '强度', default: 1.2, min: 0, max: 5, step: 0.1 },
      { key: 'speed', label: '速度', default: 1.8, min: 0, max: 10, step: 0.1 },
      { key: 'zoom', label: '缩放', default: 1.15, min: 1, max: 2, step: 0.01 },
      { key: 'rotation', label: '旋转', default: 0.9, min: 0, max: 5, step: 0.1 },
      { key: 'breathe', label: '呼吸', default: 0.7, min: 0, max: 3, step: 0.1 },
    ],
  },
  'builtin:fx-tilt-shift': {
    id: 'builtin:fx-tilt-shift',
    name: '移轴（微缩景观）',
    desc: '模拟移轴镜头：一条焦点带清晰、上下渐糊 + 饱和度/暗角。两遍可分离高斯模糊。源站 builtin:fx-tilt-shift',
    frag: tiltShiftPass1Frag,
    passes: [tiltShiftPass1Frag, tiltShiftPass2Frag],
    props: [
      { key: 'focusY', label: '焦点位置', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'focusWidth', label: '焦点带宽', default: 0.2, min: 0, max: 1, step: 0.01 },
      { key: 'tiltAngle', label: '倾角', default: 0, min: -3.14159, max: 3.14159, step: 0.01 },
      { key: 'blurStrength', label: '模糊强度', default: 12, min: 0, max: 40, step: 0.5 },
      { key: 'blurSide', label: '模糊侧(0双/1上/2下)', default: 0, min: 0, max: 2, step: 1 },
      { key: 'saturation', label: '饱和度', default: 1.3, min: 0, max: 3, step: 0.05 },
      { key: 'vignette', label: '暗角', default: 0.2, min: 0, max: 1, step: 0.01 },
    ],
  },
  'builtin:fx-chroma-key': {
    id: 'builtin:fx-chroma-key',
    name: '色度键/绿幕',
    desc: '按键色（默认绿幕）抠除背景，可调容差/羽化/溢色抑制。PRD 只提到功能名，未反编译出算法，自定实现。',
    frag: chromaKeyFrag,
    props: [
      { key: 'keyColor', label: '键色', kind: 'color', default: [0, 1, 0], uniform: 'u_keyColor' },
      { key: 'similarity', label: '容差', default: 0.18, min: 0, max: 0.6, step: 0.01 },
      { key: 'smoothness', label: '羽化', default: 0.08, min: 0.001, max: 0.4, step: 0.005 },
      { key: 'spill', label: '溢色抑制', default: 0.5, min: 0, max: 1, step: 0.01 },
    ],
  },
};

export const FX_IDS = Object.keys(FX_EFFECTS);

// LUTs (source category "lut"): camera-log → Rec.709 color transforms. Kept
// separate from FX so the library shows them under their own LUT tab, but they
// render through the same per-clip GL pipeline. intensity mixes original↔graded
// (source lut_detail.json: propertyOverrides.intensity).
export const LUT_EFFECTS: Record<string, FxDef> = {
  'builtin:slog3-s709': {
    id: 'builtin:slog3-s709',
    name: 'Sony S-Log3 s709',
    desc: 'Sony S-Log3 / S-Gamut3.Cine → Rec.709（公式实现，非源站 .cube）',
    frag: slog3Frag,
    props: [{ key: 'intensity', label: '强度', default: 1, min: 0, max: 1, step: 0.01 }],
  },
  'builtin:canon-log3-709': {
    id: 'builtin:canon-log3-709',
    name: 'Canon Log3 → Canon 709',
    desc: 'Canon Cinema Gamut / Canon Log 3 → Canon 709（公式实现，非源站 .cube）',
    frag: canonLog3Frag,
    props: [{ key: 'intensity', label: '强度', default: 1, min: 0, max: 1, step: 0.01 }],
  },
};
export const LUT_IDS = Object.keys(LUT_EFFECTS);

// every per-clip GL effect (fx + lut) — ClipFx / agent / inspector resolve here
export const ALL_FX: Record<string, FxDef> = { ...FX_EFFECTS, ...LUT_EFFECTS };

// ── 运行时自定义 fx（submit_shader 的 LLM 生成产物）注册表 ─────────────────────
// effect-tools.ts 在模块加载时用「引用」捕获了 ALL_FX（`const FX_EFFECTS = ALL_FX`），
// 所以只要往 ALL_FX 这个对象「原地」写入，manage_effects 的 `assetId in FX_EFFECTS`
// 与 describe() 就能立刻查到自定义 fx——无需改动 effect-tools.ts。CUSTOM_FX 另存一份
// 自定义条目，便于区分/枚举/测试。内置 fx 与 LUT 保持不变。
// ponytail: 注册表本质是共享运行时状态，这里是唯一必须「原地改」的地方（唯一能让已
// 捕获引用的 effect-tools 看到新 fx 的方式）；其余仍遵守不可变约定。
export const CUSTOM_FX: Record<string, FxDef> = {};

/** 注册一个运行时自定义 fx：写入 CUSTOM_FX，并原地并入 ALL_FX 供 effect-tools 查到。 */
export function registerCustomFx(def: FxDef): FxDef {
  CUSTOM_FX[def.id] = def;
  ALL_FX[def.id] = def;
  return def;
}
