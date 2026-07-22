# Official generation API documentation

Use these primary sources when a provider changes. The server boundary must keep provider-only fields isolated rather than forwarding a shared superset.

## Image

- OpenAI Images generate: https://developers.openai.com/api/reference/resources/images/methods/generate/
- OpenAI Images edit: https://developers.openai.com/api/reference/resources/images/methods/edit/
- OpenAI GPT Image 2 model: https://developers.openai.com/api/docs/models/gpt-image-2
- Google Gemini image generation: https://ai.google.dev/gemini-api/docs/image-generation
- MiniMax text-to-image: https://platform.minimax.io/docs/api-reference/image-generation-t2i
- MiniMax image-to-image: https://platform.minimax.io/docs/api-reference/image-generation-i2i

## Video

- BytePlus ModelArk Seedance generate video: https://docs.byteplus.com/en/docs/modelark/1520757
- Kling developer quick start: https://app.klingai.com/global/dev/document-api/quickStart/userManual
- MiniMax text-to-video: https://platform.minimax.io/docs/api-reference/video-generation-t2v
- MiniMax image-to-video: https://platform.minimax.io/docs/api-reference/video-generation-i2v
- MiniMax first/last-frame video: https://platform.minimax.io/docs/api-reference/video-generation-fl2v
- MiniMax subject-reference video: https://platform.minimax.io/docs/api-reference/video-generation-s2v

## Music, speech, and sound

- Mureka API documentation: https://platform.mureka.ai/docs/
- MiniMax music generation: https://platform.minimax.io/docs/api-reference/music-generation
- MiniMax T2A HTTP: https://platform.minimax.io/docs/api-reference/speech-t2a-http
- ElevenLabs text-to-speech: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
- ElevenLabs sound effects: https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert

## Intentional transport choices

- OpenChatCut polls generation jobs, so provider callback URLs are not exposed to the agent.
- Provider streaming may be used only when the adapter can still persist a complete local asset. Mureka streaming phase is accepted but final files are polled. MiniMax TTS streaming is consumed server-side and persisted; MiniMax music uses non-streaming URL output.
- Seedance reference videos and MiniMax image subject references require provider-fetchable HTTPS URLs. OpenChatCut creates temporary signed R2 URLs and never exposes storage credentials.
