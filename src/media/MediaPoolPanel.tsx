import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/icons';
import type { MediaAsset, MediaFolder } from '../editor/types';
import { usePersistedState } from '../hooks/usePersistedState';
import { importMedia } from './upload';

interface MediaPoolPanelProps {
  assets: MediaAsset[];
  folders: MediaFolder[];
  fps: number;
  onImport: (file: File) => Promise<void>;
  onAddAsset: (asset: MediaAsset) => void;
  onCreateFolder: (name: string, parentId?: string) => string;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveAssets: (ids: string[], folderId?: string) => void;
  onRenameAsset: (id: string, name: string) => void;
  onSetFavorite: (id: string, favorite: boolean) => void;
  /** source Relink File — replace offline/missing asset + clip srcs */
  onRelinkAsset?: (id: string, next: { src: string; name?: string; durationInFrames?: number; width?: number; height?: number; kind?: MediaAsset['kind'] }) => void;
  /** Add solid color clip (source solid) */
  onAddSolid?: () => void;
}

type SortKey = 'newest' | 'name' | 'duration';
type TypeFilter = 'all' | MediaAsset['kind'];
type PromptState = { title: string; initialValue: string; rejectSlash?: boolean; onSubmit: (value: string) => void };
type DeleteState = { id: string; name: string; parentId?: string };

function folderPath(folder: MediaFolder, folders: MediaFolder[]): string {
  const parts = [folder.name];
  const seen = new Set([folder.id]);
  let parentId = folder.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = folders.find((item) => item.id === parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parentId;
  }
  return parts.join('/');
}

