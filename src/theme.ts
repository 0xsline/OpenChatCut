// Theme tokens. Since the skinning system (see skins.ts), all here are var(--cc-*)
// Indirect reference - the true value is in the SKINS registry in skins.ts (default skin "Graphite",
// Consistent with old hex value-wise). Inline styles are still written as theme.x, with zero modification and zero re-rendering when changing skins.
// ⚠ These values can only be used in DOM style/CSS:canvas fillStyle, SVG attribute bits, and hex string concatenation
// None of them can parse var() (the entire position has been audited to zero, and the new code has set a precedent).
export const theme = {
  bg: 'var(--cc-bg)', // editor void / timeline background
  inset: 'var(--cc-inset)', // Inner groove (input well)
  panel: 'var(--cc-panel)', // Base editor surface.
  panelAlt: 'var(--cc-panel-alt)', // --surface-raised (cards, chat bubbles, popovers, hover)
  hover: 'var(--cc-hover)', // Row hover/activate fill
  border: 'var(--cc-border)', // Panel separator.
  borderLight: 'var(--cc-border-light)',
  text: 'var(--cc-text)', // --foreground
  textMuted: 'var(--cc-text-muted)', // secondary text
  textDim: 'var(--cc-text-dim)', // Inactive text.
  textStrong: 'var(--cc-text-strong)', // Highlight text on hover
  accent: 'var(--cc-accent)', // measured export coral
  accentDeep: 'var(--cc-accent-deep)', // accent press / bottom of main button
  onAccent: 'var(--cc-on-accent)', // accent text on fill (pastel skin = dark text)
  gold: 'var(--cc-gold)', // --primary (amber highlight)
  select: 'var(--cc-select)',
  success: 'var(--cc-success)', // Tool success/completion status (same value and different synonyms as A2 rail chip, independent token)
  danger: 'var(--cc-danger)', // Errors, deletions and destructive operations
  // Timeline surfaces use subtly blue-tinted dark colors.
  tlTrack: 'var(--cc-tl-track)', // --tl-track-bg (lane behind clips)
  tlSidePanel: 'var(--cc-tl-side-panel)', // --tl-side-panel-bg (track-header column)
  // track-header chips
  trackVideo: 'var(--cc-track-video)', // V-track chip
  trackAudioA1: 'var(--cc-track-audio-a1)',
  trackAudioA2: 'var(--cc-track-audio-a2)',
  trackCaption: 'var(--cc-track-caption)',
  // Clip fills by kind: video=blue, audio=green, MG=pink, text=amber.
  clipVideo: 'var(--cc-clip-video)', // --tl-item-video
  clipAudio: 'var(--cc-clip-audio)', // --tl-item-audio
  clipMg: 'var(--cc-clip-mg)', // --tl-item-motion-graph
  clipText: 'var(--cc-clip-text)', // --tl-item-text
} as const;

const alpha = (channel: string, opacity: number): string =>
  `rgba(var(--cc-${channel}-rgb), ${opacity})`;

/** UI Translucent color.ink As the skin turns darker and lighter,shadow Always express suspended hierarchy. */
export const themeAlpha = {
  ink: (opacity: number): string => alpha('ink', opacity),
  accent: (opacity: number): string => alpha('accent', opacity),
  shadow: (opacity: number): string => alpha('shadow', opacity),
} as const;
