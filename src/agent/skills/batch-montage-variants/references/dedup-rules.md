# Dedup Rules and Batch QA

Batch output fails in a specific way: every individual cut passes review, and
the batch as a set still gets flagged as duplicate content. These checks run on
the set, not on each timeline.

## 1. Why structural dedup, not decorative dedup

Platform duplicate detection compares content, not styling. Mirror, speed
change, color grade, caption restyle, and music swap are the classic
"伪去重" tricks — they change the bytes and not the video. What actually
separates two cuts:

- Different source footage in the opening and in the majority of shots
- Different event order — the sequence of what happens, not how it is dressed
- Different edit rhythm, which changes the perceived pacing signature
- Different duration at a meaningful scale

Treat any differentiation plan built only from decorative changes as invalid.

## 2. Pairwise checks

Run these on every pair in the batch. N cuts means N*(N-1)/2 pairs; for large
batches, at minimum check every cut against the cut it most resembles.

For each pair, verify:

1. **Opening** — no shared source frames in the first 3 seconds.
2. **Overlap budget** — shared source seconds divided by the shorter cut's duration stays under **40%**. Above that, the pair is a near-duplicate.
3. **Order signature** — the first 5 shots differ in at least 2 adjacent pairs.
4. **Rhythm** — average shot length differs by 1.5x, or the shape inverts.
5. **Duration** — differs by at least 15%, unless the platform fixes length.

Record the result as a similarity verdict: `distinct`, `borderline`, or
`near-duplicate`.

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
