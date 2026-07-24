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
const INVERT = { key: 'invert', label: 'reverse', default: 0, min: 0, max: 1, step: 1 };

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
    name: 'Black background overlay',
    desc: 'Make the black background transparent and keep the highlights, like Screen Mix - overlay flames/smoke/light leak/Particles and other black background materials.',
    frag: lumaKeyFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 1, min: 0, max: 3, step: 0.05 },
      { key: 'threshold', label: 'threshold', default: 0.03, min: 0, max: 0.2, step: 0.005 },
      { key: 'softness', label: 'Soft', default: 0.3, min: 0.05, max: 0.8, step: 0.01 },
      { key: 'gamma', label: 'Gamma', default: 0.7, min: 0.3, max: 2, step: 0.05 },
    ],
  },
  'builtin:fx-local-mosaic': {
    id: 'builtin:fx-local-mosaic',
    name: 'partial mosaic',
    desc: 'Coding a rectangular area with adjustable position/Size/block size/Feathering.',
    frag: localMosaicFrag,
    props: [
      { key: 'center_x', label: 'Center X', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'center_y', label: 'Center Y', default: 0.3, min: 0, max: 1, step: 0.01 },
      { key: 'width_ratio', label: 'Width', default: 0.2, min: 0, max: 1, step: 0.01 },
      { key: 'height_ratio', label: 'height', default: 0.2, min: 0, max: 1, step: 0.01 },
      { key: 'block_size', label: 'block size', default: 20, min: 1, max: 200, step: 1 },
      { key: 'feather', label: 'Feathering', default: 4, min: 0, max: 100, step: 1 },
    ],
  },
  'builtin:fx-magnify': {
    id: 'builtin:fx-magnify',
    name: 'magnifying glass',
    desc: 'Add a magnifying lens at the center of the specified circle with adjustable radius/magnification/border.',
    frag: magnifyFrag,
    props: [
      { key: 'center_x', label: 'Center X', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'center_y', label: 'Center Y', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'radius', label: 'radius', default: 0.15, min: 0.01, max: 1, step: 0.01 },
      { key: 'magnification', label: 'magnification', default: 2, min: 1, max: 8, step: 0.1 },
      { key: 'border_width', label: 'border', default: 4, min: 0, max: 20, step: 1 },
    ],
  },
  'builtin:fx-rect-mask': {
    id: 'builtin:fx-rect-mask',
    name: 'square mask',
    desc: 'Cut the picture into a rounded rectangle with adjustable position/Size/rounded corners/Feathering/reverse.',
    frag: rectMaskFrag,
    props: [
      { key: 'center_x', label: 'Center X', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'center_y', label: 'Center Y', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'width', label: 'Width', default: 0.5, min: 0, max: 1, step: 0.01, uniform: 'u_rect_width' },
      { key: 'height', label: 'height', default: 0.5, min: 0, max: 1, step: 0.01, uniform: 'u_rect_height' },
      { key: 'corner_radius', label: 'rounded corners', default: 0, min: 0, max: 1000, step: 1 },
      { key: 'feather', label: 'Feathering', default: 2, min: 0, max: 200, step: 1 },
      INVERT,
    ],
  },
  'builtin:fx-circle-mask': {
    id: 'builtin:fx-circle-mask',
    name: 'circle mask',
    desc: 'Cut the picture into a soft-edged circle with adjustable center/radius/Feathering/reverse.',
    frag: circleMaskFrag,
    props: [
      { key: 'center_x', label: 'Center X', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'center_y', label: 'Center Y', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'radius', label: 'radius', default: 0.3, min: 0, max: 1, step: 0.01 },
      { key: 'feather', label: 'Feathering', default: 2, min: 0, max: 200, step: 1 },
      INVERT,
    ],
  },
  'builtin:fx-crt': {
    id: 'builtin:fx-crt',
    name: 'CRT retro picture tube',
    desc: 'Simulation CRT Picture tube: scan line/screen curved/RGB offset/Noise/Vignette. animation.',
    frag: crtFrag,
    props: [
      { key: 'scanlineIntensity', label: 'scan line', default: 0.4, min: 0, max: 1, step: 0.01 },
      { key: 'curvature', label: 'bend', default: 0.15, min: 0, max: 1, step: 0.01 },
      { key: 'noiseAmount', label: 'Noise', default: 0.05, min: 0, max: 1, step: 0.01 },
      { key: 'rgbShift', label: 'RGB offset', default: 0.002, min: 0, max: 0.05, step: 0.001 },
      { key: 'brightness', label: 'brightness', default: 1.1, min: 0, max: 3, step: 0.05 },
    ],
  },
  'builtin:fx-ascii-rain': {
    id: 'builtin:fx-ascii-rain',
    name: 'ASCII Character rain',
    desc: 'Generates a blue glow in the highlights of the video ASCII Character rain.',
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
      { key: 'gridSize', label: 'character size', default: 8, min: 4, max: 32, step: 1 },
      { key: 'glow', label: 'Luminous intensity', default: 1.5, min: 0, max: 4, step: 0.1 },
      { key: 'blurRadius', label: 'Floodlight range', default: 2, min: 0, max: 8, step: 0.5 },
      { key: 'color', label: 'character color', kind: 'color', default: [0, 0.7490196078431373, 1], uniform: 'u_color' },
    ],
  },
  'builtin:fx-shake': {
    id: 'builtin:fx-shake',
    name: 'Handheld mirror',
    desc: 'fbm noise jitter + rotate/Zoom/Breathe, simulating handheld camera movement. animation.',
    frag: cameraShakeFrag,
    props: [
      { key: 'strength', label: 'intensity', default: 1.2, min: 0, max: 5, step: 0.1 },
      { key: 'speed', label: 'speed', default: 1.8, min: 0, max: 10, step: 0.1 },
      { key: 'zoom', label: 'Zoom', default: 1.15, min: 1, max: 2, step: 0.01 },
      { key: 'rotation', label: 'rotate', default: 0.9, min: 0, max: 5, step: 0.1 },
      { key: 'breathe', label: 'Breathe', default: 0.7, min: 0, max: 3, step: 0.1 },
    ],
  },
  'builtin:fx-tilt-shift': {
    id: 'builtin:fx-tilt-shift',
    name: 'Tilt-shift lens',
    desc: 'Analog tilt-shift lens: one focus band is clear, and the top and bottom are blurred + saturation/Vignette. Two-pass separable Gaussian blur.',
    frag: tiltShiftPass1Frag,
    passes: [tiltShiftPass1Frag, tiltShiftPass2Frag],
    props: [
      { key: 'focusY', label: 'focus position', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'focusWidth', label: 'focus bandwidth', default: 0.2, min: 0, max: 1, step: 0.01 },
      { key: 'tiltAngle', label: 'inclination angle', default: 0, min: -3.14159, max: 3.14159, step: 0.01 },
      { key: 'blurStrength', label: 'Blur intensity', default: 12, min: 0, max: 40, step: 0.5 },
      { key: 'blurSide', label: 'blur side(0double/1on/2down)', default: 0, min: 0, max: 2, step: 1 },
      { key: 'saturation', label: 'saturation', default: 1.3, min: 0, max: 3, step: 0.05 },
      { key: 'vignette', label: 'Vignetting', default: 0.2, min: 0, max: 1, step: 0.01 },
    ],
  },
  'builtin:fx-chroma-key': {
    id: 'builtin:fx-chroma-key',
    name: 'chroma key/green screen',
    desc: 'Key color (default green screen) to cut out the background, adjustable tolerance/Feathering/Color spill suppression.',
    frag: chromaKeyFrag,
    props: [
      { key: 'keyColor', label: 'key color', kind: 'color', default: [0, 1, 0], uniform: 'u_keyColor' },
      { key: 'similarity', label: 'Tolerance', default: 0.18, min: 0, max: 0.6, step: 0.01 },
      { key: 'smoothness', label: 'Feathering', default: 0.08, min: 0.001, max: 0.4, step: 0.005 },
      { key: 'spill', label: 'Spill suppression', default: 0.5, min: 0, max: 1, step: 0.01 },
    ],
  },

  // ── Extended generated library ──────────────────────────────────────────
  'builtin:fx-vignette': {
    id: 'builtin:fx-vignette',
    name: 'Vignetting',
    desc: 'The surrounding areas are darkened to highlight the central subject. Adjustable intensity/Soft/roundness.',
    frag: vignetteFrag,
    props: [
      { key: 'amount', label: 'intensity', default: 0.55, min: 0, max: 1, step: 0.01 },
      { key: 'softness', label: 'Soft', default: 0.45, min: 0.05, max: 1, step: 0.01 },
      { key: 'roundness', label: 'Roundness', default: 1, min: 0.5, max: 2, step: 0.01 },
    ],
  },
  'builtin:fx-film-grain': {
    id: 'builtin:fx-film-grain',
    name: 'film grain',
    desc: 'Dynamic film noise texture. animation.',
    frag: filmGrainFrag,
    props: [
      { key: 'amount', label: 'intensity', default: 0.18, min: 0, max: 0.6, step: 0.01 },
      { key: 'size', label: 'particle size', default: 1.2, min: 0.5, max: 4, step: 0.1 },
    ],
  },
  'builtin:fx-rgb-split': {
    id: 'builtin:fx-rgb-split',
    name: 'RGB separation',
    desc: 'Channel dislocation chromatic aberration, cyber/A sense of malfunction.',
    frag: rgbSplitFrag,
    props: [
      { key: 'amount', label: 'offset', default: 0.008, min: 0, max: 0.05, step: 0.001 },
      { key: 'angle', label: 'direction', default: 0, min: 0, max: 6.2832, step: 0.05 },
    ],
  },
  'builtin:fx-glitch': {
    id: 'builtin:fx-glitch',
    name: 'Fault flashing',
    desc: 'transverse slice misalignment + Occasional color inversion/Color difference. animation.',
    frag: glitchFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 0.7, min: 0, max: 2, step: 0.05 },
      { key: 'blockSize', label: 'slice density', default: 28, min: 4, max: 80, step: 1 },
    ],
  },
  'builtin:fx-bloom': {
    id: 'builtin:fx-bloom',
    name: 'halo Bloom',
    desc: 'Highlights, film highlights.',
    frag: bloomFrag,
    props: [
      { key: 'threshold', label: 'threshold', default: 0.55, min: 0, max: 1, step: 0.01 },
      { key: 'intensity', label: 'intensity', default: 0.85, min: 0, max: 3, step: 0.05 },
      { key: 'radius', label: 'radius', default: 2.5, min: 0.5, max: 8, step: 0.1 },
    ],
  },
  'builtin:fx-pixelate': {
    id: 'builtin:fx-pixelate',
    name: 'Pixelate',
    desc: 'Whole frame pixel block stylization.',
    frag: pixelateFrag,
    props: [
      { key: 'blockSize', label: 'block size', default: 12, min: 2, max: 80, step: 1 },
    ],
  },
  'builtin:fx-posterize': {
    id: 'builtin:fx-posterize',
    name: 'Posterization',
    desc: 'Reduce color levels, illustration/Poster feel.',
    frag: posterizeFrag,
    props: [
      { key: 'levels', label: 'color scale', default: 5, min: 2, max: 16, step: 1 },
      { key: 'contrast', label: 'Contrast', default: 1.15, min: 0.5, max: 2.5, step: 0.05 },
    ],
  },
  'builtin:fx-duotone': {
    id: 'builtin:fx-duotone',
    name: 'two tone',
    desc: 'Map shadow and highlight colors by brightness.',
    frag: duotoneFrag,
    props: [
      { key: 'shadowColor', label: 'shadow color', kind: 'color', default: [0.08, 0.12, 0.35], uniform: 'u_shadowColor' },
      { key: 'highlightColor', label: 'Highlight color', kind: 'color', default: [1.0, 0.72, 0.35], uniform: 'u_highlightColor' },
      { key: 'contrast', label: 'Contrast', default: 1.2, min: 0.5, max: 2.5, step: 0.05 },
      { key: 'intensity', label: 'intensity', default: 1, min: 0, max: 1, step: 0.01 },
    ],
  },
  'builtin:fx-mirror': {
    id: 'builtin:fx-mirror',
    name: 'mirror symmetry',
    desc: 'left and right/Mirror collage from top to bottom.mode: 0left→right 1right→left 2on→down 3down→on.',
    frag: mirrorFrag,
    props: [
      { key: 'mode', label: 'mode', default: 0, min: 0, max: 3, step: 1 },
      { key: 'axis', label: 'axis', default: 0.5, min: 0.1, max: 0.9, step: 0.01 },
    ],
  },
  'builtin:fx-fisheye': {
    id: 'builtin:fx-fisheye',
    name: 'fish eye',
    desc: 'Barrel distortion wide-angle effect.',
    frag: fisheyeFrag,
    props: [
      { key: 'strength', label: 'intensity', default: 0.55, min: 0, max: 1.5, step: 0.01 },
      { key: 'zoom', label: 'Zoom', default: 1.05, min: 0.5, max: 2, step: 0.01 },
    ],
  },
  'builtin:fx-kaleidoscope': {
    id: 'builtin:fx-kaleidoscope',
    name: 'kaleidoscope',
    desc: 'Radial sliced mirror, kaleidoscope pattern.',
    frag: kaleidoscopeFrag,
    props: [
      { key: 'segments', label: 'Sharding', default: 6, min: 2, max: 16, step: 1 },
      { key: 'angle', label: 'rotate', default: 0, min: 0, max: 6.2832, step: 0.05 },
      { key: 'zoom', label: 'Zoom', default: 1, min: 0.4, max: 2, step: 0.01 },
    ],
  },
  'builtin:fx-edge-glow': {
    id: 'builtin:fx-edge-glow',
    name: 'edge glow',
    desc: 'Sobel Edge detection overlays colored strokes.',
    frag: edgeGlowFrag,
    props: [
      { key: 'strength', label: 'intensity', default: 1.4, min: 0, max: 4, step: 0.05 },
      { key: 'threshold', label: 'threshold', default: 0.08, min: 0, max: 0.5, step: 0.01 },
      { key: 'color', label: 'color', kind: 'color', default: [0.4, 0.9, 1.0], uniform: 'u_color' },
    ],
  },
  'builtin:fx-soft-blur': {
    id: 'builtin:fx-soft-blur',
    name: 'soft focus blur',
    desc: 'Lightweight full image soft focus.',
    frag: softBlurFrag,
    props: [
      { key: 'amount', label: 'blur amount', default: 2.5, min: 0, max: 12, step: 0.1 },
    ],
  },
  'builtin:fx-light-leak': {
    id: 'builtin:fx-light-leak',
    name: 'light leak',
    desc: 'Film leak ribbon, slight breathing animation.',
    frag: lightLeakFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 0.55, min: 0, max: 1.5, step: 0.01 },
      { key: 'angle', label: 'angle', default: 0.7, min: 0, max: 6.2832, step: 0.05 },
      { key: 'spread', label: 'Width', default: 0.35, min: 0.05, max: 1, step: 0.01 },
      { key: 'tint', label: 'hue', kind: 'color', default: [1.0, 0.45, 0.2], uniform: 'u_tint' },
    ],
  },
  'builtin:fx-sepia': {
    id: 'builtin:fx-sepia',
    name: 'tan',
    desc: 'classic Sepia Vintage stained.',
    frag: sepiaFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 1, min: 0, max: 1, step: 0.01 },
      { key: 'contrast', label: 'Contrast', default: 1.1, min: 0.5, max: 2, step: 0.05 },
    ],
  },
  'builtin:fx-invert': {
    id: 'builtin:fx-invert',
    name: 'reverse color',
    desc: 'RGB reverse phase, negative film/Glitch style.',
    frag: invertFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 1, min: 0, max: 1, step: 0.01 },
    ],
  },
  'builtin:fx-halftone': {
    id: 'builtin:fx-halftone',
    name: 'halftone dots',
    desc: 'Printing outlets/Comic polka dot style.',
    frag: halftoneFrag,
    props: [
      { key: 'dotSize', label: 'Dot size', default: 8, min: 2, max: 32, step: 1 },
      { key: 'contrast', label: 'Contrast', default: 1.3, min: 0.5, max: 2.5, step: 0.05 },
      { key: 'intensity', label: 'intensity', default: 1, min: 0, max: 1, step: 0.01 },
    ],
  },
  'builtin:fx-motion-blur': {
    id: 'builtin:fx-motion-blur',
    name: 'motion blur',
    desc: 'Directional smear expresses the sense of speed.',
    frag: motionBlurFrag,
    props: [
      { key: 'amount', label: 'blur amount', default: 2.5, min: 0, max: 12, step: 0.1 },
      { key: 'angle', label: 'direction', default: 0, min: 0, max: 6.2832, step: 0.05 },
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
    desc: 'Sony S-Log3 / S-Gamut3.Cine → Rec.709。.cube 3D lookup table (Sony_Slog3_s709.cube, 33³）+ Universal lut.frag（sampler3D，BT.709 Codec package)',
    frag: lutFrag,
    cube: '/luts/Sony_Slog3_s709.cube',
    props: [{ key: 'intensity', label: 'intensity', default: 1, min: 0, max: 1, step: 0.01 }],
  },
  'builtin:canon-log3-709': {
    id: 'builtin:canon-log3-709',
    name: 'Canon Log 3 → BT.709',
    desc: 'Canon Cinema Gamut / Canon Log 3 → Canon 709。.cube 3D lookup table (CinemaGamut_CanonLog3-to-Canon709_33_Ver.1.0.cube, 33³）+ Universal lut.frag',
    frag: lutFrag,
    cube: '/luts/CinemaGamut_CanonLog3-to-Canon709_33_Ver.1.0.cube',
    props: [{ key: 'intensity', label: 'intensity', default: 1, min: 0, max: 1, step: 0.01 }],
  },
  // creative looks (formula grades — not camera-log cubes)
  'builtin:look-teal-orange': {
    id: 'builtin:look-teal-orange',
    name: 'Green and orange movie feel',
    desc: 'Hollywood color palette with bluish shadows and orange highlights.',
    frag: lookTealOrangeFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 0.85, min: 0, max: 1, step: 0.01 },
      { key: 'contrast', label: 'Contrast', default: 1.1, min: 0.6, max: 1.8, step: 0.02 },
    ],
  },
  'builtin:look-mono': {
    id: 'builtin:look-mono',
    name: 'black and white film',
    desc: 'high contrast black and white + Slightly dynamic grain.',
    frag: lookMonoFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 1, min: 0, max: 1, step: 0.01 },
      { key: 'contrast', label: 'Contrast', default: 1.25, min: 0.6, max: 2.2, step: 0.02 },
      { key: 'grain', label: 'particles', default: 0.08, min: 0, max: 0.4, step: 0.01 },
    ],
  },
  'builtin:look-warm': {
    id: 'builtin:look-warm',
    name: 'Warm retro',
    desc: 'Warmer color temperature and slight fading, retro texture.',
    frag: lookWarmFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 0.9, min: 0, max: 1, step: 0.01 },
      { key: 'temperature', label: 'color temperature', default: 0.7, min: 0, max: 1.5, step: 0.02 },
      { key: 'fade', label: 'fade', default: 0.35, min: 0, max: 1, step: 0.01 },
    ],
  },
  'builtin:look-cool': {
    id: 'builtin:look-cool',
    name: 'cool blue',
    desc: 'Cooler color temperature, shades of pressurized blue.',
    frag: lookCoolFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 0.85, min: 0, max: 1, step: 0.01 },
      { key: 'temperature', label: 'coldness', default: 0.75, min: 0, max: 1.5, step: 0.02 },
      { key: 'shadows', label: 'shadow blue', default: 0.55, min: 0, max: 1, step: 0.01 },
    ],
  },
  'builtin:look-sunset': {
    id: 'builtin:look-sunset',
    name: 'sunset warm gold',
    desc: 'The highlights are golden and the shadows are warm and dusk-like.',
    frag: lookSunsetFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 0.9, min: 0, max: 1, step: 0.01 },
      { key: 'warmth', label: 'warmth', default: 1, min: 0, max: 1.5, step: 0.02 },
    ],
  },
  'builtin:look-cyber': {
    id: 'builtin:look-cyber',
    name: 'cyberneon',
    desc: 'A neon sci-fi tone with cyan shadows and magenta highlights.',
    frag: lookCyberFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 0.85, min: 0, max: 1, step: 0.01 },
      { key: 'contrast', label: 'Contrast', default: 1.2, min: 0.6, max: 2, step: 0.02 },
    ],
  },
  'builtin:look-bleach': {
    id: 'builtin:look-bleach',
    name: 'bleach bypass',
    desc: 'low saturation + Lifting the black bleaching bypasses the cinematic feel.',
    frag: lookBleachFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 0.9, min: 0, max: 1, step: 0.01 },
      { key: 'fade', label: 'fade', default: 0.45, min: 0, max: 1, step: 0.01 },
    ],
  },
  // ── film / camera aesthetics (formula looks, not licensed cubes) ─────────
  'builtin:look-fuji-chrome': {
    id: 'builtin:look-fuji-chrome',
    name: 'Fuji Classic Chrome',
    desc: 'Low saturation, soft contrast, medium gray and cold color - travel/Street photography documentary feel (inspired by Fujifilm simulation, unofficial LUT）。',
    frag: lookFujiChromeFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 0.92, min: 0, max: 1, step: 0.01 },
      { key: 'fade', label: 'fade', default: 0.4, min: 0, max: 1, step: 0.01 },
      { key: 'grain', label: 'particles', default: 0.06, min: 0, max: 0.35, step: 0.01 },
    ],
  },
  'builtin:look-fuji-portra': {
    id: 'builtin:look-fuji-portra',
    name: 'Fuji portrait Pro Neg',
    desc: 'Cream skin tones, pink highlights, dark shadows - portraits/Sense of life (inspired by Portra / Pro Neg）。',
    frag: lookFujiPortraFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 0.9, min: 0, max: 1, step: 0.01 },
      { key: 'warmth', label: 'warmth', default: 0.85, min: 0, max: 1.5, step: 0.02 },
      { key: 'softness', label: 'Soft', default: 0.7, min: 0, max: 1, step: 0.02 },
      { key: 'grain', label: 'particles', default: 0.05, min: 0, max: 0.3, step: 0.01 },
    ],
  },
  'builtin:look-fuji-velvia': {
    id: 'builtin:look-fuji-velvia',
    name: 'Fuji Velvia scenery',
    desc: 'Highly saturated green/Blue and transparent contrast - scenic spots/Natural scenery (inspired by Velvia reversal film).',
    frag: lookFujiVelviaFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 0.88, min: 0, max: 1, step: 0.01 },
      { key: 'saturation', label: 'saturated', default: 1.1, min: 0.4, max: 1.8, step: 0.02 },
      { key: 'contrast', label: 'Contrast', default: 1.15, min: 0.7, max: 1.8, step: 0.02 },
      { key: 'grain', label: 'particles', default: 0.04, min: 0, max: 0.25, step: 0.01 },
    ],
  },
  'builtin:look-ricoh-gr': {
    id: 'builtin:look-ricoh-gr',
    name: 'Ricoh GR street photography',
    desc: 'Harder contrast, cold neutral gray, urban documentary——GR A casual shooting feel (inspired by Ricoh’s street photography aesthetic).',
    frag: lookRicohGrFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 0.9, min: 0, max: 1, step: 0.01 },
      { key: 'contrast', label: 'Contrast', default: 1.22, min: 0.8, max: 1.8, step: 0.02 },
      { key: 'cool', label: 'Cold tone', default: 0.75, min: 0, max: 1.5, step: 0.02 },
      { key: 'grain', label: 'particles', default: 0.07, min: 0, max: 0.35, step: 0.01 },
    ],
  },
  'builtin:look-kodak-gold': {
    id: 'builtin:look-kodak-gold',
    name: 'Kodak Gold Gold',
    desc: 'Warm yellow and green, nostalgic, soft contrast - casual shooting in the millennium / Family album feel (inspired by Kodak Gold）。',
    frag: lookKodakGoldFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 0.9, min: 0, max: 1, step: 0.01 },
      { key: 'yellow', label: 'golden', default: 1, min: 0, max: 1.5, step: 0.02 },
      { key: 'fade', label: 'fade', default: 0.4, min: 0, max: 1, step: 0.01 },
      { key: 'grain', label: 'particles', default: 0.08, min: 0, max: 0.4, step: 0.01 },
    ],
  },
  'builtin:look-disposable': {
    id: 'builtin:look-disposable',
    name: 'Polaroid / Disposable',
    desc: 'Soft, green cast, coarse grain, dark corners - the smell of polaroids and disposable cameras.',
    frag: lookDisposableFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 0.92, min: 0, max: 1, step: 0.01 },
      { key: 'cast', label: 'Color cast', default: 0.9, min: 0, max: 1.5, step: 0.02 },
      { key: 'grain', label: 'particles', default: 0.16, min: 0, max: 0.5, step: 0.01 },
      { key: 'vignette', label: 'Vignetting', default: 0.45, min: 0, max: 1, step: 0.01 },
    ],
  },
  'builtin:look-cinestill': {
    id: 'builtin:look-cinestill',
    name: 'CineStill night view',
    desc: 'Tungsten filament lamp is cool and green, and the highlights are slightly overflowing - night street/Neon (inspired by CineStill 800T）。',
    frag: lookCinestillFrag,
    props: [
      { key: 'intensity', label: 'intensity', default: 0.88, min: 0, max: 1, step: 0.01 },
      { key: 'cyan', label: 'Qing Leng', default: 0.95, min: 0, max: 1.5, step: 0.02 },
      { key: 'contrast', label: 'Contrast', default: 1.18, min: 0.7, max: 1.8, step: 0.02 },
      { key: 'grain', label: 'particles', default: 0.09, min: 0, max: 0.4, step: 0.01 },
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

// ── Runtime custom fx (LLM generated product of submit_shader) registry ─────────────────────
// effect-tools.ts captures ALL_FX (`const FX_EFFECTS = ALL_FX`) with a "reference" when loading the module,
// So just write "in place" to the ALL_FX object, manage_effects' `assetId in FX_EFFECTS`
// Use describe() to instantly find your custom fx - no need to change effect-tools.ts. CUSTOM_FXSave another copy
// Custom entries for easy differentiation/enumeration/testing. Built-in fx and LUTs remain unchanged.
// ponytail: The essence of the registry is to share the runtime state. This is the only place where it must be "changed in place" (the only place where it can be changed
// The way effect-tools that captures the reference sees the new fx); the rest still adheres to the immutable contract.
export const CUSTOM_FX: Record<string, FxDef> = {};

/** Universal lut.frag Source code(plug-in LUT def use it + own .cube URL Assemble)。 */
export const LUT_FRAG = lutFrag;

/** Take non-built-in when applying special effects assetId(plugin:/custom:)serializable def,Follow setItemEffects
 * Snapshot into state.fxDefs——Refresh/Headless export(No memory registry)Just rendered. The built-in returns null. */
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

/** Register a runtime customization fx: write CUSTOM_FX, and merged in place ALL_FX supply effect-tools Found. */
export function registerCustomFx(def: FxDef): FxDef {
  CUSTOM_FX[def.id] = def;
  ALL_FX[def.id] = def;
  return def;
}

/** Uninstall customization/plug-in fx(only CUSTOM_FX entry;Built-in non-removable)。 */
export function unregisterCustomFx(id: string): boolean {
  if (!(id in CUSTOM_FX)) return false;
  delete CUSTOM_FX[id];
  delete ALL_FX[id];
  return true;
}
