import type { ExportMediaSourceMap } from '../../shared/export-media-sources';

/** A media file rendered to carry only one half of a timeline item's output. */
export interface PremiereBakedMedia {
  /** Rendered picture; the original file's audio remains independently linkable. */
  visualSrc?: string;
  /** Rendered audio; the original file's picture remains independently linkable. */
  audioSrc?: string;
}

export interface PremiereBakeJob {
  itemId: string;
  kind: 'visual' | 'audio';
  filename: string;
  reasons: string[];
}

export interface PremiereExportIssue {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  itemIds: string[];
}

export interface PremiereExportPlan {
  bakeJobs: PremiereBakeJob[];
  issues: PremiereExportIssue[];
}

/** Inputs shared by the pure serializer and the UI/agent export adapters. */
export interface PremiereXmlExportOptions {
  title?: string;
  /** Server upload directory; resolves /media/uploads references when no map entry exists. */
  mediaDir?: string;
  /** Export-time resolved original paths and native rates, keyed by the exact source string. */
  mediaSources?: ExportMediaSourceMap;
  /** Successfully rendered stems keyed by the source TimelineItem.id. */
  bakedMedia?: Readonly<Record<string, PremiereBakedMedia>>;
}

