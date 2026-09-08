# Shot Fitness for Beat Edits

Most footage that gets forced into a beat edit was never suitable for one. Check
fitness before planning, because no amount of accurate beat alignment rescues
unsuitable material.

## 1. What makes a shot cuttable on a beat

A shot works in a beat edit when it has a **legible onset** — something the
viewer can see begin. Score each candidate:

| Signal | Good | Poor |
|---|---|---|
| Motion onset | Clear start: a hand enters frame, a jump launches, a door opens | Ambiguous: slow drift, continuous ambient movement |
| Subject framing | Subject readable within ~0.5s | Needs a second to parse what is on screen |
| Motion axis | One dominant direction | Motion scattered or chaotic |
| Duration | Long enough to trim to the slot with margin | Already shorter than the slot |
| Contrast against neighbours | Visually distinct from adjacent shots | Nearly identical to the shot before it |

A shot can fail one signal and still be usable. Two or more failures means it
should be replaced, not cut harder.

## 2. Fast BPM is not a licence

High BPM tracks demand more cuts per second, which demands more usable onset
shots. Before committing to a dense plan, count them:

```
shots_needed ≈ (section_seconds / 60) × BPM × (cuts_per_beat)
```

A 140 BPM track at dense (1 cut per beat) needs ~2.3 shots per second — roughly
28 shots for a 12-second chorus. If the pool has 15 usable onset shots, the
chorus cannot be dense. Lower the density, extend the pool, or accept visible
repetition and tell the user.

## 3. Motion continuity across cuts

Consecutive cuts should not fight each other:

- **Screen direction.** A subject moving left followed by a subject moving right reads as a collision. Either match direction or make the reversal deliberate and rare.
- **Motion axis.** Cutting between horizontal motion and vertical motion in quick succession is jarring unless the beat is strong enough to justify it.
- **Scale jumps.** Extreme close-up to wide and back, repeatedly, reads as strobing rather than rhythm.
- **Luminance flashes.** Alternating very bright and very dark shots at high frequency is physically uncomfortable. Watch for it specifically.

These are the checks that separate a professional beat edit from a generated
one. They are also the ones that only show up when watching the cut, not when
reviewing the cut list.

## 4. Holding a shot is a legitimate choice

When a shot is the strongest available and the section is dense, prefer holding
it across two beats over cutting to a weaker shot just to satisfy the grid. One
strong held shot reads as confidence; two weak cuts read as filler.

## 5. Red flags

Stop and reconsider when:

- More than a third of planned cuts land on shots with no visible onset.
- The same shot appears more than twice in a single section.
- Consecutive shots are near-identical framings of the same subject.
- The cut list is perfectly regular — every cut exactly N beats apart. Real edits have shape; a perfectly regular list is usually a sign the content was ignored.
- You cannot say what a given cut is for.
