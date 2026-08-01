# Explainer Animation Reference

Use this reference to decide what an animated explainer section must communicate before writing its visual treatment. Animation earns its place when motion, sequence, spatial relation, or changing state makes the idea easier to understand.

## Gate boundaries

- Read this file before planning any motion graphic, animated diagram, mechanism view, data animation, abstract concept animation, or MG overlay.
- This reference defines explanatory structure. It does not replace `create-motion-graphics`, its direct-authoring rules, or its project Design Style alignment.
- Load `create-motion-graphics` before proposing visual-direction choices or authoring a Motion Graphic, then read the existing project visual language and confirm a valid Design Style source through the parent gate.
- Script estimates may support planning only. Final narration-backed animation must use the matching narration text or time range and actual audio duration when available.
- Keep Explainer Video in control of section order, narration mode, timing, timeline assembly, and sync QA.

## Explanation test

For every proposed motion, finish this sentence: “The viewer understands ___ because the animation shows ___ changing or relating to ___.” If the blanks cannot be filled precisely, the motion is probably decorative.

**Animation that explains:**

- reveals steps in causal or chronological order;
- tracks an entity through a process;
- compares before and after states on a stable frame;
- exposes hierarchy, flow, dependency, scale, or feedback;
- changes a data encoding in direct response to the narrated claim;
- preserves object identity so the viewer can follow what changed.

**Decorative motion:**

- makes icons bounce, drift, pulse, or orbit without adding meaning;
- repeats the narration as animated subtitles or unrelated symbols;
- uses particles, wipes, parallax, or camera movement as filler;
- changes layout merely to keep the frame busy.

Decorative motion may support tone, but it must stay subordinate to the explanatory action and must not compete with labels or state changes.

## Map meaning to a visual grammar

Choose the grammar from the claim, not from the desired effect.

| Claim structure | Preferred visual grammar | Required evidence on screen |
| --- | --- | --- |
| Sequence or procedure | ordered states, timeline, step flow | current step, direction, start and result |
| Cause and effect | directed flow or input-process-output | cause, mechanism, effect, arrow meaning |
| System mechanism | stable diagram with state changes | entities, relationships, what enters/exits |
| Before and after | aligned states or controlled morph | same subject, same scale, changed variable |
| Comparison | parallel frames, matrix, or shared-axis chart | common basis, units, meaningful difference |
| Hierarchy or containment | nested groups or tree | parent-child relation and scope |
| Quantity or trend | honest chart or proportional encoding | value, unit, baseline, time/category |
| Feedback or cycle | loop with direction and update state | trigger, loop path, stopping or repeat condition |
| Abstract concept | consistent tokens plus a small legend | what each token represents and how it behaves |

For each animated section, record: narration phrase or time range, viewer takeaway, entities, relationship or change, state sequence, labels, data/source status, treatment, and sync risk.

## Plan mechanism and diagram states

1. Define the **initial state**: what exists before the narrated change.
2. Define each **transition state**: one meaningful change per beat whenever possible.
3. Define the **result state**: the condition that proves the narrated point.
4. Keep unchanged entities in stable positions. Move an object only when movement carries meaning.
5. Introduce entities before animating their relationship. Do not animate an unnamed box into an unexplained network.
6. Give arrows a single consistent meaning such as flow, causation, transfer, or sequence. Label the meaning when it is not obvious.
7. Show branches, exceptions, loops, and failure paths only when narration names them or they are necessary to avoid a false model.
8. Hold each important state long enough to read and compare. If the narration advances before a state can be understood, split the section or simplify the diagram.

A state is useful only if the viewer can answer “what changed, why, and what resulted?” from the frame and narration together.

## Time from narration first

1. Obtain the matching voiceover or generated TTS and read its actual duration.
2. Split the section at spoken idea boundaries, not at equal time intervals.
3. Mark phrase anchors: entity introduction, action verb, quantity, contrast, and conclusion.
4. Place visual reveals at or just before the phrase they clarify. Do not reveal the conclusion before narration establishes it.
5. Let the explanatory change complete near the relevant spoken phrase, then preserve a readable hold.
6. Align the animation and narration to the same section start and cover the full narration range unless the plan intentionally changes shots.
7. If the actual audio is too short for the required states, tighten the diagram, split the section, or revise narration. Do not accelerate labels into unreadability.

Never submit final narration-backed MG from script length alone, and never generate it in parallel with the TTS that determines its duration.

## Control information density and labels

- Give each frame one primary claim or relationship.
- As a working ceiling, keep roughly three to five active labeled entities and one highlighted change at a time. Split dense systems into progressive states rather than shrinking everything.
- Use short noun labels, values, units, or compact action phrases. Do not place full spoken sentences on screen.
- Use the same term in narration, labels, captions, and legend. Do not alternate synonyms for a technical entity.
- Keep labels attached to their objects and persistent long enough to read. Avoid crossing leader lines and moving text.
- Use emphasis to identify the current subject; mute prior context without erasing information needed for comparison.
- Prefer direct labeling over a remote legend. Use a legend only when repeated encodings make it more economical.

## Keep data honest

- Preserve the user's claims and mark unsupported values or examples as illustrative.
- Show units, categories, time range, denominator, and baseline when they affect interpretation.
- Use consistent scales across comparisons. Area, length, position, and speed must not exaggerate differences.
- Do not animate fabricated precision, interpolate missing observations as measured data, or imply causation from correlation.
- Show uncertainty, ranges, omitted intervals, and non-zero baselines when material to the claim.
- When a visual simplification changes the model, state the simplification or choose a different visual.

## Use semantic transitions

- Preserve position, color role, and shape identity when the same entity continues into the next state.
- Morph only when the object remains the same thing; use a cut or explicit replacement when identity changes.
- Use zoom to change explanatory scale, not for spectacle. Keep an orientation cue when moving between overview and detail.
- Use a cut or section reset when the topic, time, or comparison basis changes.
- Start a transition after the current point lands and finish before the next point needs attention.
- Avoid decorative wipes between tightly linked mechanism states because they erase continuity.

## Build the representative section first

1. Choose the section with the highest semantic or sync risk, not the easiest section.
2. Resolve its actual narration timing, Animation Reference Gate, `create-motion-graphics` intake, and Design Style confirmation.
3. Create one complete section and place it against the matching narration.
4. Check state logic, label readability, data integrity, visual direction, and sync before batching related sections.
5. Reuse the validated visual grammar and timing behavior, not identical choreography, across the batch.

A pre-audio style proof is allowed only with explicit user approval. Label it style-only, keep it out of final timeline content, and do not treat it as the representative section.

## Narration-visual sync QA

Replay every narration-backed section from its timeline start and verify:

- every spoken proposition has a matching visual or intentionally narration-only beat;
- entities appear before their actions, and highlights follow the spoken subject;
- state changes land on the phrase they explain rather than early or late;
- animation duration covers the full narration range without a frozen accidental tail;
- labels remain readable and do not duplicate full narration;
- information density allows the viewer to follow one meaningful change at a time;
- transitions preserve continuity or clearly signal a reset;
- values, scales, units, and comparisons remain truthful;
- the final state holds long enough for the conclusion to register.

Record the timing source, narration duration, animation duration, match result, and fix for each failed section. Fix mismatches by simplifying or splitting states, adjusting timing, tightening narration, extending or regenerating visuals, or asking the user to choose the tradeoff before delivery.