function durationLabel(frames: number, fps: number): string {
  const seconds = Math.max(0, Math.round(frames / fps));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function MediaPoolPanel({
  assets, folders, fps, onImport, onAddAsset, onCreateFolder, onRenameFolder,
  onDeleteFolder, onMoveAssets, onRenameAsset, onSetFavorite, onRelinkAsset, onAddSolid,
}: MediaPoolPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const relinkInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');
  const [type, setType] = useState<TypeFilter>('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [view, setView] = usePersistedState<'grid' | 'list'>('cc.mediaView', 'grid');
  const [menu, setMenu] = useState<'sort' | 'filter' | null>(null);
  const [assetMenu, setAssetMenu] = useState<string | null>(null);
  /** fixed-position menu so overflow:auto grid doesn't clip 收藏/重命名/文件夹 */
  const [assetMenuPos, setAssetMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null);
  /** asset ids whose media failed to load (source "Click to relink") */
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  const [relinkTarget, setRelinkTarget] = useState<string | null>(null);
  const [showRelinkAll, setShowRelinkAll] = useState(false);

  useEffect(() => {
    if (!assetMenu) return;
    const close = () => { setAssetMenu(null); setAssetMenuPos(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [assetMenu]);

  // Probe file-backed assets; mark offline when HEAD/fetch fails (source missing media).
  useEffect(() => {
    let cancelled = false;
    const fileAssets = assets.filter((a) => a.kind !== 'motion-graphic' && a.src);
    void (async () => {
      const next = new Set<string>();
      await Promise.all(fileAssets.map(async (asset) => {
        try {
          const res = await fetch(asset.src, { method: 'HEAD' });
          if (!res.ok) next.add(asset.id);
        } catch {
          next.add(asset.id);
        }
      }));
      if (!cancelled) setMissing(next);
    })();
    return () => { cancelled = true; };
  }, [assets]);

  const markMissing = (id: string) => setMissing((s) => new Set(s).add(id));
  const clearMissing = (id: string) => setMissing((s) => {
    if (!s.has(id)) return s;
    const n = new Set(s);
    n.delete(id);
    return n;
  });

  const startRelink = (id: string) => {
    setRelinkTarget(id);
    requestAnimationFrame(() => relinkInputRef.current?.click());
  };

  const onRelinkPick = async (files: FileList | null) => {
    const file = files?.[0];
    const id = relinkTarget;
    setRelinkTarget(null);
    if (relinkInputRef.current) relinkInputRef.current.value = '';
    if (!file || !id || !onRelinkAsset) return;
    setBusy(true);
    setError(null);
    try {
      const next = await importMedia(file, fps);
      onRelinkAsset(id, {
        src: next.src,
        name: next.name,
        durationInFrames: next.durationInFrames,
        width: next.width,
        height: next.height,
        kind: next.kind,
      });
      clearMissing(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const missingList = assets.filter((a) => missing.has(a.id));

  const currentFolder = folders.find((folder) => folder.id === currentFolderId);
  const childFolders = folders.filter((folder) => folder.parentId === currentFolderId);
  const order = new Map(assets.map((asset, index) => [asset.id, index]));
  const q = query.trim().toLowerCase();
  const visible = assets
    .filter((asset) => (q ? asset.name.toLowerCase().includes(q) : asset.folderId === currentFolderId))
    .filter((asset) => type === 'all' || asset.kind === type)
    .filter((asset) => !favoritesOnly || asset.favorite)
    .sort((a, b) => sort === 'name'
      ? a.name.localeCompare(b.name, 'zh-CN')
      : sort === 'duration'
        ? b.durationInFrames - a.durationInFrames
        : (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0));
  const selectedAssets = assets.filter((asset) => selected.has(asset.id));

  const onPick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) await onImport(file);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };
  const openPrompt = (next: PromptState) => { setPromptValue(next.initialValue); setPromptState(next); };
  const submitPrompt = () => {
    const value = promptValue.trim();
    if (!promptState || !value) return;
    if (promptState.rejectSlash && value.includes('/')) { setError('名称不能包含 /'); return; }
    promptState.onSubmit(value);
    setPromptState(null);
  };
  const createFolder = () => openPrompt({
    title: '新文件夹名称', initialValue: '', rejectSlash: true,
    onSubmit: (name) => setCurrentFolderId(onCreateFolder(name, currentFolderId)),
  });
  const renameFolder = () => currentFolder && openPrompt({
    title: '重命名文件夹', initialValue: currentFolder.name, rejectSlash: true,
    onSubmit: (name) => onRenameFolder(currentFolder.id, name),
  });
  const deleteFolder = () => {
    if (currentFolder && !assets.some((asset) => asset.folderId === currentFolder.id)
      && !folders.some((folder) => folder.parentId === currentFolder.id)) {
      setDeleteState({ id: currentFolder.id, name: currentFolder.name, parentId: currentFolder.parentId });
    }
  };
  const toggleSelected = (id: string) => setSelected((old) => {
    const next = new Set(old);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected((old) => {
    const next = new Set(old);
    const allSelected = visible.length > 0 && visible.every((asset) => next.has(asset.id));
    for (const asset of visible) { if (allSelected) next.delete(asset.id); else next.add(asset.id); }
    return next;
  });

  return (
    <div className="cc-media-pool" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void onPick(event.dataTransfer.files); }}>
      <input ref={inputRef} type="file" accept="video/*,image/*,audio/*,.gif,.svg,image/gif,image/svg+xml" multiple hidden onChange={(event) => onPick(event.target.files)} />
      <input ref={relinkInputRef} type="file" accept="video/*,image/*,audio/*,.gif,.svg,image/gif,image/svg+xml" hidden onChange={(event) => void onRelinkPick(event.target.files)} />
      <div className="cc-media-toolbar">
        <label className="cc-media-search">
          <Icon name="search" size={16} />
          <input aria-label="搜索素材" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" />
        </label>
        <button className="cc-media-icon" aria-label="上传素材" title="上传素材" disabled={busy} onClick={() => inputRef.current?.click()}><Icon name="upload" size={19} /></button>
        {onAddSolid && (
          <button className="cc-media-icon" aria-label="添加纯色" title="添加纯色片段" onClick={onAddSolid} style={{ fontSize: 11, fontWeight: 700 }}>色</button>
        )}
        <button className="cc-media-icon" aria-label="新建文件夹" title="新建文件夹" onClick={createFolder}><Icon name="folderPlus" size={20} /></button>
        <button className="cc-media-icon" aria-label="切换网格列表" title="切换网格/列表" onClick={() => setView((value) => value === 'grid' ? 'list' : 'grid')}><Icon name={view === 'grid' ? 'list' : 'grid'} size={19} /></button>
        <div className="cc-media-menu-anchor">
          <button className={`cc-media-icon${menu === 'sort' ? ' active' : ''}`} aria-label="素材排序" title="排序" onClick={() => setMenu((value) => value === 'sort' ? null : 'sort')}><Icon name="sort" size={19} /></button>
          {menu === 'sort' && <div className="cc-media-popover cc-media-sort-menu">
            {([['newest', '最新导入'], ['name', '名称 A–Z'], ['duration', '时长']] as const).map(([value, label]) => <button key={value} className={sort === value ? 'selected' : ''} onClick={() => { setSort(value); setMenu(null); }}>{label}</button>)}
          </div>}
        </div>
        <div className="cc-media-menu-anchor">
          <button className={`cc-media-icon${menu === 'filter' || type !== 'all' || favoritesOnly ? ' active' : ''}`} aria-label="筛选素材" title="筛选" onClick={() => setMenu((value) => value === 'filter' ? null : 'filter')}><Icon name="filter" size={19} /></button>
          {menu === 'filter' && <div className="cc-media-popover cc-media-filter-menu">
            {([['all', '全部'], ['video', '视频'], ['image', '图片'], ['gif', 'GIF'], ['svg', 'SVG'], ['audio', '音频']] as const).map(([value, label]) => <button key={value} className={type === value ? 'selected' : ''} onClick={() => setType(value)}>{label}</button>)}
            <button className={favoritesOnly ? 'selected' : ''} onClick={() => setFavoritesOnly((value) => !value)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="star" size={13} filled={favoritesOnly} /> 收藏</span></button>
          </div>}
        </div>
      </div>

      {missingList.length > 0 && (
        <div className="cc-media-missing-banner" style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          margin: '0 10px 8px', padding: '8px 10px', borderRadius: 8,
          background: 'rgba(240,136,62,0.12)', border: '1px solid rgba(240,136,62,0.45)',
          fontSize: 12, color: '#f0c9a0',
        }}>
          <span style={{ flex: 1, minWidth: 140 }}>
            有 {missingList.length} 个素材丢失或无法加载。选择文件夹搜索，或从行内重新链接。
          </span>
          <button
            type="button"
            onClick={() => setShowRelinkAll(true)}
            style={{
              background: '#f0883e', color: '#1a1208', border: 'none', borderRadius: 6,
              padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >
            重新链接离线素材
          </button>
        </div>
      )}

      {(currentFolder || childFolders.length > 0) && <div className="cc-media-breadcrumb">
        <button aria-label="返回上级文件夹" disabled={!currentFolder} onClick={() => setCurrentFolderId(currentFolder?.parentId)}>←</button>
        <span>Master{currentFolder ? ` / ${folderPath(currentFolder, folders)}` : ''}</span>
        {currentFolder && <button aria-label="重命名文件夹" onClick={renameFolder}>重命名</button>}
        {currentFolder && <button aria-label="删除空文件夹" disabled={assets.some((asset) => asset.folderId === currentFolder.id) || folders.some((folder) => folder.parentId === currentFolder.id)} onClick={deleteFolder}>删除</button>}
      </div>}
      {error && <div className="cc-media-error">{error}</div>}
      {busy && <div className="cc-media-status">正在导入素材…</div>}

      {selectedAssets.length > 0 && <div className="cc-media-selection">
        <button onClick={toggleAll}>{visible.every((asset) => selected.has(asset.id)) ? '清除选择' : '全选'}</button>
        <span>已选 {selectedAssets.length}</span>
        <button onClick={() => selectedAssets.forEach(onAddAsset)}>加到时间线</button>
        <select aria-label="移动所选素材" defaultValue="" onChange={(event) => { onMoveAssets(selectedAssets.map((asset) => asset.id), event.target.value === '__root__' ? undefined : event.target.value); setSelected(new Set()); event.target.value = ''; }}>
          <option value="" disabled>移动到…</option><option value="__root__">Master</option>
          {folders.map((folder) => <option key={folder.id} value={folder.id}>{folderPath(folder, folders)}</option>)}
        </select>
      </div>}

      <div className={`cc-media-grid ${view}`}>
        {!q && childFolders.map((folder) => <button key={folder.id} className="cc-folder-card" onClick={() => setCurrentFolderId(folder.id)}>
          <span><Icon name="folder" size={34} /></span><strong>{folder.name}</strong>
        </button>)}
        {visible.map((asset) => <div key={asset.id} className={`cc-asset-card${selected.has(asset.id) ? ' selected' : ''}${missing.has(asset.id) ? ' missing' : ''}`}>
          <div className="cc-asset-thumb-wrap">
            <button
              className="cc-asset-thumb"
              title={missing.has(asset.id) ? '点击重新链接' : `加到时间线：${asset.name}`}
              onClick={() => {
                if (missing.has(asset.id) && onRelinkAsset) startRelink(asset.id);
                else onAddAsset(asset);
              }}
            >
              {view === 'list'
                ? <Icon name={asset.kind === 'audio' ? 'music' : asset.kind === 'motion-graphic' ? 'sparkles' : asset.kind === 'gif' || asset.kind === 'svg' ? 'image' : asset.kind} size={16} />
                : missing.has(asset.id)
                  ? (
                    <span style={{ display: 'grid', placeItems: 'center', gap: 4, color: '#f0c9a0', fontSize: 11, padding: 8, textAlign: 'center' }}>
                      <Icon name="swap" size={22} />
                      点击重新链接
                    </span>
                  )
                  : asset.kind === 'image' || asset.kind === 'gif' || asset.kind === 'svg'
                    ? <img src={asset.src} alt={asset.name} onError={() => markMissing(asset.id)} onLoad={() => clearMissing(asset.id)} />
                    : asset.kind === 'video'
                      ? <video src={asset.src} muted preload="metadata" onError={() => markMissing(asset.id)} onLoadedData={() => clearMissing(asset.id)} />
                      : <Icon name={asset.kind === 'motion-graphic' ? 'sparkles' : 'music'} size={42} strokeWidth={2.2} />}
            </button>
            {asset.kind === 'audio' && <span className="cc-asset-audio-mark"><Icon name="volume" size={14} /></span>}
            {(asset.kind === 'gif' || asset.kind === 'svg') && (
              <span className="cc-asset-audio-mark" style={{ left: 4, right: 'auto', fontSize: 9, fontWeight: 700, letterSpacing: 0.3 }}>
                {asset.kind.toUpperCase()}
              </span>
            )}
            <span className="cc-asset-duration">{durationLabel(asset.durationInFrames, fps)}</span>
            <input className="cc-asset-check" aria-label={`选择 ${asset.name}`} type="checkbox" checked={selected.has(asset.id)} onChange={() => toggleSelected(asset.id)} />
            <button className="cc-asset-more" aria-label={`管理 ${asset.name}`}
              onClick={(event) => {
                event.stopPropagation();
                if (assetMenu === asset.id) {
                  setAssetMenu(null);
                  setAssetMenuPos(null);
                  return;
                }
                const r = event.currentTarget.getBoundingClientRect();
                const menuW = 160;
                const menuH = 120;
                const left = Math.min(window.innerWidth - menuW - 8, Math.max(8, r.right - menuW));
                // prefer below the ⋮ button; flip above if near bottom of viewport
                const below = r.bottom + 6;
                const top = below + menuH > window.innerHeight - 8
                  ? Math.max(8, r.top - menuH - 6)
                  : below;
                setAssetMenu(asset.id);
                setAssetMenuPos({ top, left });
              }}
            ><Icon name="more" size={17} /></button>
          </div>
          <button className="cc-asset-name" title={asset.name} onClick={() => onAddAsset(asset)}>{asset.name}</button>
        </div>)}
        {visible.length === 0 && childFolders.length === 0 && (
          <div className="cc-media-empty">
            {assets.length === 0 ? <><Icon name="folder" size={28} /><strong>这个文件夹是空的</strong><span>导入媒体或把素材拖到这里。</span></> : <span>当前筛选下没有素材</span>}
          </div>
        )}
      </div>

      {assetMenu && assetMenuPos && (() => {
        const asset = assets.find((a) => a.id === assetMenu);
        if (!asset) return null;
        return createPortal(
          <>
            <div className="cc-asset-menu-backdrop" onClick={() => { setAssetMenu(null); setAssetMenuPos(null); }} />
            <div className="cc-media-popover cc-asset-menu-portal" style={{ top: assetMenuPos.top, left: assetMenuPos.left }}
              onClick={(e) => e.stopPropagation()}>
              <button type="button" onClick={() => { onSetFavorite(asset.id, !asset.favorite); setAssetMenu(null); setAssetMenuPos(null); }}>
                {asset.favorite ? '取消收藏' : '收藏'}
              </button>
              <button type="button" onClick={() => {
                setAssetMenu(null); setAssetMenuPos(null);
                openPrompt({ title: '素材显示名称', initialValue: asset.name, onSubmit: (name) => onRenameAsset(asset.id, name) });
              }}>重命名</button>
              {onRelinkAsset && asset.kind !== 'motion-graphic' && (
                <button type="button" onClick={() => {
                  setAssetMenu(null); setAssetMenuPos(null);
                  startRelink(asset.id);
                }}>重新链接文件</button>
              )}
              <label className="cc-asset-menu-move">
                <span>移动到</span>
                <select aria-label={`移动 ${asset.name}`} value={asset.folderId ?? ''}
                  onChange={(event) => {
                    onMoveAssets([asset.id], event.target.value || undefined);
                    setAssetMenu(null); setAssetMenuPos(null);
                  }}>
                  <option value="">Master</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>{folderPath(folder, folders)}</option>
                  ))}
                </select>
              </label>
            </div>
          </>,
          document.body,
        );
      })()}

      {promptState && <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={promptState.title}>
        <form className="cc-modal" onSubmit={(event) => { event.preventDefault(); submitPrompt(); }}>
          <strong>{promptState.title}</strong>
          <input autoFocus aria-label={promptState.title} value={promptValue} onChange={(event) => setPromptValue(event.target.value)} />
          <div><button type="button" onClick={() => setPromptState(null)}>取消</button><button type="submit" className="primary">确定</button></div>
        </form>
      </div>}
      {deleteState && <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label="删除空文件夹">
        <div className="cc-modal"><strong>删除空文件夹「{deleteState.name}」？</strong><div><button onClick={() => setDeleteState(null)}>取消</button><button className="danger" onClick={() => { onDeleteFolder(deleteState.id); setCurrentFolderId(deleteState.parentId); setDeleteState(null); }}>删除</button></div></div>
      </div>}

      {showRelinkAll && (
        <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label="重新链接离线素材" onClick={() => setShowRelinkAll(false)}>
          <div className="cc-modal" style={{ width: 'min(420px, 92vw)', maxHeight: '70vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <strong>重新链接离线素材</strong>
            <p style={{ margin: '8px 0 12px', fontSize: 12, color: '#a0a0a0', lineHeight: 1.45 }}>
              工程中的文件已移动或重命名。从下方行直接重新链接缺失文件。
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {missingList.map((asset) => (
                <div key={asset.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, background: '#1e1e1e' }}>
                  <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset.name}</span>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => startRelink(asset.id)}
                    style={{ flexShrink: 0 }}
                  >
                    重新链接文件
                  </button>
                </div>
              ))}
              {missingList.length === 0 && <div style={{ fontSize: 12, color: '#888' }}>没有待重链的素材</div>}
            </div>
            <div style={{ marginTop: 12 }}><button type="button" onClick={() => setShowRelinkAll(false)}>关闭</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
