import type { TimelineItem, TimelineState } from '../editor/types';
import { sourceFrameAt } from '../editor/sourceLimit';

export interface ReviewRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReviewAnchor {
  timelineId: string;
  frame: number;
  itemId?: string;
  assetId?: string;
  sourceFrame?: number;
  region?: ReviewRegion;
}

export interface ReviewReply {
  id: string;
  text: string;
  createdAt: number;
}

export interface ReviewComment {
  id: string;
  text: string;
  createdAt: number;
  resolved: boolean;
  anchor: ReviewAnchor;
  replies: ReviewReply[];
}

const MAX_TEXT_LENGTH = 4_000;
const finiteInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';

function validRegion(value: unknown): value is ReviewRegion {
  if (!value || typeof value !== 'object') return false;
  const region = value as Partial<ReviewRegion>;
  const values = [region.x, region.y, region.width, region.height];
  return values.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    && region.x! >= 0 && region.y! >= 0 && region.width! > 0 && region.height! > 0
    && region.x! + region.width! <= 1 && region.y! + region.height! <= 1;
}

function validAnchor(value: unknown): value is ReviewAnchor {
  if (!value || typeof value !== 'object') return false;
  const anchor = value as Partial<ReviewAnchor>;
  return typeof anchor.timelineId === 'string' && !!anchor.timelineId
    && finiteInteger(anchor.frame)
    && optionalString(anchor.itemId)
    && optionalString(anchor.assetId)
    && (anchor.sourceFrame === undefined || finiteInteger(anchor.sourceFrame))
    && (anchor.region === undefined || validRegion(anchor.region));
}

function validReply(value: unknown): value is ReviewReply {
  if (!value || typeof value !== 'object') return false;
  const reply = value as Partial<ReviewReply>;
  return typeof reply.id === 'string' && !!reply.id
    && typeof reply.text === 'string' && !!reply.text.trim() && reply.text.length <= MAX_TEXT_LENGTH
    && typeof reply.createdAt === 'number' && Number.isFinite(reply.createdAt);
}

export function isReviewComment(value: unknown): value is ReviewComment {
  if (!value || typeof value !== 'object') return false;
  const comment = value as Partial<ReviewComment>;
  return typeof comment.id === 'string' && !!comment.id
    && typeof comment.text === 'string' && !!comment.text.trim() && comment.text.length <= MAX_TEXT_LENGTH
    && typeof comment.createdAt === 'number' && Number.isFinite(comment.createdAt)
    && typeof comment.resolved === 'boolean'
    && validAnchor(comment.anchor)
    && Array.isArray(comment.replies) && comment.replies.every(validReply);
}

export function normalizeReviewComments(value: unknown): ReviewComment[] {
  return Array.isArray(value) ? value.filter(isReviewComment) : [];
}

export function reviewAnchor(
  timelineId: string,
  frame: number,
  state: TimelineState,
  selectedItem: TimelineItem | null,
): ReviewAnchor {
  const anchor: ReviewAnchor = { timelineId, frame: Math.max(0, Math.round(frame)) };
  if (!selectedItem) return anchor;
  const localFrame = anchor.frame - selectedItem.startFrame;
  if (localFrame < 0 || localFrame >= selectedItem.durationInFrames) return anchor;
  const assetId = selectedItem.src
    ? state.assets?.find((asset) => asset.src === selectedItem.src)?.id
    : undefined;
  const sourceFrame = selectedItem.src
    ? Math.round(sourceFrameAt(selectedItem, localFrame))
    : undefined;
  return {
    ...anchor,
    itemId: selectedItem.id,
    ...(assetId ? { assetId } : {}),
    ...(sourceFrame === undefined ? {} : { sourceFrame }),
  };
}

function cleanText(value: string): string {
  const text = value.trim();
  if (!text) throw new Error('评论内容不能为空');
  if (text.length > MAX_TEXT_LENGTH) throw new Error(`评论不能超过 ${MAX_TEXT_LENGTH} 个字符`);
  return text;
}

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `review_${Date.now()}_${Math.random().toString(36).slice(2)}`;

export function createReviewComment(
  anchor: ReviewAnchor,
  text: string,
  createdAt = Date.now(),
  id = newId(),
): ReviewComment {
  return { id, text: cleanText(text), createdAt, resolved: false, anchor, replies: [] };
}

export function appendReviewReply(
  comments: ReviewComment[],
  commentId: string,
  text: string,
  createdAt = Date.now(),
  id = newId(),
): ReviewComment[] {
  const reply: ReviewReply = { id, text: cleanText(text), createdAt };
  return comments.map((comment) => (
    comment.id === commentId ? { ...comment, replies: [...comment.replies, reply] } : comment
  ));
}

export function setReviewResolved(
  comments: ReviewComment[],
  commentId: string,
  resolved: boolean,
): ReviewComment[] {
  return comments.map((comment) => (comment.id === commentId ? { ...comment, resolved } : comment));
}

export function removeReviewComment(comments: ReviewComment[], commentId: string): ReviewComment[] {
  return comments.filter((comment) => comment.id !== commentId);
}
