import { GLSL_TRANSITION_TYPES } from '../editor/types';
import type { TransitionItem } from '../editor/types';

export type SelectedPreviewKind = 'effect' | 'transition';
export type SelectedPreviewAdapter = 'gl-effect' | 'gl-transition' | 'css-transition' | 'source-fallback';
export type SelectedPreviewPhase = 'waiting' | 'ready' | 'fallback' | 'inactive';
export type SelectedPreviewFallbackReason =
  | 'media-loading'
  | 'missing-shader'
  | 'shader-error'
  | 'unsupported-media'
  | 'unsupported-transition'
  | 'webgl-unavailable';

export interface SelectedPreviewStatus {
  kind: SelectedPreviewKind;
  targetId: string;
  adapter: SelectedPreviewAdapter;
  phase: SelectedPreviewPhase;
  fallbackReason?: SelectedPreviewFallbackReason;
}

export type SelectedPreviewStatusListener = (status: SelectedPreviewStatus) => void;

export interface TransitionPreviewAdapterPlan {
  adapter: 'gl-transition' | 'css-transition';
  fidelity: 'exact' | 'approximate';
  /** Deterministic output while media/GL is not ready or the runtime fails. */
  fallbackAdapter: 'css-transition';
  fallbackReason?: SelectedPreviewFallbackReason;
}

export function selectTransitionPreviewAdapter(input: {
  mode: 'player' | 'render';
  selected: boolean;
  type: TransitionItem['type'];
  texturable: boolean;
  hasShader: boolean;
}): TransitionPreviewAdapterPlan {
  const glDeclared = GLSL_TRANSITION_TYPES.has(input.type);
  if (glDeclared && input.texturable && input.hasShader && (input.mode === 'render' || input.selected)) {
    return { adapter: 'gl-transition', fidelity: 'exact', fallbackAdapter: 'css-transition' };
  }
  if (!glDeclared) {
    return { adapter: 'css-transition', fidelity: 'approximate', fallbackAdapter: 'css-transition', fallbackReason: 'unsupported-transition' };
  }
  if (!input.hasShader) {
    return { adapter: 'css-transition', fidelity: 'approximate', fallbackAdapter: 'css-transition', fallbackReason: 'missing-shader' };
  }
  if (!input.texturable) {
    return { adapter: 'css-transition', fidelity: 'approximate', fallbackAdapter: 'css-transition', fallbackReason: 'unsupported-media' };
  }
  // Non-selected Player transitions retain the existing low-cost CSS path. The
  // selected transition is the explicit fidelity boundary and uses real GL.
  return { adapter: 'css-transition', fidelity: 'approximate', fallbackAdapter: 'css-transition' };
}

export interface GlTransitionPresentation {
  showFallback: boolean;
  showGl: boolean;
}

/** Exactly one visual adapter is authoritative for a transition frame. */
export function glTransitionPresentation(frameReady: boolean): GlTransitionPresentation {
  return frameReady
    ? { showFallback: false, showGl: true }
    : { showFallback: true, showGl: false };
}

export interface EffectPreviewAdapterPlan {
  adapter: 'gl-effect' | 'source-fallback';
  fidelity: 'exact' | 'fallback';
  fallbackReason?: SelectedPreviewFallbackReason;
}

export function selectEffectPreviewAdapter(input: {
  declared: boolean;
  texturable: boolean;
}): EffectPreviewAdapterPlan {
  if (input.declared && input.texturable) return { adapter: 'gl-effect', fidelity: 'exact' };
  return {
    adapter: 'source-fallback',
    fidelity: 'fallback',
    fallbackReason: input.texturable ? 'missing-shader' : 'unsupported-media',
  };
}

export function glPreviewFailureReason(error: unknown): SelectedPreviewFallbackReason {
  const message = error instanceof Error ? error.message : String(error);
  return /webgl2?\s+(?:is\s+)?not available|webgl.*(?:unavailable|context lost)/i.test(message)
    ? 'webgl-unavailable'
    : 'shader-error';
}
