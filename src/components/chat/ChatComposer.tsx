import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { theme } from '../../theme';
import { getLocale, tData, useT } from '../../i18n/locale';
import type { AgentReference } from '../../agent/context';
import type { AgentContextUsage } from '../../agent/context-compaction';
import { isSelectionRefKind } from '../../agent/selection-refs';
import { Icon, type IconName } from '../icons';
import { MenuDrillHeader } from '../timeline/MenuDrillHeader';
import { findSkill, setCustomSkills, allCreativeSkills } from '../../agent/skills/skills-catalog';
import type { SkillDefinition } from '../../agent/skills/skill-types';
import { loadCustomSkills } from '../../persist/skillStore';
import { loadAgentSettings, saveAgentSettings, MG_TIERS, type AgentSettings, type MgTier } from '../../agent/settings/agentSettings';
import { usePersistedState } from '../../hooks/usePersistedState';
import {
  ComposerMoreMenu,
  ComposerToolbar,
  type ComposerPopover as ComposerPopoverName,
} from './ComposerToolbar';
import { ComposerPopover } from './ComposerPopover';
import { ComposerModelPicker, useComposerModelView } from './ComposerModelPicker';
import { WorkflowPickerContent } from './WorkflowPickerContent';
import { activateWorkflowStarter } from './workflowStarters';
import { hasEditorDrag, parseEditorDrag, type EditorDragPayload } from '../../editor/editorDrag';
import { droppedFiles, hasExternalFiles } from '../../media/externalFileDrop';

/** composer shell height (includes textarea + toolbar); drag the top handle to resize */
const COMPOSER_H_MIN = 88;
const COMPOSER_H_MAX = 420;
const COMPOSER_H_DEFAULT = 112;
export const WORKFLOW_POPOVER_WIDTH = 400;

export type ChatMode = 'agent' | 'ask';

export type RefItem = AgentReference;

