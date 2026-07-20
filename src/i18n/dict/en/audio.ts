// EN 词典(领域分片,键=中文原文)。数据文件,行数上限豁免。
// 来源:src/audio/*(recorder 错误提示 + soundLibrary 分组标签)。
// 分组英文名沿用 soundLibrary.SOUND_GROUPS 自带的 nameEn;使用处(library 分区)包 t(group.name)。
export default {
  // recorder.ts
  '此浏览器不支持录音': 'Recording is not supported in this browser',
  '麦克风权限被拒绝': 'Microphone permission denied',
  '无法访问麦克风': 'Could not access the microphone',
  // soundLibrary.ts SOUND_GROUPS
  'UI 与动效反馈': 'UI & Motion Feedback',
  '转场与强调': 'Transition & Emphasis',
  '设备与质感': 'Device & Texture',
  '反应与情绪': 'Reaction & Mood',
} as Record<string, string>;
