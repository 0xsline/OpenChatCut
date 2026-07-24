// Skinning engine: skin = a set of design token values. The tokens of theme.ts are all
// var(--cc-*) indirect reference, the true value is here in the SKINS registry; when booting, initSkins() puts all
// The skin is generated into a <style> and injected into the head, switch = change an attribute of <html data-cc-skin>,
// Hundreds of inline styles have zero changes and zero re-rendering. Persistence localStorage('cc.skin').
// Security boundary (audited): synthesis/GL/canvas do not consume theme tokens, and export and burning are not affected by the skin;
// There is no hex splicing (`$${theme.x}22`) and SVG attribute bit (fill= attribute does not parse var) in the whole warehouse.
// Translucent "ink" (--cc-ink-rgb) and accent glow (--cc-accent-rgb) with R,G,B bare triples
// Stored for use by rgba(var(--cc-ink-rgb), α) of index.css - white ink for dark skin and black ink for light skin.

export interface SkinTokens {
  bg: string;          // Editor void/timeline bottom
  inset: string;       // Inner groove (input well, bottom one level deeper)
  panel: string;       // Panel bottom
  panelAlt: string;    // card/elastic layer/suspended bottom
  hover: string;       // Row hover/activate fill
  border: string;
  borderLight: string;
  text: string;
  textMuted: string;   // Secondary text (lighter than text, brighter than dim)
  textDim: string;
  textStrong: string;  // Hover to brighten text (dark skin #fff, light skin almost black)
  accent: string;
  accentDeep: string;  // accent press / bottom of main button (#c45c26 file)
  accentRgb: string;   // "R,G,B" for glow rgba()
  /** accent Text color on fill:dark skin white characters;Pastel accent(Mocha Peach/arctic ice blue)
   * White text contrast only ~2:1,Must use deep characters(≥4.5:1,Already asserted)。 */
  onAccent: string;
  inkRgb: string;      // "R,G,B" translucent ink base color (dark skin 255,255,255)
  shadowRgb: string;   // "R,G,B" floating layer shadow/mask base color
  colorScheme: 'dark' | 'light';
  gold: string;
  select: string;
  success: string;
  danger: string;
  tlTrack: string;
  tlSidePanel: string;
  trackVideo: string;
  trackAudioA1: string;
  trackAudioA2: string;
  trackCaption: string;
  clipVideo: string;
  clipAudio: string;
  clipMg: string;
  clipText: string;
}

export interface SkinDef {
  id: string;
  nameZh: string;
  tokens: SkinTokens;
}

// Graphite = default skin (consistent with the look and feel before the skin-changing system was implemented).
const GRAPHITE: SkinTokens = {
  bg: '#101010', inset: '#141414', panel: '#181818', panelAlt: '#212121', hover: '#2c2c2c',
  border: '#363636', borderLight: '#4a4a4a',
  text: '#e2e2e2', textMuted: '#b0b0b0', textDim: '#808080', textStrong: '#ffffff',
  accent: '#dc7036', accentDeep: '#c45c26', accentRgb: '220,112,54', onAccent: '#ffffff',
  inkRgb: '255,255,255', shadowRgb: '0,0,0', colorScheme: 'dark',
  gold: '#e6ac42', select: '#3b82f6', success: '#3fae6a', danger: '#e06c60',
  tlTrack: '#25262b', tlSidePanel: '#202126',
  trackVideo: '#3b4bd8', trackAudioA1: '#e8993f', trackAudioA2: '#3fae6a', trackCaption: '#b05bd3',
  clipVideo: '#2d7fb5', clipAudio: '#2f9e5a', clipMg: '#c14d86', clipText: '#c8912f',
};

