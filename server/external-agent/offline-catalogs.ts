// Editor catalogs for headless sessions (offline MCP and the occ CLI).
//
// The browser agent context carries the bundled template registry plus whatever
// plugin packs the user installed; pack hydration happens in the renderer, so a
// headless host starts from the bundled set and the built-in audio library. Tools
// that resolve a pack-provided template therefore see only the built-ins here and
// answer "no template matching …" instead of picking something wrong — a stated
// capability gap rather than a silent mismatch.
import { TEMPLATES } from '../../src/editor/initial.ts';
import { AUDIO_ASSETS, type AudioAsset } from '../../src/audio/library.ts';
import type { Tpl } from '../../src/types.ts';

/** Bundled motion-graphic templates (211 + social shorts + koubo scenes). */
export const OFFLINE_TEMPLATES: Tpl[] = [...TEMPLATES];

/** Built-in music / SFX library; project audio assets come from the project doc. */
export const OFFLINE_AUDIO: AudioAsset[] = [...AUDIO_ASSETS];
