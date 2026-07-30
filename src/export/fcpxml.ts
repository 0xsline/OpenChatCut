// FCPXML 序列化器（submit_export format=xml, nleFormat fcp_xml/fcp_xml_resolve）。
// 纯函数：读 TimelineState → 吐 FCPXML 1.10 字符串。无 DOM/fetch/fs，不含
// Date.now()/Math.random()，同一输入永远同一输出，方便 headless 测试和
// server/client 两端复用。集成方负责把它接到 submit_export 的 xml 分支。
import {
  timelineDuration,
  timelineTrackIds,
  trackKind,
  type TimelineItem,
  type TimelineState,
  type TrackId,
} from '../editor/types';
import { itemEditOpts, itemWindow, keptSegments } from '../transcript/edit';
import { motionGraphicRenderFilename, motionGraphicRenderKey } from './motionGraphicRefs';

/** 素材 URL 前缀:磁盘上落在 mediaDir 里,同名。 */
const UPLOAD_PREFIX = '/media/uploads/';

/** 绝对磁盘路径 → file:// URL。POSIX 与 Windows 盘符都覆盖;路径分段按 URL 规则
 * 编码(中文/空格文件名不编码的话 NLE 解析不到),盘符的冒号必须保持原样。 */
function toFileUrl(absPath: string): string {
  const slashed = absPath.replace(/\\/g, '/');
  const rooted = /^[A-Za-z]:/.test(slashed) ? `/${slashed}` : slashed;
  const encoded = rooted
    .split('/')
    .map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
  return `file://${encoded}`;
}

/**
 * 片段 src → NLE 能重链的地址。`/media/uploads/<name>` 是同源 URL,物理位置由
 * mediaDir 决定(MEDIA_DIR 可改),必须换算成绝对路径,否则 NLE 里每条素材都是
 * 离线的。远程/内联地址原样透传(NLE 关不了它们,但谎报本地路径更糟)。
 */
export function resolveAssetSrc(src: string, mediaDir?: string): string {
  if (/^(?:https?|file|data|blob):/i.test(src)) return src;
  if (mediaDir && src.startsWith(UPLOAD_PREFIX)) {
    const name = decodeURIComponent(src.slice(UPLOAD_PREFIX.length));
    return toFileUrl(`${mediaDir.replace(/[/\\]+$/, '')}/${name}`);
  }
  return src.startsWith('/') ? toFileUrl(src) : `file://${src}`;
}

/**
 * 音频件的文字稿编辑(删词 / 压静音 / 语块重排)在播放层拆成多段
 * (TimelineComposition 的 AudioClip),导出必须拆成同样的多条 asset-clip——
 * 否则 NLE 里会按连续源区间播放,把删掉的词播回来、后面的内容整段丢失。
 * 与渲染层共用 keptSegments,保证两边永远同一个真源。
 * video 件的删词不改画面(永远连续播放),所以只有 audio 需要分段。
 */
function transcriptSegments(
  item: TimelineItem,
  fps: number,
): ReturnType<typeof keptSegments> | null {
  if (item.kind !== 'audio' || !item.transcript?.length) return null;
  return keptSegments(item.transcript, new Set(item.deletedWordIdx ?? []), fps, item.startFrame, {
    ...itemEditOpts(item),
    window: itemWindow(item),
  });
}

/** XML 属性/文本转义（5 个保留字符）。 */
function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** XML 注释不能含 "--"；占位说明是给人看的，直接把连字符替换掉最省事。 */
function xmlComment(text: string): string {
  return `<!-- ${text.replace(/-/g, '_')} -->`;
}

