// 服务端插件装配(单一真源):本机共享存储 + key-gated connect 中间件及各自的 keystore
// getter 配置,从 vite.config.ts 原样抽出。两种宿主共用同一份装配,保证 API 面一致:
//   - vite.config.ts        → dev server(vite 挂载)
//   - desktop/embedded-server.ts → Electron 生产壳(桩子挂载)
// getter 即时读 keystore——设置面板保存后下一请求生效,无需重启。
import type { Plugin } from 'vite';
import { projectStorePlugin } from './project-store.ts';
import { extensionStorePlugin } from './extension-store.ts';
import { exportPlugin } from './export.ts';
import { exportQaPlugin } from './export-qa.ts';
import { uploadPlugin } from './upload.ts';
import { uploadMultipartPlugin } from './upload-multipart.ts';
import { extractAudioPlugin } from './extract-audio.ts';
import { extractFramesPlugin } from './extract-frames.ts';
import { sceneDetectionPlugin } from './scene-detection.ts';
import { mediaPreviewPlugin } from './media-preview.ts';
import { isolateVoicePlugin } from './isolate-voice.ts';
import { normalizeMediaPlugin } from './normalize-media.ts';
import { imageGenerationPlugin } from './image.ts';
import { voiceGenerationPlugin } from './voice.ts';
import { soundGenerationPlugin } from './sound.ts';
import { musicGenerationPlugin } from './music.ts';
import { videoGenerationPlugin } from './video.ts';
import { e2bPlugin } from './e2b.ts';
import { subtitleExportPlugin } from './subtitles.ts';
import { generationProgressPlugin } from './generation-jobs.ts';
import { stockSearchPlugin } from './stock.ts';
import { firecrawlPlugin } from './firecrawl.ts';
import { settingsPlugin } from './settings.ts';
import { externalAgentPlugin } from './external-agent.ts';
import { llmProxyPlugin } from './llm-proxy.ts';
import { getKey } from '../keystore.ts';

export function serverPlugins(): Plugin[] {
  return [llmProxyPlugin(), projectStorePlugin(), extensionStorePlugin(), externalAgentPlugin(), settingsPlugin(), exportPlugin(), exportQaPlugin(), uploadMultipartPlugin(), uploadPlugin(), extractAudioPlugin(), extractFramesPlugin(), sceneDetectionPlugin(), mediaPreviewPlugin(), isolateVoicePlugin(), normalizeMediaPlugin(), imageGenerationPlugin({
    get baseUrl() { return getKey('IMAGE_BASE_URL') || 'https://api.openai.com'; },
    get apiKey() { return getKey('IMAGE_API_KEY') || getKey('OPENAI_API_KEY'); },
    get geminiBaseUrl() { return getKey('GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com'; },
    get geminiApiKey() { return getKey('GEMINI_API_KEY'); },
    get geminiModel() { return getKey('GEMINI_IMAGE_MODEL') || 'gemini-3.1-flash-image'; },
    get minimaxBaseUrl() { return getKey('MINIMAX_BASE_URL') || 'https://api.minimaxi.com'; },
    get minimaxApiKey() { return getKey('MINIMAX_API_KEY'); },
    get minimaxModel() { return getKey('MINIMAX_IMAGE_MODEL') || 'image-01'; },
  }), voiceGenerationPlugin({
    get elevenBaseUrl() { return getKey('ELEVENLABS_BASE_URL') || 'https://api.elevenlabs.io'; },
    get elevenApiKey() { return getKey('ELEVENLABS_API_KEY'); },
    get elevenModel() { return getKey('ELEVENLABS_TTS_MODEL') || 'eleven_multilingual_v2'; },
    get doubaoBaseUrl() { return getKey('DOUBAO_TTS_BASE_URL') || 'https://openspeech.bytedance.com'; },
    get doubaoAppId() { return getKey('DOUBAO_TTS_APP_ID'); },
    get doubaoAccessKey() { return getKey('DOUBAO_TTS_ACCESS_KEY'); },
    get doubaoResourceId() { return getKey('DOUBAO_TTS_RESOURCE_ID') || 'seed-tts-2.0'; },
    get minimaxBaseUrl() { return getKey('MINIMAX_BASE_URL') || 'https://api.minimaxi.com'; },
    get minimaxApiKey() { return getKey('MINIMAX_API_KEY'); },
    get minimaxModel() { return getKey('MINIMAX_TTS_MODEL') || 'speech-2.6-hd'; },
  }), soundGenerationPlugin({ get baseUrl() { return getKey('ELEVENLABS_BASE_URL') || 'https://api.elevenlabs.io'; }, get apiKey() { return getKey('ELEVENLABS_API_KEY'); }, get model() { return getKey('ELEVENLABS_SOUND_MODEL') || 'eleven_text_to_sound_v2'; } }),
  musicGenerationPlugin({
    get baseUrl() { return getKey('MUREKA_BASE_URL') || 'https://api.mureka.ai'; }, get apiKey() { return getKey('MUREKA_API_KEY'); }, get model() { return getKey('MUREKA_MUSIC_MODEL') || 'auto'; },
    get minimaxBaseUrl() { return getKey('MINIMAX_BASE_URL') || 'https://api.minimaxi.com'; },
    get minimaxApiKey() { return getKey('MINIMAX_API_KEY'); },
    get minimaxModel() { return getKey('MINIMAX_MUSIC_MODEL') || 'music-2.6'; },
  }),
  videoGenerationPlugin({
    get seedanceBaseUrl() { return getKey('SEEDANCE_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3'; }, get seedanceApiKey() { return getKey('SEEDANCE_API_KEY'); }, get seedanceModel() { return getKey('SEEDANCE_VIDEO_MODEL') || 'doubao-seedance-2-0-260128'; },
    get klingBaseUrl() { return getKey('KLING_BASE_URL') || 'https://api-singapore.klingai.com'; }, get klingApiKey() { return getKey('KLING_API_KEY'); }, get klingModel() { return getKey('KLING_VIDEO_MODEL') || 'kling-v3-omni'; },
    get minimaxBaseUrl() { return getKey('MINIMAX_BASE_URL') || 'https://api.minimaxi.com'; },
    get minimaxApiKey() { return getKey('MINIMAX_API_KEY'); },
    get minimaxModel() { return getKey('MINIMAX_VIDEO_MODEL') || 'MiniMax-Hailuo-02'; },
  }),
  generationProgressPlugin(),
  subtitleExportPlugin(),
  stockSearchPlugin({
    get pexelsApiKey() { return getKey('PEXELS_API_KEY'); },
    get pixabayApiKey() { return getKey('PIXABAY_API_KEY'); },
    get unsplashAccessKey() { return getKey('UNSPLASH_ACCESS_KEY'); },
    get freesoundApiKey() { return getKey('FREESOUND_API_KEY'); },
    get firecrawlApiKey() { return getKey('FIRECRAWL_API_KEY'); },
  }),
  firecrawlPlugin({ get apiKey() { return getKey('FIRECRAWL_API_KEY'); } }),
  e2bPlugin({ get apiKey() { return getKey('E2B_API_KEY'); }, get template() { return getKey('E2B_TEMPLATE') || undefined; } }),
  ];
}
