import { getLocale, useT } from '../../i18n/locale';
import { CREATIVE_SKILLS, allCreativeSkills } from '../../agent/skills/skills-catalog';
import { Icon } from '../icons';
import { activateWorkflowStarter } from './workflowStarters';

interface WorkflowPickerContentProps {
  creativeMode: string | null;
  onCreativeModeChange: (id: string | null) => void;
  onPromptChange: (value: string) => void;
  onRequestFocus: () => void;
  onClose: () => void;
}

export function WorkflowPickerContent({
  creativeMode,
  onCreativeModeChange,
  onPromptChange,
  onRequestFocus,
  onClose,
}: WorkflowPickerContentProps) {
  const t = useT();
  const builtinIds = new Set(CREATIVE_SKILLS.map((skill) => skill.id));
  const skillName = (skill: { name: string; nameZh: string }) => (
    getLocale() === 'en' ? skill.name : skill.nameZh
  );

  return (
    <>
      <div className="cc-creative-picker-head">
        <span><Icon name="wand" size={15} /></span>
        <div>
          <strong>{t('选择创作工作流')}</strong>
          <small>{t('工作流会约束 Agent 的规划与工具调用。')}</small>
        </div>
      </div>
      <button
        type="button"
        onClick={() => { onCreativeModeChange(null); onClose(); }}
        className="cc-creative-mode-row"
        data-active={!creativeMode}
        aria-pressed={!creativeMode}
      >
        <span className="cc-creative-mode-icon"><Icon name="sparkles" size={15} /></span>
        <span className="cc-creative-mode-copy">
          <strong>{t('自由创作')}</strong>
          <small>{t('不限定工作流，根据当前目标灵活执行。')}</small>
        </span>
        {!creativeMode && <span className="cc-creative-mode-check"><Icon name="check" size={13} strokeWidth={2.4} /></span>}
      </button>
      <div className="cc-creative-picker-section">{t('专业工作流')}</div>
      <div className="cc-creative-mode-grid">
        {allCreativeSkills().map((skill) => (
          <button
            type="button"
            key={skill.id}
            onClick={() => {
              activateWorkflowStarter(skill, {
                translate: t,
                locale: getLocale(),
                onCreativeModeChange,
                onPromptChange,
                onRequestFocus,
              });
              onClose();
            }}
            className="cc-creative-mode-row cc-creative-mode-card"
            data-active={creativeMode === skill.id}
            aria-pressed={creativeMode === skill.id}
            title={t(skill.summary)}
          >
            <span className="cc-creative-mode-icon"><Icon name="wand" size={15} /></span>
            <span className="cc-creative-mode-copy">
              <span className="cc-creative-mode-title">
                <strong>{skillName(skill)}</strong>
                {!builtinIds.has(skill.id) && <em>{t('自定义')}</em>}
              </span>
              <small>{t(skill.summary)}</small>
            </span>
            {creativeMode === skill.id && <span className="cc-creative-mode-check"><Icon name="check" size={13} strokeWidth={2.4} /></span>}
          </button>
        ))}
      </div>
    </>
  );
}
