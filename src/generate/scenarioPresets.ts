// 场景预设(创作起步画廊)——源站 /public-api/scenario-presets 的 19 条内置
// prompt 模板。数据本体在 scenarioPresets.data.ts(逐字生成);本文件提供
// 类型与「预设 → 可发送首条消息」的转换缝。
import { SCENARIO_PRESETS_DATA } from './scenarioPresets.data';

export type ScenarioGroup = 'video-gen' | 'app-promo';

export interface ScenarioPreset {
  /** 源站预设 uuid(与 public/scenario-presets/ 资产文件名一致)。 */
  id: string;
  name: string;
  nameZh: string;
  group: ScenarioGroup;
  /** 逐字源站 prompt,含 {{field:…}} 占位符与 @[ref:image:…](S3) 引用原文。 */
  prompt: string;
  /** 逐字源站 agent 指导语(选中预设后应注入 agent 上下文;本期仅存数据)。 */
  agentGuidance: string;
  /** 本地封面路径,如 /scenario-presets/<uuid>-cover.png。 */
  coverUrl: string;
  /** 本地预览视频路径(hover 播放),如 /scenario-presets/<uuid>-preview.mp4。 */
  previewUrl: string;
  /** 源站 proFeatureKey 非空(Seedance 2.0 门控);本期仅作标记不拦截。 */
  pro: boolean;
  // TODO(hiddenReferences): 源站 4 条 app-promo 预设还带 hiddenReferences
  // (S3 参考图),本期跳过;补搬时在此加 `hiddenReferences?: string[]`。
}

/** 全部 19 条,组内按源站 sortOrder(video-gen 14 条在前,app-promo 5 条在后)。 */
export const SCENARIO_PRESETS: readonly ScenarioPreset[] = SCENARIO_PRESETS_DATA;

export function scenarioPresetById(id: string): ScenarioPreset | undefined {
  return SCENARIO_PRESETS.find((p) => p.id === id);
}

const FIELD_PLACEHOLDER = /\{\{field:([^}]*)\}\}/g;

/**
 * 把预设 prompt 转成可直接发给 agent 的首条消息:{{field:xxx}} 占位符
 * 变成中文补充提示,如 `{{field:5~15s}}` → `(请补充: 5~15s)`。
 *
 * 接线缝(seam):编辑器打开带 `ProjectMeta.scenarioPresetId` 的工程且聊天
 * 为空时,用本函数产出首条消息预填/发送(主线后续在 Editor 侧接)。
 * 未知 id 返回 ''(预设可能被下架,调用方按「无预设」处理)。
 */
export function presetInitialMessage(id: string): string {
  const preset = scenarioPresetById(id);
  if (!preset) return '';
  return preset.prompt.replace(FIELD_PLACEHOLDER, (_m, label: string) => `(请补充: ${label.trim()})`);
}
