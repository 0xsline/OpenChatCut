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
import lutFrag from './lut.frag?raw';
import chromaKeyFrag from './chroma-key.frag?raw';
import vignetteFrag from './vignette.frag?raw';
import filmGrainFrag from './film-grain.frag?raw';
import rgbSplitFrag from './rgb-split.frag?raw';
import glitchFrag from './glitch.frag?raw';
import bloomFrag from './bloom.frag?raw';
import pixelateFrag from './pixelate.frag?raw';
import posterizeFrag from './posterize.frag?raw';
import duotoneFrag from './duotone.frag?raw';
import mirrorFrag from './mirror.frag?raw';
import fisheyeFrag from './fisheye.frag?raw';
import kaleidoscopeFrag from './kaleidoscope.frag?raw';
import edgeGlowFrag from './edge-glow.frag?raw';
import softBlurFrag from './soft-blur.frag?raw';
import lightLeakFrag from './light-leak.frag?raw';
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
import sepiaFrag from './sepia.frag?raw';
import invertFrag from './invert.frag?raw';
import halftoneFrag from './halftone.frag?raw';
import motionBlurFrag from './motion-blur.frag?raw';
import type { FxDef, SerializableFxDef } from './uniforms';
import type { FxPass } from '../runtime';

// invert is modeled as a 0/1 slider.
const INVERT = { key: 'invert', label: '反转', default: 0, min: 0, max: 1, step: 1 };

// Per-clip WebGL effects (builtin:fx-*): single-input renderPass, u_input +
// named uniforms (name, default, min, max), premultiplied-alpha out.
// `props` carry each uniform's defaults/ranges and drive both the
// uniform values and the inspector sliders. u_width/u_height/u_resolution are
// supplied by the runtime (canvas size), not user properties.

export type { FxDef, FxProperty } from './uniforms';
export { fxUniform, fxUniforms } from './uniforms';

