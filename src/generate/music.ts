export interface SubmitMusicArgs {
  prompt: string;
  name?: string;
  provider?: 'mureka' | 'minimax';
  lyrics?: string;
}

interface MusicResponse {
  jobId?: string;
  status?: 'queued';
  error?: string;
}

export interface GenerationSubmission {
  jobId: string;
  status: 'queued';
}

export async function submitMusic(args: SubmitMusicArgs): Promise<GenerationSubmission> {
  const prompt = args.prompt.trim();
  if (!prompt) throw new Error('prompt is required');
  const response = await fetch('/generate/music', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, name: args.name, provider: args.provider, lyrics: args.lyrics }),
  });
  const result = await response.json().catch(() => ({})) as MusicResponse;
  if (!response.ok) throw new Error(result.error ?? `music generation failed (${response.status})`);
  if (!result.jobId || result.status !== 'queued') throw new Error('music generation returned an invalid job submission');
  return { jobId: result.jobId, status: result.status };
}
