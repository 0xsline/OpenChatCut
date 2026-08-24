import { createPortal } from 'react-dom';
import { theme } from '../../theme';
import { BrandMark, Icon, OpenChatCutWordmark } from '../icons';
import { AgentChangeLogMenu } from './AgentChangeLogMenu';
import { AgentRunInspector } from './AgentRunInspector';
import { ChatComposer } from './ChatComposer';
import { ChatMessage } from './ChatMessage';
import { ChatRunStatus } from './ChatRunStatus.tsx';
import { ExternalProposalCard } from './ExternalProposalCard';
import { ProposalCard } from './ProposalCard';
import { ToolGroupRow } from './ToolGroupRow';
import { groupMessages } from './message-groups';
import { EMPTY_PROJECT_STARTERS, QUICK_ACTIONS } from './chatPanelPresets';
import type { DisplayMessage } from '../../agent/agent-session';
import { readStoredServerRun } from '../../agent/serverRunSessionStorage';
import type { ChatPanelController } from './chatPanelController';
import { CapabilityBanner } from './CapabilityGapBanner';

const MESSAGE_WINDOW_SIZE = 40;

function ChangeLogPortal({ controller }: { controller: ChatPanelController }) {
  const { changeLogSlot, agent } = controller;
  if (!changeLogSlot) return null;
  return createPortal(
    <AgentChangeLogMenu
      changeLog={agent.changeLog}
      running={agent.running}
      canRollback={agent.canRollbackChangeSession}
      onRollback={agent.rollbackChangeSession}
    />,
    changeLogSlot,
  );
}

function CollapsedPanel({ controller }: { controller: ChatPanelController }) {
  const { props, t } = controller;
  return <>
    <ChangeLogPortal controller={controller} />
    <aside className="cc-chat-panel collapsed" data-cc-shortcut-surface="agent-chat" tabIndex={-1}
      style={{ gridColumn: 1, gridRow: '2 / 5', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '10px 0', borderRight: `0.5px solid ${theme.border}`, background: theme.panel }}>
      <button type="button" onClick={props.onToggleCollapse} title={t('展开 OpenChatCut Agent')}
        style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 14 }}>
        <span style={{ transform: 'rotate(-90deg)', display: 'inline-flex' }}><Icon name="chevronDown" size={14} /></span>
      </button>
      <div className="cc-chat-collapsed-brand">OpenChatCut</div>
    </aside>
  </>;
}

function ChatHeader({ controller }: { controller: ChatPanelController }) {
  const { props, t, agent } = controller;
  return <div className="cc-chat-header">
    <div className="cc-chat-brand">
      <BrandMark size={20} />
      <span className="cc-chat-brand-copy">
        <OpenChatCutWordmark width={102} />
        <small>{t('Agent 工作台')}</small>
      </span>
    </div>
    <AgentRunInspector projectId={props.projectId} />
    <button type="button" onClick={agent.clearHistory} disabled={agent.running} title={t('清空对话')}
      style={{ background: 'none', border: 'none', color: theme.textDim, cursor: agent.running ? 'default' : 'pointer', opacity: agent.running ? 0.4 : 1, padding: 2, lineHeight: 0 }}>
      <Icon name="trash" size={14} />
    </button>
    <button type="button" onClick={props.onToggleCollapse} title={t('收起 OpenChatCut Agent')}
      style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 13 }}>
      <span style={{ transform: 'rotate(90deg)', display: 'inline-flex' }}><Icon name="chevronDown" size={14} /></span>
    </button>
  </div>;
}

function ChatOnboarding({ controller }: { controller: ChatPanelController }) {
  const { composer, t } = controller;
  return <div className="cc-chat-onboarding">
    <div className="cc-chat-onboarding-kicker">{t('从这里开工')}</div>
    <h2>{t('从一个剪辑目标开始')}</h2>
    <p>{t('选择工作流，或直接描述你想得到的成片。')}</p>
    <div className="cc-chat-starter-list">
      {EMPTY_PROJECT_STARTERS.map((starter) => (
        <button type="button" key={starter.label} onClick={() => {
          composer.setInput(t(starter.prompt));
          requestAnimationFrame(() => composer.taRef.current?.focus());
        }}>
          <span className="cc-chat-starter-icon"><Icon name={starter.icon} size={16} /></span>
          <span className="cc-chat-starter-copy">
            <strong>{t(starter.label)}</strong><small>{t(starter.description)}</small>
          </span>
          <span className="cc-chat-starter-arrow" aria-hidden="true">→</span>
        </button>
      ))}
    </div>
  </div>;
}