interface ChatComposerProps {
  value: string;
  onChange: (s: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onEnhance: () => void;
  enhancing: boolean;
  running: boolean;
  mode: ChatMode;
  onModeChange: (m: ChatMode) => void;
  autoApply: boolean;
  contextUsage: AgentContextUsage | null;
  onAutoApplyChange: (v: boolean) => void;
  /** Select mode: pick clips / canvas regions / transcript
   * spans / ruler times as structured references for the next message. */
  selecting: boolean;
  onToggleSelecting: () => void;
  /** active creative-mode skill id (agent_skill), or null = universal */
  creativeMode: string | null;
  onCreativeModeChange: (id: string | null) => void;
  references: RefItem[];
  onInsertRef: (reference: RefItem) => void;
  /** Structured @ refs attached to the next send (chat_context_entry). */
  selectedRefs?: RefItem[];
  onRemoveRef?: (id: string) => void;
  /** Paste supported files (video/image/audio/gif/svg) straight into the chat.
   * Semantics: Files attached to the chat box are first imported into the media pool and then automatically attached to @ref (not directly uploaded to the timeline). */
  onPasteFiles?: (files: File[]) => void;
  /** Finder drops use the same progressive import-and-attach path as paste. */
  onDropFiles?: (files: File[]) => void;
  /** true while a pasted file is importing into the pool */
  pasting?: boolean;
  /** Number of attachment placeholders that have not resolved to ready pool assets. */
  pendingAttachmentCount?: number;
  /** last paste import error, or null */
  pasteError?: string | null;
  onDismissPasteError?: () => void;
  /** Editor cards become structured references; sending remains explicit. */
  onDropEditorItem?: (payload: EditorDragPayload) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
}


// MG three-level quality label (speed|balance|quality)
const TIER_LABELS: Record<MgTier, string> = { speed: '速度', balance: '均衡', quality: '质量' };

const REF_ICON: Record<RefItem['kind'], IconName> = {
  video: 'filePlay', image: 'filePlay', gif: 'image', svg: 'image',
  audio: 'fileHeadphone', 'motion-graphic': 'sparkles', template: 'sparkles',
  'library-resource': 'sparkles',
  // selection-mode picks (item / time / region / transcript references)
  item: 'film', timepoint: 'clock', timerange: 'clock',
  'canvas-region': 'aspect', 'transcript-selection': 'text',
};

function referenceChipText(reference: RefItem): string {
  if (isSelectionRefKind(reference.kind)) return reference.name;
  const displayName = reference.kind === 'template' ? tData(reference.name) : reference.name;
  return `@${displayName}`;
}

export function hasPendingComposerAttachment(
  pasting: boolean | undefined,
  pendingAttachmentCount: number,
): boolean {
  return pasting === true || pendingAttachmentCount > 0;
}

export function shouldSubmitComposerOnKeyDown(
  key: string,
  shiftKey: boolean,
  canSend: boolean,
): boolean {
  return key === 'Enter' && !shiftKey && canSend;
}

export function ChatComposer(props: ChatComposerProps) {
  const t = useT();
  // The skill catalog comes with its own official English name, which can be used directly in English without duplication in the dictionary; the summary is only in Chinese, so use t().
  const skillName = (s: { name: string; nameZh: string }): string =>
    (getLocale() === 'en' ? s.name : s.nameZh);
  const {
    value, onChange, onSubmit, onStop, onEnhance, enhancing, running, mode, onModeChange,
    autoApply, onAutoApplyChange, contextUsage, selecting, onToggleSelecting,
    creativeMode, onCreativeModeChange, references, onInsertRef,
    selectedRefs = [], onRemoveRef, onPasteFiles, onDropFiles, pasting, pendingAttachmentCount = 0,
    pasteError, onDismissPasteError,
    onDropEditorItem,
    taRef, placeholder,
  } = props;
  const [editorDragOver, setEditorDragOver] = useState(false);
  const editorDragDepth = useRef(0);
  // Hydration custom skill (manage_skill): read IDB → memory registry when mounting, bump triggers re-rendering
  // Make allCreativeSkills()/findSkill reflect custom skills. The real source is IDB, and the manage_skill tool is also the same.
  const [, bumpCustom] = useState(0);
  useEffect(() => {
    loadCustomSkills().then((list) => { setCustomSkills(list); bumpCustom((n) => n + 1); });
  }, []);
  const activeSkill = findSkill(creativeMode);
  const modelView = useComposerModelView(contextUsage);
  const { activeModel, contextLabel, contextTitle, modelReady, modelState } = modelView;
  const [pop, setPop] = useState<ComposerPopoverName>(null);
  const [popAnchor, setPopAnchor] = useState<HTMLElement | null>(null);
  /** @ picker drill level: root → assets/timeline/templates → track items. */
  type RefDrill = 'root' | 'assets' | 'timeline' | 'templates' | `track:${string}`;
  const [refDrill, setRefDrill] = useState<RefDrill>('root');
  const [refIndex, setRefIndex] = useState(-1);
  // `/` skill command: value starting with `/` opens slug completion. The slash
  // stays in the input as a command prefix; Tab/Enter completes to an activation.
  const slashQuery = value.startsWith('/') ? value.slice(1) : null;
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(-1);
  const slashMatches = useMemo((): SkillDefinition[] => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase().trim();
    const skills = allCreativeSkills();
    if (!q) return skills;
    const starts = skills.filter((s) => s.slug.toLowerCase().startsWith(q));
    const contains = skills.filter((s) => !starts.includes(s)
      && (s.slug.toLowerCase().includes(q)
        || s.name.toLowerCase().includes(q)
        || s.nameZh.includes(q)));
    return [...starts, ...contains];
  }, [slashQuery]);
  useEffect(() => {
    if (slashQuery === null) { setSlashOpen(false); return; }
    setSlashOpen(true);
    setSlashIndex((i) => (slashMatches.length > 0 ? Math.min(i, slashMatches.length - 1) : -1));
  }, [slashMatches.length, slashQuery]);
  const activateSlash = (skill: SkillDefinition) => {
    setSlashOpen(false);
    setSlashIndex(-1);
    onChange('');
    activateWorkflowStarter(skill, {
      translate: t,
      locale: getLocale(),
      onCreativeModeChange,
      onPromptChange: onChange,
      onRequestFocus: () => taRef.current?.focus(),
    });
  };
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(() => loadAgentSettings());
  const patchAgent = (patch: Partial<AgentSettings>) => {
    setAgentSettings((prev) => {
      const next = { ...prev, ...patch };
      saveAgentSettings(next);
      return next;
    });
  };
  const closePop = () => { setPop(null); setPopAnchor(null); };
  const toggle = (p: ComposerPopoverName, el?: EventTarget | null) => {
    const node = el instanceof HTMLElement ? el : null;
    setPop((cur) => {
      if (cur === p) { setPopAnchor(null); return null; }
      setPopAnchor(node);
      return p;
    });
  };
  const attachmentsPending = hasPendingComposerAttachment(pasting, pendingAttachmentCount);
  const canSend = !!value.trim() && !running && !attachmentsPending && modelReady;
  const canEnhance = !!value.trim() && !enhancing && !running && !attachmentsPending && modelReady;
  const pendingReason = t('请等待附件导入完成。');
  const sendTitle = attachmentsPending
    ? pendingReason
    : modelReady
      ? t('发送 (Enter)')
      : modelState.loaded
        ? t('请先在设置中配置一个模型厂商。')
        : t('正在读取模型配置…');
  const refList = (kind: 'asset' | 'template') =>
    references.filter((r) => (kind === 'template' ? r.kind === 'template' : r.kind !== 'template'));