// Source of color adjustment (the user named the GitHub theme, the value is the official color palette, MIT):
// Mocha/Latte = Catppuccin(github.com/catppuccin/palette,palette.json check),
// Arctic = Nord(nordtheme.com), Tokyo Night = Tokyo Night. Graphite/Jet Black = homemade dark color.
// Discipline (impeccable colorize): Only official neutral gradients are used for the surface elevation; track/fragment/select/
// success is **semantic color**, unified across skins (inherited from graphite); text comparison text/panel ≥ 7,
// textDim/panel ≥ 4.5, onAccent/accent ≥ 4.5 (script skin-by-skin assertion, individual official grayscale
// Fine-tune L to reach the standard). Pastel accent skin (Mocha/Arctic/Tokyo Night/Latte) onAccent uses dark fonts.
export const SKINS: readonly SkinDef[] = [
  { id: 'graphite', nameZh: 'graphite', tokens: GRAPHITE },
  {
    id: 'midnight', nameZh: 'jet black',
    tokens: {
      ...GRAPHITE,
      bg: '#000000', inset: '#070707', panel: '#0b0b0b', panelAlt: '#161616', hover: '#212121',
      border: '#282828', borderLight: '#3d3d3d',
      text: '#e6e6e6', textMuted: '#ababab', textDim: '#7d7d7d',
      tlTrack: '#131417', tlSidePanel: '#0e0f11',
    },
  },
  // Catppuccin Mocha:crust/mantle/base/surface level,accent = peach color (warm tone)
  {
    id: 'mocha', nameZh: 'Mocha',
    tokens: {
      ...GRAPHITE,
      bg: '#11111b', inset: '#181825', panel: '#1e1e2e', panelAlt: '#313244', hover: '#45475a',
      border: '#45475a', borderLight: '#585b70',
      text: '#cdd6f4', textMuted: '#a6adc8', textDim: '#868ba4', textStrong: '#ffffff',
      accent: '#fab387', accentDeep: '#dc976b', accentRgb: '250,179,135', onAccent: '#11111b',
      gold: '#f9e2af', select: '#89b4fa', success: '#a6e3a1', danger: '#f38ba8',
      tlTrack: '#242436', tlSidePanel: '#1b1b2c',
    },
  },
  // Nord:polar night,accent = frost ice blue
  {
    id: 'nord', nameZh: 'arctic',
    tokens: {
      ...GRAPHITE,
      bg: '#252b37', inset: '#2a2f3b', panel: '#2e3440', panelAlt: '#3b4252', hover: '#434c5e',
      border: '#4c566a', borderLight: '#626d81',
      text: '#eceff4', textMuted: '#d8dee9', textDim: '#919cb3', textStrong: '#ffffff',
      accent: '#88c0d0', accentDeep: '#5e81ac', accentRgb: '136,192,208', onAccent: '#2e3440',
      gold: '#ebcb8b', select: '#81a1c1', success: '#a3be8c', danger: '#ef9aa2',
      tlTrack: '#3d4557', tlSidePanel: '#303745',
    },
  },
  // Tokyo Night: night level (storm as card surface), accent = logo blue
  {
    id: 'tokyo', nameZh: 'tokyo night',
    tokens: {
      ...GRAPHITE,
      bg: '#16161e', inset: '#1a1a22', panel: '#1a1b26', panelAlt: '#24283b', hover: '#292e42',
      border: '#3b4261', borderLight: '#545c7e',
      text: '#c0caf5', textMuted: '#a9b1d6', textDim: '#7f86af', textStrong: '#ffffff',
      accent: '#7aa2f7', accentDeep: '#3d59a1', accentRgb: '122,162,247', onAccent: '#16161e',
      gold: '#e0af68', select: '#7dcfff', success: '#9ece6a', danger: '#f7768e',
      tlTrack: '#1f202e', tlSidePanel: '#1c1d2a',
    },
  },
  // Catppuccin Latte: official light color (blue-gray neutral, non-cream beige), accent = peach orange
  {
    id: 'latte', nameZh: 'latte(light color)',
    tokens: {
      ...GRAPHITE,
      bg: '#dce0e8', inset: '#d3d7df', panel: '#eff1f5', panelAlt: '#e6e9ef', hover: '#d8dce4',
      // In light colors, 0.5px thin lines need to be deeper to be readable: border=surface2, borderLight=overlay1 (official level)
      border: '#acb0be', borderLight: '#8c8fa1',
      text: '#4c4f69', textMuted: '#5c5f77', textDim: '#62657b', textStrong: '#282a42',
      accent: '#fe640b', accentDeep: '#e54c00', accentRgb: '254,100,11', onAccent: '#282a42',
      inkRgb: '40,42,66', colorScheme: 'light',
      gold: '#df8e1d', select: '#1e66f5', success: '#40a02b', danger: '#b00020',
      tlTrack: '#d8dde8', tlSidePanel: '#e3e7ef',
    },
  },
];

const STORAGE_KEY = 'cc.skin';
export const DEFAULT_SKIN = 'graphite';

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function skinBlock(tokens: SkinTokens): string {
  return (Object.entries(tokens) as [string, string][])
    .map(([name, value]) => `  --cc-${kebab(name)}: ${value};`)
    .join('\n');
}

/** all skin CSS text::root = Default skin,The rest press data-cc-skin Cover. */
export function buildSkinsCss(): string {
  const base = SKINS.find((s) => s.id === DEFAULT_SKIN) ?? SKINS[0];
  const overrides = SKINS.filter((s) => s.id !== base.id)
    .map((s) => `html[data-cc-skin='${s.id}'] {\n${skinBlock(s.tokens)}\n}`)
    .join('\n');
  return `:root {\n${skinBlock(base.tokens)}\n}\n${overrides}\n` +
    // The body follows the skin background color + the color direction of the native control (the select/scroll bar goes light under light skin)
    'body { background: var(--cc-bg); color-scheme: var(--cc-color-scheme); }\n';
}

export function getSkin(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SKINS.some((s) => s.id === saved)) return saved;
  } catch { /* storage If not available, use the default */ }
  return DEFAULT_SKIN;
}

export function applySkin(id: string): void {
  const skin = SKINS.some((s) => s.id === id) ? id : DEFAULT_SKIN;
  if (skin === DEFAULT_SKIN) delete document.documentElement.dataset.ccSkin;
  else document.documentElement.dataset.ccSkin = skin;
  try { localStorage.setItem(STORAGE_KEY, skin); } catch { /* ignore */ }
}

/** boot Inject(main.tsx Pre-rendering):Create style sheet + Apply long-lasting skin,Avoid flashy colors. */
export function initSkins(): void {
  if (!document.getElementById('cc-skins')) {
    const style = document.createElement('style');
    style.id = 'cc-skins';
    style.textContent = buildSkinsCss();
    document.head.appendChild(style);
  }
  applySkin(getSkin());
}
