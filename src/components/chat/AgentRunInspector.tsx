import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/locale';
import {
  loadAgentRuntimeSidecar,
  subscribeAgentRuntime,
  type AgentApprovalRecord,
  type AgentArtifactIndexEntry,
  type AgentCheckpointRecord,
  type AgentRunEvent,
  type AgentToolOutcomeKind,
  type AgentRunRecord,
  type AgentRuntimeSidecar,
} from '../../persist/agentRuntimeStore';
import { theme, themeAlpha } from '../../theme';
import { Icon } from '../icons';

type Translate = (key: string, params?: Record<string, string | number>) => string;
type PopoverBox = { left: number; top: number; width: number; maxHeight: number };

const compactNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const mono: CSSProperties = { fontFamily: 'Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace' };

function useRuntimeSidecar(projectId: string) {
  const [sidecar, setSidecar] = useState<AgentRuntimeSidecar | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setSidecar(null);
    setLoading(true);
    setFailed(false);
    const refresh = async () => {
      try {
        const next = await loadAgentRuntimeSidecar(projectId);
        if (alive) { setSidecar(next); setFailed(false); }
      } catch {
        if (alive) setFailed(true);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void refresh();
    const unsubscribe = subscribeAgentRuntime(projectId, () => { void refresh(); });
    return () => { alive = false; unsubscribe(); };
  }, [projectId]);
  return { sidecar, loading, failed };
}

function usePopoverBox(open: boolean, anchor: HTMLElement | null): PopoverBox | null {
  const [box, setBox] = useState<PopoverBox | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchor) { setBox(null); return; }
    const place = () => {
      const trigger = anchor.getBoundingClientRect();
      const boundary = anchor.closest<HTMLElement>('[data-cc-chat-popover-boundary]')?.getBoundingClientRect();
      const margin = 8;
      const availableWidth = Math.max(240, (boundary?.width ?? window.innerWidth) - margin * 2);
      const width = Math.min(380, availableWidth, window.innerWidth - margin * 2);
      const minLeft = Math.max(margin, (boundary?.left ?? 0) + margin);
      const maxLeft = Math.min(window.innerWidth - width - margin, (boundary?.right ?? window.innerWidth) - width - margin);
      const left = Math.max(minLeft, Math.min(trigger.right - width, Math.max(minLeft, maxLeft)));
      const top = Math.min(trigger.bottom + 6, window.innerHeight - 120);
      setBox({ left, top, width, maxHeight: Math.max(112, window.innerHeight - top - margin) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, open]);
  return box;
}

function statusLabel(status: string, t: Translate): string {
  return {
    running: t('运行中'), waiting_approval: t('等待确认'), awaiting_user: t('等待回复'),
    completed: t('已完成'), failed: t('失败'), aborted: t('已取消'), interrupted: t('已中断'),
  }[status] ?? t('未知状态');
}

function statusColor(status: string): string {
  if (status === 'completed') return theme.success;
  if (status === 'failed') return theme.danger;
  if (status === 'waiting_approval' || status === 'awaiting_user') return theme.gold;
  if (status === 'running') return theme.accent;
  return theme.textDim;
}

