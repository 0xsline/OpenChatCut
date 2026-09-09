# Fal.ai

Use `model: "fal"` with a `falModel` ID from the tool schema. A configured
Fal key enables the catalog, not the native-provider routes. Use the saved
Fal model default unless the user explicitly selects another model. If neither
exists, ask before submitting; never silently substitute a different model.

Read the per-model limits in the `falModel` tool description. Omit output options
to use that model's defaults. Do not send native-provider-only controls such as
masks, seeds, priority, camera locks, or multi-shot prompts. Unsupported options
fail locally before submission. Reference inputs must be project asset IDs.

Generate only after the user explicitly requests it. Generation costs Fal credits.
For videos, use `track_progress` with the returned job ID; resuming a stored job
polls/downloads the same request rather than submitting another generation.
After an interrupted image request, check Fal request history before retrying.