function EarlierMessagesButton({ controller }: { controller: ChatPanelController }) {
  const { visibleFrom, composer, t, scroll } = controller;
  if (visibleFrom === 0) return null;
  return <button type="button"
    onClick={() => {
      // Keep the current viewport anchored: the newly loaded history is
      // inserted above, so restore the previous bottom offset after render.
      const node = scroll.scrollRef.current;
      const bottomBefore = node ? node.scrollHeight - node.scrollTop : 0;
      composer.setVisibleMessageCount((count) => count + MESSAGE_WINDOW_SIZE);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (node) node.scrollTop = node.scrollHeight - bottomBefore;
      }));
    }}
    style={{ display: 'block', margin: '4px auto 12px', padding: '5px 10px', border: `0.5px solid ${theme.border}`, borderRadius: 6, background: 'transparent', color: theme.textDim, cursor: 'pointer', fontSize: 12 }}>
    {t('加载更早消息')}（{visibleFrom}）
  </button>;
}

function MessageEntries({ controller }: { controller: ChatPanelController }) {
  const { agent, composer, visibleMessages, visibleFrom } = controller;
  const onRetry = (retry: NonNullable<DisplayMessage['retry']>) => {
    if (!agent.running) void agent.send(retry.text, {
      askOnly: retry.askOnly,
      references: retry.references,
    });
  };
  return <>
    {groupMessages(visibleMessages, visibleFrom).map((item) => item.kind === 'toolgroup' ? (
      <ToolGroupRow key={item.index} name={item.name} items={item.items} />
    ) : (
      <ChatMessage key={item.index} msg={item.msg} running={agent.running}
        retry={item.msg.role === 'user' ? item.msg.retry : undefined}
        streaming={agent.running && item.index === agent.messages.length - 1 && item.msg.role === 'assistant'}
        widgetSubmitted={agent.messages.slice(item.index + 1).some((message) => message.role === 'user')}
        onRetry={onRetry}
        onContinue={item.msg.role === 'continue' && item.index === agent.messages.length - 1 && !agent.running
          ? () => { void agent.send('继续'); } : null}
        onWidgetSubmit={(answer) => {
          if (!agent.running) void agent.send(answer, { askOnly: composer.mode === 'ask' });
        }} />
    ))}
  </>;
}

function AgentRunCards({ controller }: { controller: ChatPanelController }) {
  const { agent, composer, externalProposal, props, streamingThinking, runSeed } = controller;
  const showProposal = agent.proposal
    && !composer.autoApply;
  return <>
    <ChatRunStatus running={agent.running} liveTool={agent.liveTool}
      streamingThinking={streamingThinking} phraseSeed={runSeed}
      startedAt={readStoredServerRun(props.projectId)?.createdAt ?? Date.now()} />
    {showProposal && agent.proposal && (
      <ProposalCard proposal={agent.proposal} onApply={agent.applyProposal} onReject={agent.rejectProposal}
        stale={agent.proposalStale} onForceApply={agent.forceApplyProposal} onRePropose={agent.reProposeStale}
        onPreview={(on) => props.onPreviewState(on ? agent.proposal?.resultState ?? null : null)} />
    )}
    <ExternalProposalCard external={externalProposal} onPreviewState={props.onPreviewState} />
  </>;
}

function ScrollNavigation({ controller }: { controller: ChatPanelController }) {
  const { scroll, t } = controller;
  const target = scroll.target;
  if (!target) return null;
  const label = t(target === 'top' ? '快速到顶部' : '快速到底部');
  return <div className={`cc-chat-scroll-navigation cc-chat-scroll-navigation--${target}`}
    aria-label={t('聊天滚动快捷操作')}>
    <button type="button"
      className={`cc-chat-scroll-navigation-button cc-tip${target === 'bottom' ? ' cc-chat-scroll-navigation-button--bottom cc-tip-up' : ''}`}
      data-tip={label} aria-label={label} onClick={() => scroll.scrollTo(target)}>
      <Icon name="arrowUp" size={14} />
    </button>
  </div>;
}

