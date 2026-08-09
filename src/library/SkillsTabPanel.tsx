// Skill library tab: creative workflows + custom skills, mirroring the chat
// composer picker. Selecting a card activates the creative mode (same state
// the composer uses); the active skill is highlighted. Custom skills get a
// search box, per-card edit (name/summary/body via modal) and delete.
import { useEffect, useMemo, useState } from 'react';
import { getLocale, useT } from '../i18n/locale';
import { allCreativeSkills, setCustomSkills, findSkill } from '../agent/skills/skills-catalog';
import { loadCustomSkills, saveCustomSkill, deleteCustomSkill } from '../persist/skillStore';
import type { CustomSkill } from '../persist/skillStore';
import type { SkillDefinition } from '../agent/skills/skill-types';
import { theme } from '../theme';

const BUILTIN_IDS = new Set(['long-video-to-shorts', 'multi-clips-to-reels', 'ai-cinematic-short-film', 'product-ad-video-script', 'explainer-video', 'motion-graphic-placement', 'storyboard-shot-breakdown', 'video-thumbnail-generator', 'skill-creator']);

export function SkillsTabPanel({
  creativeMode,
  onCreativeModeChange,
}: {
  creativeMode: string | null;
  onCreativeModeChange: (id: string | null) => void;
}) {
  const t = useT();
  const [, bumpCustom] = useState(0);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<CustomSkill | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  useEffect(() => {
    loadCustomSkills().then((list) => { setCustomSkills(list); bumpCustom((n) => n + 1); });
  }, []);
  const skills = allCreativeSkills();
  const active = findSkill(creativeMode);
  const skillName = (s: SkillDefinition) => (getLocale() === 'en' ? s.name : s.nameZh);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) =>
      [skill.name, skill.nameZh, skill.summary, skill.description, skill.slug]
        .some((field) => field.toLowerCase().includes(needle)));
  }, [skills, query]);

  const reload = () => {
    loadCustomSkills().then((list) => { setCustomSkills(list); bumpCustom((n) => n + 1); });
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto', padding: '12px 14px 18px', gap: 8 }}>
      <div style={{ fontSize: 11.5, color: theme.textDim, lineHeight: 1.5, marginBottom: 2 }}>
        {t('选择创作工作流会约束 Agent 的规划与工具调用；激活后下一条消息按该工作流执行。')}
      </div>
      <div style={{ position: 'relative' }}>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('搜索技能（名称 / 说明）')}
          style={{
            width: '100%', padding: '6px 9px 6px 26px', borderRadius: 5,
            border: `0.5px solid ${theme.borderLight}`, background: theme.inset,
            color: theme.text, fontSize: 12, outline: 'none',
          }}
        />
        <span style={{ position: 'absolute', left: 8, top: 7, color: theme.textDim, fontSize: 11, pointerEvents: 'none' }}>🔍</span>
      </div>
      {active && (
        <button
          type="button"
          onClick={() => onCreativeModeChange(null)}
          style={{ textAlign: 'left', padding: '7px 10px', borderRadius: 6, border: `0.5px solid ${theme.accent}`, background: theme.panelAlt, cursor: 'pointer', color: theme.text }}
        >
          <div style={{ fontSize: 12, fontWeight: 600 }}>{t('当前：{name}', { name: skillName(active) })}</div>
          <div style={{ fontSize: 11, color: theme.textDim, marginTop: 1 }}>{t('点击取消创作模式，回到自由创作')}</div>
        </button>
      )}
      <div className="cc-creative-picker-section">{t('专业工作流')}</div>
      {filtered.length === 0 && (
        <div style={{ fontSize: 12, color: theme.textDim, padding: '14px 4px' }}>{t('没有匹配的技能')}</div>
      )}
      <div className="cc-creative-mode-grid">
        {filtered.map((skill) => (
          <div key={skill.id} className="cc-skill-card-wrap">
            <button
              type="button"
              onClick={() => onCreativeModeChange(creativeMode === skill.id ? null : skill.id)}
              className="cc-creative-mode-row cc-creative-mode-card"
              data-active={creativeMode === skill.id}
              aria-pressed={creativeMode === skill.id}
              title={t(skill.summary)}
            >
              <span className="cc-creative-mode-icon"><IconWand /></span>
              <span className="cc-creative-mode-copy">
                <span className="cc-creative-mode-title">
                  <strong>{skillName(skill)}</strong>
                  {!BUILTIN_IDS.has(skill.slug) && <em>{t('自定义')}</em>}
                </span>
                <small>{t(skill.summary)}</small>
              </span>
              {creativeMode === skill.id && <span className="cc-creative-mode-check">✓</span>}
            </button>
            {!BUILTIN_IDS.has(skill.slug) && (
              <span className="cc-skill-actions">
                <button
                  type="button"
                  title={t('修改技能')}
                  aria-label={t('修改技能')}
                  onClick={(event) => {
                    event.stopPropagation();
                    const custom = skills.find((candidate) => candidate.id === skill.id) as CustomSkill | undefined;
                    setEditing(custom ?? null);
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  title={t('删除技能')}
                  aria-label={t('删除技能')}
                  className={confirmingDelete === skill.id ? 'cc-skill-delete-confirm' : undefined}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (confirmingDelete !== skill.id) { setConfirmingDelete(skill.id); return; }
                    setConfirmingDelete(null);
                    void deleteCustomSkill(skill.id).then(reload);
                  }}
                >
                  {confirmingDelete === skill.id ? t('确认?') : '✕'}
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: theme.textDim, marginTop: 8, lineHeight: 1.5 }}>
        {t('提示：也可在聊天输入框用 /skill:名称 快速激活，或用「技能创作器」创建自己的技能。')}
      </div>
      {editing && (
        <SkillEditDialog
          skill={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}

function SkillEditDialog({
  skill,
  onClose,
  onSaved,
}: {
  skill: CustomSkill;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(skill.name);
  const [summary, setSummary] = useState(skill.summary);
  const [body, setBody] = useState(skill.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) { setError(t('名称不能为空')); return; }
    setSaving(true);
    setError(null);
    try {
      await saveCustomSkill({ ...skill, name: name.trim(), nameZh: name.trim(), summary: summary.trim() || name.trim(), body });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cc-modal-backdrop" onPointerDown={onClose}>
      <div
        className="cc-modal"
        style={{ width: 640, gap: 10, maxHeight: 'calc(100vh - 64px)', overflowY: 'auto' }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 14 }}>{t('修改技能')} · {skill.slug}</strong>
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', padding: '3px 9px' }}>{t('取消')}</button>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          {t('名称')}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            style={{ padding: '5px 8px', borderRadius: 4, border: `0.5px solid ${theme.borderLight}`, background: theme.inset, color: theme.text, fontSize: 12 }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          {t('说明')}
          <textarea
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            rows={2}
            style={{ padding: '5px 8px', borderRadius: 4, border: `0.5px solid ${theme.borderLight}`, background: theme.inset, color: theme.text, fontSize: 12, resize: 'vertical' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          {t('正文（Markdown，含 frontmatter）')}
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={14}
            style={{
              padding: '7px 9px', borderRadius: 4, border: `0.5px solid ${theme.borderLight}`,
              background: theme.inset, color: theme.text, fontSize: 11.5, lineHeight: 1.5, resize: 'vertical',
              fontFamily: 'Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          />
        </label>
        {error && <div style={{ fontSize: 12, color: theme.danger }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={{ padding: '5px 14px' }}>{t('取消')}</button>
          <button type="button" onClick={() => void save()} disabled={saving} style={{ padding: '5px 14px' }}>
            {saving ? t('保存中…') : t('保存')}
          </button>
        </div>
      </div>
    </div>
  );
}

function IconWand() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M12.2 5.2L11 4M3 21l9-9M12.2 5.2l6.6 6.6" />
    </svg>
  );
}
