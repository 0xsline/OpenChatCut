import { useEffect, useRef, useState } from 'react';
import type { LiveTool, PendingGuard } from '../../agent/agent-session';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import { GUARD_SKILL_LABELS } from './chatPanelPresets';
import { thinkingPhrase } from './thinkingPhrases';
import { ApprovalDetails } from './ApprovalDetails';

function ElapsedTimer() {
  const [now, setNow] = useState(() => performance.now());
  const startRef = useRef(performance.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(id);
  }, []);
  const seconds = Math.max(0, (now - startRef.current) / 1000);
  return <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.75, flexShrink: 0 }}>{seconds.toFixed(1)}s</span>;
}

export function ChatRunStatus({
  running,
  liveTool,
  streamingThinking,
  phraseSeed,
}: {
  running: boolean;
  liveTool: LiveTool | null;
  streamingThinking: boolean;
  phraseSeed: number;
}) {
  const t = useT();
  return <>
    {running && liveTool && (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, margin: '9px 0', color: theme.textDim, fontSize: 12.5 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: theme.accent, flexShrink: 0, marginTop: 5, animation: 'cc-rec-pulse 1.2s ease-out infinite' }} />
        <span style={{ minWidth: 0, lineHeight: 1.45 }}>
          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: 0.2 }}>{liveTool.name}</span>
          <span style={{ opacity: 0.8 }}> · {t('正在编写参数…')}</span>
          {liveTool.partial.length > 40 && (
            <span style={{ display: 'block', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, opacity: 0.55, overflowWrap: 'anywhere', maxHeight: 48, overflow: 'hidden' }}>
              …{liveTool.partial.slice(-160)}
            </span>
          )}
        </span>
      </div>
    )}
    {running && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: theme.textDim, fontSize: 12.5, margin: '10px 0' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: theme.accent, animation: 'cc-rec-pulse 1.2s ease-out infinite', flexShrink: 0 }} />
        {streamingThinking ? (
          <>
            <style>{'@keyframes cc-think-glow{0%,100%{opacity:.4}50%{opacity:1}}'}</style>
            <span style={{ animation: 'cc-think-glow 1.4s ease-in-out infinite' }}>{t('思考中…')}</span>
          </>
        ) : <>{t(thinkingPhrase(phraseSeed))}…</>}
        <ElapsedTimer />
      </div>
    )}
  </>;
}

export function AgentGuardCard({ pendingGuard }: { pendingGuard: PendingGuard | null }) {
  const t = useT();
  if (!pendingGuard) return null;
  const categoryLabel = pendingGuard.permissionKind === 'persistent_local'
    ? t('本地持久化操作')
    : pendingGuard.permissionKind === 'irreversible_external'
      ? t('不可逆外部操作')
      : t(GUARD_SKILL_LABELS[pendingGuard.skill]);
  return (
    <div style={{ margin: '10px 0', padding: '10px 12px', border: `0.5px solid ${theme.border}`, borderRadius: 4, background: theme.panelAlt }}>
      <div style={{ fontSize: 12.5, color: theme.text, marginBottom: 8, lineHeight: 1.5 }}>
        {t('AI 请求执行需确认操作：{name}', { name: categoryLabel })}
        <span style={{ color: theme.textDim }}>（{pendingGuard.requestedTool ?? pendingGuard.tool}）</span>
        {pendingGuard.summary && !pendingGuard.details?.length && (
          <div style={{ marginTop: 5, color: theme.textDim, fontSize: 11.5, overflowWrap: 'anywhere' }}>
            {pendingGuard.summary}
          </div>
        )}
        <ApprovalDetails
          details={pendingGuard.details}
          argsDigest={pendingGuard.argsDigest}
          operationId={pendingGuard.operationId}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => pendingGuard.resolve('allow-once')}
          style={{ border: `0.5px solid ${theme.accent}`, background: theme.accent, color: theme.onAccent, borderRadius: 6, padding: '5px 14px', fontSize: 12.5, cursor: 'pointer' }}>
          {t('仅本次允许')}
        </button>
        {pendingGuard.approval === 'project' && (
          <button type="button" onClick={() => pendingGuard.resolve('allow-scope')}
            style={{ border: `0.5px solid ${theme.border}`, background: 'transparent', color: theme.text, borderRadius: 6, padding: '5px 14px', fontSize: 12.5, cursor: 'pointer' }}>
            {pendingGuard.skill === 'motion-graphic-gen' ? t('所有工程不再询问') : t('本工程不再询问')}
          </button>
        )}
        <button type="button" onClick={() => pendingGuard.resolve('deny')}
          style={{ border: `0.5px solid ${theme.border}`, background: 'transparent', color: theme.textDim, borderRadius: 6, padding: '5px 14px', fontSize: 12.5, cursor: 'pointer' }}>
          {t('拒绝')}
        </button>
      </div>
    </div>
  );
}
