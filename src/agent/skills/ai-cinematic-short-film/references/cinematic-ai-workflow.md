# Cinematic AI Workflow and Style Bible

Use this reference after the story premise and ending are clear. The bible serves the story: lock only choices that help viewers recognize the world, subjects, and progression. Generation remains variable; references and repeated language improve continuity but do not guarantee identical results.

## Operating order

1. Reduce the story to one sentence and list the emotional turn of each beat.
2. Lock the few visual invariants required to understand those beats.
3. Define a restrained camera and lighting grammar.
4. Assign every planned shot a narrative job before writing prompts.
5. Generate a representative identity shot and a representative world shot first.
6. Approve or revise those anchors, then generate the remaining shots.
7. Select clips by story clarity first, continuity second, spectacle third.
8. Place selected clips as separate OpenChatCut timeline items; refine order, trims, pacing, and transitions without flattening the sequence.
9. Review composed timeline frames and normal-speed playback before finalizing.

## Copyable style-bible template

Fill each line with one decisive rule. Remove any field that does not affect this film.

```text
STORY CONTRACT
Premise: one sentence describing protagonist, pursuit, obstacle, and payoff
Emotional arc: opening state -> turning point -> final state
Viewer must understand: the indispensable fact or change
Protected user claims: exact product, identity, wording, or reference details that must not drift

WORLD / LOCATION LOCKS
Era and geography:
Location identity and recurring landmarks:
Spatial logic and screen direction:
Architecture, materials, weather, and atmosphere:
Allowed changes across story time:
Forbidden contradictions:

CHARACTER / PRODUCT LOCKS
Identity name and role:
Recognition anchors: silhouette, face/hair, wardrobe, proportions, gait, or signature prop
Product anchors: form, materials, color, logo placement, package text, scale, and handling rules
State by beat: clean/damaged, open/closed, worn/carried, emotional or physical progression
Elements allowed to vary:
Elements that must never change:

PALETTE / LIGHTING LOCKS
Core palette: three to five named colors with their story roles
Saturation and contrast range:
Key-light direction, softness, and color temperature:
Practical sources and atmospheric effects:
Beat-specific lighting evolution:
Forbidden color or lighting treatments:

LENS / CAMERA / MOTION LANGUAGE
Default framing and depth character:
Wide-shot purpose:
Close-up purpose:
Camera height and subject distance:
Allowed moves: static, pan, tilt, track, push, pull, orbit, or handheld when narratively earned
Movement rhythm and stabilization character:
Forbidden moves or visual habits:

TEXTURE / FINISH
Material and surface character:
Image cleanliness, grain, bloom, flare, and sharpness policy:
Effects that may support the story:
Effects that must not obscure identity, action, product, or readable text:
```

## Continuity anchors

Keep anchors observable rather than abstract. “Red knee-length wool coat with brass buttons” is reusable; “stylish coat” is not.

- **World:** lock landmark arrangement, entrances, dominant materials, time of day, weather direction, and any geography needed for the next cut.
- **Character:** lock two to four recognition anchors, not every incidental detail. Include left/right placement for asymmetrical marks, accessories, or injuries.
- **Product:** preserve supplied design, proportions, logo orientation, label wording, color, and use. Never invent claims or silently redesign packaging.
- **State:** record changes caused by the story—wetness, damage, dirt, opened packaging, missing props, or wardrobe changes—and carry them forward.
- **Screen direction:** note subject travel, eyelines, handedness, and prop transfers when consecutive shots must cut together.

## Prompt structure

Write each shot prompt in this order, using the same locked phrases for recurring anchors:

1. **Narrative purpose:** what the viewer must learn or feel.
2. **Subject and anchors:** exact recurring identity or product phrases.
3. **Visible action:** one primary action with a clear start or result.
4. **Environment:** only location details visible in this shot.
5. **Composition:** shot size, subject placement, depth layers, and eyeline.
6. **Camera behavior:** angle and one motivated move, or explicitly static.
7. **Lighting and palette:** shared lock plus any story-driven change.
8. **Mood and texture:** concise finish language from the bible.
9. **Continuity clause:** incoming state, screen direction, required prop, and outgoing state.
10. **Negative constraints:** only likely failures such as changed identity, unreadable product text, extra limbs, duplicate props, or unmotivated camera motion.