/** FCPXML 资源/元素 id 必须是合法 NCName：非法字符替换 + 固定前缀保证不以数字开头。 */
function sanitizeId(raw: string): string {
  return `id-${raw.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

/**
 * 帧 → FCPXML 有理数时间 "N/Ds"。整数帧率直接用 frames/fps；非整数帧率
 * （如 29.97）放大到整数分母再取整，保证与 frames/fps 秒数精确等价——
 * 此处是最简单能保证精确往返换算的写法，不追求 NTSC 1001/30000
 * 的行业惯例分母。
 */
function rationalTime(frames: number, fps: number): string {
  if (Number.isInteger(fps)) return `${frames}/${fps}s`;
  const scale = 1000;
  return `${Math.round(frames * scale)}/${Math.round(fps * scale)}s`;
}

function validateState(state: TimelineState): void {
  if (!state || !Array.isArray(state.items)) {
    throw new Error('timelineToFcpxml: state.items 必须是数组');
  }
  if (!Number.isFinite(state.fps) || state.fps <= 0) {
    throw new Error('timelineToFcpxml: state.fps 必须是正数');
  }
  if (!Number.isInteger(state.width) || state.width <= 0 || !Number.isInteger(state.height) || state.height <= 0) {
    throw new Error('timelineToFcpxml: state.width/height 必须是正整数');
  }
  for (const item of state.items) {
    if (!Number.isInteger(item.startFrame) || item.startFrame < 0) {
      throw new Error(`timelineToFcpxml: item ${item.id} 的 startFrame 非法`);
    }
    if (!Number.isInteger(item.durationInFrames) || item.durationInFrames <= 0) {
      throw new Error(`timelineToFcpxml: item ${item.id} 的 durationInFrames 非法`);
    }
  }
}

/** 轨道 → FCPXML lane：底部视频轨(V1)=lane 1，往上每条轨 +1；A1=lane -1，
 * 往下每条轨 -1（负数惯例：音频挂在主线下方）。未知轨兜底成视频 lane 1。 */
function buildLaneOf(state: TimelineState): (track: TrackId) => number {
  const ids = timelineTrackIds(state);
  const videoTracks = ids.filter((id) => trackKind(state, id) === 'video');
  const audioTracks = ids.filter((id) => trackKind(state, id) === 'audio');
  return (track: TrackId): number => {
    const vIdx = videoTracks.indexOf(track);
    if (vIdx >= 0) return videoTracks.length - vIdx;
    const aIdx = audioTracks.indexOf(track);
    if (aIdx >= 0) return -(aIdx + 1);
    return 1;
  };
}

interface AssetInfo {
  id: string;
  kind: TimelineItem['kind'];
  durationFrames: number;
}

interface RenderedMotionGraphicInfo {
  id: string;
  key: string;
  filename: string;
  durationFrames: number;
}

/** 按 src 去重收集 asset 资源：同一素材在时间线上多次使用只登记一条 asset。 */
function collectAssets(state: TimelineState): Map<string, AssetInfo> {
  const bySrc = new Map<string, AssetInfo>();
  for (const item of state.items) {
    if (!item.src) continue;
    // 分段件用到的源区间由最后一段决定,可能远超编辑后时长(删词把中间掏掉了)
    const segs = transcriptSegments(item, state.fps);
    const usedTo = segs?.length
      ? Math.max(...segs.map((seg) => seg.srcEndFrame))
      : (item.srcInFrame ?? 0) + item.durationInFrames;
    const libraryAsset = state.assets?.find((a) => a.src === item.src);
    const full = Math.max(usedTo, libraryAsset?.durationInFrames ?? 0);
    const existing = bySrc.get(item.src);
    if (existing) {
      existing.durationFrames = Math.max(existing.durationFrames, full);
    } else {
      bySrc.set(item.src, { id: sanitizeId(item.id), kind: item.kind, durationFrames: full });
    }
  }
  return bySrc;
}

function assetResourceXml(
  src: string,
  info: AssetInfo,
  fps: number,
  formatId: string,
  mediaDir?: string,
): string {
  const hasVideo = info.kind !== 'audio';
  const hasAudio = info.kind === 'audio' || info.kind === 'video';
  const name = escapeXml(decodeURIComponent(src.split('/').pop() || src));
  const formatAttr = hasVideo ? ` format="${formatId}"` : '';
  const href = escapeXml(resolveAssetSrc(src, mediaDir));
  return `<asset id="${info.id}" name="${name}" src="${href}" start="0s" duration="${rationalTime(info.durationFrames, fps)}" hasVideo="${hasVideo ? 1 : 0}" hasAudio="${hasAudio ? 1 : 0}"${formatAttr}/>`;
}

function collectRenderedMotionGraphics(
  state: TimelineState,
  requestedKeys: readonly string[],
): Map<string, RenderedMotionGraphicInfo> {
  const allowed = new Set(requestedKeys.map((key) => key.trim()).filter(Boolean));
  const rendered = new Map<string, RenderedMotionGraphicInfo>();
  if (!allowed.size) return rendered;
  for (const item of state.items) {
    if (item.kind !== 'motion-graphic' || item.src) continue;
    const key = motionGraphicRenderKey(item);
    if (!allowed.has(key)) continue;
    const existing = rendered.get(key);
    if (existing) {
      existing.durationFrames = Math.max(existing.durationFrames, item.durationInFrames);
      continue;
    }
    rendered.set(key, {
      id: sanitizeId(`mg-${key}`),
      key,
      filename: motionGraphicRenderFilename(key),
      durationFrames: item.durationInFrames,
    });
  }
  return rendered;
}

function motionGraphicResourceXml(
  info: RenderedMotionGraphicInfo,
  fps: number,
  formatId: string,
): string {
  return `<asset id="${info.id}" name="${escapeXml(info.filename)}" src="file:./${escapeXml(info.filename)}" start="0s" duration="${rationalTime(info.durationFrames, fps)}" hasVideo="1" hasAudio="0" format="${formatId}"/>`;
}

/** 有 src 的条目（video/audio/image/gif）→ asset-clip；没有 src 的条目
 * （motion-graphic/text，MG 没有真实媒体文件）→ 带名字+注释的占位 gap，
 * 集成方可用 export_motion_graphic_prores 渲出透明视频后替换这段 gap。 */
function itemToSpineElement(
  item: TimelineItem,
  fps: number,
  lane: number,
  assets: Map<string, AssetInfo>,
  renderedMotionGraphics: Map<string, RenderedMotionGraphicInfo>,
): string {
  const offset = rationalTime(item.startFrame, fps);
  const duration = rationalTime(item.durationInFrames, fps);
  const name = escapeXml(item.name);
  if (item.src) {
    const ref = assets.get(item.src)?.id ?? '';
    const segs = transcriptSegments(item, fps);
    if (segs?.length) {
      // 每个保留段一条 clip:offset 已是时间线绝对帧(keptSegments 传入了 startFrame)
      return segs
        .map((seg) => `<asset-clip ref="${ref}" lane="${lane}" offset="${rationalTime(seg.fromFrame, fps)}" duration="${rationalTime(seg.durFrames, fps)}" start="${rationalTime(seg.srcStartFrame, fps)}" name="${name}"/>`)
        .join('\n        ');
    }
    const start = rationalTime(item.srcInFrame ?? 0, fps);
    return `<asset-clip ref="${ref}" lane="${lane}" offset="${offset}" duration="${duration}" start="${start}" name="${name}"/>`;
  }
  if (item.kind === 'motion-graphic') {
    const rendered = renderedMotionGraphics.get(motionGraphicRenderKey(item));
    if (rendered) {
      return `<asset-clip ref="${rendered.id}" lane="${lane}" offset="${offset}" duration="${duration}" start="0s" name="${name}"/>`;
    }
  }
  return `<gap name="MG: ${name}" lane="${lane}" offset="${offset}" duration="${duration}">${xmlComment(`motion graphic placeholder, render before NLE import: ${name}`)}</gap>`;
}

/**
 * 把当前时间线序列化成 FCPXML 1.10 文档（Final Cut Pro / DaVinci Resolve /
 * 经 Resolve 转一手的 Premiere 都能读）。
 *
 * 结构：<fcpxml> → <resources>(一条 <format> + 每个去重 src 一条 <asset>)
 * → <library><event><project><sequence><spine>。spine 用一条铺满全长的
 * 背景 <gap> 当主线（lane 0），每个 item 都作为它的 lane 子节点，offset 用
 * 时间线绝对帧位换算——因为背景 gap 本身从 0 开始铺满全长，lane 子节点的
 * "相对锚点偏移"数值上就等于绝对偏移，不用另算相对坐标。这是简化多轨
 * OpenChatCut 时间线（每轨独立绝对帧位）到 FCPX 磁性时间线（连接片段带 lane）
 * 的直接映射方式；按 FCPXML 规范实现。
 */
export type NleFormat = 'fcp_xml' | 'fcp_xml_resolve';

export interface FcpxmlExportOptions {
  title?: string;
  nleFormat?: NleFormat;
  /** Render keys returned by export_motion_graphic_prores filenameMode=xml. */
  motionGraphicRenderKeys?: string[];
  /** 素材目录的绝对磁盘路径(服务端 uploadDir());缺省时 /media/uploads 原样输出,
   * NLE 会把所有素材标成离线。调用方应从 /api/keys 的 mediaDir 取。 */
  mediaDir?: string;
}

export function timelineToFcpxml(
  state: TimelineState,
  opts: FcpxmlExportOptions = {},
): string {
  validateState(state);
  const fps = state.fps;
  const total = timelineDuration(state);
  const title = escapeXml((opts.title ?? '').trim() || 'OpenChatCut Timeline');
  const nle: NleFormat = opts.nleFormat === 'fcp_xml_resolve' ? 'fcp_xml_resolve' : 'fcp_xml';
  const laneOf = buildLaneOf(state);
  const assets = collectAssets(state);
  const renderedMotionGraphics = collectRenderedMotionGraphics(state, opts.motionGraphicRenderKeys ?? []);

  const formatId = 'fmt1';
  // Resolve prefers an explicit colorSpace on <format>; Premiere path keeps the
  // leaner attribute set for fcp_xml than fcp_xml_resolve.
  const formatXml = nle === 'fcp_xml_resolve'
    ? `<format id="${formatId}" name="FFVideoFormatCustom${state.width}x${state.height}p${fps}" frameDuration="${rationalTime(1, fps)}" width="${state.width}" height="${state.height}" colorSpace="1-1-1 (Rec. 709)"/>`
    : `<format id="${formatId}" name="FFVideoFormatCustom${state.width}x${state.height}p${fps}" frameDuration="${rationalTime(1, fps)}" width="${state.width}" height="${state.height}"/>`;
  const assetXmls = Array.from(assets.entries())
    .map(([src, info]) => assetResourceXml(src, info, fps, formatId, opts.mediaDir));
  const motionGraphicXmls = Array.from(renderedMotionGraphics.values())
    .map((info) => motionGraphicResourceXml(info, fps, formatId));
  const resourcesXml = [formatXml, ...assetXmls, ...motionGraphicXmls].join('\n    ');

  const sortedItems = [...state.items].sort((a, b) => {
    const laneDiff = laneOf(b.track) - laneOf(a.track);
    return laneDiff !== 0 ? laneDiff : a.startFrame - b.startFrame;
  });
  const spineChildren = sortedItems
    .map((item) => itemToSpineElement(item, fps, laneOf(item.track), assets, renderedMotionGraphics))
    .join('\n        ');

  const backgroundGap = `<gap name="Background" offset="${rationalTime(0, fps)}" duration="${rationalTime(total, fps)}">\n        ${spineChildren}\n      </gap>`;
  const eventName = nle === 'fcp_xml_resolve' ? 'OpenChatCut Export (Resolve)' : 'OpenChatCut Export';

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.10">',
    '  <resources>',
    `    ${resourcesXml}`,
    '  </resources>',
    '  <library>',
    `    <event name="${eventName}">`,
    `      <project name="${title}">`,
    `        <sequence format="${formatId}" duration="${rationalTime(total, fps)}" tcStart="${rationalTime(0, fps)}" tcFormat="NDF">`,
    '          <spine>',
    `            ${backgroundGap}`,
    '          </spine>',
    '        </sequence>',
    '      </project>',
    '    </event>',
    '  </library>',
    '</fcpxml>',
  ].join('\n');
}
