// 换肤引擎:皮肤 = 一整套设计令牌值。theme.ts 的令牌全部是
// var(--cc-*) 间接引用,真值在这里的 SKINS 注册表;boot 时 initSkins() 把全部
// 皮肤生成成一个 <style> 注入 head,切换 = 改 <html data-cc-skin> 一个属性,
// 几百处内联样式零改动、零重渲染。持久化 localStorage('cc.skin')。
// 安全边界(已审计):合成/GL/canvas 均不消费 theme 令牌,导出烧录不受皮肤影响;
// 全仓无 hex 拼接(`${theme.x}22`)与 SVG 属性位(fill= 属性不解析 var)。
// 半透明"墨水"(--cc-ink-rgb)与 accent 辉光(--cc-accent-rgb)以 R,G,B 裸三元组
// 存放,供 index.css 的 rgba(var(--cc-ink-rgb), α) 用——深肤白墨、浅肤黑墨。

export interface SkinTokens {
  bg: string;          // 编辑器虚空 / 时间线底
  inset: string;       // 内凹槽(输入井、深一档的底)
  panel: string;       // 面板底
  panelAlt: string;    // 卡片 / 弹层 / 悬浮底
  hover: string;       // 行悬停 / 激活填充
  border: string;
  borderLight: string;
  text: string;
  textMuted: string;   // 次级文本(比 text 淡、比 dim 亮)
  textDim: string;
  textStrong: string;  // 悬停增亮文本(深肤 #fff,浅肤近黑)
  accent: string;
  accentDeep: string;  // accent 按下 / 主按钮底(#c45c26 档)
  accentRgb: string;   // "R,G,B" 供辉光 rgba() 用
  /** accent 填充上的文字色:深色系皮肤白字;粉彩 accent(摩卡桃/北极冰蓝)
   * 白字对比只有 ~2:1,必须用深字(≥4.5:1,已逐肤断言)。 */
  onAccent: string;
  inkRgb: string;      // "R,G,B" 半透明墨水基色(深肤 255,255,255)
  shadowRgb: string;   // "R,G,B" 悬浮层阴影/遮罩基色
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

// 石墨 = 默认皮肤(与换肤系统落地前的观感逐值一致)。
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

// 调色来源(用户点名走 GitHub 名主题,值取官方调色板,MIT):
// 摩卡/拿铁 = Catppuccin(github.com/catppuccin/palette,palette.json 核对),
// 北极 = Nord(nordtheme.com),东京夜 = Tokyo Night。石墨/墨黑 = 自制深色系。
// 纪律(impeccable colorize):表面只用官方中性阶造海拔;轨道/片段/select/
// success 是**语义色**,跨皮肤统一(继承石墨);文本对比 text/panel ≥ 7、
// textDim/panel ≥ 4.5、onAccent/accent ≥ 4.5(脚本逐肤断言,个别官方灰阶
// 微调 L 达标)。粉彩 accent 皮肤(摩卡/北极/东京夜/拿铁)onAccent 用深字。
export const SKINS: readonly SkinDef[] = [
  { id: 'graphite', nameZh: '石墨', tokens: GRAPHITE },
  {
    id: 'midnight', nameZh: '墨黑',
    tokens: {
      ...GRAPHITE,
      bg: '#000000', inset: '#070707', panel: '#0b0b0b', panelAlt: '#161616', hover: '#212121',
      border: '#282828', borderLight: '#3d3d3d',
      text: '#e6e6e6', textMuted: '#ababab', textDim: '#7d7d7d',
      tlTrack: '#131417', tlSidePanel: '#0e0f11',
    },
  },
  // Catppuccin Mocha:crust/mantle/base/surface 阶,accent = 桃色(暖调)
  {
    id: 'mocha', nameZh: '摩卡',
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
  // Nord:polar night 阶,accent = frost 冰蓝
  {
    id: 'nord', nameZh: '北极',
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
  // Tokyo Night:night 阶(storm 作卡面),accent = 标志蓝
  {
    id: 'tokyo', nameZh: '东京夜',
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
  // Catppuccin Latte:官方浅色(蓝灰中性,非奶油米黄),accent = 桃橙
  {
    id: 'latte', nameZh: '拿铁(浅色)',
    tokens: {
      ...GRAPHITE,
      bg: '#dce0e8', inset: '#d3d7df', panel: '#eff1f5', panelAlt: '#e6e9ef', hover: '#d8dce4',
      // 浅色下 0.5px 细线要更深才可读:border=surface2、borderLight=overlay1(官方阶)
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

/** 全部皮肤的 CSS 文本::root = 默认皮肤,其余按 data-cc-skin 覆盖。 */
export function buildSkinsCss(): string {
  const base = SKINS.find((s) => s.id === DEFAULT_SKIN) ?? SKINS[0];
  const overrides = SKINS.filter((s) => s.id !== base.id)
    .map((s) => `html[data-cc-skin='${s.id}'] {\n${skinBlock(s.tokens)}\n}`)
    .join('\n');
  return `:root {\n${skinBlock(base.tokens)}\n}\n${overrides}\n` +
    // body 跟随皮肤底色 + 原生控件配色方向(浅肤下 select/滚动条走 light)
    'body { background: var(--cc-bg); color-scheme: var(--cc-color-scheme); }\n';
}

export function getSkin(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SKINS.some((s) => s.id === saved)) return saved;
  } catch { /* storage 不可用则用默认 */ }
  return DEFAULT_SKIN;
}

export function applySkin(id: string): void {
  const skin = SKINS.some((s) => s.id === id) ? id : DEFAULT_SKIN;
  if (skin === DEFAULT_SKIN) delete document.documentElement.dataset.ccSkin;
  else document.documentElement.dataset.ccSkin = skin;
  try { localStorage.setItem(STORAGE_KEY, skin); } catch { /* 忽略 */ }
}

/** boot 注入(main.tsx 渲染前调):建样式表 + 应用持久化皮肤,避免闪默认色。 */
export function initSkins(): void {
  if (!document.getElementById('cc-skins')) {
    const style = document.createElement('style');
    style.id = 'cc-skins';
    style.textContent = buildSkinsCss();
    document.head.appendChild(style);
  }
  applySkin(getSkin());
}
