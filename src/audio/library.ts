// Audio asset library (music / SFX the user can drop onto A1/A2).
// Files live in public/audio/ and are served at /audio/*.
// Source: SoundHelix (www.soundhelix.com) — free to use with attribution;
// trimmed to 20s clips for the demo. Swap in your own assets freely.

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