function numberText(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? compactNumber.format(value) : undefined;
}
function percentText(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value * 100)}%`
    : undefined;
}


function validTime(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toLocaleString()
    : '—';
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function contextMetric(context: unknown, key: string): unknown {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return undefined;
  return Reflect.get(context, key);
}
function cacheMissLabel(value: unknown, t: Translate): string | undefined {
  if (typeof value !== 'string') return undefined;
  return {
    none: t('已命中缓存'),
    first_request: t('首次请求'),
    model_changed: t('模型已变化'),
    system_prompt_changed: t('系统提示已变化'),
    tool_surface_changed: t('工具面已变化'),
    idle_ttl_expired: t('缓存已过期'),
    unknown: t('未确认原因'),
  }[value];
}


function isOutcomeKind(value: unknown): value is AgentToolOutcomeKind {
  return typeof value === 'string' && [
    'success', 'validation_failed', 'denied', 'aborted_before_side_effect',
    'stale', 'retryable_failure', 'outcome_unknown', 'terminal_failure',
  ].includes(value);
}


function validToolOutcomes(events: unknown): AgentRunEvent[] {
  if (!Array.isArray(events)) return [];
  return events.filter((event): event is AgentRunEvent =>
    !!event && typeof event === 'object' && 'type' in event && event.type === 'tool_outcome');
}

function Metric({ label, value, title }: { label: string; value: string | number | undefined; title?: string }) {
  return <span style={metric} title={title ?? label}><span style={{ color: theme.textDim }}>{label}</span> {value ?? '—'}</span>;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <section style={section}>
    <h4 style={sectionTitle} title={hint}>{title}{hint && <Icon name="info" size={11} />}</h4>
    {children}
  </section>;
}

function ContextSection({ run, t }: { run: AgentRunRecord; t: Translate }) {
  const context = run.context;
  // 缓存写仅对支持「显式写缓存」的 provider（如 Anthropic）有意义；DeepSeek 等
  // 只有服务器端 prompt 缓存，从不回报缓存写。无值时隐藏，避免显示无意义的 —。
  const cacheWriteTokens = numberText(contextMetric(context, 'cacheWriteTokens'));
  return <Section title={t('上下文与工具')} hint={t('本次运行与最近一次模型请求的 token 用量、缓存与工具面信息')}>
    <div style={subheadInSection}>{t('最近一次模型请求')}</div>
    <div style={metrics}>
      <Metric label={t('输入')} title={t('输入 token：最近一次模型请求的输入量（提示词+工具结果）')} value={numberText(contextMetric(context, 'inputTokens'))} />
      <Metric label={t('输出')} title={t('输出 token：最近一次模型请求返回的文本量')} value={numberText(contextMetric(context, 'outputTokens'))} />
      <Metric label={t('系统')} title={t('系统提示词占用的输入 token')} value={numberText(contextMetric(context, 'systemTokens'))} />
      <Metric label={t('历史')} title={t('对话历史占用的输入 token')} value={numberText(contextMetric(context, 'historyTokens'))} />
    </div>
    <div style={subheadInSection}>{t('缓存')}</div>
    <div style={metrics}>
      <Metric label={t('缓存读')} title={t('缓存读：本次命中缓存的输入 token 数；命中越多越省')} value={numberText(contextMetric(context, 'cacheReadTokens'))} />
      {cacheWriteTokens !== undefined && (
        <Metric label={t('缓存写')} title={t('缓存写：本次写入缓存的 token 数（仅部分模型支持）')} value={cacheWriteTokens} />
      )}
      <Metric label={t('未缓存')} title={t('未缓存：本次未命中缓存、需重新计算的输入 token')} value={numberText(contextMetric(context, 'noCacheTokens'))} />
      <Metric label={t('命中率')} title={t('本次运行累计的缓存命中比例')} value={percentText(contextMetric(context, 'cacheHitRatio'))} />
      <Metric label={t('诊断')} title={t('上次缓存未命中的原因，用于判断为何没省到缓存')} value={cacheMissLabel(contextMetric(context, 'cacheMissReason'), t)} />
    </div>
    <div style={subheadInSection}>{t('工具')}</div>
    <div style={metrics}>
      <Metric label={t('活跃工具')} title={t('本次请求向模型开放可调用的工具数量')} value={numberText(contextMetric(context, 'activeToolCount'))} />
      <Metric label={t('工具定义')} title={t('随请求一起发送给模型的工具 Schema 数量')} value={numberText(contextMetric(context, 'toolSchemaCount'))} />
    </div>
    <div style={subheadInSection}>{t('本次运行累计')}</div>
    <div style={metrics}>
      <Metric label={t('模型请求')} title={t('本次运行累计发起的模型请求次数')} value={numberText(contextMetric(context, 'modelRequestCount'))} />
      <Metric label={t('累计输入')} title={t('本次运行所有模型请求的输入 token 之和')} value={numberText(contextMetric(context, 'totalInputTokens'))} />
      <Metric label={t('新鲜输入')} title={t('未命中任何缓存、真正新计算的输入 token 之和')} value={numberText(contextMetric(context, 'totalFreshInputTokens'))} />
      <Metric label={t('累计输出')} title={t('本次运行所有模型请求的输出 token 之和')} value={numberText(contextMetric(context, 'totalOutputTokens'))} />
      <Metric label={t('累计重试')} title={t('本次运行因临时错误自动重试的次数')} value={numberText(contextMetric(context, 'totalRetryCount'))} />
      <Metric label={t('图片输入')} title={t('本次发送给模型的图片数量')} value={numberText(contextMetric(context, 'totalMediaInputs'))} />
    </div>
    <details style={detailsStyle}>
      <summary style={detailsSummary}>{t('高级细节')}</summary>
      <div style={metrics}>
        <Metric label={t('Schema 字符')} title={t('全部工具 Schema 的字符数，衡量工具面大小')} value={numberText(contextMetric(context, 'toolSchemaChars'))} />
      </div>
    </details>
  </Section>;
}

function CheckpointSection({ checkpoint, t }: { checkpoint?: AgentCheckpointRecord; t: Translate }) {
  if (!checkpoint) return <Section title={t('上下文检查点')} hint={t('长对话被压缩后的摘要检查点，用于追溯上下文如何被裁剪')}><div style={emptyLine}>{t('本次运行没有检查点')}</div></Section>;
  return <Section title={t('上下文检查点')} hint={t('长对话被压缩后的摘要检查点，用于追溯上下文如何被裁剪')}>
    <div style={detailLine}>{checkpoint.summary || t('无摘要')}</div>
    <div style={subtle}>{t('源消息 {count} 条', { count: numberText(checkpoint.sourceMessageCount) ?? '—' })}</div>
    <code title={checkpoint.sourceDigest} style={digest}>{checkpoint.sourceDigest}</code>
    {checkpoint.summaryDigest && <code title={checkpoint.summaryDigest} style={digest}>{checkpoint.summaryDigest}</code>}
  </Section>;
}

function outcomeLabel(event: AgentRunEvent, t: Translate): string {
  const kind = event.outcome?.kind;
  if (!isOutcomeKind(kind)) return t('未知结果');
  const labels: Record<AgentToolOutcomeKind, string> = {
    success: t('成功'),
    validation_failed: t('校验失败'),
    denied: t('已拒绝'),
    aborted_before_side_effect: t('副作用前已中止'),
    stale: t('已过期'),
    retryable_failure: t('可重试失败'),
    outcome_unknown: t('结果未知'),
    terminal_failure: t('终止失败'),
  };
  return labels[kind];
}

function ToolOutcomeSection({ events, t }: { events: unknown; t: Translate }) {
  const outcomes = validToolOutcomes(events).slice(-8).reverse();
  return <Section title={t('工具结果')} hint={t('最近调用的工具及其执行结果（只列最近 8 条）')}>
    {outcomes.length === 0 ? <div style={emptyLine}>{t('没有工具结果')}</div> : outcomes.map((event) => {
      const detail = firstText(event.outcome?.summary, event.outcome?.code, event.operationId);
      return <div key={event.eventId} style={row}>
        <span style={{ ...statusDot, background: statusColor(event.outcome?.kind === 'success' ? 'completed' : 'failed') }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={rowTitle}><code style={mono}>{textValue(event.toolName) ?? t('未知工具')}</code><span>{outcomeLabel(event, t)}</span></div>
          {detail && <div style={subtle}>{detail}</div>}
        </div>
      </div>;
    })}
  </Section>;
}

function approvalLabel(status: string, t: Translate): string {
  return {
    pending: t('待决定'), allowed: t('已允许'), denied: t('已拒绝'),
    expired: t('已过期'), cancelled: t('已取消'),
  }[status] ?? t('未知状态');
}

function ApprovalSection({ approvals, t }: { approvals: readonly AgentApprovalRecord[]; t: Translate }) {
  return <Section title={t('审批')} hint={t('本次运行涉及的确认/审批记录（只列前 6 条）')}>
    {approvals.length === 0 ? <div style={emptyLine}>{t('没有审批记录')}</div> : approvals.slice(0, 6).map((approval) => {
      const detail = firstText(approval.summary, approval.operationId);
      return <div key={approval.approvalId} style={row}>
        <span style={{ ...statusDot, background: statusColor(approval.status === 'allowed' ? 'completed' : approval.status === 'pending' ? 'waiting_approval' : 'failed') }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={rowTitle}><code style={mono}>{textValue(approval.toolName) ?? t('未知工具')}</code><span>{approvalLabel(approval.status, t)}</span></div>
          {detail && <div style={subtle}>{detail}</div>}
          <code title={approval.argsDigest} style={digest}>{t('参数摘要')} {approval.argsDigest}</code>
        </div>
      </div>;
    })}
  </Section>;
}

function ArtifactSection({ artifacts, t }: { artifacts: readonly AgentArtifactIndexEntry[]; t: Translate }) {
  return <Section title={t('归档结果')} hint={t('本次运行归档的产物记录（只列前 6 条）')}>
    {artifacts.length === 0 ? <div style={emptyLine}>{t('没有归档结果')}</div> : artifacts.slice(0, 6).map((artifact) => (
      <div key={artifact.artifactId} style={artifactRow}>
        <div style={rowTitle}><code title={artifact.artifactId} style={mono}>{artifact.artifactId}</code><span>{textValue(artifact.toolName) ?? artifact.kind}</span></div>
        <div style={subtle}>
          {numberText(artifact.originalChars) ?? '—'} {t('字符')} · {numberText(artifact.originalBytes) ?? '—'} {t('字节')}
          {artifact.redacted ? ` · ${t('已脱敏')}` : ''}{artifact.binaryOmitted ? ` · ${t('已省略二进制')}` : ''}
        </div>
        <code title={artifact.bodySha256} style={digest}>SHA-256 {artifact.bodySha256}</code>
      </div>
    ))}
  </Section>;
}

function InspectorContent({ sidecar, loading, failed, t }: {
  sidecar: AgentRuntimeSidecar | null;
  loading: boolean;
  failed: boolean;
  t: Translate;
}) {
  if (loading && !sidecar) return <div role="status" style={emptyState}>{t('正在读取运行记录…')}</div>;
  if (failed && !sidecar) return <div role="alert" style={emptyState}>{t('无法读取运行记录')}</div>;
  const run = sidecar?.runs[0];
  if (!run) return <div style={emptyState}><strong>{t('还没有运行记录')}</strong><span>{t('发送消息后可在这里查看运行状态；中断的操作不会自动重放。')}</span></div>;
  const checkpoint = sidecar.checkpoints.find((item) => item.runId === run.runId);
  const approvals = sidecar.approvals.filter((item) => item.runId === run.runId);
  const artifacts = sidecar.artifacts.filter((item) => item.runId === run.runId);
  return <>
    <div style={runSummary}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ ...statusDot, background: statusColor(run.status) }} />
        <strong style={{ color: theme.text, fontSize: 12.5 }}>{statusLabel(run.status, t)}</strong>
        <span style={{ marginLeft: 'auto', color: theme.textDim, fontSize: 10.5 }}>{validTime(run.updatedAt)}</span>
      </div>
      <div style={backend}>{textValue(run.backend) ?? t('未知后端')} · {textValue(run.modelId) ?? t('未知模型')}</div>
      <div style={{ ...subtle, marginTop: 4 }}>{run.userInputPreview || t('未记录请求摘要')}</div>
    </div>
    {run.status === 'interrupted' && <div role="note" style={interrupted}>{t('这次运行被意外中断，系统不会自动继续或重放副作用。请先检查外部任务状态，再决定是否重试。')}</div>}
    <ContextSection run={run} t={t} />
    <CheckpointSection checkpoint={checkpoint} t={t} />
    <ToolOutcomeSection events={run.events} t={t} />
    <ApprovalSection approvals={approvals} t={t} />
    <ArtifactSection artifacts={artifacts} t={t} />
  </>;
}

export function AgentRunInspector({ projectId }: { projectId: string }) {
  const t = useT();
  const { sidecar, loading, failed } = useRuntimeSidecar(projectId);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const box = usePopoverBox(open, triggerRef.current);
  const close = useCallback(() => { setOpen(false); requestAnimationFrame(() => triggerRef.current?.focus()); }, []);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close, open]);
  useEffect(() => {
    if (open && box) requestAnimationFrame(() => closeRef.current?.focus());
  }, [box, open]);
  const latest = sidecar?.runs[0];
  return <>
    <button ref={triggerRef} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls="cc-agent-run-inspector"
      title={t('Agent 运行检查器')} aria-label={t('Agent 运行检查器')} onClick={() => setOpen((value) => !value)}
      className="cc-header-btn" style={trigger}>
      <Icon name="list" size={14} />
      {latest && <span aria-hidden style={{ ...triggerDot, background: statusColor(latest.status) }} />}
    </button>
    {open && box && createPortal(
      <div role="presentation" onPointerDown={close} style={backdrop}>
        <section id="cc-agent-run-inspector" role="dialog" aria-label={t('Agent 运行检查器')}
          onPointerDown={(event) => event.stopPropagation()} style={{ ...popover, ...box }}>
          <header style={header}>
            <div><strong style={{ fontSize: 13 }}>{t('Agent 运行检查器')}</strong><div style={subtle}>{t('只读诊断，不会执行或恢复任何操作。')}</div></div>
            <button ref={closeRef} type="button" onClick={close} aria-label={t('关闭')} title={t('关闭')} className="cc-header-btn" style={closeButton}><Icon name="x" size={14} /></button>
          </header>
          <div style={scroll}><InspectorContent sidecar={sidecar} loading={loading} failed={failed} t={t} /></div>
        </section>
      </div>, document.body,
    )}
  </>;
}

const trigger: CSSProperties = { position: 'relative', width: 28, height: 28, display: 'grid', placeItems: 'center', padding: 0, border: 0, borderRadius: 4, background: 'none', color: theme.textDim, cursor: 'pointer', lineHeight: 0 };
const triggerDot: CSSProperties = { position: 'absolute', right: 2, bottom: 2, width: 5, height: 5, borderRadius: '50%', boxShadow: `0 0 0 1px ${theme.panel}` };
const backdrop: CSSProperties = { position: 'fixed', inset: 0, zIndex: 70, background: 'transparent' };
const popover: CSSProperties = { position: 'fixed', display: 'flex', flexDirection: 'column', overflow: 'hidden', color: theme.text, border: `0.5px solid ${theme.borderLight}`, borderRadius: 7, background: theme.panelAlt, boxShadow: `0 14px 42px ${themeAlpha.shadow(0.5)}` };
const header: CSSProperties = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '11px 12px', borderBottom: `0.5px solid ${theme.border}` };
const closeButton: CSSProperties = { width: 26, height: 26, display: 'grid', placeItems: 'center', flex: '0 0 auto', padding: 0, border: 0, borderRadius: 4, background: 'transparent', color: theme.textDim, cursor: 'pointer' };
const scroll: CSSProperties = { minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' };
const emptyState: CSSProperties = { minHeight: 130, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5, padding: 20, color: theme.textDim, fontSize: 11.5, lineHeight: 1.5, textAlign: 'center' };
const runSummary: CSSProperties = { padding: '10px 12px 9px' };
const statusDot: CSSProperties = { width: 7, height: 7, flex: '0 0 auto', borderRadius: '50%' };
const backend: CSSProperties = { marginTop: 6, color: theme.text, fontSize: 11.5, ...mono };
const interrupted: CSSProperties = { margin: '0 12px 8px', padding: 8, border: `0.5px solid ${theme.gold}`, borderRadius: 4, color: theme.text, background: themeAlpha.ink(0.04), fontSize: 11, lineHeight: 1.45 };
const section: CSSProperties = { padding: '9px 12px', borderTop: `0.5px solid ${theme.border}` };
const sectionTitle: CSSProperties = { margin: '0 0 7px', color: theme.textMuted, fontSize: 10.5, fontWeight: 650, display: 'flex', alignItems: 'center', gap: 4 };
const subheadInSection: CSSProperties = { margin: '6px 0 4px', color: theme.textMuted, fontSize: 9.5, fontWeight: 650, textTransform: 'uppercase', letterSpacing: 0.3 };
const detailsStyle: CSSProperties = { marginTop: 5 };
const detailsSummary: CSSProperties = { color: theme.textDim, fontSize: 10, cursor: 'pointer', userSelect: 'none' };
const metrics: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '5px 10px' };
const metric: CSSProperties = { color: theme.text, fontSize: 10.5, fontVariantNumeric: 'tabular-nums' };
const row: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0' };
const artifactRow: CSSProperties = { padding: '5px 0' };
const rowTitle: CSSProperties = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, color: theme.text, fontSize: 10.5 };
const detailLine: CSSProperties = { color: theme.text, fontSize: 11, lineHeight: 1.45 };
const subtle: CSSProperties = { color: theme.textDim, fontSize: 10.5, lineHeight: 1.4, overflowWrap: 'anywhere' };
const emptyLine: CSSProperties = { color: theme.textDim, fontSize: 10.5 };
const digest: CSSProperties = { display: 'block', marginTop: 5, color: theme.textDim, fontSize: 9.5, lineHeight: 1.35, overflowWrap: 'anywhere', ...mono };
