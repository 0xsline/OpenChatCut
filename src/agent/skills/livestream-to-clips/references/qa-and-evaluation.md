# Livestream Clip QA and Evaluation

Tool success proves that an edit operation ran. Completion requires evidence that the composed clip is truthful, coherent, technically sound, and appropriate for its profile and objective.

## Per-Clip QA

### Source and meaning

- Source timestamps and asset identity are traceable.
- Speaker, person, product, team, score, date, price, unit, and claim match the source.
- The clip preserves setup, causality, intent, and payoff.
- A title, subtitle, crop, or inserted visual does not change the source meaning.

### Visual

- Inspect composed frames at opening, event/claim, payoff, ending, and every major crop or overlay change.
- Essential face, action, product, gameplay UI, scoreboard, instrument, slide, code, or result remains visible.
- No essential black, frozen, duplicate, corrupted, or severely blurred frames.
- Captions and graphics remain readable and do not cover the viewer's primary task.
- Reframing remains stable; cuts and scale changes are motivated rather than repetitive decoration.

### Audio

- Opening and ending do not clip words, breaths, beats, attacks, landings, laughter, or reactions.
- Speech is intelligible; music and effects do not mask it.
- Jump cuts do not introduce clicks, abrupt ambience changes, or impossible conversational timing.
- Music/performance clips preserve phrase and beat continuity.

### Text and captions

- Captions are synchronized and preserve proper nouns, numbers, prices, scores, dates, and units.
- Filler removal still sounds human and does not erase emphasis or emotional timing.
- OCR-derived text used in the edit has been confirmed against source frames when material.

### Profile and platform

- The active profile's event arc is complete.
- The objective is visible in the result: reach, conversion, education, community, recap, or teaser.
- Duration, aspect ratio, safe composition, timeline name, and requested output count are correct.
- Sensitive or regulated material carries the appropriate review flag.

### Export readiness

- No unintended gaps, overlaps, missing media, offline links, or unsupported effects.
- Preview and export use the same intended composition.
- When delivery is requested, track the render through terminal success and inspect the resulting media rather than relying on submission success.

## First-Clip Gate

For a new source, profile, or style, complete one highest-ranked clip before batching. Inspect it end to end and revise candidate scoring or treatment when the real timeline reveals a poor assumption. Only then apply the treatment to the remaining candidates.

Before export, re-read the transcript at the edited boundaries. The first audible words must form a clear opening rather than a dangling continuation, and the final audible words must complete the thought, reaction, result, or call to action. Move either boundary when this check fails, even if the candidate score was high.

## Benchmark Protocol

Build the benchmark from real livestream recordings covering multiple profiles, paces, layouts, languages, and quality levels. Keep source and expected decisions versioned outside the shipped skill body.

For each source, have reviewers independently mark:

- section profiles and profile transitions;
- notable events and unacceptable excerpts;
- preferred start/end ranges with acceptable boundary tolerance;
- why each event is worth clipping;
- factual entities that must remain exact;
- technical defects and privacy/compliance risks;
- preferred top clips for at least two different objectives.

Evaluate:

| Metric | Meaning |
|---|---|
| Event recall | Human-marked valuable events surfaced in the candidate ledger |
| Top-k precision | Selected clips judged publishable or useful by reviewers |
| Boundary error | Difference from acceptable human start/end ranges |
| Standalone clarity | New viewers understand setup and payoff |
| Meaning fidelity | No changed claim, attribution, causality, or chronology |
| Profile correctness | Section and candidate use the right genre rules |
| Technical defect rate | Black frames, clipped audio, bad crop, subtitle errors, gaps, or offline media |
| Diversity | Selected set avoids redundant topics, events, and treatments |
| Editability | Reviewers can refine the result without rebuilding it |
| Export completion | A real rendered artifact opens, has expected duration, and matches the timeline |

Use human ratings in addition to automated checks. Compare counterexamples and disagreements instead of hiding them in one average score. Keep separate results by profile because a global average can conceal a failure on a smaller genre.

## Evidence to Record During Real Agent Tests

- exact user instruction and selected skill;
- tools called with source ranges and returned evidence;
- candidate ledger and rejection reasons;
- timeline/project identifiers before and after editing;
- inspected source and timeline frames;
- audio or transcript boundary checks;
- render identifier, terminal status, output duration, and playable artifact path;
- reviewer notes for the first clip and any re-ranking performed.

## Research Basis

- PodReels found that candidate options, preview, sentence-level control, and visible treatment of jump cuts improved creator efficiency and control: https://arxiv.org/abs/2311.05867
- CatchLive evaluated highlights across game, cooking, and talk streams and reported different needs by genre and stream pace: https://doi.org/10.1145/3491102.3517461
- Audience-chat highlight work reports precision, recall, and F-score while separating chat, visual, and fused inputs, supporting per-modality ablations: https://arxiv.org/abs/1707.08559
- Instructional-video research evaluates learning utility, effort, claim coverage, temporal alignment, and human agreement rather than surface polish alone: https://arxiv.org/abs/2606.28531
