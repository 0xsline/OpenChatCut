// Default keyboard preset with 55 actions. The UI can show Chinese via labelZh.

export type ShortcutGroup =
  | 'ai'
  | 'edit'
  | 'markers'
  | 'navigation'
  | 'playback'
  | 'view';

export interface ShortcutAction {
  id: string;
  label: string;
  labelZh: string;
  group: ShortcutGroup;
  /** Human-readable bindings such as "Mod + Alt + V / Mod + Shift + B". */
  keys: string;
  /** If true, ignore when focus is in input/textarea/contenteditable (default true). */
  disabledWhenTyping?: boolean;
}

export const SHORTCUT_GROUPS: { id: ShortcutGroup; label: string; labelZh: string }[] = [
  { id: 'playback', label: 'Playback', labelZh: '播放' },
  { id: 'edit', label: 'Edit', labelZh: '编辑' },
  { id: 'navigation', label: 'Navigation', labelZh: '导航' },
  { id: 'markers', label: 'Markers', labelZh: '标记' },
  { id: 'view', label: 'View', labelZh: '视图' },
  { id: 'ai', label: 'AI', labelZh: 'AI' },
];

/** Canonical 55 actions — source of truth for help UI + matcher. */
export const SHORTCUT_CATALOG: ShortcutAction[] = [
  { id: 'play-pause', label: 'Play / Pause', labelZh: '播放/暂停', group: 'playback', keys: 'Space' },
  { id: 'seek-back', label: 'Previous frame', labelZh: '上一帧', group: 'playback', keys: '←' },
  { id: 'seek-fwd', label: 'Next frame', labelZh: '下一帧', group: 'playback', keys: '→' },
  { id: 'seek-back-sec', label: 'Step back 1 second', labelZh: '后退 1 秒', group: 'playback', keys: 'Shift + ←' },
  { id: 'seek-fwd-sec', label: 'Step forward 1 second', labelZh: '前进 1 秒', group: 'playback', keys: 'Shift + →' },
  { id: 'shuttle-back', label: 'Shuttle backward', labelZh: '倒放梭 (J)', group: 'playback', keys: 'J' },
  { id: 'shuttle-fwd', label: 'Shuttle forward', labelZh: '正放梭 (L)', group: 'playback', keys: 'L' },
  { id: 'shuttle-pause', label: 'Shuttle pause', labelZh: '梭暂停 (K)', group: 'playback', keys: 'K' },
  { id: 'shuttle-jog-back', label: 'Jog back one frame', labelZh: '点退一帧 (K+J)', group: 'playback', keys: 'K + J' },
  { id: 'shuttle-jog-fwd', label: 'Jog forward one frame', labelZh: '点进一帧 (K+L)', group: 'playback', keys: 'K + L' },

  { id: 'undo', label: 'Undo', labelZh: '撤销', group: 'edit', keys: 'Mod + Z' },
  { id: 'redo', label: 'Redo', labelZh: '重做', group: 'edit', keys: 'Mod + Shift + Z / Mod + Y' },
  { id: 'copy', label: 'Copy', labelZh: '复制', group: 'edit', keys: 'Mod + C' },
  { id: 'cut', label: 'Cut', labelZh: '剪切', group: 'edit', keys: 'Mod + X' },
  { id: 'paste', label: 'Paste', labelZh: '粘贴', group: 'edit', keys: 'Mod + V' },
  { id: 'paste-effects', label: 'Paste Effects', labelZh: '粘贴效果', group: 'edit', keys: 'Mod + Alt + V / Mod + Shift + B' },
  { id: 'duplicate', label: 'Duplicate', labelZh: '复制片段', group: 'edit', keys: 'Mod + D' },
  { id: 'delete', label: 'Delete', labelZh: '删除', group: 'edit', keys: 'Backspace / Delete' },
  { id: 'split', label: 'Split', labelZh: '切分', group: 'edit', keys: 'C / Enter' },
  { id: 'interaction-mode-selection', label: 'Selection Mode', labelZh: '选择模式', group: 'edit', keys: 'V' },
  { id: 'interaction-mode-trim', label: 'Trim Edit Mode', labelZh: '修剪模式', group: 'edit', keys: 'N' },
  { id: 'interaction-mode-blade', label: 'Blade Edit Mode', labelZh: '刀片模式', group: 'edit', keys: 'B' },
  { id: 'interaction-mode-pen', label: 'Pen Edit Mode', labelZh: '钢笔模式', group: 'edit', keys: 'P' },
  { id: 'nudge-left', label: 'Nudge left 1 / 5 frames', labelZh: '左移 1/5 帧', group: 'edit', keys: 'E / Shift + E' },
  { id: 'nudge-right', label: 'Nudge right 1 / 5 frames', labelZh: '右移 1/5 帧', group: 'edit', keys: 'R / Shift + R' },
  { id: 'trim-start', label: 'Trim start', labelZh: '裁到入点', group: 'edit', keys: 'Q' },
  { id: 'trim-end', label: 'Trim end', labelZh: '裁到出点', group: 'edit', keys: 'W' },
  // disabled when typing so ⌘A still selects text in chat/inspector inputs
  { id: 'select-all', label: 'Select all', labelZh: '全选', group: 'edit', keys: 'Mod + A' },
  { id: 'select-after', label: 'Select clips forward', labelZh: '向后选片段', group: 'edit', keys: 'Y' },
  { id: 'move-up', label: 'Move clip up', labelZh: '片段上移轨', group: 'edit', keys: 'Alt + ↑' },
  { id: 'move-down', label: 'Move clip down', labelZh: '片段下移轨', group: 'edit', keys: 'Alt + ↓' },
  { id: 'move-left-boundary', label: 'Move left to boundary', labelZh: '左贴边', group: 'edit', keys: 'Ctrl + E' },
  { id: 'move-right-boundary', label: 'Move right to boundary', labelZh: '右贴边', group: 'edit', keys: 'Ctrl + R' },
  { id: 'save-version', label: 'Save version', labelZh: '保存版本', group: 'edit', keys: 'Mod + S' },

  { id: 'prev-edit', label: 'Previous edit', labelZh: '上一剪辑点', group: 'navigation', keys: '↑' },
  { id: 'next-edit', label: 'Next edit', labelZh: '下一剪辑点', group: 'navigation', keys: '↓' },
  { id: 'zone-in', label: 'Mark in', labelZh: '入点', group: 'navigation', keys: 'I' },
  { id: 'zone-out', label: 'Mark out', labelZh: '出点', group: 'navigation', keys: 'O' },
  { id: 'zone-clear', label: 'Clear marks', labelZh: '清除入出点', group: 'navigation', keys: 'X' },
  { id: 'zone-clip', label: 'Mark clip at playhead', labelZh: '按片段打入出点', group: 'navigation', keys: '/' },
  { id: 'zone-selection', label: 'Mark selection', labelZh: '按选区打入出点', group: 'navigation', keys: '' },

  { id: 'marker-add', label: 'Add marker', labelZh: '添加标记', group: 'markers', keys: 'M' },
  { id: 'marker-shortcut-add-and-open', label: 'Add marker and open dialog', labelZh: '添加并编辑标记', group: 'markers', keys: 'Mod + M' },
  { id: 'marker-modify-at-playhead', label: 'Modify marker at playhead', labelZh: '编辑播放头标记', group: 'markers', keys: 'Shift + M' },
  { id: 'marker-delete-at-playhead', label: 'Delete marker at playhead', labelZh: '删除播放头标记', group: 'markers', keys: 'Alt + M' },
  { id: 'marker-prev', label: 'Previous marker', labelZh: '上一标记', group: 'markers', keys: 'Shift + ↑' },
  { id: 'marker-next', label: 'Next marker', labelZh: '下一标记', group: 'markers', keys: 'Shift + ↓' },

  { id: 'snapping', label: 'Snapping', labelZh: '吸附', group: 'view', keys: 'S' },
  { id: 'selection-mode', label: 'Selection mode', labelZh: '选择模式 (Alt)', group: 'view', keys: 'Alt + S' },
  { id: 'zoom-in', label: 'Timeline zoom in', labelZh: '时间线放大', group: 'view', keys: 'Mod + = / Mod + +' },
  { id: 'zoom-out', label: 'Timeline zoom out', labelZh: '时间线缩小', group: 'view', keys: 'Mod + -' },
  { id: 'zoom-fit', label: 'Zoom timeline to fit', labelZh: '适配视图', group: 'view', keys: 'Shift + Z' },
  { id: 'fullscreen', label: 'Fullscreen preview', labelZh: '全屏', group: 'view', keys: '`' },
  { id: 'keyboard-shortcuts', label: 'Keyboard shortcuts', labelZh: '快捷键列表', group: 'view', keys: 'Mod + Alt + K', disabledWhenTyping: false },

  { id: 'ask-ai', label: 'Add to AI chat', labelZh: '聚焦 AI 对话', group: 'ai', keys: 'Tab' },
];

export const SHORTCUT_BY_ID = Object.fromEntries(
  SHORTCUT_CATALOG.map((a) => [a.id, a]),
) as Record<string, ShortcutAction>;
