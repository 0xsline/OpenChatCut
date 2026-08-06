// Vision-model bypass configuration: when the active agent model cannot see
// images (e.g. DeepSeek family is text-only), a separately configured
// vision-capable model describes user attachments and rendered timeline
// frames as text that the main model can consume.
//
// Mode semantics:
// - follow (default): bypass is off; images are stripped exactly as before.
// - custom: images are described by the chosen vision model and injected as
//   text into the main model's messages (only when the main model lacks
//   image input — a vision-capable main model sees images natively).
// - disabled: never bypass, regardless of the main model's capabilities.
import type { AgentModelChoice } from './model-selection';
import type { LlmProvider, OpenAiApiMode } from './providerConfig';

export type VisionModelMode = 'follow' | 'disabled' | 'custom';

export interface VisionModelConfig {
  mode: VisionModelMode;
  /** custom mode: the vision provider (must already have a configured API key). */
  provider?: LlmProvider | null;
  model?: string | null;
  openAiApiMode?: OpenAiApiMode | null;
}

/** A resolved vision model ready for description calls. */
export interface VisionModelRef {
  provider: LlmProvider;
  model: string;
  openAiApiMode: OpenAiApiMode;
}

const STORAGE_KEY = 'cc.visionModel.v1';
const MODES: readonly VisionModelMode[] = ['follow', 'disabled', 'custom'];
const listeners = new Set<() => void>();

let current: VisionModelConfig = readInitial();

function readInitial(): VisionModelConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mode: 'follow' };
    const parsed = JSON.parse(raw) as Partial<VisionModelConfig>;
    const mode = MODES.includes(parsed.mode as VisionModelMode) ? (parsed.mode as VisionModelMode) : 'follow';
    return {
      mode,
      provider: typeof parsed.provider === 'string' ? (parsed.provider as LlmProvider) : null,
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : null,
      openAiApiMode: parsed.openAiApiMode === 'responses' ? 'responses' : null,
    };
  } catch {
    return { mode: 'follow' };
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function getVisionModelConfig(): VisionModelConfig {
  return current;
}

export function setVisionModelConfig(next: VisionModelConfig): void {
  current = {
    mode: MODES.includes(next.mode) ? next.mode : 'follow',
    provider: typeof next.provider === 'string' ? next.provider : null,
    model: typeof next.model === 'string' && next.model ? next.model : null,
    openAiApiMode: next.openAiApiMode === 'responses' ? 'responses' : null,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* private mode / quota */
  }
  emit();
}

export function subscribeVisionModelConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Resolve the bypass vision model for the given active agent choice.
 * Returns null when the main model can see images (no bypass needed),
 * the mode is not custom, or the custom model is incomplete.
 */
export function resolveVisionModel(
  active: AgentModelChoice | undefined,
  config: VisionModelConfig = current,
): VisionModelRef | null {
  if (!active) return null;
  if (active.capabilities.supportsImages.value) return null;
  if (config.mode !== 'custom') return null;
  if (!config.provider || !config.model) return null;
  return { provider: config.provider, model: config.model, openAiApiMode: config.openAiApiMode ?? 'chat' };
}
