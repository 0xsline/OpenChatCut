import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/icons';
import type { MediaAsset } from '../../editor/types';
import { useT } from '../../i18n/locale';
import { isSemanticMedia } from './mediaFrames';
import { MAX_SEMANTIC_QUERY_LENGTH, type SemanticMatch } from './types';
import { useSemanticSearch } from './useSemanticSearch';
import './semantic-search.css';

interface SemanticSearchControlsProps {
  scopeId: string;
  assets: MediaAsset[];
  onResultsChange: (matches: SemanticMatch[] | null) => void;
}

export function SemanticSearchControls({ scopeId, assets, onResultsChange }: SemanticSearchControlsProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchedQuery, setSearchedQuery] = useState('');
  const semantic = useSemanticSearch(scopeId, assets);
  const visualAssets = useMemo(() => assets.filter(isSemanticMedia), [assets]);
  const names = useMemo(() => new Map(assets.map((asset) => [asset.id, asset.name])), [assets]);
  useEffect(() => {
    onResultsChange(searchedQuery ? semantic.state.matches : null);
  }, [onResultsChange, searchedQuery, semantic.state.matches]);
  return <div className="cc-semantic-anchor">
    <button type="button" className={`cc-media-icon cc-semantic-trigger${open || searchedQuery ? ' active' : ''}`}
      aria-label={t('语义搜索')} title={t('本地语义搜索')} onClick={() => setOpen((value) => !value)}>
      <Icon name="sparkles" size={17} />
    </button>
    {open && <SemanticPanel assets={visualAssets} names={names} query={query} setQuery={setQuery}
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

function SemanticPanel(props: SemanticPanelProps) {
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
  return <section className="cc-semantic-panel" role="dialog" aria-label={t('本地语义搜索')}>
    <PanelHeader onClose={props.onClose} t={t} />
    {semantic.state.status === 'idle' || semantic.state.status === 'error'
      ? <EnableView state={semantic.state} onEnable={() => void semantic.enable()} t={t} />
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

function EnableView({ state, onEnable, t }: ViewProps & { onEnable: () => void }) {
  return <div className="cc-semantic-empty">
    <Icon name="sparkles" size={28} />
    <strong>{t('按画面内容搜索素材')}</strong>
    <p>{t('首次启用会下载可选模型。索引和搜索都在本机完成，不影响未启用时的编辑器。')}</p>
    {state.error && <span className="cc-semantic-error">{t('语义搜索暂不可用，请重试。')}</span>}
    <button type="button" className="primary" onClick={onEnable}>{t('启用本地模型')}</button>
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
    <SearchResults state={state} names={props.names} t={t} />
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