  const insert = (reference: RefItem) => { onInsertRef(reference); closePop(); taRef.current?.focus(); };

  // Drag up and down to change the height of the input area: top handle + localStorage memory
  const [shellH, setShellH] = usePersistedState('cc.composerShellH', COMPOSER_H_DEFAULT);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onResizePointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: shellH };
  }, [shellH]);
  const onResizePointerMove = useCallback((e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // drag up → taller (negative dy grows height)
    const next = Math.max(COMPOSER_H_MIN, Math.min(COMPOSER_H_MAX, d.startH + (d.startY - e.clientY)));
    setShellH(next);
  }, [setShellH]);
  const onResizePointerUp = useCallback(() => { dragRef.current = null; }, []);

  // Model line: compact card (selected = accent check mark, slightly illuminated when hovering)
  const modeRow = (m: ChatMode, label: string, desc: string) => {
    const active = mode === m;
    return (
      <button onClick={() => { onModeChange(m); closePop(); }}
        style={{ display: 'block', width: '100%', textAlign: 'left', background: active ? theme.panel : 'none', border: 'none', borderRadius: 3, padding: '6px 9px', cursor: 'pointer', color: theme.text }}
        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = theme.panel; }}
        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'none'; }}>
        <div style={{ fontSize: 12, fontWeight: 550, display: 'flex', alignItems: 'center' }}>
          {label}
          {active && <span style={{ marginLeft: 'auto', color: theme.accent, display: 'inline-flex' }}><Icon name="check" size={12} strokeWidth={2.4} /></span>}
        </div>
        <div style={{ fontSize: 10.5, color: theme.textDim, marginTop: 1, lineHeight: 1.45 }}>{desc}</div>
      </button>
    );
  };

  const refRow = (r: RefItem) => (
    <button key={r.id} onClick={() => insert(r)}
      style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', background: 'none', border: 'none', borderRadius: 3, padding: '7px 10px', cursor: 'pointer', color: theme.text }}
      onMouseEnter={(e) => { e.currentTarget.style.background = theme.panel; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
      <span style={{ color: theme.textDim, lineHeight: 0 }}><Icon name={REF_ICON[r.kind]} size={15} /></span>
      <span style={{ fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
    </button>
  );

  const refGroupTitle = (text: string) => (
    <div style={{ fontSize: 10.5, color: theme.textDim, padding: '6px 8px 2px', letterSpacing: 0.4 }}>{text}</div>
  );

  interface RefEntry { key: string; icon: IconName; label: string; sub?: string; action: () => void }

  const refEntries = (): RefEntry[] => {
    const assets = references.filter((r) => r.kind !== 'template' && r.kind !== 'item');
    const timelineItems = references.filter((r) => r.kind === 'item');
    const trackOf = (r: RefItem): string => (r.kind === 'item' && r.metadata?.trackAlias ? r.metadata.trackAlias : '');
    const tracks = [...new Set(timelineItems.map(trackOf))].filter(Boolean);
    const go = (drill: RefDrill) => () => { setRefDrill(drill); setRefIndex(0); };
    if (refDrill === 'assets') {
      return assets.map((r) => ({ key: r.id, icon: REF_ICON[r.kind], label: r.name, action: () => insert(r) }));
    }
    if (refDrill === 'timeline') {
      return tracks.map((alias) => ({
        key: alias, icon: 'film', label: alias,
        sub: `${timelineItems.filter((r) => trackOf(r) === alias).length}`,
        action: go(`track:${alias}`),
      }));
    }
    if (refDrill === 'templates') {
      return refList('template').map((r) => ({ key: r.id, icon: REF_ICON[r.kind], label: r.name, action: () => insert(r) }));
    }
    if (refDrill.startsWith('track:')) {
      const alias = refDrill.slice('track:'.length);
      return timelineItems.filter((r) => trackOf(r) === alias)
        .map((r) => ({ key: r.id, icon: REF_ICON[r.kind], label: r.name, action: () => insert(r) }));
    }
    return [
      { key: 'assets', icon: 'filePlay', label: t('引用媒体池素材'), sub: `${assets.length}`, action: go('assets') },
      { key: 'timeline', icon: 'film', label: t('时间线'), sub: `${tracks.length}`, action: go('timeline') },
      { key: 'templates', icon: 'sparkles', label: t('引用模板库'), action: go('templates') },
    ];
  };

  const refDrillTitle = (): { title: string; onBack: (() => void) | null } => {
    if (refDrill === 'assets') return { title: t('引用媒体池素材'), onBack: () => { setRefDrill('root'); setRefIndex(0); } };
    if (refDrill === 'timeline') return { title: t('时间线'), onBack: () => { setRefDrill('root'); setRefIndex(0); } };
    if (refDrill === 'templates') return { title: t('引用模板库'), onBack: () => { setRefDrill('root'); setRefIndex(0); } };
    if (refDrill.startsWith('track:')) return { title: refDrill.slice('track:'.length), onBack: () => { setRefDrill('timeline'); setRefIndex(0); } };
    return { title: t('引用'), onBack: null };
  };

  const refPopoverBody = (kind: 'asset' | 'template', empty: string) => {
    if (kind === 'template') {
      const list = refList('template');
      return (
        <>
          {refGroupTitle(t('引用模板库'))}
          {list.length === 0 && <div style={{ fontSize: 12, color: theme.textDim, padding: '6px 10px' }}>{empty}</div>}
          {list.map(refRow)}
        </>
      );
    }
    const entries = refEntries();
    const drillTitle = refDrillTitle();
    return (
      <>
        {drillTitle.onBack
          ? <MenuDrillHeader title={drillTitle.title} onBack={drillTitle.onBack} />
          : refGroupTitle(drillTitle.title)}
        {entries.length === 0
          && <div style={{ fontSize: 12, color: theme.textDim, padding: '6px 10px' }}>{empty}</div>}
        {entries.map((entry, index) => (
          <button key={entry.key} onClick={entry.action}
            style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', background: index === refIndex ? theme.panel : 'none', border: 'none', borderRadius: 3, padding: '7px 10px', cursor: 'pointer', color: theme.text }}
            onMouseEnter={() => setRefIndex(index)}
            onMouseLeave={() => { if (index === refIndex) setRefIndex(-1); }}>
            <span style={{ color: theme.textDim, lineHeight: 0 }}><Icon name={entry.icon} size={15} /></span>
            <span style={{ fontSize: 12.5, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.label}</span>
            {entry.sub && <span style={{ fontSize: 10, color: theme.textDim }}>{entry.sub}</span>}
            {drillTitle.onBack && <span style={{ color: theme.textDim }}>›</span>}
          </button>
        ))}
      </>
    );
  };

  return (
    <div
      className="cc-chat-composer"
      data-cc-shortcut-surface="agent-input"
      data-editor-drag-over={editorDragOver ? 'true' : undefined}
      onDragEnter={(event) => {
        if (!hasEditorDrag(event) && !hasExternalFiles(event.dataTransfer)) return;
        event.preventDefault();
        editorDragDepth.current += 1;
        setEditorDragOver(true);
      }}
      onDragOver={(event) => {
        if (!hasEditorDrag(event) && !hasExternalFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!hasEditorDrag(event) && !hasExternalFiles(event.dataTransfer)) return;
        editorDragDepth.current = Math.max(0, editorDragDepth.current - 1);
        if (editorDragDepth.current === 0) setEditorDragOver(false);
      }}
      onDrop={(event) => {
        const files = droppedFiles(event.dataTransfer);
        const payload = parseEditorDrag(event);
        editorDragDepth.current = 0;
        setEditorDragOver(false);
        if (files.length > 0 && onDropFiles) {
          event.preventDefault();
          event.stopPropagation();
          onDropFiles(files);
          taRef.current?.focus();
          return;
        }
        if (!payload || !onDropEditorItem) return;
        event.preventDefault();
        event.stopPropagation();
        onDropEditorItem(payload);
        taRef.current?.focus();
      }}
      style={{
        position: 'relative', display: 'flex', flexDirection: 'column',
        height: shellH, minHeight: COMPOSER_H_MIN, maxHeight: COMPOSER_H_MAX,
        width: '100%', minWidth: 0, maxWidth: '100%', overflow: 'visible',
        boxSizing: 'border-box', background: theme.panelAlt,
    border: `0.5px solid ${theme.borderLight}`, borderRadius: 4,
        padding: '10px 6px 5px',
        boxShadow: editorDragOver ? `inset 0 0 0 1px ${theme.accent}` : undefined,
        transition: 'box-shadow 120ms ease',
      }}
    >
      {/* top edge drag handle — pull up to expand, down to shrink */}
      <div
        className="cc-chat-composer-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('拖动调整输入框高度')}
        title={t('上下拖动调整输入框高度')}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
      >
        <span className="cc-chat-composer-resize-grip" aria-hidden />
      </div>
      {selectedRefs.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }} title={t('发送时以 chat_context_entry 结构化注入')}>
          {selectedRefs.map((r) => (
            <span
              key={r.id}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%',
                fontSize: 11, lineHeight: 1.2, padding: '2px 6px', borderRadius: 999,
                background: theme.panel, border: `0.5px solid ${theme.borderLight}`, color: theme.text,
              }}
            >
              <Icon name={REF_ICON[r.kind]} size={12} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{referenceChipText(r)}</span>
              {onRemoveRef && (
                <button
                  type="button"
                  title={t('移除引用')}
                  onClick={() => onRemoveRef(r.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.textDim, padding: 0, lineHeight: 0, display: 'grid' }}
                >
                  <Icon name="x" size={11} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {(attachmentsPending || pasteError) && (
        <div
          id="cc-chat-composer-import-status"
          role="status"
          aria-live="polite"
          style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: 11.5 }}
        >
          {attachmentsPending && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: theme.accent }}>
              <Icon name="sparkles" size={12} /> {pendingReason}
            </span>
          )}
          {pasteError && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#e5866a', minWidth: 0 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pasteError}</span>
              {onDismissPasteError && (
                <button type="button" title={t('关闭')} onClick={onDismissPasteError}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#e5866a', padding: 0, lineHeight: 0, display: 'grid', flexShrink: 0 }}>
                  <Icon name="x" size={11} />
                </button>
              )}
            </span>
          )}
        </div>
      )}
      <textarea
        ref={taRef}
        data-cc-chat-composer
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) event.preventDefault();
          if (slashOpen && slashQuery !== null) {
            if (event.key === 'ArrowDown' && slashMatches.length) {
              event.preventDefault();
              setSlashIndex((i) => (i + 1) % slashMatches.length);
              return;
            }
            if (event.key === 'ArrowUp' && slashMatches.length) {
              event.preventDefault();
              setSlashIndex((i) => (i <= 0 ? slashMatches.length - 1 : i - 1));
              return;
            }
            if ((event.key === 'Enter' || event.key === 'Tab') && slashMatches.length) {
              event.preventDefault();
              activateSlash(slashMatches[Math.max(0, slashIndex)]);
              return;
            }
            if (event.key === 'Escape') {
              setSlashOpen(false);
              setSlashIndex(-1);
              onChange('');
              return;
            }
          }
          if (event.key === '@') {
            // @ opens the asset/timeline reference picker (anchored to the input).
            setPopAnchor(taRef.current);
            setRefDrill('root');
            setRefIndex(-1);
            setPop((cur) => (cur === 'assets' ? null : 'assets'));
            return;
          }
          if (pop === 'assets') {
            const entries = refEntries();
            if (event.key === 'ArrowDown' && entries.length) {
              event.preventDefault();
              setRefIndex((i) => (i + 1) % entries.length);
              return;
            }
            if (event.key === 'ArrowUp' && entries.length) {
              event.preventDefault();
              setRefIndex((i) => (i <= 0 ? entries.length - 1 : i - 1));
              return;
            }
            if (event.key === 'Enter' && entries.length) {
              event.preventDefault();
              entries[Math.max(0, refIndex)]?.action();
              return;
            }
          }
          if (shouldSubmitComposerOnKeyDown(event.key, event.shiftKey, canSend)) onSubmit();
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData?.files ?? []);
          if (files.length > 0 && onPasteFiles) { e.preventDefault(); onPasteFiles(files); }
        }}
        placeholder={placeholder ?? t('告诉 AI 要做哪些修改 - @ 引用素材')}
        aria-describedby={attachmentsPending ? 'cc-chat-composer-import-status' : undefined}
        rows={1}
        style={{
          flex: 1, width: '100%', minHeight: 28, minWidth: 0, resize: 'none',
          overflowY: 'auto', background: 'transparent', border: 'none', outline: 'none',
          color: theme.text, fontSize: 13, fontFamily: 'inherit', lineHeight: 1.45,
        }}
      />
      <ComposerToolbar
        mode={mode} activeModel={activeModel} activeSkillName={activeSkill ? skillName(activeSkill) : undefined}
        contextLabel={contextLabel} contextTitle={contextTitle}
        pop={pop} selecting={selecting} enhancing={enhancing} running={running}
        canEnhance={canEnhance} canSend={canSend} sendTitle={sendTitle}
        onTogglePop={toggle} onToggleSelecting={onToggleSelecting} onEnhance={onEnhance}
        onSubmit={onSubmit} onStop={onStop} />

      {/* menus rendered fixed — never clipped by composer bounds */}
      {pop === 'mode' && (
        <ComposerPopover width={172} anchor={popAnchor} onClose={closePop}>
          {modeRow('agent', t('代理模式'), t('可编辑时间线，改动可撤销'))}
          {modeRow('ask', t('问答模式'), t('只回答，不动时间线'))}
        </ComposerPopover>
      )}
      {pop === 'model' && (
        <ComposerModelPicker anchor={popAnchor} onClose={closePop} view={modelView} />
      )}
      {pop === 'settings' && (
        <ComposerPopover anchor={popAnchor} onClose={closePop}>
          <div style={{ padding: '8px 10px 4px', color: theme.text, fontSize: 12.5 }}>{t('模式')}</div>
          <div style={{ display: 'flex', gap: 4, padding: '0 10px' }}>
            {(['ask', 'yolo'] as const).map((m) => {
              const active = (m === 'yolo') === autoApply;
              return (
                <button key={m} onClick={() => onAutoApplyChange(m === 'yolo')}
                  style={{ flex: 1, padding: '4px 0', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', border: `0.5px solid ${active ? theme.accent : theme.borderLight}`, background: active ? theme.panel : 'none', color: active ? theme.text : theme.textDim }}>
                  {m === 'ask' ? t('Ask 模式') : t('YOLO 模式')}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: theme.textDim, padding: '0 10px 6px' }}>
            {autoApply
              ? t('YOLO 模式：AI 改动直接生效，无需逐条确认（仍可撤销）。')
              : t('Ask 模式：AI 的改动先经你确认；有多个可选项时 AI 会先问你。')}
          </div>
          <div style={{ fontSize: 11, color: theme.textDim, padding: '0 10px 6px' }}>
            {t('生成/导出/转写/网页抓取等付费操作无论哪种模式都会先经你确认。')}
          </div>
          <div style={{ padding: '8px 10px 4px', color: theme.text, fontSize: 12.5 }}>{t('MG 质量')}</div>
          <div style={{ display: 'flex', gap: 4, padding: '0 10px' }}>
            {MG_TIERS.map((tier) => (
              <button key={tier} onClick={() => patchAgent({ mgTier: tier })}
                style={{ flex: 1, padding: '4px 0', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', border: `0.5px solid ${agentSettings.mgTier === tier ? theme.accent : theme.borderLight}`, background: agentSettings.mgTier === tier ? theme.panel : 'none', color: agentSettings.mgTier === tier ? theme.text : theme.textDim }}>
                {t(TIER_LABELS[tier])}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: theme.textDim, padding: '4px 10px 6px' }}>
            {t('速度=最快出活 / 均衡 / 质量=打磨动效细节。')}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer', color: theme.text, fontSize: 12.5 }}>
            <input type="checkbox" checked={agentSettings.planMode} onChange={(e) => patchAgent({ planMode: e.target.checked })} style={{ accentColor: theme.accent }} />
            {t('计划模式')}
          </label>
          <div style={{ fontSize: 11, color: theme.textDim, padding: '0 10px 10px' }}>
            {t('先出编号计划，确认后再动手。')}
          </div>
        </ComposerPopover>
      )}
      {pop === 'assets' && (
        <ComposerPopover anchor={popAnchor} onClose={closePop}>
          {refPopoverBody('asset', t('媒体池暂无素材'))}
        </ComposerPopover>
      )}
      {pop === 'skill' && (
        <ComposerPopover
          width={WORKFLOW_POPOVER_WIDTH}
          className="cc-chat-popover--workflow"
          ariaLabel={t('选择创作工作流')}
          anchor={popAnchor}
          onClose={closePop}
        >
          <WorkflowPickerContent
            creativeMode={creativeMode}
            onCreativeModeChange={onCreativeModeChange}
            onPromptChange={onChange}
            onRequestFocus={() => taRef.current?.focus()}
            onClose={closePop}
          />
        </ComposerPopover>
      )}
      {pop === 'templates' && (
        <ComposerPopover anchor={popAnchor} onClose={closePop}>
          {refPopoverBody('template', t('暂无模板'))}
        </ComposerPopover>
      )}
      {slashOpen && slashQuery !== null && (
        <ComposerPopover
          width={WORKFLOW_POPOVER_WIDTH}
          className="cc-chat-popover--workflow"
          ariaLabel={t('技能命令补全')}
          anchor={taRef.current}
          onClose={() => { setSlashOpen(false); setSlashIndex(-1); }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 12px 6px' }}>
            <Icon name="wand" size={14} />
            <strong style={{ fontSize: 12.5 }}>{t('创作工作流')}</strong>
            <code style={{ marginLeft: 'auto', fontSize: 10.5, color: theme.textDim }}>{value}</code>
          </div>
          <div style={{ maxHeight: 264, overflowY: 'auto', padding: '2px 6px 8px' }}>
            {slashMatches.length === 0 && (
              <div style={{ fontSize: 12, color: theme.textDim, padding: '6px 10px' }}>
                {t('没有匹配“{query}”的创作工作流', { query: slashQuery.trim() })}
              </div>
            )}
            {slashMatches.map((s, index) => (
              <button
                key={s.id}
                type="button"
                onClick={() => activateSlash(s)}
                onMouseEnter={() => setSlashIndex(index)}
                onMouseLeave={() => { if (slashIndex === index) setSlashIndex(-1); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
                  background: index === slashIndex ? theme.panel : 'none', border: 'none', borderRadius: 3,
                  padding: '7px 10px', cursor: 'pointer', color: theme.text,
                }}
              >
                <span style={{ color: theme.textDim, lineHeight: 0 }}><Icon name="wand" size={15} /></span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                    <strong style={{ fontSize: 12.5 }}>{skillName(s)}</strong>
                    <code style={{ fontSize: 10, color: theme.textDim }}>/{s.slug}</code>
                  </span>
                  <span style={{ display: 'block', fontSize: 10.5, color: theme.textDim, lineHeight: 1.4, marginTop: 1 }}>
                    {t(s.summary)}
                  </span>
                </span>
                {creativeMode === s.id && <Icon name="check" size={12} strokeWidth={2.4} />}
              </button>
            ))}
            <div style={{ fontSize: 10, color: theme.textDim, padding: '6px 10px 2px', letterSpacing: 0.4 }}>
              {t('Tab / Enter 补全并激活 · Esc 退出')}
            </div>
          </div>
        </ComposerPopover>
      )}
      {pop === 'more' && (
        <ComposerPopover anchor={popAnchor} onClose={closePop}>
          <ComposerMoreMenu
            selecting={selecting} activeSkillName={activeSkill ? skillName(activeSkill) : undefined}
            canEnhance={canEnhance} enhancing={enhancing}
            onChoosePopover={setPop} onToggleSelecting={onToggleSelecting}
            onEnhance={onEnhance} onClose={closePop} />
        </ComposerPopover>
      )}
    </div>
  );
}
