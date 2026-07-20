import type { MediaAsset, TimelineState } from '../editor/types';

export interface SubmitImageArgs {
  model?: 'gpt-image-2' | 'nano-banana' | 'image-01';
  prompt: string;
  name: string;
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3' | '4:5' | '5:4' | '21:9';
  imageSize?: '1K' | '2K' | '4K';
  quality?: 'low' | 'medium' | 'high' | 'auto';
  referenceAssetIds?: string[];
  count?: number;
  /** MiniMax image-01 only: prompt_optimizer (default true). */
  promptOptimizer?: boolean;
}

interface ImageResponse {
  paths?: string[];
  width?: number;
  height?: number;
  error?: string;
}

const newId = () => crypto.randomUUID?.() ?? `generated_${Date.now()}_${Math.random().toString(36).slice(2)}`;

export async function submitImage(args: SubmitImageArgs, state: TimelineState): Promise<MediaAsset[]> {
  const prompt = args.prompt.trim();
  const name = args.name.trim();
  if (!prompt) throw new Error('prompt is required');
  if (!name) throw new Error('name is required');
  const referencePaths = (args.referenceAssetIds ?? []).map((id) => {
    const asset = (state.assets ?? []).find((candidate) => candidate.id === id);
    if (!asset) throw new Error(`reference asset not found: ${id}`);
    if (asset.kind !== 'image') throw new Error(`reference asset is not an image: ${id}`);
    return asset.src;
  });

  const response = await fetch('/generate/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...args, prompt, name, referencePaths }),
  });
  const result = await response.json().catch(() => ({})) as ImageResponse;
  if (!response.ok) throw new Error(result.error ?? `image generation failed (${response.status})`);
  if (!result.paths?.length) throw new Error('image generation returned no assets');
  // a still defaults to 3s (CapCut-style photo default) — 5s felt too long on
  // a fresh timeline; trim/extend per clip as needed.
  const durationInFrames = Math.round(state.fps * 3);
  return result.paths.map((src, index) => ({
    id: newId(),
    name: result.paths!.length === 1 ? name : `${name} ${index + 1}`,
    kind: 'image',
    src,
    durationInFrames,
    width: result.width,
    height: result.height,
  }));
}
