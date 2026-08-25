# Livestream Profile Matrix

Classify the recording by section. Profiles set selection and packaging priorities; they do not override source evidence. When the section does not fit cleanly, use `mixed` with the two strongest profiles and explain the overlap.

| Profile | Preferred event arc | Strong signals | Boundary and packaging priorities | Reject or flag |
|---|---|---|---|---|
| Commerce | product/need → demonstration or proof → offer → CTA | product visibility, product/price words, demonstration, questions, buyer reaction | preserve exact product identity and verified numbers; show the product when it is discussed | product/price mismatch, expired or uncertain offer, unsupported claim |
| Gaming | game state → event → streamer reaction → outcome | game UI change, impact cue, facecam expression, speech excitement, chat spike | include enough pre-event game state; keep UI and reaction visible after reframing | reaction without the triggering event, hidden score/UI, duplicated round |
| Esports/sports | buildup → decisive play → result → replay/reaction | scoreboard, commentary energy, crowd sound, replay transition, win-probability change | preserve rules context and result; use contiguous action when possible | wrong score/player/team, result without buildup, replay mistaken for live action |
| Talk/just chatting | setup or question → story/claim → turn or payoff | transcript semantics, tone change, laughter, audience response | optimize standalone clarity and speaker intent | quote requires omitted context, sarcasm or irony reversed |
| Interview/podcast | question → answer → evidence/example → conclusion | speaker turns, thesis, personal story, disagreement, concise takeaway | retain the question when the answer depends on it; use reaction shots to cover jumps | speaker attribution error, stitched answer changes meaning |
| Education/tutorial | goal → explanation/steps → demonstration → result | transcript structure, screen/slide changes, cursor/action, before/after state | retain prerequisites, key steps, labels, and readable screen content | correct conclusion with missing method, illegible screen, unsafe omitted step |
| Entertainment/variety | setup → escalation → punchline/reveal → group reaction | laughter, facial reaction, repeated audience response, surprise, visual reveal | keep comedic timing and reaction tail | punchline without setup, private or humiliating context |
| Music | phrase/build → chorus/drop/solo → resolution | beat/tempo, harmonic repetition, energy, performer motion, applause | cut on phrase/beat boundaries; preserve performance continuity | mid-beat start/end, audio discontinuity, unrelated camera cut |
| Dance/performance | setup → movement phrase → signature move → resolution | beat, full-body motion, pose, crowd reaction | keep complete movement phrases and subject framing | crop removes body/prop, pose or landing truncated |
| IRL/travel/lifestyle | place/task setup → discovery/action → result/reaction | scene novelty, movement, environmental sound, location or object mention | preserve spatial continuity and protect private information | exposed address/identity, unsafe or misleading location context |
| Food/cooking | ingredient/goal → key technique → transformation → result/taste | close-up, step language, texture change, timer/temperature, reaction | keep critical steps and finished result | wrong ingredient/unit, omitted safety-critical step, result from another batch |
| Creative/making | intent → process milestone → breakthrough → reveal | canvas/code/object change, tool action, before/after, creator reaction | compress repetition while retaining causal milestones | result disconnected from process, screen or work area unreadable |
| News/commentary | event/claim → evidence/source → analysis → conclusion | names, dates, source references, graphics, quoted material | retain attribution and separate fact from opinion | altered claim, uncertain identity/date, sensational title unsupported by source |
| Call-in/emotional | issue → exchange → emotional turn → response or resolution | speaker turns, silence, prosody, explicit consent/context | favor contiguous excerpts and conservative packaging | private data, vulnerable disclosure, decontextualized accusation |
| Mixed | profile transition → local event arc → next state | scene/topic/activity changes across all modalities | split at real format changes and apply local profile weights | one global style obscures a meaningful profile change |

## Profile Classification Procedure

1. Start from observable activity, not the video's title or filename.
2. Classify bounded sections after building the stream map.
3. Record the strongest and second-strongest profile plus confidence.
4. Reclassify when the activity changes, such as gameplay → chatting → sponsor read.
5. Use `mixed` only when both profiles actively shape the same candidate.

## Objective Is Separate from Profile

The same event can serve different objectives:

- **Reach:** immediate hook, novelty, emotion, and standalone clarity.
- **Conversion:** verified product/offer, demonstration, trust, and CTA.
- **Education:** retained prerequisites, explanation quality, and visible result.
- **Community:** audience interaction, streamer personality, and shared context.
- **Recap:** coverage, chronology, diversity, and major outcomes.
- **Teaser:** curiosity and tension without falsely hiding the actual payoff.

Apply objective weights after profile classification. Do not infer “most exciting” as the universal objective.

## Optional Interaction Evidence

If synchronized interaction data exists, derive only bounded features such as message rate, unique participants, repeated terms/emotes, sentiment shift, questions, donations, or poll changes. Channel-specific slang and emotes require local context. A burst indicates attention, not automatically positive quality; inspect the associated source event before ranking it.

## Research Basis

- CatchLive found that game, cooking, and talk streams need different summarization detail and that representative frames, transcript, and interaction data help viewers recover context: https://dl.acm.org/doi/10.1145/3491102.3517461
- Audience chat reactions improved esports highlight prediction when combined with visual evidence: https://arxiv.org/abs/1707.08559
- Multi-view game research found that streamer face and audio novelty can be as important as game footage: https://arxiv.org/abs/1807.09715
- PodReels showed that podcast teaser creation benefits from transcript selection, speaker context, preview, and reaction-shot treatment: https://arxiv.org/abs/2311.05867
- LiveRetro aligns ecommerce performance with viewer, merchandise, feature, and segment feedback rather than treating a stream as one homogeneous session: https://doi.org/10.1109/TVCG.2023.3326911