Prefer one readable action over a brittle list of simultaneous events. Use only controls exposed by the current OpenChatCut generation capability; do not imply that prompts, seeds, or references make a result deterministic.

## Reference-frame policy

- Use a reference only when it protects a meaningful invariant: character identity, exact product, costume, landmark, prop state, or a required first/last composition.
- Prefer user-approved or previously approved frames. Label each reference by role: `identity`, `product`, `location`, `costume`, `state`, `first-frame`, or `last-frame`.
- Keep one canonical identity reference per stable state. Add another only for a necessary angle, expression, or story-state change.
- Do not use an attractive frame as a reference if it contradicts the current shot’s geography, wardrobe state, lighting phase, or screen direction.
- A generated reference is a proposal until reviewed. Store approved generated images or clips in the OpenChatCut media pool before using them downstream.
- If the available video generation mode accepts references, supply only the relevant approved ones. Otherwise carry their observable details into the prompt; never claim exact reproduction.
- Record which references influenced each shot so a failed shot can be regenerated without changing unrelated anchors.

## Per-shot continuity ledger

Maintain one row per shot and update it after selecting a take.

| Field | Record |
| --- | --- |
| Shot ID / beat | Stable ID, story beat, and narrative purpose |
| Timing | Target duration, actual selected duration, and timeline position |
| Incoming state | Character/product/prop condition, location, time, and screen direction |
| Action / reveal | Single visible action and the information it delivers |
| Framing / motion | Shot size, angle, depth, camera move, and motion direction |
| Lighting / palette | Shared locks plus intentional beat-specific deviation |
| References | Approved asset or frame identifiers and their roles |
| Required outgoing state | State the next shot must inherit |
| Selected result | Generation job/result or media-pool asset used |
| Deviations / decision | Accepted variance, required fix, regeneration reason, or user decision |

## Regeneration and QA thresholds

Review first at normal speed, then inspect suspect frames. Classify before retrying:

- **Regenerate:** the story beat is unclear; the primary action is missing; character or product identity changes; protected text/claims are wrong; required state, prop, geography, or screen direction breaks; or a severe artifact dominates the subject.
- **Regenerate or redesign the shot:** two or more visible bible deviations compete for attention, motion makes the action unreadable, or the result cannot cut coherently to both neighbors.
- **Repair on the timeline:** the source take is sound and the problem is order, trim, duration, framing, pacing, transition, or audio alignment.
- **Accept:** the intended beat reads immediately, all protected anchors hold, adjacent shots connect, and remaining variation is incidental at normal playback speed.

Retry only the failed shot. Keep its story purpose, stable anchor phrases, and approved references fixed; change one failure source at a time. After two regenerations fail on the same invariant, simplify the action or camera move, split the shot, or present the tradeoff for user review instead of brute-forcing more variations.

## Final continuity checklist

- [ ] Every shot advances setup, escalation, reveal/payoff, or final beat.
- [ ] Character, product, wardrobe, landmark, and prop anchors match the ledger.
- [ ] Story-state changes occur on screen or are intentionally motivated between shots.
- [ ] Eyelines, travel direction, handedness, and object transfers cut coherently.
- [ ] Palette and lighting evolve only where the story calls for change.
- [ ] Lens choice and camera motion follow the shared grammar; novelty does not displace clarity.
- [ ] Product appearance and supplied wording remain faithful and readable when required.
- [ ] No visual artifact distracts from the subject, action, or emotional beat.
- [ ] Timeline order, trims, pacing, and transitions preserve the planned arc.
- [ ] Composed frames and playback confirm the result is ready for user review or export.