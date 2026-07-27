import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../components/icons';
import type { TimelineItem, TimelineState } from '../editor/types';
import { useT } from '../i18n/locale';
import { theme, themeAlpha } from '../theme';
import {
  appendReviewReply,
  createReviewComment,
  removeReviewComment,
  reviewAnchor,
  setReviewResolved,
  type ReviewComment,
} from './reviewModel';
import { loadReviewComments, saveReviewComments } from './reviewStore';

interface ReviewCommentsButtonProps {
  projectId: string;
  timelineId: string;
  state: TimelineState;
  selectedItem: TimelineItem | null;
  openRequest?: ReviewOpenRequest | null;
  getCurrentFrame: () => number;
  onSeek: (frame: number) => void;
}

export interface ReviewOpenRequest {
  itemId: string;
  frame: number;
  clientX: number;
  clientY: number;
  nonce: number;
}

interface ReviewPanelProps extends ReviewCommentsButtonProps {
  comments: ReviewComment[];
  busy: boolean;
  error: string;
  target: ReviewOpenRequest | null;
  commit: (next: ReviewComment[]) => Promise<boolean>;
  onClose: () => void;
}

export function ReviewCommentsButton(props: ReviewCommentsButtonProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ReviewOpenRequest | null>(null);
  const { comments, busy, error, commit } = useStoredComments(props.projectId);
  const openCount = comments.filter((comment) => !comment.resolved).length;

  useEffect(() => {
    if (!props.openRequest) return;
    setTarget(props.openRequest);
    setOpen(true);
  }, [props.openRequest]);

  const toggle = () => {
    if (!open) setTarget(null);
    setOpen(!open);
  };

  return (
    <div style={{ position: 'relative' }}>
      <button type="button" title={t('审阅评论')} aria-label={t('审阅评论')}
        onClick={toggle}
        style={{ ...toolbarButton, color: open ? theme.text : theme.textDim, background: open ? theme.panelAlt : 'transparent' }}>
        <Icon name="clipboard" size={12} />
        <span>{t('评论')}</span>
        {openCount > 0 && <span style={countBadge}>{openCount}</span>}
      </button>
      {open && (
        <ReviewPanel {...props} comments={comments} busy={busy} error={error}
          target={target} commit={commit} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function useStoredComments(projectId: string) {
  const t = useT();
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setComments([]);
    setError('');
    loadReviewComments(projectId)
      .then((loaded) => { if (!cancelled) setComments(loaded); })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : t('评论加载失败'));
      });
    return () => { cancelled = true; };
  }, [projectId, t]);

  const commit = async (next: ReviewComment[]) => {
    setBusy(true);
    setError('');
    try {
      await saveReviewComments(projectId, next);
      setComments(next);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('评论保存失败'));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { comments, busy, error, commit };
}

function ReviewPanel(props: ReviewPanelProps) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const visible = useMemo(
    () => [...props.comments].sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.createdAt - a.createdAt),
    [props.comments],
  );

  useLayoutEffect(() => {
    if (!props.target || !panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(props.target.clientX + 8, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(props.target.clientY + 8, window.innerHeight - rect.height - 8)),
    });
  }, [props.target, visible.length, replyingTo, props.error]);

  const addComment = () => {
    const selectedItem = props.target
      ? props.state.items.find((item) => item.id === props.target?.itemId) ?? null
      : props.selectedItem;
    const anchor = reviewAnchor(
      props.timelineId,
      props.target?.frame ?? props.getCurrentFrame(),
      props.state,
      selectedItem,
    );
    return props.commit([...props.comments, createReviewComment(anchor, text)])
      .then((saved) => { if (saved) setText(''); });
  };
  const addReply = (commentId: string) => props.commit(
    appendReviewReply(props.comments, commentId, reply),
  ).then((saved) => {
    if (saved) {
      setReply('');
      setReplyingTo(null);
    }
  });

  return (
    <div ref={panelRef} role="dialog" aria-label={t('审阅评论')}
      style={props.target ? { ...popover, position: 'fixed', left: position.left, top: position.top, right: 'auto' } : popover}>
      <PanelHeader onClose={props.onClose} />
      <AddCommentForm text={text} setText={setText} busy={props.busy} onAdd={addComment} />
      <CommentList {...props} comments={visible} replyingTo={replyingTo} reply={reply}
        setReply={setReply} setReplyingTo={setReplyingTo} addReply={addReply} />
      {props.error && <div role="alert" style={errorRow}>{props.error}</div>}
    </div>
  );
}

function PanelHeader({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <div style={header}>
      <strong>{t('审阅评论')}</strong>
      <button type="button" title={t('关闭')} onClick={onClose} style={iconButton}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

function AddCommentForm({ text, setText, busy, onAdd }: {
  text: string;
  setText: (value: string) => void;
  busy: boolean;
  onAdd: () => Promise<void>;
}) {
  const t = useT();
  return (
    <div style={{ padding: 10, borderBottom: `0.5px solid ${theme.border}` }}>
      <textarea autoFocus value={text} onChange={(event) => setText(event.target.value)}
        placeholder={t('在当前帧添加审阅评论')} style={textarea} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 }}>
        <span style={{ flex: 1, fontSize: 10, color: theme.textMuted }}>
          {t('绑定当前帧；可用时同时记录片段与源位置')}
        </span>
        <button type="button" disabled={busy || !text.trim()} onClick={() => void onAdd()} style={primaryButton}>
          {t('添加评论')}
        </button>
      </div>
    </div>
  );
}

interface CommentListProps extends ReviewPanelProps {
  replyingTo: string | null;
  reply: string;
  setReply: (value: string) => void;
  setReplyingTo: (value: string | null) => void;
  addReply: (commentId: string) => Promise<void>;
}

