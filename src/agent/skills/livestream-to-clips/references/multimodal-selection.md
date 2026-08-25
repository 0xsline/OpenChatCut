# Multimodal Livestream Candidate Selection

Use this reference to turn a long, heterogeneous stream into evidence-backed clip candidates without overwhelming model context or favoring one modality.

## 1. Hierarchical Scan

Use three passes:

1. **Overview pass:** read bounded transcript ranges and sparse visual/audio summaries to map sections, entities, activities, and profile changes.
2. **Candidate pass:** apply explicit objective and profile rules inside each section; generate source-aligned event ranges with evidence.
3. **Verification pass:** inspect dense evidence only around top candidates, resolve boundaries, reject defects, and rank globally.

This balances two long-context failures: windows that are too large lose middle content and structured precision, while windows that are too small lose topic and causal context. Keep overview notes compact and retain timestamps into every later pass.

## 2. Evidence Channels

### Speech and transcript

Use word timestamps, speaker turns, topic changes, questions, claims, examples, jokes, instructions, offers, corrections, and conclusions. Measure transcript confidence around names, numbers, prices, scores, dates, units, and proper nouns.

### Visual

Use scene changes, subject visibility, face expression, action, product/object state, UI/scoreboard, slide or screen text, before/after differences, camera quality, and crop feasibility. Sample opening, event peak, payoff, and transitions rather than treating one thumbnail as proof for the whole range.

### Audio

Use speech clarity, overlap, energy change, laughter, applause, crowd reaction, game cues, impacts, silence contrast, music structure, and clipping/noise defects. Audio peaks are candidate signals; verify that they correspond to meaningful source events.

### Interaction and metadata

Use synchronized chat, emotes, reactions, donations, polls, markers, scores, telemetry, products, or agenda data when present. Align them by timestamp and record provenance. Treat them as unavailable when absent.

## 3. Candidate Record

Each candidate must retain:

- source and transcript ranges;
- section profile and objective;
- event arc and opening hook;
- evidence per available modality;
- missing modalities and unresolved facts;
- boundary rationale;
- proposed packaging;
- rejection flags and confidence.

Do not convert missing chat or telemetry into a low engagement score. Reweight across the evidence that actually exists.

## 4. Hard Gates Before Ranking

Reject or require review when any of these apply:

- the excerpt changes speaker intent, causality, chronology, or factual meaning;
- setup, triggering action, critical step, or payoff is missing;
- identity, product, price, score, date, unit, or source attribution is unresolved;
- source frames contain severe black/frozen/obscured content across an essential moment;
- audio is missing, unintelligible, badly clipped, or cut mid-utterance at an essential point;
- crop hides the subject, product, instrument, demonstration, UI, scoreboard, slide, or result;
- the excerpt exposes private data or sensitive context that should not be amplified;
- it substantially duplicates a stronger selected candidate.

## 5. Reproducible Scoring

Score each dimension from 0 to 5 and record one sentence of evidence:

| Dimension | Question |
|---|---|
| Standalone clarity | Can a new viewer understand the moment without omitted context? |
| Hook | Does the opening create immediate interest without a misleading title? |
| Payoff | Does the event deliver a result, insight, reaction, reveal, or resolution? |
| Profile value | Does it satisfy the active profile's event arc and signals? |
| Objective fit | Does it serve reach, conversion, education, community, recap, or teaser intent? |
| Visual usability | Are the essential subject and action visible and crop-safe? |
| Audio usability | Is speech/music/action intelligible and clean at the boundaries? |
| Evidence confidence | Do multiple available signals agree, and are important facts verified? |
| Editability | Can it be tightened and packaged without unnatural discontinuity? |
| Novelty | Does it add something distinct to the selected set? |

Start with equal weights, then apply these small profile adjustments rather than inventing a separate scoring system:

- Commerce: +2 profile value, +1 evidence confidence.
- Gaming/sports: +2 payoff, +1 audio usability, +1 visual usability.
- Talk/interview/news: +2 standalone clarity, +1 evidence confidence.
- Education/tutorial: +2 standalone clarity, +2 payoff, where payoff means usable understanding or visible result.
- Music/dance: +2 audio usability, +2 visual usability, +1 editability.
- Entertainment/IRL/creative: +1 hook, +1 payoff, +1 visual usability.

Scores compare candidates; hard gates protect truth and quality. A high total never overrides a failed gate.

## 6. Boundary Resolution

Start with the event peak and expand outward:

1. Expand backward to the nearest sufficient setup, question, game state, product identity, task goal, or musical phrase boundary.
2. Expand forward through the result, reaction, proof, conclusion, landing, or musical resolution.
3. Snap speech to clean word/phrase boundaries and action to clean visual state changes.
4. Add short handles when the edit needs an audio fade, reaction cover, or crop transition.
5. Preview the exact range; revise if the hook starts slowly or the ending feels truncated.

## 7. Global Selection

Rank after gates, then enforce diversity across profile, topic, product, speaker, round, event shape, visual treatment, and source time. For overlapping candidates, keep the one with the clearer arc or intentionally create duration variants. Do not fill a quota with weak clips.

## 8. Research Basis

- RankCut uses overview, explicit selection rules, and small-window ranking to mitigate long-context and transparency failures: https://doi.org/10.1145/3742413.3789115
- CatchLive supports overall structure and multiple levels of detail, with stream pace affecting the preferred summary density: https://doi.org/10.1145/3491102.3517461
- Game-stream research shows multi-view agreement is stronger than isolated novelty spikes: https://arxiv.org/abs/1807.09715
- SoccerNet-Echoes studies audio commentary aligned with sports events, supporting audio as event evidence rather than mere quality metadata: https://arxiv.org/abs/2405.07354
- Music-synchronized editing research reports stronger audio-visual harmony from beat-aware analysis and a reviewer loop than fixed segmentation: https://arxiv.org/abs/2603.29664
- Instructional evaluation should measure accessible learning or usable understanding, not only visual salience or summary coverage: https://arxiv.org/abs/2606.28531
