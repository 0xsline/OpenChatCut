// EN 词典(领域分片,键=中文原文)。数据文件,行数上限豁免。
// 来源:src/editor/types.ts 顶层常量的 UI 标签(常量本体保持中文,使用处包 t(label))。
// reduce/store 里存进 undo 历史/工程数据的动态标签 v1 不进 i18n(见扫换规则)。
export default {
  // ZOOM_SHAPE_LABELS
  '冲击': 'Punch',
  '推进拉回': 'Push & Pull Back',
  '慢推': 'Slow Push',
  '瞬时': 'Instant',
  '拉远': 'Zoom Out',
  '缓入推近': 'Ease-In Push',
  '弹性推近': 'Bouncy Push',
  '快切推近': 'Snap Push',
  '心跳脉冲': 'Pulse',
  '甩入推近': 'Whip-In Push',
  // TRANSITION_LABELS
  '推进转场': 'Anticipation Zoom',
  '白色划线转场': 'Clean Line Wipe',
  '叠化转场': 'Cross Dissolve',
  '闪黑转场': 'Dip to Black',
  '闪白转场': 'Flash',
  '冲击抖动转场': 'Impact Shake',
  '叠加转场': 'Luma Blend',
  '光溶转场': 'Organic Dissolve',
  '翻页转场': 'Page Curl',
  '焦点转场': 'Rack Focus',
  '柔化擦除转场': 'Soft Wipe',
  '甩镜转场': 'Whip Pan',
  '圆形擦除转场': 'Circle Wipe',
  '序列': 'Sequence',
  '序列 {n}': 'Sequence {n}',
  '副本': 'Copy',
  '旁白': 'Voiceover',
  '序列 1': 'Sequence 1',
  '未命名版本': 'Untitled version',
  '双击编辑文字': 'Double-click to edit text',
} as Record<string, string>;
