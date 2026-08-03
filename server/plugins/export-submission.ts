import type { ProjectDoc, TimelineState } from '../../src/editor/types.ts';
import { isSequenceGraphError } from '../../src/editor/sequenceGraph.ts';
import { createSequenceGraphExportFailure, ExportFailureError } from '../../src/export/exportFailure.ts';
import { planExport, type ExportPlan, type ExportRequest } from './export-plan.ts';
import {
  materializeServerExportMedia,
  type ServerExportMediaOptions,
} from './export-media-plan.ts';

export interface AcceptedExportSubmission {
  readonly plan: ExportPlan;
  readonly materializedPaths: readonly string[];
  cleanup(): Promise<void>;
}

/** The sole server-render acceptance boundary: all render-visible media is local before return. */
export async function acceptExportSubmission(
  body: ExportRequest | null,
  mediaOptions: ServerExportMediaOptions = {},
): Promise<AcceptedExportSubmission> {
  mediaOptions.signal?.throwIfAborted();
  let plan: ExportPlan;
  try {
    plan = planExport(body);
  } catch (error) {
    if (!isSequenceGraphError(error)) throw error;
    throw new ExportFailureError(createSequenceGraphExportFailure(error), { cause: error });
  }
  mediaOptions.signal?.throwIfAborted();
  const mediaSnapshot = plan.project && plan.timelineId
    ? { ...plan.project, activeTimelineId: plan.timelineId }
    : plan.state;
  const materialized = await materializeServerExportMedia(mediaSnapshot, mediaOptions);
  try {
    mediaOptions.signal?.throwIfAborted();
    let state: TimelineState;
    let project: ProjectDoc | undefined;
    if (plan.project && plan.timelineId) {
      project = materialized.snapshot as ProjectDoc;
      const selected = project.timelines.find((timeline) => timeline.id === plan.timelineId);
      if (!selected) throw new Error(`materialized timeline ${plan.timelineId} not found in project`);
      state = selected;
    } else {
      state = materialized.snapshot as TimelineState;
    }
    mediaOptions.signal?.throwIfAborted();
    return Object.freeze({
      plan: Object.freeze({ ...plan, state, project }),
      materializedPaths: materialized.localPaths,
      cleanup: materialized.cleanup,
    });
  } catch (error) {
    await materialized.cleanup();
    throw error;
  }
}
