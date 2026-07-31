import type { TransitionDirection } from '../editor/types';
import { GL_COLOR_PIPELINE } from './colorPipeline';
import type { FxDef } from './fx/uniforms';
import { fxPasses } from './fx/uniforms';
import type { FxPass, UniformValue } from './runtime';

export { GL_COLOR_PIPELINE } from './colorPipeline';

export interface TransitionShaderDefinition {
  frag: string;
  uniforms: (ctx: {
    time: number;
    aspect: number;
    direction: TransitionDirection;
  }) => Record<string, UniformValue>;
}

export interface TransitionShaderFrame {
  frag: string;
  progress: number;
  time: number;
  aspect: number;
  uniforms: Record<string, UniformValue>;
  colorPipeline: typeof GL_COLOR_PIPELINE;
}

/**
 * Remotion Sequence frames are inclusive 0..L-1. Map both rendered endpoints
 * exactly; a one-frame transition is the incoming endpoint by policy.
 */
export function transitionProgress(sequenceFrame: number, durationInFrames: number): number {
  const duration = Number.isFinite(durationInFrames)
    ? Math.max(1, Math.floor(durationInFrames))
    : 1;
  if (duration === 1) return 1;
  return Math.max(0, Math.min(1, sequenceFrame / (duration - 1)));
}

export function buildTransitionShaderFrame(
  definition: TransitionShaderDefinition,
  input: {
    sequenceFrame: number;
    durationInFrames: number;
    windowStartFrame: number;
    fps: number;
    width: number;
    height: number;
    direction: TransitionDirection;
  },
): TransitionShaderFrame {
  const fps = Math.max(Number.EPSILON, input.fps);
  const progress = transitionProgress(input.sequenceFrame, input.durationInFrames);
  const time = (input.windowStartFrame + input.sequenceFrame) / fps;
  const aspect = input.width / Math.max(1, input.height);
  return {
    frag: definition.frag,
    progress,
    time,
    aspect,
    uniforms: definition.uniforms({ time, aspect, direction: input.direction }),
    colorPipeline: GL_COLOR_PIPELINE,
  };
}

export interface EffectShaderFrame {
  passes: FxPass[];
  time: number;
  colorPipeline: typeof GL_COLOR_PIPELINE;
}

export function buildEffectShaderFrame(
  effects: Array<{ def: FxDef; overrides?: Record<string, UniformValue> }>,
  frame: number,
  fps: number,
): EffectShaderFrame {
  const time = frame / Math.max(Number.EPSILON, fps);
  return {
    passes: fxPasses(effects, time),
    time,
    colorPipeline: GL_COLOR_PIPELINE,
  };
}
