# Dedup Rules and Batch QA

These editorial checks compare the batch as a set. They do not guarantee a platform's duplicate-detection outcome. Select the batch mode before applying them.

## 1. Why structural dedup, not decorative dedup

For distinct-cut batches, mirror, speed change, color grade, caption restyle and music swap alone do not establish structural differentiation. Compare:

- Different source footage in the opening and in the majority of shots
- Different event order — the sequence of what happens, not how it is dressed
- Different edit rhythm, which changes the perceived pacing signature
- Different duration at a meaningful scale

Treat a distinct-cut plan built only from decorative changes as insufficient. Controlled hook tests and platform adaptations intentionally preserve content and follow their own contract.

## 2. Pairwise checks

For `controlled-hook-test`, verify different openings and an otherwise unchanged body, order, duration, rhythm, music and packaging. Record the intentional shared content; high overlap is expected and is not a failure.

For `platform-adaptation`, verify the approved content is preserved and each target's aspect ratio, safe areas, captions and duration requirements are met. Shared openings and bodies are allowed.

For distinct cuts, run these on every pair in the batch. N cuts means N*(N-1)/2 pairs; for large
batches, at minimum check every cut against the cut it most resembles.

Use the following as editorial planning targets, subject to the approved matrix:

1. **Opening** — no shared source frames in the first 3 seconds.
2. **Overlap budget** — target shared source seconds divided by the shorter cut's duration under **40%**. Higher overlap needs review against the agreed contract; it is not a platform classification.
3. **Order signature** — the first 5 shots differ in at least 2 adjacent pairs.
4. **Rhythm** — average shot length differs by 1.5x, or the shape inverts.
5. **Duration** — differs by at least 15%, unless the platform fixes length.

Record the distinct-cut result as an editorial similarity verdict: `distinct`, `borderline`, or `near-duplicate`. For the other modes, report `controlled-hook-test` or `platform-adaptation` and whether its contract passed; do not apply the distinct-cut thresholds.

## 3. What to do with each verdict

| Verdict | Action |
|---|---|
| `distinct` | Ship. |
| `borderline` | Ship only if the user accepts the risk, and flag the specific pair in the report. |
| `near-duplicate` | Do not ship both. Re-cut one on a different dimension, or drop it and tell the user the pool would not support the requested count. |

Never silently ship a `near-duplicate` pair. The whole point of the batch is
that the outputs are genuinely different; a hidden duplicate is worse than a
smaller batch because it fails later, after publishing.

## 4. Per-cut QA (still required)

The batch check does not replace individual review. For each cut:

- Opens on the strongest available visual, not a logo or a slow establish
- Sequence has a purpose: hook, context, escalation/proof, payoff
- Captions and titles state only what the footage supports
- Platform treatment correct: aspect ratio, safe areas, duration
- Exports cleanly

## 5. Report format

Report the batch as a set, not as N independent successes:

```
Batch: <topic> — <N> cuts, <platform>
Music: shared bed <name> | distinct beds per cut

v01 <name>  28s  differs by: hook + order
v02 <name>  34s  differs by: hook + rhythm
...

Most similar pair: v03 / v05 — borderline (overlap 38%, order differs in 2 pairs)
Review first: v03 and v05, then v01 (hook test baseline)
```

Always name the most similar pair. If the user only has time to check two
files, they should check the two that might be duplicates — that is the pair
most likely to cause a problem, and hiding it defeats the purpose of the
check.
