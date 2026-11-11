/**
 * Model shutdown dates that the bundled catalog cannot know about.
 *
 * `assets/model-capabilities/models-dev.json` is generated from
 * https://models.dev/api.json, and that API exposes no deprecation or shutdown
 * field — only id, type, name, description, family, attachment, reasoning,
 * tool_call, temperature, knowledge, release_date, last_updated, modalities,
 * open_weights, limit and cost. Regenerating the catalog therefore keeps
 * advertising models the provider has already shut down, and choosing one fails
 * on the first request (or starts failing on a date the user cannot see).
 *
 * The authoritative dates are published on
 * https://ai.google.dev/gemini-api/docs/deprecations. Each entry below is
 * transcribed from that page, so maintaining this file means re-checking it
 * when Google announces a retirement — the generated JSON is never hand-edited.
 *
 * `retiredAt` is the earliest announced shutdown date. A model whose date is in
 * the future still works today and may legitimately be saved in a user's
 * configuration, so pickers keep offering it and only annotate it;
 * `isRetiredAt` starts returning true once that date has passed, and that is the
 * only thing pickers filter on.
 */
export interface RetiredModel {
  /** Model id exactly as the catalog / provider spells it. */
  readonly id: string;
  /** Earliest shutdown date announced by the provider, ISO `YYYY-MM-DD`. */
  readonly retiredAt: string;
  /** Model the provider recommends instead. */
  readonly replacement?: string;
  /** Provider caveat worth showing in review, e.g. the automatic routing note. */
  readonly note?: string;
}

export const RETIRED_MODELS: readonly RetiredModel[] = [
  {
    id: 'gemini-2.5-flash-preview-tts',
    retiredAt: '2026-11-17',
    replacement: 'gemini-3.8-flash-tts',
  },
  {
    id: 'gemini-2.5-pro-preview-tts',
    retiredAt: '2026-11-17',
    replacement: 'gemini-3.8-flash-tts',
  },
  {
    id: 'gemini-3.1-flash-tts-preview',
    retiredAt: '2026-11-17',
    replacement: 'gemini-3.8-flash-tts',
  },
  {
    id: 'gemini-3.1-flash-live-preview',
    retiredAt: '2026-11-17',
    replacement: 'gemini-3.8-live',
  },
  {
    id: 'gemini-2.5-flash',
    retiredAt: '2026-12-01',
    replacement: 'gemini-3.5-flash-lite',
    note: 'From the shutdown date the API routes requests to gemini-3.5-flash-lite with its breaking changes.',
  },
  {
    id: 'gemini-2.5-pro',
    retiredAt: '2026-12-01',
    replacement: 'gemini-3.8-flash',
    note: 'From the shutdown date the API routes requests to gemini-3.8-flash with its breaking changes.',
  },
  {
    id: 'gemini-2.5-computer-use-preview-10-2025',
    retiredAt: '2026-07-28',
    replacement: 'gemini-3.8-flash',
  },
  {
    id: 'gemini-3-pro-preview',
    retiredAt: '2026-03-09',
    replacement: 'gemini-3.1-pro-preview',
  },
  {
    id: 'gemini-3.1-flash-lite-preview',
    retiredAt: '2026-05-25',
    replacement: 'gemini-3.1-flash-lite',
  },
  {
    id: 'gemini-3.1-flash-image-preview',
    retiredAt: '2026-06-25',
    replacement: 'gemini-nano-banana-2.1',
  },
  {
    id: 'gemini-3-pro-image-preview',
    retiredAt: '2026-06-25',
    replacement: 'gemini-3-pro-image',
  },
  {
    id: 'veo-3.1-generate-preview',
    retiredAt: '2026-10-22',
    replacement: 'gemini-omni-1.2-flash',
  },
  {
    id: 'veo-3.1-fast-generate-preview',
    retiredAt: '2026-10-22',
    replacement: 'gemini-omni-1.2-flash',
  },
  {
    id: 'veo-3.1-lite-generate-preview',
    retiredAt: '2026-10-22',
    replacement: 'gemini-omni-1.2-flash',
  },
];

const RETIRED_BY_ID: ReadonlyMap<string, RetiredModel> = new Map(
  RETIRED_MODELS.map((model) => [model.id, model]),
);

/** Shutdown day starts at 00:00 UTC, matching the dates Google publishes. */
function shutdownInstant(model: RetiredModel): number {
  return Date.parse(`${model.retiredAt}T00:00:00Z`);
}

/** The retirement record for `id`, whether its date has passed or not. */
export function retirementFor(id: string): RetiredModel | undefined {
  const key = id.trim();
  return key ? RETIRED_BY_ID.get(key) : undefined;
}

/** True once the announced shutdown date has passed — i.e. the model is dead. */
export function isRetiredAt(id: string, at: Date = new Date()): boolean {
  const model = retirementFor(id);
  return model !== undefined && at.getTime() >= shutdownInstant(model);
}

/** Same predicate as {@link isRetiredAt}, named for call sites that read as a check. */
export function isRetiredModel(id: string, at: Date = new Date()): boolean {
  return isRetiredAt(id, at);
}

/**
 * Picker rule: offer only models that still work. A model that is merely
 * scheduled for shutdown stays selectable (it works today) — the UI annotates
 * it from `retirementFor` — and `keep` preserves whatever value is already
 * saved, so opening a picker never silently blanks a user's configuration.
 */
export function filterSelectableModels(
  ids: readonly string[],
  { keep, at = new Date() }: { readonly keep?: string; readonly at?: Date } = {},
): readonly string[] {
  const saved = keep?.trim();
  return ids.filter((id) => id === saved || !isRetiredAt(id, at));
}
