// Server-side plugin assembly (single source of truth): native shared storage + key-gated connect middleware and respective keystores
// Getter configuration, extracted from config/vite.config.ts as is. The two hosts share the same assembly and ensure the same API:
// - config/vite.config.ts → dev server(vite mount)
// - desktop/embedded-server.ts → Electron production shell (stub mounting)
// Getter reads keystore immediately - the next request will take effect after the setting panel is saved, no need to restart.
import type { Plugin } from "vite";
import { crossOriginIsolationPlugin } from "./cross-origin-isolation.ts";
import { storageLifecyclePlugin } from './storage-lifecycle.ts';
import { projectStorePlugin } from "./project-store-plugin.ts";
import { extensionStorePlugin } from "./extension-store.ts";
import { exportPlugin } from "./export.ts";
import { exportQaPlugin } from "./export-qa.ts";
import { exportDestinationPlugin } from "./export-destination.ts";
import { exportStagePlugin } from "./export-stage.ts";
import { uploadPlugin } from "./upload.ts";
import { mobileUploadPlugin } from "./mobile-upload.ts";
import { uploadMultipartPlugin } from "./upload-multipart.ts";
import { extractAudioPlugin } from "./extract-audio.ts";
import { hfProxyPlugin } from "./hf-proxy.ts";
import { asrModelsPlugin } from "./asr-models.ts";
import { modelPacksPlugin } from "./model-packs.ts";
import { assemblyAiUploadPlugin } from "./assemblyai-upload.ts";
import { transcriptionPlugin } from "./transcription.ts";
import { extractFramesPlugin } from "./extract-frames.ts";
import { sceneDetectionPlugin } from "./scene-detection.ts";
import { autoGradePlugin } from "./auto-grade.ts";
import { mediaPreviewPlugin } from "./media-preview.ts";
import { isolateVoicePlugin } from "./isolate-voice.ts";
import { normalizeMediaPlugin } from "./normalize-media.ts";
import { imageGenerationPlugin } from "./image.ts";
import { voiceGenerationPlugin } from "./voice.ts";
import { aiVoiceOptions, transcriptionOptions } from "./media-provider-config.ts";
import { soundGenerationPlugin } from "./sound.ts";
import { musicGenerationPlugin } from "./music.ts";
import { videoGenerationPlugin } from "./video.ts";
import { e2bPlugin } from "./e2b.ts";
import { subtitleExportPlugin } from "./subtitles.ts";
import { generationProgressPlugin } from "./generation-jobs.ts";
import { stockSearchPlugin } from "./stock.ts";
import { firecrawlPlugin } from "./firecrawl.ts";
import { settingsPlugin } from "./settings.ts";
import { skillFilesPlugin } from "./skill-files.ts";
import { skillInstallPlugin } from "./skill-install.ts";
import { skillExecPlugin } from "./skill-exec.ts";
import { externalAgentPlugin } from "./external-agent.ts";
import { codexAgentPlugin } from "./codex-agent.ts";
import { xaiOauthPlugin } from "./xai-oauth.ts";
import { llmProxyPlugin } from "./llm-proxy.ts";
import { agentRunsPlugin } from "../agent-runs/routes.ts";
import { resourcePreviewPlugin } from "./resource-preview.ts";
import { getKey } from "../keystore.ts";

import { installSystemProxy } from '../net.ts';
import { requestShapeGatePlugin } from './request-shape-gate';

