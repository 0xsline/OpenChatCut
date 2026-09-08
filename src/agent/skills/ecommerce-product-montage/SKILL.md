---
name: ecommerce-product-montage
description: |
  Assemble product footage, UGC, and b-roll into a conversion-oriented montage with a hook → pain → demo → proof → CTA rhythm.
  Use for 带货混剪, 产品混剪, 商品短视频, 种草视频, ecommerce montage, product reel, UGC cutdown, or when the user wants selling footage cut into a short that converts.
---

# Ecommerce Product Montage

Use this workflow when the goal is a short that *sells*, not just one that looks
good. The failure mode to avoid is a pretty montage with no sales spine: strong
footage, pleasant cuts, and zero reason for the viewer to act.

This workflow decides **structure and sequencing** for selling footage. It does
not write the ad copy — when the hook, angles, or CTA text are not given, hand
off to `product-ad-video-script` for the script, then come back here to assemble.
It does not re-explain music tooling — for beat-driven placement use
`beat-sync-montage` or `music-intelligence`.

This is a OpenChatCut-native workflow. Use the current project, source assets,
asset-frame inspection, AV/script context, and OpenChatCut editing tools.

## When to switch workflows

- No script yet, only a product/offer → `product-ad-video-script` first, return here to cut.
- Music should drive the cut placement → `beat-sync-montage` (and `music-intelligence` for tools).
- Many clips, no selling intent, just the strongest cut → `multi-clips-to-reels`.
- N distinct selling variants from one pool → `batch-montage-variants`, using this workflow per cut.

## Workflow

1. Fix the one job the edit must do: which objection it dissolves or which action it drives (save, tap, buy, follow). If the brief names none, propose one and confirm.
2. Inventory the material by sales role, not by file: hero demo, UGC reaction, proof (review/result), context b-roll, price/offer card. See [references/material-roles.md](references/material-roles.md). Footage that fills no role is parked, not force-inserted.
3. Lay the sales spine before cutting: hook (0–3s, the open loop) → pain/context → demo → proof → CTA. See [references/sales-spine.md](references/sales-spine.md). Every beat maps to a spine position; a clip with no spine position is cut.
4. Lead with the hook from a real moment, not a title card. The first three seconds either open a loop ("you are doing X wrong") or show the payoff; a logo sting as opener loses the scroll.
5. Place the demo where the viewer is curious, not where the script says "demo." Demo proves the hook; if the hook is a result, demo the path to it.
6. Insert proof as a pattern interrupt, not a block. One real review line or result frame beats a stacked proof montage. See [references/proof-placement.md](references/proof-placement.md).
7. Hold the CTA long enough to read. Price, offer, and the exact action each get a legible beat; a CTA flashed for one cut is a CTA nobody acts on.
8. Keep claims grounded. Do not manufacture prices, guarantees, medical, or earnings claims the assets do not support. Pull offer text from the product page or user notes; if absent, ask.
9. QA by the spine, not by the cut list: can a cold viewer state the offer and the action after watching once? If not, the edit sells nothing.
10. Report the spine coverage and any role with no usable footage, so a thin section is flagged before shipping.

## Plan Format

- The one job this edit does
- Material inventory by role, with what is missing
- Spine map: timestamp → spine position → which clip → why it earns that slot
- Hook type (open loop / payoff) and the moment used
- Proof placement and the interrupt it creates
- CTA beats: price, offer, action, each with duration
- Risks: ungrounded claims, thin demo, CTA too short, hook that does not land

## Rules

- **Spine over polish.** A serviceable cut in the right spine position beats a beautiful cut that breaks the argument.
- **Hook is a moment, not a card.** Open on footage that creates tension or shows the result; title cards come later if at all.
- **One job per edit.** An edit trying to handle every objection handles none. Pick the one that converts this audience.
- **Proof interrupts, it does not pile.** One credible proof point lands harder than five weak ones.
- **CTA must be legible.** Price, offer, and action each get a readable beat; never flash the CTA.
- **Claims stay grounded.** No invented price, guarantee, medical, or earnings claim. Ask when the asset is silent.
- **Park, do not force.** Footage that fits no spine position weakens the edit; leave it out and say so.
