# Beat Density

Density is the main artistic control in a beat edit, and it is a property of the
whole piece. Deciding it per-cut produces a metronome edit: technically on beat,
mechanically flat.

## 1. Read the music's structure first

Before choosing any cut point, get the section map. Typical shape:

| Section | Role in the edit | Default density |
|---|---|---|
| Intro | Establish, hook | sparse — one or two hits, let the viewer orient |
| Verse | Context, information | sparse to medium |
| Build / pre-chorus | Escalation | medium, accelerating |
| Drop / chorus | Payoff | dense, but only as long as the material holds |
| Breakdown | Reset | rest — hold shots, stop cutting |
| Outro | Resolve | sparse, land the final hit cleanly |

The density arc should look like the energy curve of the track. An edit that is
dense from second one has nowhere to go.

## 2. The four density levels

| Level | Cut on | Shots per 4 beats | Feels like |
|---|---|---|---|
| `rest` | section boundary only | 1 or fewer | Deliberate, lets a moment breathe |
| `sparse` | downbeats | 1 | Calm, readable, good for information |
| `medium` | downbeats + off-beats | 2 | Forward motion without pressure |
| `dense` | every beat | 4 | High energy; fatiguing past ~8 seconds |

`dense` is a spice, not a setting. Past roughly eight continuous seconds it
stops reading as energy and starts reading as noise.

## 3. Anchors first

An anchor is a cut that must land on a specific musical event because the
**content** has impact there — a product reveal, a jump, an impact frame, a
lyric that means something.

Plan 3–6 anchors before filling anything else:

- Put one on the first downbeat of the drop or chorus.
- Put one on the section boundary into the payoff.
- Put the strongest visual on the strongest musical event, not merely on an early one.

Everything between anchors is connective rhythm. Fill it at the section's
density, then stop. An edit built anchor-first reads as intentional; an edit
built by filling every beat reads as generated.

## 4. Breathing room

Rule of thumb: **at least one held shot per 15 seconds**, longer than the
surrounding cuts, where the edit deliberately stops cutting.

Why it matters:

- It resets attention, so the next dense passage lands harder.
- It gives the viewer time to read what they just saw.
- Without it, every cut is equally weighted, which means nothing is emphasised.

Place a breath right before a drop. The contrast is what makes the drop feel
like a drop.

## 5. When to break the grid

Deliberately hold across beats when:

- The shot contains an action that needs to complete (a pour, a turn, a landing).
- The shot carries information the viewer must read (text on screen, a product detail).
- The music has a sustained note or a vocal line that the cutting would chop.

Deliberately cut off-grid when:

- The action onset does not align with the beat — cut on the action, and let the beat be approximate. A visible action landing cleanly beats an invisible beat landing exactly.
- Syncing to a lyric or a sound effect rather than to the rhythm section.

## 6. Capacity check against the material

Density is capped by the material, not by the music:

```
max_sustainable_dense_seconds = usable_onset_shots / (shots_per_second_at_dense)
```

If the plan needs 20 dense seconds and the pool has 12 usable onset shots, the
honest options are to lower the density, extend the pool, or accept repetition.
Repetition in a beat edit is very visible — say so before shipping it rather
than after.
