import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../components/icons';
import type { MediaAsset } from '../../editor/types';
import { useT } from '../../i18n/locale';
import { isSemanticMedia } from './mediaFrames';
import { resolveSemanticPanelRect } from './semanticPanelPosition';
import { MAX_SEMANTIC_QUERY_LENGTH, type SemanticMatch } from './types';
import { useSemanticSearch } from './useSemanticSearch';
import {
  DEFAULT_SAMPLING_CONFIG,
  normalizeSamplingConfig,
  readSamplingConfig,
  writeSamplingConfig,
  type SemanticSamplingConfig,
} from './samplingConfig';
import { showAppToast } from '../../ui/appToast';
import './semantic-search.css';

interface SemanticSearchControlsProps {
  scopeId: string;
  assets: MediaAsset[];
  onResultsChange: (matches: SemanticMatch[] | null) => void;
  openRequest?: number;
}

export function SemanticSearchControls({ scopeId, assets, onResultsChange, openRequest = 0 }: SemanticSearchControlsProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchedQuery, setSearchedQuery] = useState('');
  const anchorRef = useRef<HTMLDivElement>(null);
  const semantic = useSemanticSearch(scopeId, assets);
  const visualAssets = useMemo(() => assets.filter(isSemanticMedia), [assets]);
  const names = useMemo(() => new Map(assets.map((asset) => [asset.id, asset.name])), [assets]);
  useEffect(() => {
    onResultsChange(searchedQuery ? semantic.state.matches : null);
  }, [onResultsChange, searchedQuery, semantic.state.matches]);
  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);
  return <div ref={anchorRef} className="cc-semantic-anchor">
    <button type="button" className={`cc-media-icon cc-semantic-trigger cc-tip${open || searchedQuery ? ' active' : ''}`}
      aria-label={t('语义搜索')} data-tip={t('本地语义搜索')} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen((value) => !value)}>
      <Icon name="sparkles" size={17} />
    </button>
    {open && <SemanticPanelPortal anchorRef={anchorRef} assets={visualAssets} names={names} query={query} setQuery={setQuery}
      setSearchedQuery={setSearchedQuery} semantic={semantic} onClose={() => setOpen(false)} t={t} />}
  </div>;
}

type SemanticApi = ReturnType<typeof useSemanticSearch>;
type Translate = ReturnType<typeof useT>;

interface SemanticPanelProps {
  assets: MediaAsset[];
  names: Map<string, string>;
  query: string;
  setQuery: (value: string) => void;
  setSearchedQuery: (value: string) => void;
  semantic: SemanticApi;
  onClose: () => void;
  t: Translate;
}

function SemanticPanelPortal(props: SemanticPanelProps & { anchorRef: RefObject<HTMLDivElement | null> }) {
  const { anchorRef, onClose } = props;
  const panelRef = useRef<HTMLElement>(null);
  const position = useSemanticPanelPosition(anchorRef, panelRef);
  useEffect(() => {
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !anchorRef.current?.contains(target)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [anchorRef, onClose]);
  return createPortal(<SemanticPanel {...props} panelRef={panelRef} style={position} />, document.body);
}

function useSemanticPanelPosition(
  anchorRef: RefObject<HTMLDivElement | null>,
  panelRef: RefObject<HTMLElement | null>,
): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const anchorRect = anchor.getBoundingClientRect();
      const bounds = anchor.closest('.cc-library-panel')?.getBoundingClientRect()
        ?? document.documentElement.getBoundingClientRect();
      setPosition(resolveSemanticPanelRect(
        anchorRect, bounds, { width: window.innerWidth, height: window.innerHeight }, panel.offsetHeight,
      ));
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef, panelRef]);
  return position;
}

function SemanticPanel(props: SemanticPanelProps & {
  panelRef: RefObject<HTMLElement | null>;
  style: CSSProperties;
}) {
  const { semantic, t } = props;
  const runSearch = () => {
    const next = props.query.trim();
    props.setSearchedQuery(next);
    void semantic.search(next);
  };
  const clearSearch = () => {
    props.setQuery('');
    props.setSearchedQuery('');
    void semantic.search('');
  };
  const rebuild = async () => {
    if (await semantic.reset()) await semantic.index();
  };
  const disable = () => {
    props.setQuery('');
    props.setSearchedQuery('');
    semantic.cancel();
  };
  return <section ref={props.panelRef} style={props.style} className="cc-semantic-panel" role="dialog" aria-label={t('本地语义搜索')}>
    <PanelHeader onClose={props.onClose} t={t} />
    {semantic.state.status === 'idle' || semantic.state.status === 'error'
      ? <EnableView state={semantic.state} onEnable={() => void semantic.enable()}
          onInstall={() => void semantic.installAndEnable()} t={t} />
      : <ReadyView {...props} state={semantic.state} runSearch={runSearch} clearSearch={clearSearch}
          index={() => void semantic.index()} rebuild={() => void rebuild()} cancel={semantic.cancel} disable={disable} />}
  </section>;
}

