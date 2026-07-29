// EN dictionary (field fragmentation, key = Chinese original text). Data files are exempt from the upper limit of row count.
// Source: src/audio/* (recorder error message + soundLibrary grouping label).
// The English name of the group follows the nameEn; usage (library partition) package t(group.name) that comes with soundLibrary.SOUND_GROUPS.
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
