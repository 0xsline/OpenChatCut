import lumaKeyFrag from './luma-key.frag?raw';
import localMosaicFrag from './local-mosaic.frag?raw';
import magnifyFrag from './magnify.frag?raw';
import rectMaskFrag from './rect-mask.frag?raw';
import circleMaskFrag from './circle-mask.frag?raw';
import type { FxDef } from './uniforms';

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
};

export const FX_IDS = Object.keys(FX_EFFECTS);
