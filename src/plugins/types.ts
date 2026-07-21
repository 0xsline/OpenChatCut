// 内容插件(openchatcut-plugin@1)领域类型与上限。设计:docs/plugin-system-design.md。
// 社区 DIY 内容(MG/转场/特效/LUT/缩放)的打包分发格式。
// 纯类型和常量，保持 Node 验证脚本可直接执行。
//
// format 兼容策略:仅认 PLUGIN_FORMAT 精确字符串;未知 format 一律拒装
// (见 validatePack)。未来 @2 需同步改 PLUGIN_FORMAT + 迁移说明,不静默兼容。

export const PLUGIN_FORMAT = 'openchatcut-plugin@1';

/** 安装校验上限(第三方内容视为不可信输入) */
export const PLUGIN_LIMITS = {
  maxItems: 64,
  maxFragBytes: 64 * 1024,
  maxCodeBytes: 256 * 1024,
  maxCubeBytes: 2 * 1024 * 1024,
  maxProps: 12,
  minEnvelopePoints: 2,
  maxEnvelopePoints: 120,
  /** 包络值域上限(>1 允许过冲弹跳曲线) */
  maxEnvelopeValue: 1.5,
  maxNameLen: 60,
  maxDescLen: 500,
  /** 预览图上限(data URL 内联,保持包单文件自包含) */
  maxThumbBytes: 128 * 1024,
} as const;

export const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const ITEM_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const PROP_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/;

/** 可调数值属性(与 CustomTransitionProp / FxNumberProperty 同构) */
export interface PluginNumberProp {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step?: number;
}

interface PluginItemBase {
  id: string;
  name: string;
  desc?: string;
  /** 预览图:data:image/* 内联(≤128KB)或同源/https URL;资源库卡片直接用 */
  thumb?: string;
}

/** MG 模板:应用时 code 快照进 item.code(既有机制),运行期永远走沙箱 */
export interface PluginMgTemplateItem extends PluginItemBase {
  type: 'mg-template';
  code: string;
  width?: number;
  height?: number;
  props?: Record<string, unknown>;
  /**
   * 可选:检查器字段 schema(与 Tpl.propSchema 同构)。
   * 省略时由 props 值类型自动推断(string→text, #hex→color, number→number, boolean→boolean)。
   */
  propSchema?: Array<{
    key: string;
    type: string;
    defaultValue?: unknown;
    label?: string;
    min?: number;
    max?: number;
    step?: number;
  }>;
}

/** 转场:双输入 GLSL(u_outgoing/u_incoming/u_progress),应用时快照进 TransitionItem.customFrag */
export interface PluginTransitionItem extends PluginItemBase {
  type: 'transition';
  frag: string;
  props?: PluginNumberProp[];
  defaultDurationFrames?: number;
}

/** 特效:单输入 GLSL(u_input);应用时 def 写入 state.fxDefs 自包含 */
export interface PluginFxItem extends PluginItemBase {
  type: 'fx';
  frag: string;
  props?: PluginNumberProp[];
  /** 线性多 pass(每段读上一段输出);不支持 DAG pipeline */
  passes?: string[];
}

/** LUT:.cube 文本;安装时上传成 /media/uploads 文件,def.cube 记 URL */
export interface PluginLutItem extends PluginItemBase {
  type: 'lut';
  cube: string;
}

/** 缩放曲线:0..1 归一化包络,整段 clip 线性采样(ZoomEffect.envelope) */
export interface PluginZoomItem extends PluginItemBase {
  type: 'zoom';
  envelope: number[];
  magnification?: number;
}

export type PluginItem =
  | PluginMgTemplateItem
  | PluginTransitionItem
  | PluginFxItem
  | PluginLutItem
  | PluginZoomItem;

export interface PluginPack {
  format: typeof PLUGIN_FORMAT;
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  items: PluginItem[];
}

/** 运行时资产 id:与 builtin: / custom: 前缀并列,永不冲突 */
export function pluginAssetId(packId: string, itemId: string): string {
  return `plugin:${packId}/${itemId}`;
}

export function isPluginAssetId(id: string): boolean {
  return id.startsWith('plugin:');
}
