// Pure transition-type helpers — split from transitionPreview.tsx so that
// file only exports components (react only-export-components).
import { CSS_TRANSITION_TYPES } from './types';
import type { CssTransitionType, TransitionItem } from './types';

const PREVIEW_APPROXIMATION: Partial<Record<TransitionItem['type'], CssTransitionType>> = {
  'clean-line-wipe': 'soft-wipe',
  'page-curl': 'soft-wipe',
  'impact-shake': 'whip-pan',
  'rack-focus': 'luma-blend',
  'organic-dissolve': 'luma-blend',
  'anticipation-zoom': 'luma-blend',
  'radial-blur': 'luma-blend',
  'glitch-cut': 'flash',
  'dip-to-color': 'dip-to-black',
};

export function previewTransitionType(type: TransitionItem['type']): CssTransitionType {
  if (CSS_TRANSITION_TYPES.has(type)) return type as CssTransitionType;
  return PREVIEW_APPROXIMATION[type] ?? 'cross-dissolve';
}