export const FX_EFFECTS: Record<string, FxDef> = {
  'builtin:fx-luma-key': {
    id: 'builtin:fx-luma-key',
    name: '黑底叠加',
    desc: '把黑色背景变透明、保留亮部，像 Screen 混合——叠加火焰/烟雾/漏光/粒子等黑底素材。',
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
    desc: '对矩形区域打码，可调位置/尺寸/块大小/羽化。',
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
    desc: '在指定圆心加一个放大镜头，可调半径/倍率/边框。',
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
    name: '方形蒙版',
    desc: '把画面裁成圆角矩形，可调位置/尺寸/圆角/羽化/反转。',
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
    name: '圆形蒙版',
    desc: '把画面裁成柔边圆形，可调圆心/半径/羽化/反转。',
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
    name: 'CRT 复古显像管',
    desc: '模拟 CRT 显像管：扫描线/屏幕弯曲/RGB 偏移/噪点/暗角。动画。',
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
    name: 'ASCII 字符雨',
    desc: '在视频亮部生成蓝色发光 ASCII 字符雨。',
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
    name: '手持运镜',
    desc: 'fbm 噪声抖动 + 旋转/缩放/呼吸，模拟手持相机运动。动画。',
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
    name: '移轴镜头',
    desc: '模拟移轴镜头：一条焦点带清晰、上下渐糊 + 饱和度/暗角。两遍可分离高斯模糊。',
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
    desc: '按键色（默认绿幕）抠除背景，可调容差/羽化/溢色抑制。',
    frag: chromaKeyFrag,
    props: [
      { key: 'keyColor', label: '键色', kind: 'color', default: [0, 1, 0], uniform: 'u_keyColor' },
      { key: 'similarity', label: '容差', default: 0.18, min: 0, max: 0.6, step: 0.01 },
      { key: 'smoothness', label: '羽化', default: 0.08, min: 0.001, max: 0.4, step: 0.005 },
      { key: 'spill', label: '溢色抑制', default: 0.5, min: 0, max: 1, step: 0.01 },
    ],
  },

  // ── Extended generated library ──────────────────────────────────────────
  'builtin:fx-vignette': {
    id: 'builtin:fx-vignette',
    name: '暗角',
    desc: '四周压暗，突出中心主体。可调强度/柔和/圆度。',
    frag: vignetteFrag,
    props: [
      { key: 'amount', label: '强度', default: 0.55, min: 0, max: 1, step: 0.01 },
      { key: 'softness', label: '柔和', default: 0.45, min: 0.05, max: 1, step: 0.01 },
      { key: 'roundness', label: '圆度', default: 1, min: 0.5, max: 2, step: 0.01 },
    ],
  },
  'builtin:fx-film-grain': {
    id: 'builtin:fx-film-grain',
    name: '胶片颗粒',
    desc: '动态胶片噪点质感。动画。',
    frag: filmGrainFrag,
    props: [
      { key: 'amount', label: '强度', default: 0.18, min: 0, max: 0.6, step: 0.01 },
      { key: 'size', label: '颗粒大小', default: 1.2, min: 0.5, max: 4, step: 0.1 },
    ],
  },
  'builtin:fx-rgb-split': {
    id: 'builtin:fx-rgb-split',
    name: 'RGB 分离',
    desc: '通道错位色差，赛博/故障感。',
    frag: rgbSplitFrag,
    props: [
      { key: 'amount', label: '偏移', default: 0.008, min: 0, max: 0.05, step: 0.001 },
      { key: 'angle', label: '方向', default: 0, min: 0, max: 6.2832, step: 0.05 },
    ],
  },
  'builtin:fx-glitch': {
    id: 'builtin:fx-glitch',
    name: '故障闪烁',
    desc: '横向切片错位 + 偶发反色/色差。动画。',
    frag: glitchFrag,
    props: [
      { key: 'intensity', label: '强度', default: 0.7, min: 0, max: 2, step: 0.05 },
      { key: 'blockSize', label: '切片密度', default: 28, min: 4, max: 80, step: 1 },
    ],
  },
  'builtin:fx-bloom': {
    id: 'builtin:fx-bloom',
    name: '光晕 Bloom',
    desc: '亮部溢光，电影高光感。',
    frag: bloomFrag,
    props: [
      { key: 'threshold', label: '阈值', default: 0.55, min: 0, max: 1, step: 0.01 },
      { key: 'intensity', label: '强度', default: 0.85, min: 0, max: 3, step: 0.05 },
      { key: 'radius', label: '半径', default: 2.5, min: 0.5, max: 8, step: 0.1 },
    ],
  },
  'builtin:fx-pixelate': {
    id: 'builtin:fx-pixelate',
    name: '像素化',
    desc: '整帧像素块风格化。',
    frag: pixelateFrag,
    props: [
      { key: 'blockSize', label: '块大小', default: 12, min: 2, max: 80, step: 1 },
    ],
  },
  'builtin:fx-posterize': {
    id: 'builtin:fx-posterize',
    name: '色调分离',
    desc: '减少色阶，插画/海报感。',
    frag: posterizeFrag,
    props: [
      { key: 'levels', label: '色阶', default: 5, min: 2, max: 16, step: 1 },
      { key: 'contrast', label: '对比', default: 1.15, min: 0.5, max: 2.5, step: 0.05 },
    ],
  },
  'builtin:fx-duotone': {
    id: 'builtin:fx-duotone',
    name: '双色调',
    desc: '按亮度映射阴影色与高光色。',
    frag: duotoneFrag,
    props: [
      { key: 'shadowColor', label: '阴影色', kind: 'color', default: [0.08, 0.12, 0.35], uniform: 'u_shadowColor' },
      { key: 'highlightColor', label: '高光色', kind: 'color', default: [1.0, 0.72, 0.35], uniform: 'u_highlightColor' },
      { key: 'contrast', label: '对比', default: 1.2, min: 0.5, max: 2.5, step: 0.05 },
      { key: 'intensity', label: '强度', default: 1, min: 0, max: 1, step: 0.01 },
    ],
  },
  'builtin:fx-mirror': {
    id: 'builtin:fx-mirror',
    name: '镜像对称',
    desc: '左右/上下镜像拼贴。mode: 0左→右 1右→左 2上→下 3下→上。',
    frag: mirrorFrag,
    props: [
      { key: 'mode', label: '模式', default: 0, min: 0, max: 3, step: 1 },
      { key: 'axis', label: '轴线', default: 0.5, min: 0.1, max: 0.9, step: 0.01 },
    ],
  },
  'builtin:fx-fisheye': {
    id: 'builtin:fx-fisheye',
    name: '鱼眼',
    desc: '桶形畸变广角效果。',
    frag: fisheyeFrag,
    props: [
      { key: 'strength', label: '强度', default: 0.55, min: 0, max: 1.5, step: 0.01 },
      { key: 'zoom', label: '缩放', default: 1.05, min: 0.5, max: 2, step: 0.01 },
    ],
  },
  'builtin:fx-kaleidoscope': {
    id: 'builtin:fx-kaleidoscope',
    name: '万花筒',
    desc: '径向分片镜像，万花筒图案。',
    frag: kaleidoscopeFrag,
    props: [
      { key: 'segments', label: '分片', default: 6, min: 2, max: 16, step: 1 },
      { key: 'angle', label: '旋转', default: 0, min: 0, max: 6.2832, step: 0.05 },
      { key: 'zoom', label: '缩放', default: 1, min: 0.4, max: 2, step: 0.01 },
    ],
  },
  'builtin:fx-edge-glow': {
    id: 'builtin:fx-edge-glow',
    name: '边缘发光',
    desc: 'Sobel 边缘检测叠加彩色描边。',
    frag: edgeGlowFrag,
    props: [
      { key: 'strength', label: '强度', default: 1.4, min: 0, max: 4, step: 0.05 },
      { key: 'threshold', label: '阈值', default: 0.08, min: 0, max: 0.5, step: 0.01 },
      { key: 'color', label: '颜色', kind: 'color', default: [0.4, 0.9, 1.0], uniform: 'u_color' },
    ],
  },
  'builtin:fx-soft-blur': {
    id: 'builtin:fx-soft-blur',
    name: '柔焦模糊',
    desc: '轻量全图柔焦。',
    frag: softBlurFrag,
    props: [
      { key: 'amount', label: '模糊量', default: 2.5, min: 0, max: 12, step: 0.1 },
    ],
  },
  'builtin:fx-light-leak': {
    id: 'builtin:fx-light-leak',
    name: '漏光',
    desc: '胶片漏光色带，轻微呼吸动画。',
    frag: lightLeakFrag,
    props: [
      { key: 'intensity', label: '强度', default: 0.55, min: 0, max: 1.5, step: 0.01 },
      { key: 'angle', label: '角度', default: 0.7, min: 0, max: 6.2832, step: 0.05 },
      { key: 'spread', label: '宽度', default: 0.35, min: 0.05, max: 1, step: 0.01 },
      { key: 'tint', label: '色调', kind: 'color', default: [1.0, 0.45, 0.2], uniform: 'u_tint' },
    ],
  },
  'builtin:fx-sepia': {
    id: 'builtin:fx-sepia',
    name: '棕褐色',
    desc: '经典 Sepia 复古染色。',
    frag: sepiaFrag,
    props: [
      { key: 'intensity', label: '强度', default: 1, min: 0, max: 1, step: 0.01 },
      { key: 'contrast', label: '对比', default: 1.1, min: 0.5, max: 2, step: 0.05 },
    ],
  },
  'builtin:fx-invert': {
    id: 'builtin:fx-invert',
    name: '反色',
    desc: 'RGB 反相，负片/故障风格。',
    frag: invertFrag,
    props: [
      { key: 'intensity', label: '强度', default: 1, min: 0, max: 1, step: 0.01 },
    ],
  },
  'builtin:fx-halftone': {
    id: 'builtin:fx-halftone',
    name: '半色调网点',
    desc: '印刷网点/漫画圆点风格。',
    frag: halftoneFrag,
    props: [
      { key: 'dotSize', label: '网点大小', default: 8, min: 2, max: 32, step: 1 },
      { key: 'contrast', label: '对比', default: 1.3, min: 0.5, max: 2.5, step: 0.05 },
      { key: 'intensity', label: '强度', default: 1, min: 0, max: 1, step: 0.01 },
    ],
  },
  'builtin:fx-motion-blur': {
    id: 'builtin:fx-motion-blur',
    name: '运动模糊',
    desc: '定向拖影，表现速度感。',
    frag: motionBlurFrag,
    props: [
      { key: 'amount', label: '模糊量', default: 2.5, min: 0, max: 12, step: 0.1 },
      { key: 'angle', label: '方向', default: 0, min: 0, max: 6.2832, step: 0.05 },
    ],
  },
};

