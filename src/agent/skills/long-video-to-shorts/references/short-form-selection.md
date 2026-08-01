# Short-Form Candidate Selection

Use this guide to compare transcript moments from one long source and visual sequences assembled from multiple clips. Score source strength before adding captions, music, transitions, or other packaging.

## 1. Record candidate evidence

Create one row per candidate and use stable IDs so another pass can reproduce the ranking.

| Field | Long-source moment | Multi-clip sequence |
| --- | --- | --- |
| Candidate ID | Source asset + start/end range | Ordered asset IDs + ranges |
| Direct evidence | Exact transcript line, speaker turn, action, or audio beat | Observed subject, action, motion, reaction, composition, or audio beat |
| Proposed arc | Hook → setup/proof → payoff within the range | Hook shot → context/proof shots → payoff shot |
| Boundary evidence | Complete phrase, breath, pause, reaction, or action | Entry/exit motion, beat, action completion, or natural transition |
| Constraints | Requested audience, duration, format, tone, and purpose | Requested audience, duration, format, tone, and purpose |
| Risks | Missing context, weak audio, misleading implication, safety/privacy, crop, or rights concern | Continuity, unsupported claim, duplicate footage, safety/privacy, crop, or rights concern |

Write observations as facts. Label interpretations as assumptions and verify them before editing. Never infer a claim, identity, relationship, result, or chronology that the source does not support.

## 2. Check the candidate arc

A viable candidate should answer these questions from its own selected material:

- **Standalone clarity:** Can a new viewer understand the subject, action, or claim without the surrounding source?
- **Hook:** Does the opening create immediate curiosity, tension, surprise, relevance, or visual interest?
- **Payoff:** Does the selection deliver an answer, proof, reveal, emotional turn, lesson, result, or satisfying final beat?
- **Context integrity:** Does trimming preserve the speaker's meaning, event order, cause and effect, and user-supplied claims?
- **Visual strength:** Is there a readable subject, meaningful action, expressive reaction, useful detail, or purposeful composition?
- **Platform fit:** Does the material suit the user's requested duration, format, audience, tone, and viewing conditions without relying on assumed platform conventions?
- **Redundancy:** Is it meaningfully different from stronger candidates in topic, claim, action, framing, energy, or payoff?
- **Clean boundaries:** Can it start and end without clipped speech, incomplete action, abrupt context loss, or accidental dead air?

For speech-led moments, visuals may support rather than lead. For visual sequences, meaning may come from shot order and audio rather than dialogue. Do not penalize either form merely for lacking the other's evidence type.

## 3. Score reproducibly

Score each factor from `0` to `4` using the same evidence pass:

- `0` — absent, unusable, or contradicted by the source
- `1` — weak; major repair or outside explanation required
- `2` — workable; clear limitations remain
- `3` — strong; minor editing is enough
- `4` — exceptional; immediately legible and well supported

| Factor | Weight | Scoring question |
| --- | ---: | --- |
| Standalone clarity | 18 | Does the selected material explain itself? |
| Hook | 16 | Is the first usable beat compelling? |
| Payoff | 14 | Is there a concrete, satisfying destination? |
| Context integrity | 14 | Will the cut preserve meaning and chronology? |
| Visual strength | 12 | Are the selected images/actions readable and purposeful? |
| Platform fit | 10 | Does it fit the user's stated delivery constraints? |
| Clean boundaries | 8 | Are there natural, editable start and end points? |
| Distinctiveness | 8 | Does it add value beyond higher-ranked candidates? |

Calculate:

`base score = sum(factor rating × factor weight) ÷ 4`

The base score is out of `100`. Keep the individual ratings and one evidence note per factor; a total without notes is not reproducible.

Apply only evidence-based deductions after the base score:

| Deduction | Range | Use when |
| --- | ---: | --- |
| Correctable risk | `-1` to `-10` | A crop, audio, pacing, continuity, or boundary issue is real but repairable |
| Redundancy | `-1` to `-12` | A higher-ranked candidate already delivers substantially the same value |

`final score = base score - deductions`

Do not deduct twice for the same weakness. Rank by final score, then break ties in this order: context integrity, standalone clarity, hook, payoff, visual strength. Preserve the original candidate IDs and scores when re-ranking after user feedback.

## 4. Reject before ranking

Reject a candidate rather than trying to rescue it with packaging when any of these are true:

- It changes or obscures the source meaning, chronology, speaker intent, or user-provided claim.
- It requires invented context, unsupported title text, or an unverified factual claim to make sense.
- It lacks a usable opening, understandable middle, or payoff after reasonable trimming.
- Speech or action is irreparably clipped, inaudible, visually unreadable, or missing the evidence needed for the proposed arc.
- Safety, privacy, consent, rights, or sensitive-content concerns cannot be resolved within the user's instructions and available project evidence.
- It is materially weaker than and redundant with a stronger candidate.
- It cannot meet the user's stated duration or format without breaking context integrity.

A rejected candidate receives a reason, not a score. Do not lower the threshold merely to reach a requested count.

## 5. Select and sequence

1. Inventory broadly enough to find competing hooks and payoffs; do not score only the first plausible moment.
2. Remove rejected candidates.
3. Score the remaining candidates in one pass with the same constraints and evidence standard.
4. Rank by final score and apply the tie-break order.
5. Review the tentative set for variety across subject, claim, action, framing, energy, and payoff; apply redundancy deductions and re-rank.
6. Record the selected source ranges, opening beat, arc, expected duration, treatment constraints, and unresolved risks.

## 6. Prove the first clip before batching

When style is not established, material is varied, the source is very long, or the requested count is high, create or preview the highest-ranked candidate first. Verify that its hook, clarity, payoff, boundaries, crop, pacing, and packaging work in the actual timeline. Use that confirmed treatment as the batch reference, then process the remaining ranked candidates. If the first clip exposes a scoring assumption or treatment problem, update the rubric notes and re-rank before batching; do not repeat the flaw across outputs.