export function serverPlugins(options: { projectStoreHttp?: boolean } = {}): Plugin[] {
  installSystemProxy();
  return [
    requestShapeGatePlugin(),
    crossOriginIsolationPlugin(),
    storageLifecyclePlugin(),
    llmProxyPlugin(),
    xaiOauthPlugin(),
    agentRunsPlugin(),
    skillFilesPlugin(),
    skillInstallPlugin(),
    skillExecPlugin(),
    resourcePreviewPlugin({
      get token() {
        return getKey("RESOURCE_PREVIEW_TOKEN");
      },
    }),
    projectStorePlugin({ http: options.projectStoreHttp }),
    extensionStorePlugin(),
    externalAgentPlugin(),
    codexAgentPlugin(),
    settingsPlugin(),
    exportStagePlugin(),
    exportPlugin(),
    exportDestinationPlugin(),
    exportQaPlugin(),
    uploadMultipartPlugin(),
    uploadPlugin(),
    mobileUploadPlugin(),
    extractAudioPlugin(),
    hfProxyPlugin(),
    asrModelsPlugin(),
    modelPacksPlugin(),
    assemblyAiUploadPlugin(),
    transcriptionPlugin(transcriptionOptions()),
    extractFramesPlugin(),
    sceneDetectionPlugin(),
    autoGradePlugin(),
    mediaPreviewPlugin(),
    isolateVoicePlugin(),
    normalizeMediaPlugin(),
    imageGenerationPlugin({
      get baseUrl() {
        return getKey("IMAGE_BASE_URL") || "https://api.openai.com";
      },
      get apiKey() {
        return getKey("IMAGE_API_KEY") || getKey("OPENAI_API_KEY");
      },
      get geminiBaseUrl() {
        return (
          getKey("GEMINI_BASE_URL") ||
          "https://generativelanguage.googleapis.com"
        );
      },
      get geminiApiKey() {
        return getKey("GEMINI_API_KEY");
      },
      get geminiModel() {
        return getKey("GEMINI_IMAGE_MODEL") || "gemini-3.1-flash-image";
      },
      get minimaxBaseUrl() {
        return getKey("MINIMAX_BASE_URL") || "https://api.minimaxi.com";
      },
      get minimaxApiKey() {
        return getKey("MINIMAX_API_KEY");
      },
      get minimaxModel() {
        return getKey("MINIMAX_IMAGE_MODEL") || "image-01";
      },
      get waveSpeedBaseUrl() {
        return getKey("WAVESPEED_BASE_URL") || "https://api.wavespeed.ai";
      },
      get waveSpeedApiKey() {
        return getKey("WAVESPEED_API_KEY");
      },
      get waveSpeedModel() {
        return getKey("WAVESPEED_IMAGE_MODEL") || "wavespeed-ai/flux-dev";
      },
      get byteplusBaseUrl() {
        return getKey("BYTEPLUS_BASE_URL") || "https://ark.ap-southeast.bytepluses.com/api/v3";
      },
      get byteplusApiKey() {
        return getKey("BYTEPLUS_API_KEY");
      },
      get byteplusModel() {
        return getKey("BYTEPLUS_IMAGE_MODEL") || "seedream-4-5-251128";
      },
    }),
    voiceGenerationPlugin({
      get elevenBaseUrl() {
        return getKey("ELEVENLABS_BASE_URL") || "https://api.elevenlabs.io";
      },
      get elevenApiKey() {
        return getKey("ELEVENLABS_API_KEY");
      },
      get elevenModel() {
        return getKey("ELEVENLABS_TTS_MODEL") || "eleven_multilingual_v2";
      },
      get doubaoBaseUrl() {
        return (
          getKey("DOUBAO_TTS_BASE_URL") || "https://openspeech.bytedance.com"
        );
      },
      get doubaoAppId() {
        return getKey("DOUBAO_TTS_APP_ID");
      },
      get doubaoAccessKey() {
        return getKey("DOUBAO_TTS_ACCESS_KEY");
      },
      get doubaoResourceId() {
        return getKey("DOUBAO_TTS_RESOURCE_ID") || "seed-tts-2.0";
      },
      get minimaxBaseUrl() {
        return getKey("MINIMAX_BASE_URL") || "https://api.minimaxi.com";
      },
      get minimaxApiKey() {
        return getKey("MINIMAX_API_KEY");
      },
      get minimaxModel() {
        return getKey("MINIMAX_TTS_MODEL") || "speech-2.6-hd";
      },
      get inworldBaseUrl() {
        return getKey("INWORLD_TTS_BASE_URL") || "https://api.inworld.ai";
      },
      get inworldApiKey() {
        return getKey("INWORLD_TTS_API_KEY");
      },
      get inworldModel() {
        return getKey("INWORLD_TTS_MODEL") || "inworld-tts-2";
      },
      get fishAudioBaseUrl() {
        return getKey("FISHAUDIO_TTS_BASE_URL") || "https://api.fish.audio";
      },
      get fishAudioApiKey() {
        return getKey("FISHAUDIO_TTS_API_KEY");
      },
      get fishAudioModel() {
        return getKey("FISHAUDIO_TTS_MODEL") || "s2.1-pro";
      },
      get speechifyBaseUrl() {
        return getKey("SPEECHIFY_TTS_BASE_URL") || "https://api.sws.speechify.com";
      },
      get speechifyApiKey() {
        return getKey("SPEECHIFY_TTS_API_KEY");
      },
      get speechifyModel() {
        return getKey("SPEECHIFY_TTS_MODEL") || "simba-multilingual";
      },
      ai: aiVoiceOptions(),
    }),
    soundGenerationPlugin({
      get baseUrl() {
        return getKey("ELEVENLABS_BASE_URL") || "https://api.elevenlabs.io";
      },
      get apiKey() {
        return getKey("ELEVENLABS_API_KEY");
      },
      get model() {
        return getKey("ELEVENLABS_SOUND_MODEL") || "eleven_text_to_sound_v2";
      },
      get soniloBaseUrl() {
        return getKey("SONILO_BASE_URL") || "https://api.sonilo.com";
      },
      get soniloApiKey() {
        return getKey("SONILO_API_KEY");
      },
    }),
    musicGenerationPlugin({
      get baseUrl() {
        return getKey("MUREKA_BASE_URL") || "https://api.mureka.ai";
      },
      get apiKey() {
        return getKey("MUREKA_API_KEY");
      },
      get model() {
        return getKey("MUREKA_MUSIC_MODEL") || "auto";
      },
      get minimaxBaseUrl() {
        return getKey("MINIMAX_BASE_URL") || "https://api.minimaxi.com";
      },
      get minimaxApiKey() {
        return getKey("MINIMAX_API_KEY");
      },
      get minimaxModel() {
        return getKey("MINIMAX_MUSIC_MODEL") || "music-2.6";
      },
      get atlasBaseUrl() {
        return getKey("ATLASCLOUD_API_BASE") || "https://api.atlascloud.ai/api/v1";
      },
      get atlasApiKey() {
        return getKey("ATLASCLOUD_API_KEY");
      },
      get atlasModel() {
        return getKey("ATLASCLOUD_MUSIC_MODEL") || "minimax/music-2.6";
      },
      get soniloBaseUrl() {
        return getKey("SONILO_BASE_URL") || "https://api.sonilo.com";
      },
      get soniloApiKey() {
        return getKey("SONILO_API_KEY");
      },
    }),
    videoGenerationPlugin({
      get seedanceBaseUrl() {
        return (
          getKey("SEEDANCE_BASE_URL") ||
          "https://ark.cn-beijing.volces.com/api/v3"
        );
      },
      get seedanceApiKey() {
        return getKey("SEEDANCE_API_KEY");
      },
      get seedanceModel() {
        return getKey("SEEDANCE_VIDEO_MODEL") || "doubao-seedance-2-0-260128";
      },
      get klingBaseUrl() {
        return getKey("KLING_BASE_URL") || "https://api-singapore.klingai.com";
      },
      get klingApiKey() {
        return getKey("KLING_API_KEY");
      },
      get klingModel() {
        return getKey("KLING_VIDEO_MODEL") || "kling-v3-omni";
      },
      get minimaxBaseUrl() {
        return getKey("MINIMAX_BASE_URL") || "https://api.minimaxi.com";
      },
      get minimaxApiKey() {
        return getKey("MINIMAX_API_KEY");
      },
      get minimaxModel() {
        return getKey("MINIMAX_VIDEO_MODEL") || "MiniMax-Hailuo-02";
      },
      get byteplusBaseUrl() {
        return getKey("BYTEPLUS_BASE_URL") || "https://ark.ap-southeast.bytepluses.com/api/v3";
      },
      get byteplusApiKey() {
        return getKey("BYTEPLUS_API_KEY");
      },
      get byteplusModel() {
        return getKey("BYTEPLUS_VIDEO_MODEL") || "seedance-1-5-pro-251215";
      },
    }),
    generationProgressPlugin(),
    subtitleExportPlugin(),
    stockSearchPlugin({
      get pexelsApiKey() {
        return getKey("PEXELS_API_KEY");
      },
      get pixabayApiKey() {
        return getKey("PIXABAY_API_KEY");
      },
      get unsplashAccessKey() {
        return getKey("UNSPLASH_ACCESS_KEY");
      },
      get freesoundApiKey() {
        return getKey("FREESOUND_API_KEY");
      },
      get firecrawlApiKey() {
        return getKey("FIRECRAWL_API_KEY");
      },
    }),
    firecrawlPlugin({
      get apiKey() {
        return getKey("FIRECRAWL_API_KEY");
      },
    }),
    e2bPlugin({
      get apiKey() {
        return getKey("E2B_API_KEY");
      },
      get template() {
        return getKey("E2B_TEMPLATE") || undefined;
      },
    }),
  ];
}
