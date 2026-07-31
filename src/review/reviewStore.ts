import { kvGet, kvSet } from '../persist/sharedKv';
import { normalizeReviewComments, type ReviewComment } from './reviewModel';

const reviewKey = (projectId: string): string => `review:${projectId}`;

export async function loadReviewComments(projectId: string): Promise<ReviewComment[]> {
  return normalizeReviewComments(await kvGet<unknown>(reviewKey(projectId)));
}

export async function saveReviewComments(projectId: string, comments: ReviewComment[]): Promise<void> {
  await kvSet(reviewKey(projectId), normalizeReviewComments(comments));
}
