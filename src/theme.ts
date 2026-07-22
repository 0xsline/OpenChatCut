// Theme tokens。自换肤系统起(见 skins.ts),这里全部是 var(--cc-*)
// 间接引用——真值在 skins.ts 的 SKINS 注册表(默认皮肤「石墨」,
// 与旧 hex 逐值一致)。内联样式照旧写 theme.x,切皮肤零改动零重渲染。
// ⚠ 这些值只能进 DOM style/CSS:canvas fillStyle、SVG 属性位、hex 字符串拼接
// 都解析不了 var()(全仓已审计为零,新代码别开先例)。
export const theme = {
  bg: 'var(--cc-bg)', // editor void / timeline background
  inset: 'var(--cc-inset)', // 内凹槽(输入井)
  panel: 'var(--cc-panel)', // Base editor surface.
  panelAlt: 'var(--cc-panel-alt)', // --surface-raised (cards, chat bubbles, popovers, hover)
  hover: 'var(--cc-hover)', // 行悬停 / 激活填充
  border: 'var(--cc-border)', // Panel separator.
  borderLight: 'var(--cc-border-light)',
  text: 'var(--cc-text)', // --foreground
  textMuted: 'var(--cc-text-muted)', // 次级文本
  textDim: 'var(--cc-text-dim)', // Inactive text.
  textStrong: 'var(--cc-text-strong)', // 悬停增亮文本
  accent: 'var(--cc-accent)', // measured export coral
  accentDeep: 'var(--cc-accent-deep)', // accent 按下 / 主按钮底
  onAccent: 'var(--cc-on-accent)', // accent 填充上的文字(粉彩皮肤 = 深字)
  gold: 'var(--cc-gold)', // --primary (amber highlight)
  select: 'var(--cc-select)',
  success: 'var(--cc-success)', // 工具成功/完成态(与 A2 轨芯片同值不同义,独立令牌)
  danger: 'var(--cc-danger)', // 错误、删除和破坏性操作
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

/** UI 半透明色。ink 随深浅皮肤反转，shadow 始终表达悬浮层级。 */
export const themeAlpha = {
  ink: (opacity: number): string => alpha('ink', opacity),
  accent: (opacity: number): string => alpha('accent', opacity),
  shadow: (opacity: number): string => alpha('shadow', opacity),
} as const;
