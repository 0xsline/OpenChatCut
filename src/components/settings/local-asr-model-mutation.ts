import { editorCredentialHeaders } from '../../agent/editor-credential';

export type LocalAsrModelMutation = 'download' | 'delete';

export async function mutateLocalAsrModel(action: LocalAsrModelMutation, id: string): Promise<void> {
  const response = await fetch(`/api/asr-models/${action}`, {
    method: 'POST',
    headers: await editorCredentialHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ id }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