function MessageWorkspace({ controller }: { controller: ChatPanelController }) {
  const { agent, scroll } = controller;
  return <div className="cc-chat-messages-shell">
    <div ref={scroll.scrollRef} onScroll={scroll.onScroll}
      className={`cc-chat-messages${agent.messages.length === 0 ? ' empty' : ''}`}>
      {agent.messages.length === 0 && <ChatOnboarding controller={controller} />}
      <EarlierMessagesButton controller={controller} />
      <MessageEntries controller={controller} />
      <AgentRunCards controller={controller} />
    </div>
    <ScrollNavigation controller={controller} />
  </div>;
}

function QuickActionSelect({ controller }: { controller: ChatPanelController }) {
  const { agent, composer, t } = controller;
  return <select aria-label={t('快速操作')} value="" disabled={agent.running}
    onChange={(event) => {
      if (!event.target.value) return;
      const action = QUICK_ACTIONS[Number(event.target.value)];
      if (!action) return;
      composer.setInput(t(action.prompt));
      requestAnimationFrame(() => composer.taRef.current?.focus());
    }}
    style={{ width: '100%', marginBottom: 8, border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: '6px 8px', background: theme.panelAlt, color: theme.text, fontSize: 12 }}>
    <option value="">{t('快速操作…')}</option>
    {QUICK_ACTIONS.map((action, index) => (
      <option key={action.label} value={index}>{t(action.label)}</option>
    ))}
  </select>;
}

function ComposerInput({ controller }: { controller: ChatPanelController }) {
  const { props, agent, composer, actions, references, t } = controller;
  return <ChatComposer
    value={composer.input} onChange={actions.onComposerChange}
    onSubmit={actions.submit} onStop={agent.stop}
    onEnhance={actions.runEnhance} enhancing={composer.enhancing} running={agent.running}
    mode={composer.mode} onModeChange={composer.setMode}
    autoApply={composer.autoApply} onAutoApplyChange={composer.setAutoApply}
    agentSettings={composer.agentSettings} patchAgent={composer.patchAgent}
    contextUsage={agent.contextUsage}
    selecting={composer.selecting} onToggleSelecting={() => composer.setSelecting((value) => !value)}
    creativeMode={props.creativeMode} onCreativeModeChange={props.onCreativeModeChange}
    references={references} onInsertRef={actions.insertRef}
    selectedRefs={composer.selectedRefs} onRemoveRef={actions.removeRef}
    onPasteFiles={actions.importPastedFiles} onDropFiles={actions.importPastedFiles}
    pasting={composer.pendingAttachmentCount > 0}
    pendingAttachmentCount={composer.pendingAttachmentCount}
    pasteError={composer.pasteError} onDismissPasteError={() => composer.setPasteError(null)}
    onDropEditorItem={actions.onDropEditorItem} taRef={composer.taRef}
    placeholder={agent.messages.length === 0
      ? t('描述你想要创建的内容...') : t('告诉 AI 要做哪些修改 - @ 引用素材')} />;
}

function ComposerSection({ controller }: { controller: ChatPanelController }) {
  return <div style={{ padding: 12, borderTop: `0.5px solid ${theme.border}`, minWidth: 0, flexShrink: 0, boxSizing: 'border-box' }}>
    <QuickActionSelect controller={controller} />
    <ComposerInput controller={controller} />
  </div>;
}

function ExpandedPanel({ controller }: { controller: ChatPanelController }) {
  const { scroll } = controller;
  return <>
    <ChangeLogPortal controller={controller} />
    <aside className="cc-chat-panel" data-cc-chat-popover-boundary data-cc-shortcut-surface="agent-chat"
      tabIndex={-1} onKeyDown={scroll.onKeyDown}
      onPointerDownCapture={(event) => {
        if (!(event.target instanceof HTMLElement)) return;
        if (!event.target.closest('button, input, select, textarea, [contenteditable="true"]')) {
          event.currentTarget.focus({ preventScroll: true });
        }
      }}
      style={{ gridColumn: 1, gridRow: '2 / 5', display: 'flex', flexDirection: 'column', borderRight: `0.5px solid ${theme.border}`, background: theme.panel, minHeight: 0, minWidth: 0 }}>
      <ChatHeader controller={controller} />
      <CapabilityBanner controller={controller} />
      <MessageWorkspace controller={controller} />
      <ComposerSection controller={controller} />
    </aside>
  </>;
}

export function ChatPanelView({ controller }: { controller: ChatPanelController }) {
  return controller.props.collapsed
    ? <CollapsedPanel controller={controller} />
    : <ExpandedPanel controller={controller} />;
}