function CommentList(props: CommentListProps) {
  const t = useT();
  return (
    <div style={{ overflowY: 'auto', maxHeight: 360, padding: 8 }}>
      {props.comments.length === 0 && <div style={empty}>{t('还没有审阅评论')}</div>}
      {props.comments.map((comment) => (
        <CommentCard key={comment.id} {...props} comment={comment} />
      ))}
    </div>
  );
}

function CommentCard({ comment, ...props }: CommentListProps & { comment: ReviewComment }) {
  const t = useT();
  const startReply = () => { props.setReplyingTo(comment.id); props.setReply(''); };
  return (
    <article style={{ ...commentCard, opacity: comment.resolved ? 0.58 : 1 }}>
      <button type="button" onClick={() => props.onSeek(comment.anchor.frame)} style={anchorButton}>
        {formatFrame(comment.anchor.frame, props.state.fps)}
        {comment.anchor.itemId ? ` · ${t('片段')}` : ` · ${t('时间线')}`}
      </button>
      <p style={{ margin: '7px 0', whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{comment.text}</p>
      {comment.replies.map((entry) => <div key={entry.id} style={replyRow}>{entry.text}</div>)}
      {props.replyingTo === comment.id && (
        <ReplyForm {...props} commentId={comment.id} />
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button type="button" onClick={startReply} style={smallButton}>{t('回复')}</button>
        <button type="button" disabled={props.busy}
          onClick={() => void props.commit(setReviewResolved(props.comments, comment.id, !comment.resolved))} style={smallButton}>
          {comment.resolved ? t('重新打开') : t('解决')}
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" disabled={props.busy} title={t('删除评论')}
          onClick={() => void props.commit(removeReviewComment(props.comments, comment.id))} style={iconButton}>
          <Icon name="trash" size={12} />
        </button>
      </div>
    </article>
  );
}

function ReplyForm({ commentId, reply, setReply, addReply, busy }: CommentListProps & { commentId: string }) {
  const t = useT();
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
      <input autoFocus value={reply} onChange={(event) => setReply(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && reply.trim()) void addReply(commentId); }}
        placeholder={t('输入回复')} style={replyInput} />
      <button type="button" disabled={busy || !reply.trim()} onClick={() => void addReply(commentId)} style={smallButton}>
        {t('回复')}
      </button>
    </div>
  );
}

function formatFrame(frame: number, fps: number): string {
  const seconds = Math.max(0, Math.floor(frame / fps));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

const toolbarButton: CSSProperties = {
  height: 22, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0 7px',
  border: `0.5px solid ${theme.border}`, borderRadius: 5, cursor: 'pointer', fontSize: 11,
};
const countBadge: CSSProperties = {
  minWidth: 14, height: 14, padding: '0 3px', display: 'grid', placeItems: 'center',
  borderRadius: 7, background: theme.accent, color: theme.onAccent, fontSize: 9, fontWeight: 700,
};
const popover: CSSProperties = {
  position: 'absolute', zIndex: 40, top: 27, right: 0, width: 'min(360px, calc(100vw - 32px))',
  border: `0.5px solid ${theme.border}`, borderRadius: 8, background: theme.panel,
  color: theme.text, boxShadow: '0 16px 42px rgba(0,0,0,0.42)', overflow: 'hidden',
};
const header: CSSProperties = {
  height: 36, padding: '0 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  borderBottom: `0.5px solid ${theme.border}`, fontSize: 12,
};
const iconButton: CSSProperties = {
  width: 24, height: 24, display: 'grid', placeItems: 'center', padding: 0,
  border: 'none', borderRadius: 4, background: 'transparent', color: theme.textDim, cursor: 'pointer',
};
const textarea: CSSProperties = {
  width: '100%', minHeight: 62, resize: 'vertical', boxSizing: 'border-box',
  border: `0.5px solid ${theme.border}`, borderRadius: 5, background: theme.inset,
  color: theme.text, padding: '7px 8px', font: 'inherit', fontSize: 11, outline: 'none',
};
const primaryButton: CSSProperties = {
  border: 'none', borderRadius: 4, padding: '5px 9px', background: theme.accent,
  color: theme.onAccent, fontSize: 11, fontWeight: 600, cursor: 'pointer',
};
const smallButton: CSSProperties = {
  border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: '3px 7px',
  background: 'transparent', color: theme.textDim, fontSize: 10, cursor: 'pointer',
};
const commentCard: CSSProperties = {
  padding: 9, marginBottom: 7, border: `0.5px solid ${theme.border}`,
  borderRadius: 6, background: themeAlpha.ink(0.025), fontSize: 11,
};
const anchorButton: CSSProperties = {
  padding: 0, border: 'none', background: 'transparent', color: theme.accent,
  fontSize: 10, cursor: 'pointer',
};
const replyRow: CSSProperties = {
  marginTop: 5, padding: '6px 7px', borderLeft: `2px solid ${theme.border}`,
  color: theme.textDim, background: themeAlpha.ink(0.025), whiteSpace: 'pre-wrap',
};
const replyInput: CSSProperties = {
  minWidth: 0, flex: 1, border: `0.5px solid ${theme.border}`, borderRadius: 4,
  background: theme.inset, color: theme.text, padding: '4px 6px', fontSize: 10, outline: 'none',
};
const empty: CSSProperties = { padding: 24, textAlign: 'center', color: theme.textMuted, fontSize: 11 };
const errorRow: CSSProperties = {
  padding: '7px 10px', borderTop: `0.5px solid ${theme.border}`, color: theme.danger, fontSize: 10,
};
