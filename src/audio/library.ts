// Demo / agent seed audio assets (BGM + sample VO) — NOT the Library "Audio" tab.
// 库背景音乐清单(Audio FX/人声隔离已下线)。
// SFX live in soundLibrary.ts (音效 tab). Product audio: assets/audio|media (URL /audio|/media).

export interface AudioAsset {
  id: string;
  name: string;
  category: 'music' | 'sfx' | 'voice';
  src: string; // public path, e.g. /audio/track-1.mp3
  durationInFrames: number; // at the project fps (30)
}

const SEC = 30; // project fps

export const AUDIO_ASSETS: AudioAsset[] = [
  { id: 'aud_voice_wildfires', name: '口播·加拿大山火(45s)', category: 'voice', src: '/media/speech-sample.mp3', durationInFrames: 45 * SEC },
  { id: 'aud_groove', name: 'Ambient Groove', category: 'music', src: '/audio/track-1.mp3', durationInFrames: 20 * SEC },
  { id: 'aud_drive', name: 'Upbeat Drive', category: 'music', src: '/audio/track-2.mp3', durationInFrames: 20 * SEC },
  { id: 'aud_pulse', name: 'Cinematic Pulse', category: 'music', src: '/audio/track-3.mp3', durationInFrames: 20 * SEC },
];