/** Core library order first, followed by extended effects. */
export const FX_ORDER = [
  'builtin:fx-rect-mask',
  'builtin:fx-circle-mask',
  'builtin:fx-local-mosaic',
  'builtin:fx-magnify',
  'builtin:fx-tilt-shift',
  'builtin:fx-crt',
  'builtin:fx-ascii-rain',
  'builtin:fx-shake',
  'builtin:fx-luma-key',
  'builtin:fx-chroma-key',
  'builtin:fx-vignette',
  'builtin:fx-film-grain',
  'builtin:fx-rgb-split',
  'builtin:fx-glitch',
  'builtin:fx-bloom',
  'builtin:fx-pixelate',
  'builtin:fx-posterize',
  'builtin:fx-duotone',
  'builtin:fx-mirror',
  'builtin:fx-fisheye',
  'builtin:fx-kaleidoscope',
  'builtin:fx-edge-glow',
  'builtin:fx-soft-blur',
  'builtin:fx-light-leak',
  'builtin:fx-sepia',
  'builtin:fx-invert',
  'builtin:fx-halftone',
  'builtin:fx-motion-blur',
] as const;

export const FX_IDS = [
  ...FX_ORDER.filter((id) => id in FX_EFFECTS),
  ...Object.keys(FX_EFFECTS).filter((id) => !(FX_ORDER as readonly string[]).includes(id)),
];

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

