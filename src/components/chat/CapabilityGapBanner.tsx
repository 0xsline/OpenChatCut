import { useState } from 'react';
import { getLocale } from '../../i18n/locale';
import type { ChatPanelController } from './chatPanelController';
import { CAPABILITY_LABELS, formatCapabilityNames, missingCreativeCaps } from './capabilityBanner';

export function CapabilityBanner({ controller }: { controller: ChatPanelController }) {
  const { props, t } = controller;
  const [dismissed, setDismissed] = useState(false);
  const missing = missingCreativeCaps();
  if (dismissed || !props.onOpenSettings || missing.length === 0) return null;
  const names = formatCapabilityNames(
    missing.map((key) => t(CAPABILITY_LABELS[key] ?? key)),
    getLocale(),
  );
  return <div className="cc-chat-capability-banner">
    <span>{t('以下能力未配置，相关功能暂不可用：')}{names}</span>
    <button type="button" onClick={props.onOpenSettings}>{t('去设置配置')}</button>
    <button type="button" className="cc-chat-capability-banner-close" aria-label={t('关闭')}
      onClick={() => setDismissed(true)}>×</button>
  </div>;
}
