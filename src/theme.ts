// ChatCut theme tokens — values lifted from the real editor's design tokens
// (root bundle `--surface-*` / `--tl-*`, oklch converted to hex).
export const theme = {
  bg: '#101010', // editor void / timeline background
  panel: '#181818', // measured --surface-base in the source editor
  panelAlt: '#212121', // --surface-raised (cards, chat bubbles, popovers, hover)
  border: '#363636', // measured source panel separator
  borderLight: '#4a4a4a',
  text: '#e2e2e2', // --foreground
  textDim: '#808080', // source inactive text
  accent: '#dc7036', // measured export coral
  gold: '#e6ac42', // --primary (amber highlight: credits sparkle)
  select: '#3b82f6',
  // timeline surfaces (source --tl-* : subtly blue-tinted dark)
  tlTrack: '#25262b', // --tl-track-bg (lane behind clips)
  tlSidePanel: '#202126', // --tl-side-panel-bg (track-header column)
  // track-header chips
  trackVideo: '#3b4bd8', // V-track chip
  trackAudioA1: '#e8993f',
  trackAudioA2: '#3fae6a',
  // clip fills BY KIND (source --tl-item-*: video=blue, audio=green, mg=pink, text=amber)
  clipVideo: '#2d7fb5', // --tl-item-video
  clipAudio: '#2f9e5a', // --tl-item-audio
  clipMg: '#c14d86', // --tl-item-motion-graph
  clipText: '#c8912f', // --tl-item-text
} as const;
