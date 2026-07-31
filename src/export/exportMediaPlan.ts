import {
  createExportFailure,
  ExportFailureError,
  type ExportMediaIssue,
} from './exportFailure.js';

export type ExportMediaOwner = ExportMediaIssue['owner'];

export interface ExportMediaReference {
  source: string;
  owner: ExportMediaOwner;
  timelineId?: string;
  itemId?: string;
  assetId?: string;
  field: string;
}

export interface ExportMediaPlan {
  references: readonly ExportMediaReference[];
  issues: readonly ExportMediaIssue[];
}

type SnapshotObject = object;
const MEDIA_ITEM_KINDS: Partial<Record<string, true>> = {
  audio: true,
  video: true,
  image: true,
  gif: true,
  svg: true,
};
const MEDIA_FIELD = /(?:^|_)(?:src|url|path|cube|lut)$/i;
const MEDIA_FIELD_SUFFIX = /(?:Src|Url|Path)$/;

function propertyOf(record: SnapshotObject, key: string): unknown {
  return Reflect.get(record, key);
}

function stringField(record: SnapshotObject, key: string): string | undefined {
  const value = propertyOf(record, key);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function mediaField(key: string): boolean {
  return MEDIA_FIELD.test(key) || MEDIA_FIELD_SUFFIX.test(key);
}

function mediaLookingValue(value: string): boolean {
  return /^(?:blob:|data:|https?:|file:|\/|\.\.?(?:\/|\\)|[A-Za-z]:[\\/])/.test(value)
    || /\.(?:mp4|m4v|mov|webm|mp3|wav|m4a|aac|ogg|opus|flac|png|jpe?g|gif|webp|avif|heic|svg|cube)(?:[?#].*)?$/i.test(value);
}

function freezeRecursively(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeRecursively(child, seen);
  Object.freeze(value);
}

/** Capture the exact serializable project/timeline state used by a background export. */
export function immutableExportSnapshot<Value>(value: Value): Value {
  const snapshot = structuredClone(value);
  freezeRecursively(snapshot, new WeakSet());
  return snapshot;
}

export function collectExportMediaPlan(snapshot: unknown): ExportMediaPlan {
  const references: ExportMediaReference[] = [];
  const issues: ExportMediaIssue[] = [];
  const referenceKeys = new Set<string>();
  const issueKeys = new Set<string>();
  const timelines = new Map<string, SnapshotObject>();
  const anonymousTimelines: SnapshotObject[] = [];
  const root = snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : null;

  const addIssue = (issue: ExportMediaIssue) => {
    const key = `${issue.code}\0${issue.owner}\0${issue.timelineId ?? ''}\0${issue.itemId ?? ''}\0${issue.field ?? ''}\0${issue.source ?? ''}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push(issue);
  };
  const addReference = (reference: ExportMediaReference) => {
    const source = reference.source.trim();
    const key = `${source}\0${reference.owner}\0${reference.timelineId ?? ''}\0${reference.itemId ?? ''}\0${reference.assetId ?? ''}`;
    if (referenceKeys.has(key)) return;
    referenceKeys.add(key);
    references.push({ ...reference, source });
  };
  const registerTimeline = (value: unknown, fallbackId?: string) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || !Array.isArray(propertyOf(value, 'items'))) return;
    const id = stringField(value, 'id') ?? fallbackId;
    if (id) timelines.set(id, value);
    else anonymousTimelines.push(value);
  };

  if (root) {
    registerTimeline(root);
    const projectTimelines = propertyOf(root, 'timelines');
    if (Array.isArray(projectTimelines)) {
      for (const timeline of projectTimelines) registerTimeline(timeline);
    }
    for (const containerKey of ['sequenceTimelines', 'sequences', 'timelineById']) {
      const container = propertyOf(root, containerKey);
      if (container === null || typeof container !== 'object' || Array.isArray(container)) continue;
      for (const [id, timeline] of Object.entries(container)) registerTimeline(timeline, id);
    }
  }

  const assets = new Map<string, SnapshotObject>();
  const registerAssets = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const asset of value) {
      if (asset === null || typeof asset !== 'object' || Array.isArray(asset)) continue;
      const id = stringField(asset, 'id');
      if (id) assets.set(id, asset);
    }
  };
  registerAssets(root ? propertyOf(root, 'assets') : undefined);
  for (const timeline of [...timelines.values(), ...anonymousTimelines]) {
    registerAssets(propertyOf(timeline, 'assets'));
  }

  const scanMediaFields = (
    value: unknown,
    owner: ExportMediaOwner,
    context: Omit<ExportMediaReference, 'source' | 'owner' | 'field'>,
    fieldPrefix: string,
    seen: WeakSet<object>,
  ) => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry, index) => scanMediaFields(entry, owner, context, `${fieldPrefix}[${index}]`, seen));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (fieldPrefix === 'item' && key === 'effects') continue;
      const field = fieldPrefix ? `${fieldPrefix}.${key}` : key;
      if (typeof child === 'string' && /assetId$/i.test(key)) {
        const asset = assets.get(child);
        const assetSource = asset ? stringField(asset, 'src') : undefined;
        if (assetSource) addReference({ ...context, source: assetSource, owner, assetId: child, field });
      } else if (typeof child === 'string' && mediaField(key) && mediaLookingValue(child)) {
        addReference({ ...context, source: child, owner, field });
      } else if (child && typeof child === 'object') {
        scanMediaFields(child, owner, context, field, seen);
      }
    }
  };

  const visited = new Set<SnapshotObject>();
  const visitTimeline = (timeline: SnapshotObject, fallbackTimelineId?: string) => {
    if (visited.has(timeline)) return;
    visited.add(timeline);
    const timelineId = stringField(timeline, 'id') ?? fallbackTimelineId;
    const rawItems = propertyOf(timeline, 'items');
    const items: SnapshotObject[] = [];
    if (Array.isArray(rawItems)) {
      for (const item of rawItems) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) items.push(item);
      }
    }
    const itemsById = new Map<string, SnapshotObject>();
    for (const item of items) {
      const id = stringField(item, 'id');
      if (id) itemsById.set(id, item);
    }

    for (const item of items) {
      const itemId = stringField(item, 'id');
      const kind = stringField(item, 'kind') ?? '';
      const owner: ExportMediaOwner = kind === 'audio' ? 'audio' : kind === 'sequence' ? 'sequence' : 'item';
      let source = stringField(item, 'src');
      const itemAssetId = stringField(item, 'mediaAssetId') ?? stringField(item, 'sourceAssetId');
      const itemAsset = itemAssetId ? assets.get(itemAssetId) : undefined;
      if (!source && itemAsset) source = stringField(itemAsset, 'src');
      if (source) {
        addReference({ source, owner, timelineId, itemId, assetId: itemAssetId, field: 'src' });
      } else if (MEDIA_ITEM_KINDS[kind]) {
        addIssue({
          code: 'missing_source',
          source: null,
          owner,
          timelineId,
          itemId,
          assetId: itemAssetId,
          field: 'src',
          message: `Media item ${itemId ?? '(unknown)'} has no source`,
        });
      }

      const effects = propertyOf(item, 'effects');
      if (Array.isArray(effects)) {
        for (const effect of effects) {
          if (effect === null || typeof effect !== 'object' || Array.isArray(effect)) continue;
          const assetId = stringField(effect, 'assetId');
          scanMediaFields(effect, 'effect', { timelineId, itemId, assetId }, 'effect', new WeakSet());
          const fxDefs = propertyOf(timeline, 'fxDefs');
          const fxDef = assetId && fxDefs !== null && typeof fxDefs === 'object' && !Array.isArray(fxDefs)
            ? propertyOf(fxDefs, assetId)
            : undefined;
          if (fxDef !== null && typeof fxDef === 'object') {
            scanMediaFields(fxDef, 'effect', { timelineId, itemId, assetId }, 'fxDef', new WeakSet());
          }
        }
      }
      scanMediaFields(item, owner, { timelineId, itemId, assetId: itemAssetId }, 'item', new WeakSet());

      if (kind === 'sequence') {
        const nestedId = stringField(item, 'timelineId');
        const nested = nestedId ? timelines.get(nestedId) : undefined;
        if (!nested) {
          addIssue({
            code: 'missing_sequence',
            source: null,
            owner: 'sequence',
            timelineId,
            itemId,
            field: 'timelineId',
            message: nestedId
              ? `Sequence ${itemId ?? '(unknown)'} references missing timeline ${nestedId}`
              : `Sequence ${itemId ?? '(unknown)'} has no timeline reference`,
          });
        } else {
          visitTimeline(nested, nestedId);
        }
      }
    }

    const transitions = propertyOf(timeline, 'transitions');
    if (Array.isArray(transitions)) {
      for (const transition of transitions) {
        if (transition === null || typeof transition !== 'object' || Array.isArray(transition)) continue;
        if (propertyOf(transition, 'enabled') === false) continue;
        scanMediaFields(transition, 'transition', {
          timelineId,
          itemId: stringField(transition, 'outgoingItemId'),
        }, 'transition', new WeakSet());
      }
    }

    const captionPayloads: unknown[] = [propertyOf(timeline, 'captions')];
    const tracks = propertyOf(timeline, 'tracks');
    if (tracks !== null && typeof tracks === 'object' && !Array.isArray(tracks)) {
      for (const track of Object.values(tracks)) {
        if (track !== null && typeof track === 'object' && !Array.isArray(track)) {
          captionPayloads.push(propertyOf(track, 'captions'));
        }
      }
    }
    for (const captions of captionPayloads) {
      if (captions === null || typeof captions !== 'object' || Array.isArray(captions)) continue;
      if (propertyOf(captions, 'enabled') === false) continue;
      scanMediaFields(captions, 'caption', { timelineId }, 'captions', new WeakSet());
      const sourceIds = new Set<string>();
      const sourceItemId = stringField(captions, 'sourceItemId');
      if (sourceItemId) sourceIds.add(sourceItemId);
      const sources = propertyOf(captions, 'sources');
      if (Array.isArray(sources)) {
        for (const id of sources) if (typeof id === 'string' && id) sourceIds.add(id);
      }
      const sourceEntries = propertyOf(captions, 'sourceEntries');
      if (Array.isArray(sourceEntries)) {
        for (const entry of sourceEntries) {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
          const id = stringField(entry, 'itemId');
          if (id && !id.startsWith('manual:')) sourceIds.add(id);
        }
      }
      for (const sourceId of sourceIds) {
        if (itemsById.has(sourceId)) continue;
        addIssue({
          code: 'missing_reference',
          source: null,
          owner: 'caption',
          timelineId,
          itemId: sourceId,
          field: 'sourceItemId',
          message: `Captions reference missing item ${sourceId}`,
        });
      }
    }
  };

  if (root && Array.isArray(propertyOf(root, 'items'))) {
    visitTimeline(root, stringField(root, 'id'));
  } else if (root) {
    const activeId = stringField(root, 'activeTimelineId');
    const active = activeId ? timelines.get(activeId) : timelines.values().next().value;
    if (active) visitTimeline(active, activeId);
  }

  return Object.freeze({
    references: Object.freeze(references),
    issues: Object.freeze(issues),
  });
}

async function readableFromBrowser(reference: ExportMediaReference, fetcher: typeof fetch): Promise<ExportMediaIssue | null> {
  if (reference.source.startsWith('data:')) return null;
  if (/^(?:file:|[A-Za-z]:[\\/])/.test(reference.source)) {
    return {
      ...reference,
      code: 'unsupported_source',
      message: `Browser export cannot read local file source: ${reference.source}`,
    };
  }
  let response: Response | undefined;
  try {
    response = await fetcher(reference.source, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    const htmlFallback = contentType === 'text/html';
    const readable = (response.status === 200 || response.status === 206) && !htmlFallback;
    return readable ? null : {
      ...reference,
      code: response.status === 404 || htmlFallback ? 'missing_source' : 'unreadable',
      message: htmlFallback
        ? `Media source resolved to HTML instead of media (HTTP ${response.status}): ${reference.source}`
        : `Media source is not readable (HTTP ${response.status}): ${reference.source}`,
    };
  } catch (error) {
    return {
      ...reference,
      code: 'unreadable',
      message: `Media source is not readable: ${reference.source} (${error instanceof Error ? error.message : String(error)})`,
    };
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}

/** Browser-side gate. No render or server job may start until every source passes. */
export async function assertExportMediaReadable(
  snapshot: unknown,
  fetcher: typeof fetch = fetch,
): Promise<ExportMediaPlan> {
  const plan = collectExportMediaPlan(snapshot);
  const checked = await Promise.all(plan.references.map((reference) => readableFromBrowser(reference, fetcher)));
  const issues = [...plan.issues, ...checked.filter((issue): issue is ExportMediaIssue => issue !== null)];
  if (issues.length > 0) {
    throw new ExportFailureError(createExportFailure({
      stage: 'preflight',
      code: 'export_media_preflight_failed',
      retryable: false,
      message: `Export media preflight failed for ${issues.length} reference${issues.length === 1 ? '' : 's'}`,
      mediaIssues: issues,
    }));
  }
  return plan;
}
