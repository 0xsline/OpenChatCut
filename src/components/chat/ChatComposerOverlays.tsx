import type { RefObject } from 'react';
import { isSelectionRefKind } from '../../agent/selection-refs';
import type { SkillDefinition } from '../../agent/skills/skill-types';
import { localizedCatalogText, tData, useT } from '../../i18n/locale';
import { theme } from '../../theme';
import { Icon } from '../icons';
import { REF_ICON, type RefItem } from './ChatComposerContract';
import { ComposerPopover } from './ComposerPopover';

function referenceChipText(reference: RefItem): string {
  if (isSelectionRefKind(reference.kind)) return reference.name;
  return `@${reference.kind === 'template' ? tData(reference.name) : reference.name}`;
}

function ActiveSkillBadge({ skill, onCancel }: {
  skill: SkillDefinition;
  onCancel: () => void;
}) {
  const t = useT();
  const name = localizedCatalogText(skill.name, skill.nameZh);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }} title={t('当前创作工作流，随消息发送')}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', fontSize: 11, lineHeight: 1.2, padding: '2px 6px', borderRadius: 999, background: theme.panel, border: `0.5px solid ${theme.accent}`, color: theme.text }}>
        <Icon name="wand" size={12} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t('创作模式：{name}', { name })}
        </span>
        <button type="button" title={t('取消创作模式')} onClick={onCancel}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.textDim, padding: 0, lineHeight: 0, display: 'grid' }}>
          <Icon name="x" size={11} />
        </button>
      </span>
    </div>
  );
}

function ReferenceBadges({ references, onRemove }: {
  references: RefItem[];
  onRemove?: (id: string) => void;
}) {
  const t = useT();
  if (references.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }} title={t('发送时以 chat_context_entry 结构化注入')}>
      {references.map((reference) => (
        <span key={reference.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', fontSize: 11, lineHeight: 1.2, padding: '2px 6px', borderRadius: 999, background: theme.panel, border: `0.5px solid ${theme.borderLight}`, color: theme.text }}>
          <Icon name={REF_ICON[reference.kind]} size={12} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{referenceChipText(reference)}</span>
          {onRemove && (
            <button type="button" title={t('移除引用')} onClick={() => onRemove(reference.id)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.textDim, padding: 0, lineHeight: 0, display: 'grid' }}>
              <Icon name="x" size={11} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

function ImportStatus({ pending, reason, error, onDismiss }: {
  pending: boolean;
  reason: string;
  error?: string | null;
  onDismiss?: () => void;
}) {
  const t = useT();
  if (!pending && !error) return null;
  return (
    <div id="cc-chat-composer-import-status" role="status" aria-live="polite"
      style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: 11.5 }}>
      {pending && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: theme.accent }}>
          <Icon name="sparkles" size={12} /> {reason}
        </span>
      )}
      {error && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: theme.accent, minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{error}</span>
          {onDismiss && (
            <button type="button" title={t('关闭')} onClick={onDismiss}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.accent, padding: 0, lineHeight: 0, display: 'grid', flexShrink: 0 }}>
              <Icon name="x" size={11} />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

export function ComposerStatus(props: {
  activeSkill: SkillDefinition | null | undefined;
  selectedRefs: RefItem[];
  attachmentsPending: boolean;
  pendingReason: string;
  pasteError?: string | null;
  onCancelSkill: () => void;
  onRemoveRef?: (id: string) => void;
  onDismissPasteError?: () => void;
}) {
  return (
    <>
      {props.activeSkill && <ActiveSkillBadge skill={props.activeSkill} onCancel={props.onCancelSkill} />}
      <ReferenceBadges references={props.selectedRefs} onRemove={props.onRemoveRef} />
      <ImportStatus pending={props.attachmentsPending} reason={props.pendingReason}
        error={props.pasteError} onDismiss={props.onDismissPasteError} />
    </>
  );
}

function SlashSkillRow({ skill, index, activeIndex, selected, onActivate, onHover }: {
  skill: SkillDefinition;
  index: number;
  activeIndex: number;
  selected: boolean;
  onActivate: (skill: SkillDefinition) => void;
  onHover: (index: number) => void;
}) {
  const t = useT();
  const name = localizedCatalogText(skill.name, skill.nameZh);
  return (
    <button type="button" onClick={() => onActivate(skill)} onMouseEnter={() => onHover(index)}
      onMouseLeave={() => { if (activeIndex === index) onHover(-1); }}
      style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', background: index === activeIndex ? theme.panel : 'none', border: 'none', borderRadius: 3, padding: '7px 10px', cursor: 'pointer', color: theme.text }}>
      <span style={{ color: theme.textDim, lineHeight: 0 }}><Icon name="wand" size={15} /></span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
          <strong style={{ fontSize: 12.5 }}>{name}</strong>
          <code style={{ fontSize: 10, color: theme.textDim }}>/{skill.slug}</code>
        </span>
        <span style={{ display: 'block', fontSize: 10.5, color: theme.textDim, lineHeight: 1.4, marginTop: 1 }}>
          {t(skill.summary)}
        </span>
      </span>
      {selected && <Icon name="check" size={12} strokeWidth={2.4} />}
    </button>
  );
}

function SlashResults(props: {
  explicit: boolean;
  query: string;
  matches: SkillDefinition[];
  activeIndex: number;
  creativeMode: string | null;
  onActivate: (skill: SkillDefinition) => void;
  onHover: (index: number) => void;
}) {
  const t = useT();
  if (props.matches.length === 0) {
    return (
      <div style={{ fontSize: 12, color: theme.textDim, padding: '6px 10px' }}>
        {props.explicit
          ? t('未知技能“{query}”，按 / 查看全部创作工作流', { query: props.query.trim() })
          : t('没有匹配“{query}”的创作工作流', { query: props.query.trim() })}
      </div>
    );
  }
  return props.matches.map((skill, index) => (
    <SlashSkillRow key={skill.id} skill={skill} index={index} activeIndex={props.activeIndex}
      selected={props.creativeMode === skill.id} onActivate={props.onActivate} onHover={props.onHover} />
  ));
}

export function ComposerSlashPopover(props: {
  width: number;
  explicit: boolean;
  query: string;
  value: string;
  matches: SkillDefinition[];
  activeIndex: number;
  creativeMode: string | null;
  anchor: HTMLElement | null;
  listRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onActivate: (skill: SkillDefinition) => void;
  onHover: (index: number) => void;
}) {
  const t = useT();
  return (
    <ComposerPopover width={props.width} className="cc-chat-popover--workflow"
      ariaLabel={t('技能命令补全')} anchor={props.anchor} onClose={props.onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 12px 6px' }}>
        <Icon name="wand" size={14} />
        <strong style={{ fontSize: 12.5 }}>{props.explicit ? t('技能命令') : t('创作工作流')}</strong>
        <code style={{ marginLeft: 'auto', fontSize: 10.5, color: theme.textDim }}>{props.value}</code>
      </div>
      <div ref={props.listRef} style={{ maxHeight: 264, overflowY: 'auto', padding: '2px 6px 8px' }}>
        <SlashResults {...props} />
        <div style={{ fontSize: 10, color: theme.textDim, padding: '6px 10px 2px', letterSpacing: 0.4 }}>
          {t('Tab / Enter 补全并激活 · Esc 退出')}
        </div>
      </div>
    </ComposerPopover>
  );
}