function PanelHeader({ onClose, t }: { onClose: () => void; t: Translate }) {
  return <header>
    <div><strong>{t('本地语义搜索')}</strong><span>{t('素材不会上传')}</span></div>
    <button type="button" aria-label={t('关闭')} onClick={onClose}><Icon name="x" size={15} /></button>
  </header>;
}

interface ViewProps {
  state: SemanticApi['state'];
  t: Translate;
}

function EnableView({ state, onEnable, onInstall, t }: ViewProps & {
  onEnable: () => void;
  onInstall: () => void;
}) {
  const packAbsent = state.pack === 'absent' || state.pack === 'error';
  const packDownloading = state.pack === 'downloading';
  return <div className="cc-semantic-empty">
    <span className="cc-semantic-empty-icon"><Icon name="sparkles" size={18} /></span>
    <div><strong>{t('按画面内容搜索素材')}</strong>
      <p>{t('索引和搜索都在本机完成，素材不会上传，不影响未启用时的编辑器。')}</p>
    </div>
    {packAbsent && (
      <div className="cc-semantic-pack-missing">
        <p>{state.pack === 'error'
          ? t('模型包下载失败，请到 设置 → 本地模型 重试。')
          : t('首次使用需要下载可选模型包（约 178MB）。模型在本机运行，素材不会上传。')}</p>
        <button type="button" className="primary" onClick={onInstall}>
          <Icon name="download" size={13} />{t('下载并启用')}
        </button>
      </div>
    )}
    {packDownloading && (
      <div className="cc-semantic-pack-missing">
        <p>{t('正在下载画面语义轻量包… {n}%', { n: state.packProgress })}</p>
      </div>
    )}
    {!packAbsent && !packDownloading && <>
      {state.error && <span className="cc-semantic-error">{t('语义搜索暂不可用，请重试。')}</span>}
      <button type="button" className="primary" onClick={onEnable}><Icon name="sparkles" size={13} />{t('启用本地模型')}</button>
    </>}
  </div>;
}

interface ReadyViewProps extends ViewProps, Omit<SemanticPanelProps, 'semantic' | 'onClose'> {
  runSearch: () => void;
  clearSearch: () => void;
  index: () => void;
  rebuild: () => void;
  cancel: () => void;
  disable: () => void;
}

function ReadyView(props: ReadyViewProps) {
  const { state, t } = props;
  if (state.status === 'loading') return <LoadingView state={state} cancel={props.cancel} t={t} />;
  const busy = state.status === 'indexing' || state.status === 'searching';
  return <div className="cc-semantic-ready">
    <form onSubmit={(event) => { event.preventDefault(); props.runSearch(); }}>
      <Icon name="search" size={15} />
      <input value={props.query} maxLength={MAX_SEMANTIC_QUERY_LENGTH} onChange={(event) => props.setQuery(event.target.value)} placeholder={t('例如：海边日落、城市夜景')} disabled={busy} />
      {props.query && <button type="button" onClick={props.clearSearch}><Icon name="x" size={14} /></button>}
      <button type="submit" className="primary" disabled={busy || !props.query.trim()}>{t('搜索')}</button>
    </form>
    <IndexStatus {...props} />
    <SamplingSettings t={t} />
    <SearchResults state={state} names={props.names} t={t} />
    <TextResults state={state} names={props.names} t={t} />
    <DuplicateResults state={state} names={props.names} t={t} />
  </div>;
}

function LoadingView({ state, cancel, t }: ViewProps & { cancel: () => void }) {
  return <div className="cc-semantic-loading">
    <strong>{t('正在准备本地模型…')}</strong>
    <progress max={100} value={state.modelProgress} />
    <span>{Math.round(state.modelProgress)}% · {state.device === 'webgpu' ? t('GPU 加速') : t('CPU 模式')}</span>
    <button type="button" onClick={cancel}>{t('取消')}</button>
  </div>;
}

function IndexStatus(props: ReadyViewProps) {
  const { assets, state, t } = props;
  const indexing = state.status === 'indexing';
  const allIndexed = assets.length > 0 && state.indexedAssets >= assets.length;
  return <div className="cc-semantic-index-status">
    <div><strong>{indexing ? t('正在建立索引…') : t('本地索引')}</strong><span>{indexing
      ? t('已处理 {done} / {total}', { done: state.indexedAssets, total: state.totalAssets })
      : t('已索引 {done} / {total} 个可视素材', { done: Math.min(state.indexedAssets, assets.length), total: assets.length })}</span></div>
    {indexing ? <button type="button" onClick={props.cancel}>{t('取消')}</button> : <div>
      <button type="button" disabled={allIndexed || assets.length === 0} onClick={props.index}>{t('索引新素材')}</button>
      <button type="button" onClick={props.rebuild}>{t('重建')}</button>
      <button type="button" onClick={props.disable}>{t('停用本地模型')}</button>
    </div>}
    {state.skippedAssets > 0 && <small>{t('有 {n} 个素材无法解码，已跳过', { n: state.skippedAssets })}</small>}
  </div>;
}

