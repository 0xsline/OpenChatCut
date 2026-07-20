# MiniMax TTS (`provider: "minimax"`)

Read this before `submit_voice({ provider: "minimax", … })`.

Grounded in OpenChatCut’s voice tool + server adapter (`server/plugins/voice.ts` → MiniMax `t2a_v2`). Preset table: [voices.md](voices.md) § MiniMax.

## Capabilities (as wired)

| Dimension | Value |
| --- | --- |
| Provider arg | `minimax` |
| Text | Required |
| `voiceId` | Required — system voices (`female-yujie` default if empty) or raw/cloned MiniMax id |
| `speed` | Optional, **0.5–2** (default 1) → `voice_setting.speed` |
| `pitch` | Optional, **-12–12** (default 0) → native `voice_setting.pitch` |
| `volume` | Optional, **0–10** (default 1) → `voice_setting.vol` |
| `emotion` | Optional: happy, sad, angry, fearful, disgusted, surprised, calm, fluent, whisper |
| Other knobs | **Rejected** — no Doubao/ElevenLabs-only fields |
| Placement | **Media pool only** — does not place on the timeline |

## When to use

- MiniMax key is configured and the user wants MiniMax TTS.
- User named MiniMax speech (as distinct from Doubao / ElevenLabs).
- Only MiniMax voice capability is on.

## When not to use

- Need Doubao dialect / `performancePrompt` → `doubao`
- Need ElevenLabs multilingual catalog → `elevenlabs`
- User has not picked a voice → offer candidates from [voices.md](voices.md) first

## Tool shape

```ts
submit_voice({
  provider: "minimax",
  text: "……",
  voiceId: "female-yujie",
  speed: 1,
  pitch: 0,
  volume: 1,
  emotion: "calm", // optional
  name: "VO · intro",
});
```

Then place with `edit_item` only if the user wants it on a track.

## Rules

- Never mix MiniMax `voiceId` values with `provider: "doubao"` or `"elevenlabs"`.
- Confirm a concrete `voiceId` before submit.
- Check capabilities: if MiniMax voice is off, say which key is missing.
