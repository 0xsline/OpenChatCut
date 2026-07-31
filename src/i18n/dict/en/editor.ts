// EN dictionary (field fragmentation, key = Chinese original text). Data files are exempt from the upper limit of row count.
// Source: src/editor/types.ts UI label of top-level constant (the constant body remains in Chinese, and the usage package is t(label)).
// The dynamic label v1 of undo historical/project data stored in reduce/store does not enter i18n (see the scanning rules).
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
} as Record<string, string>;
