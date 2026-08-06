// Skill library tab: creative workflows + custom skills, mirroring the chat
// composer picker. Selecting a card activates the creative mode (same state
// the composer uses); the active skill is highlighted.
import { useEffect, useState } from 'react';
import { getLocale, useT } from '../i18n/locale';
import { allCreativeSkills, setCustomSkills, findSkill } from '../agent/skills/skills-catalog';
import { loadCustomSkills } from '../persist/skillStore';
import type { SkillDefinition } from '../agent/skills/skill-types';
import { theme } from '../theme';

export function SkillsTabPanel({
  creativeMode,
  onCreativeModeChange,
}: {
  creativeMode: string | null;
  onCreativeModeChange: (id: string | null) => void;
}) {
  const t = useT();
  const [, bumpCustom] = useState(0);
  useEffect(() => {
    loadCustomSkills().then((list) => { setCustomSkills(list); bumpCustom((n) => n + 1); });
  }, []);
  const skills = allCreativeSkills();
  const active = findSkill(creativeMode);
  const skillName = (s: SkillDefinition) => (getLocale() === 'en' ? s.name : s.nameZh);
  const builtinIds = new Set(['long-video-to-shorts', 'multi-clips-to-reels', 'ai-cinematic-short-film', 'product-ad-video-script', 'explainer-video', 'motion-graphic-placement', 'storyboard-shot-breakdown', 'video-thumbnail-generator', 'skill-creator']);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto', padding: '12px 14px 18px', gap: 8 }}>
      <div style={{ fontSize: 11.5, color: theme.textDim, lineHeight: 1.5, marginBottom: 4 }}>
        {t('选择创作工作流会约束 Agent 的规划与工具调用；激活后下一条消息按该工作流执行。')}
      </div>
      {active && (
        <button
          type="button"
          onClick={() => onCreativeModeChange(null)}
          style={{ textAlign: 'left', padding: '9px 12px', borderRadius: 6, border: `0.5px solid ${theme.accent}`, background: theme.panelAlt, cursor: 'pointer', color: theme.text }}
        >
          <div style={{ fontSize: 12, fontWeight: 600 }}>{t('当前：{name}', { name: skillName(active) })}</div>
          <div style={{ fontSize: 11, color: theme.textDim, marginTop: 2 }}>{t('点击取消创作模式，回到自由创作')}</div>
        </button>
      )}
      <div className="cc-creative-picker-section">{t('专业工作流')}</div>
      <div className="cc-creative-mode-grid">
        {skills.map((skill) => (
          <button
            type="button"
            key={skill.id}
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
                {!builtinIds.has(skill.slug) && <em>{t('自定义')}</em>}
              </span>
              <small>{t(skill.summary)}</small>
            </span>
            {creativeMode === skill.id && <span className="cc-creative-mode-check">✓</span>}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: theme.textDim, marginTop: 10, lineHeight: 1.5 }}>
        {t('提示：也可在聊天输入框用 /skill:名称 快速激活，或用「技能创作器」创建自己的技能。')}
      </div>
    </div>
  );
}

function IconWand() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M12.2 5.2L11 4M3 21l9-9M12.2 5.2l6.6 6.6" />
    </svg>
  );
}
