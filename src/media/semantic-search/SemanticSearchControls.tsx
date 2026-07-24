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
      aria-label={t('Semantic search')} title={t('local semantic search')} onClick={() => setOpen((value) => !value)}>
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
  return <section className="cc-semantic-panel" role="dialog" aria-label={t('local semantic search')}>
    <PanelHeader onClose={props.onClose} t={t} />
    {semantic.state.status === 'idle' || semantic.state.status === 'error'
      ? <EnableView state={semantic.state} onEnable={() => void semantic.enable()} t={t} />
      : <ReadyView {...props} state={semantic.state} runSearch={runSearch} clearSearch={clearSearch}
          index={() => void semantic.index()} rebuild={() => void rebuild()} cancel={semantic.cancel} disable={disable} />}
  </section>;
}

function PanelHeader({ onClose, t }: { onClose: () => void; t: Translate }) {
  return <header>
    <div><strong>{t('local semantic search')}</strong><span>{t('Materials will not be uploaded')}</span></div>
    <button type="button" aria-label={t('close')} onClick={onClose}><Icon name="x" size={15} /></button>
  </header>;
}

interface ViewProps {
  state: SemanticApi['state'];
  t: Translate;
}

function EnableView({ state, onEnable, t }: ViewProps & { onEnable: () => void }) {
  return <div className="cc-semantic-empty">
    <Icon name="sparkles" size={28} />
    <strong>{t('Search materials by screen content')}</strong>
    <p>{t('Optional models are downloaded upon first activation. Indexing and searching are done locally and do not affect the editor when it is not enabled.')}</p>
    {state.error && <span className="cc-semantic-error">{t('Semantic search is temporarily unavailable, please try again.')}</span>}
    <button type="button" className="primary" onClick={onEnable}>{t('Enable local model')}</button>
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
      <input value={props.query} maxLength={MAX_SEMANTIC_QUERY_LENGTH} onChange={(event) => props.setQuery(event.target.value)} placeholder={t('For example: beach sunset, city night view')} disabled={busy} />
      {props.query && <button type="button" onClick={props.clearSearch}><Icon name="x" size={14} /></button>}
      <button type="submit" className="primary" disabled={busy || !props.query.trim()}>{t('Search')}</button>
    </form>
    <IndexStatus {...props} />
    <SearchResults state={state} names={props.names} t={t} />
    <DuplicateResults state={state} names={props.names} t={t} />
  </div>;
}

function LoadingView({ state, cancel, t }: ViewProps & { cancel: () => void }) {
  return <div className="cc-semantic-loading">
    <strong>{t('Preparing local model...')}</strong>
    <progress max={100} value={state.modelProgress} />
    <span>{Math.round(state.modelProgress)}% · {state.device === 'webgpu' ? t('GPU speed up') : t('CPU mode')}</span>
    <button type="button" onClick={cancel}>{t('Cancel')}</button>
  </div>;
}

function IndexStatus(props: ReadyViewProps) {
  const { assets, state, t } = props;
  const indexing = state.status === 'indexing';
  const allIndexed = assets.length > 0 && state.indexedAssets >= assets.length;
  return <div className="cc-semantic-index-status">
    <div><strong>{indexing ? t('Indexing...') : t('local index')}</strong><span>{indexing
      ? t('Processed {done} / {total}', { done: state.indexedAssets, total: state.totalAssets })
      : t('Indexed {done} / {total} visual material', { done: Math.min(state.indexedAssets, assets.length), total: assets.length })}</span></div>
    {indexing ? <button type="button" onClick={props.cancel}>{t('Cancel')}</button> : <div>
      <button type="button" disabled={allIndexed || assets.length === 0} onClick={props.index}>{t('Index new material')}</button>
      <button type="button" onClick={props.rebuild}>{t('rebuild')}</button>
      <button type="button" onClick={props.disable}>{t('Deactivate local model')}</button>
    </div>}
    {state.skippedAssets > 0 && <small>{t('Yes {n} The material cannot be decoded and has been skipped', { n: state.skippedAssets })}</small>}
  </div>;
}

function SearchResults({ state, names, t }: ViewProps & { names: Map<string, string> }) {
  if (state.matches.length === 0) return null;
  return <div className="cc-semantic-results">
    <strong>{t('Semantic results {n} a', { n: state.matches.length })}</strong>
    {state.matches.slice(0, 5).map((match) => <span key={`${match.assetId}:${match.sampleTime}`}>
      <b>{names.get(match.assetId) ?? match.assetId}</b>
      <em>{match.sampleTime > 0 ? formatTime(match.sampleTime) : `${Math.round(match.score * 100)}%`}</em>
    </span>)}
  </div>;
}

function DuplicateResults({ state, names, t }: ViewProps & { names: Map<string, string> }) {
  if (state.duplicates.length === 0) return null;
  return <div className="cc-semantic-results">
    <strong>{t('Suspected duplicate material')}</strong>
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