function SearchResults({ state, names, t }: ViewProps & { names: Map<string, string> }) {
  if (state.matches.length === 0) return null;
  return <div className="cc-semantic-results">
    <strong>{t('语义结果 {n} 个', { n: state.matches.length })}</strong>
    {state.matches.slice(0, 5).map((match) => <span key={`${match.assetId}:${match.sampleTime}`}>
      <b>{names.get(match.assetId) ?? match.assetId}</b>
      <em>{match.sampleTime > 0 ? formatTime(match.sampleTime) : `${Math.round(match.score * 100)}%`}</em>
    </span>)}
  </div>;
}

function describeTextHit(ref: string): string {
  const separator = ref.lastIndexOf(':');
  if (separator <= 0) return ref;
  const prefix = ref.slice(0, separator);
  const tail = ref.slice(separator + 1);
  if (prefix.startsWith('chat:')) return `聊天第 ${Number(tail) + 1} 条`;
  if (tail === 'captions') return '字幕';
  if (tail === 'transcript') return '转写';
  return ref;
}

function TextResults({ state, t }: ViewProps & { names: Map<string, string> }) {
  if (state.textHits.length === 0) return null;
  return <div className="cc-semantic-results">
    <strong>{t('相关文本 {n} 处', { n: state.textHits.length })}</strong>
    {state.textHits.slice(0, 5).map((hit) => <span key={`${hit.kind}:${hit.ref}`}>
      <b>{describeTextHit(hit.ref)}</b>
      <em>{hit.kind}</em>
    </span>)}
  </div>;
}

function DuplicateResults({ state, names, t }: ViewProps & { names: Map<string, string> }) {
  if (state.duplicates.length === 0) return null;
  return <div className="cc-semantic-results">
    <strong>{t('疑似重复素材')}</strong>
    {state.duplicates.slice(0, 3).map((match) => <span key={`${match.leftAssetId}:${match.rightAssetId}`}>
      <b>{names.get(match.leftAssetId)} ↔ {names.get(match.rightAssetId)}</b>
      <em>{Math.round(match.score * 100)}%</em>
    </span>)}
  </div>;
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

function SamplingSettings({ t }: { t: Translate }) {
  const [draft, setDraft] = useState<SemanticSamplingConfig>(() => readSamplingConfig());
  const update = (field: keyof SemanticSamplingConfig) => (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    setDraft((current) => ({ ...current, [field]: Number(event.target.value) }));
  };
  const save = () => {
    writeSamplingConfig(normalizeSamplingConfig(draft));
    showAppToast(t('采样设置已保存，重建索引后生效。'));
  };
  const reset = () => {
    writeSamplingConfig(DEFAULT_SAMPLING_CONFIG);
    setDraft(DEFAULT_SAMPLING_CONFIG);
    showAppToast(t('采样设置已恢复默认，重建索引后生效。'));
  };
  return <details className="cc-semantic-sampling">
    <summary>{t('采样设置')}</summary>
    <p className="cc-semantic-sampling-note">{t('索引帧采样与搜索参数，网页与桌面端通用。改动索引相关项需重建索引生效。')}</p>
    <label>
      <span>{t('兜底间隔（秒）')}</span>
      <input type="number" min={1} max={300} value={draft.intervalSeconds}
        onChange={update('intervalSeconds')} />
    </label>
    <label>
      <span>{t('兜底最大帧数')}</span>
      <input type="number" min={1} max={480} value={draft.maxFallbackFrames}
        onChange={update('maxFallbackFrames')} />
    </label>
    <label>
      <span>{t('场景模式上限')}</span>
      <input type="number" min={1} max={480} value={draft.maxSceneFrames}
        onChange={update('maxSceneFrames')} />
    </label>
    <label>
      <span>{t('搜索结果条数')}</span>
      <input type="number" min={1} max={100} value={draft.resultLimit}
        onChange={update('resultLimit')} />
    </label>
    <label>
      <span>{t('搜索结果相对下限')}</span>
      <input type="number" min={0} max={1} step={0.01} value={draft.relativeFloor}
        onChange={update('relativeFloor')} />
    </label>
    <label>
      <span>{t('疑似重复阈值')}</span>
      <input type="number" min={0} max={0.999} step={0.001} value={draft.duplicateThreshold}
        onChange={update('duplicateThreshold')} />
    </label>
    <label>
      <span>{t('长视频阈值（秒）')}</span>
      <input type="number" min={10} max={600} value={draft.longVideoSeconds}
        onChange={update('longVideoSeconds')} />
    </label>
    <div className="cc-semantic-sampling-actions">
      <button type="button" onClick={save}>{t('保存')}</button>
      <button type="button" onClick={reset}>{t('恢复默认')}</button>
    </div>
  </details>;
}
