const H264_PROFILE_LABELS = {
  h264_videotoolbox: 'Apple VideoToolbox',
  h264_nvenc: 'NVIDIA NVENC',
  h264_qsv: 'Intel Quick Sync Video',
  h264_amf: 'AMD AMF',
  h264_vaapi: 'Linux VA-API',
  libx264: 'Software (libx264)',
};
const RENDER_MEDIA_FIELD = /(?:^|_)(?:src|url|path|cube|lut)$/i;
const RENDER_MEDIA_FIELD_SUFFIX = /(?:Src|Url|Path)$/;

export function normalizeH264Profile(codec, profile) {
  if (codec !== 'h264') return undefined;
  const id = profile?.id;
  if (typeof id !== 'string' || !Object.hasOwn(H264_PROFILE_LABELS, id)) {
    return { id: 'libx264', label: H264_PROFILE_LABELS.libx264, hardware: false, transport: 'server' };
  }
  return { id, label: H264_PROFILE_LABELS[id], hardware: id !== 'libx264', transport: 'server' };
}

function renderSnapshotRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function renderSnapshotString(record, key) {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function renderMediaField(key) {
  return RENDER_MEDIA_FIELD.test(key) || RENDER_MEDIA_FIELD_SUFFIX.test(key);
}

function collectTimelines(root) {
  const timelines = new Map();
  const registerTimeline = (value, fallbackId) => {
    const timeline = renderSnapshotRecord(value);
    if (!timeline || !Array.isArray(timeline.items)) return;
    const id = renderSnapshotString(timeline, 'id') ?? fallbackId;
    if (id) timelines.set(id, timeline);
  };
  registerTimeline(root);
  if (Array.isArray(root.timelines)) {
    for (const timeline of root.timelines) registerTimeline(timeline);
  }
  for (const containerKey of ['sequenceTimelines', 'sequences', 'timelineById']) {
    const container = renderSnapshotRecord(root[containerKey]);
    if (!container) continue;
    for (const [id, timeline] of Object.entries(container)) registerTimeline(timeline, id);
  }
  return timelines;
}

function collectAssets(root, timelines) {
  const assets = new Map();
  const registerAssets = (value) => {
    if (!Array.isArray(value)) return;
    for (const candidate of value) {
      const asset = renderSnapshotRecord(candidate);
      const id = renderSnapshotString(asset, 'id');
      if (asset && id) assets.set(id, asset);
    }
  };
  registerAssets(root.assets);
  for (const timeline of timelines.values()) registerAssets(timeline.assets);
  return assets;
}

function createMediaFieldScanner(assets, operation) {
  const assertExternal = (source, field) => {
    if (/^https?:\/\//i.test(source.trim())) {
      throw new Error(`${operation}: external media at ${field} was not materialized`);
    }
  };
  const scanned = new WeakSet();
  const scanMediaFields = (value, fieldPrefix) => {
    if (value === null || typeof value !== 'object' || scanned.has(value)) return;
    scanned.add(value);
    if (Array.isArray(value)) {
      value.forEach((child, index) => scanMediaFields(child, `${fieldPrefix}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const field = fieldPrefix ? `${fieldPrefix}.${key}` : key;
      if (typeof child === 'string' && /assetId$/i.test(key)) {
        const asset = assets.get(child);
        const assetSource = renderSnapshotString(asset, 'src');
        if (assetSource) assertExternal(assetSource, `assets.${child}.src`);
      } else if (typeof child === 'string' && renderMediaField(key)) {
        assertExternal(child, field);
      } else if (child && typeof child === 'object') {
        scanMediaFields(child, field);
      }
    }
  };
  return scanMediaFields;
}

function scanTimelineItems(timeline, prefix, timelines, scanMediaFields, visitTimeline) {
  const items = Array.isArray(timeline.items)
    ? timeline.items.filter((item) => renderSnapshotRecord(item))
    : [];
  for (const item of items) {
    const itemId = renderSnapshotString(item, 'id');
    scanMediaFields(item, `${prefix}.items.${itemId ?? '(unknown)'}`);
    if (Array.isArray(item.effects)) {
      for (const effect of item.effects) {
        const effectRecord = renderSnapshotRecord(effect);
        const assetId = renderSnapshotString(effectRecord, 'assetId');
        const fxDefs = renderSnapshotRecord(timeline.fxDefs);
        const fxDef = assetId && fxDefs ? renderSnapshotRecord(fxDefs[assetId]) : null;
        if (fxDef) scanMediaFields(fxDef, `${prefix}.fxDefs.${assetId}`);
      }
    }
    if (renderSnapshotString(item, 'kind') === 'sequence') {
      const nestedId = renderSnapshotString(item, 'timelineId');
      const nested = nestedId ? timelines.get(nestedId) : undefined;
      if (nested) visitTimeline(nested, nestedId);
    }
  }
}

function scanTimelineMetadata(timeline, prefix, scanMediaFields) {
  if (Array.isArray(timeline.transitions)) {
    for (const transition of timeline.transitions) {
      const transitionRecord = renderSnapshotRecord(transition);
      if (transitionRecord && transitionRecord.enabled !== false) {
        scanMediaFields(transitionRecord, `${prefix}.transitions`);
      }
    }
  }
  const captionPayloads = [timeline.captions];
  const tracks = renderSnapshotRecord(timeline.tracks);
  if (tracks) {
    for (const track of Object.values(tracks)) {
      const trackRecord = renderSnapshotRecord(track);
      if (trackRecord) captionPayloads.push(trackRecord.captions);
    }
  }
  for (const captions of captionPayloads) {
    const captionRecord = renderSnapshotRecord(captions);
    if (captionRecord && captionRecord.enabled !== false) {
      scanMediaFields(captionRecord, `${prefix}.captions`);
    }
  }
}

function createTimelineVisitor(timelines, scanMediaFields) {
  const visited = new Set();
  const visitTimeline = (timeline, fallbackId) => {
    if (visited.has(timeline)) return;
    visited.add(timeline);
    const id = renderSnapshotString(timeline, 'id') ?? fallbackId;
    const prefix = id ? `timelines.${id}` : 'timeline';
    scanTimelineItems(timeline, prefix, timelines, scanMediaFields, visitTimeline);
    scanTimelineMetadata(timeline, prefix, scanMediaFields);
  };
  return visitTimeline;
}

/** Inspect only the active timeline and sequence timelines it can render. */
export function assertMaterializedRenderSnapshot(snapshot, operation = 'render', timelineId) {
  const root = renderSnapshotRecord(snapshot);
  if (!root) return;
  const timelines = collectTimelines(root);
  const scanMediaFields = createMediaFieldScanner(collectAssets(root, timelines), operation);
  const visitTimeline = createTimelineVisitor(timelines, scanMediaFields);
  if (Array.isArray(root.items)) {
    visitTimeline(root, renderSnapshotString(root, 'id'));
    return;
  }
  const activeId = timelineId ?? renderSnapshotString(root, 'activeTimelineId');
  const active = activeId ? timelines.get(activeId) : timelines.values().next().value;
  if (active) visitTimeline(active, activeId);
}
