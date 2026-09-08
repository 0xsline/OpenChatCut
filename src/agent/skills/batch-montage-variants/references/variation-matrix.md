# Variation Matrix

The variation matrix is the batch plan. It exists so differentiation is designed
before cutting, not discovered afterward when two timelines already look alike.

## 1. Score reuse headroom first

Before planning, classify every source asset:

| Class | Meaning | Planning rule |
|---|---|---|
| `single-use` | Only works in one position: logo end card, QR code, one spoken punchline, a reveal that only makes sense once | May appear in many cuts, but never as the hook of more than one |
| `positional` | Works in one role: establishing wide, product close-up, reaction shot | May repeat across cuts, but not in the same slot |
| `flexible` | Works anywhere: B-roll texture, ambient motion, cutaway | Free to reuse; carries no differentiation |

Count the `single-use` assets. The honest batch size is bounded by how many
distinct hooks the pool supports, not by how many permutations exist on paper.

## 2. The five differentiation dimensions

Ranked by how much they actually change viewer and platform perception:

1. **Hook asset** (strongest) — the first 3 seconds. Different source clip, different visual subject.
2. **Shot order** — the sequence signature. `A-C-E-B` vs `C-A-B-E`.
3. **Rhythm** — average shot length and its shape over time (slow open → ramp, constant fast, front-loaded then settle).
4. **Packaging** — captions style, motion graphics, transitions, crops, speed ramps.
5. **Music bed** (weakest alone) — a different track changes mood but barely changes perceived content.

Rules of thumb:

- Dimensions 4 and 5 alone do **not** constitute a distinct variant. A recut with new music and new caption styling is the same video.
- Dimensions 1 and 2 alone are sufficient, even with identical packaging.
- Aim for 2+ changed dimensions per pair, with at least one from 1–3.

## 3. Minimum separation budget

For distinct-cut batches, use these as planning targets agreed with the user, not platform detection rules. Controlled hook tests and platform adaptations use the mode-specific checks below instead.

| Dimension | Minimum separation between any two cuts |
|---|---|
| Opening 3s | Different source asset, no shared frames |
| Shot order | At least 2 adjacent-pair differences in the first 5 shots |
| Rhythm | At least 1.5x difference in average shot length, **or** an inverted shape (one ramps up, one settles down) |
| Duration | At least 15% difference, unless platform rules force a fixed length |
| Music | Distinct track, or explicitly shared by user request |

When a distinct-cut pair misses the agreed targets, revise the plan or report the shortfall before cutting.

## 4. Choosing the dominant variable

Pick one dimension to carry the batch and let the others support it:

- **Hook testing**: only the opening changes; body, order after the hook, duration, rhythm, music and packaging stay fixed. Do not apply distinct-cut overlap, order, rhythm or duration thresholds. Report `controlled-hook-test` and identify the intentional shared body.
- **Matrix accounts / 多账号分发**: hook, order, and rhythm all change. Packaging may stay consistent as a brand signature.
- **Platform variants**: content structure stays fixed; duration, aspect ratio, caption placement, and safe-area treatment adapt to each platform. Shared openings and bodies are allowed. Report `platform-adaptation`; do not apply distinct-cut separation thresholds.

A batch with no dominant variable reads as noise. State which mode you are in
before cutting.

## 5. Capacity check

Check whether the actual source ranges can support N cuts under the selected mode and agreed separation targets. Distinct cuts and hook tests need enough usable openings; hook tests may intentionally reuse the full body. Platform adaptations can reuse the same edit. Do not infer a numeric capacity from total footage duration alone.

If the pool cannot support the requested plan, report the specific shortage and offer fewer cuts or more source media. Switching to controlled tests or platform adaptations changes the batch contract and must be explicit.

## 6. Naming

`<topic>-v<NN>-<hook-label>`, zero-padded, consistent across the batch.
Examples: `summer-drop-v01-unbox`, `summer-drop-v02-beforeafter`.

Auditable naming is what makes the batch reviewable later — the reviewer should
be able to tell from the timeline name which dimension each cut was testing.
