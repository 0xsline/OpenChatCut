import type { CubeLut } from './fx/cube.js';
import type { TransitionSourceOpacity } from './sourceOpacity.js';

export type UniformValue = number | number[];

export interface FxPass {
  frag: string;
  uniforms?: Record<string, UniformValue>;
  /** Read u_input from an earlier pass instead of the immediately previous one. */
  inputFrom?: number;
  /** Bind named sampler uniforms to earlier pass outputs. */
  samplers?: Record<string, number>;
  /** 3D LUT bound to the u_lut sampler3D uniform. */
  lut3d?: CubeLut;
}

export interface GlRuntime {
  canvas: HTMLCanvasElement;
  render: (
    frag: string,
    outgoing: TexImageSource,
    incoming: TexImageSource,
    progress: number,
    extra?: Record<string, UniformValue>,
  ) => void;
  renderTransitionWithFx: (
    frag: string,
    outgoing: TexImageSource,
    incoming: TexImageSource,
    outgoingPasses: FxPass[],
    incomingPasses: FxPass[],
    progress: number,
    extra?: Record<string, UniformValue>,
    sourceOpacity?: TransitionSourceOpacity,
  ) => void;
  renderFx: (
    frag: string,
    input: TexImageSource,
    extra?: Record<string, UniformValue>,
    lut3d?: CubeLut,
  ) => void;
  renderFxChain: (passes: FxPass[], input: TexImageSource) => void;
  dispose: () => void;
}