/** 通用 lut.frag 源码(插件 LUT def 用它 + 自己的 .cube URL 组装)。 */
export const LUT_FRAG = lutFrag;

/** 应用特效时取非内置 assetId(plugin:/custom:)的可序列化 def,随 setItemEffects
 * 快照进 state.fxDefs——刷新/无头导出(无内存注册表)才渲染得出。内置返回空。 */
export function serializableDefsFor(effects: Array<{ assetId: string }>): SerializableFxDef[] {
  const out: SerializableFxDef[] = [];
  for (const { assetId } of effects) {
    if (assetId.startsWith('builtin:')) continue;
    const def = ALL_FX[assetId];
    if (!def || def.pipeline) continue;
    out.push({
      id: def.id, name: def.name, desc: def.desc, frag: def.frag, props: def.props,
      ...(def.passes ? { passes: def.passes } : {}),
      ...(def.cube ? { cube: def.cube } : {}),
    });
  }
  return out;
}

/** 注册一个运行时自定义 fx：写入 CUSTOM_FX，并原地并入 ALL_FX 供 effect-tools 查到。 */
export function registerCustomFx(def: FxDef): FxDef {
  CUSTOM_FX[def.id] = def;
  ALL_FX[def.id] = def;
  return def;
}

/** 卸载自定义/插件 fx(仅 CUSTOM_FX 条目;内置不可卸)。 */
export function unregisterCustomFx(id: string): boolean {
  if (!(id in CUSTOM_FX)) return false;
  delete CUSTOM_FX[id];
  delete ALL_FX[id];
  return true;
}
