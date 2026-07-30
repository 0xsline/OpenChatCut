import type { AgentContext } from '../context';

export async function execProgressTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<unknown> {
  if (name !== 'track_progress') return { error: `unknown tool ${name}` };
  // Target-selected literal imports keep every Vite chunk discoverable while
  // loading only the executor needed by this progress request.
  if (args.target === 'transcription') {
    const { execTranscriptionProgress } = await import('../progress/transcription-progress');
    return execTranscriptionProgress(args, ctx);
  }
  if (args.target === 'upload' || args.target === 'visual-analysis') {
    const progress = await import('../progress/track-progress-targets');
    return args.target === 'upload'
      ? progress.execUploadProgress(args, ctx)
      : progress.execVisualAnalysisProgress(args, ctx);
  }
  const { execGenerateTool } = await import('./generate-tools');
  return execGenerateTool(name, { ...args, target: 'generation' }, ctx);
}
