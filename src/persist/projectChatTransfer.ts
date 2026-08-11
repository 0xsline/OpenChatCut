import { parseAgentChangeLog } from '../agent/changeLog';
import {
  adoptAgentSessionWriteGeneration,
  currentAgentSessionGeneration,
  rotateAgentSessionGeneration,
} from './agentSessionGeneration';
import {
  loadChat,
  saveChat,
  type PersistedChat,
} from './projectStore';
import { sanitizePortableProjectDoc } from './portableProject';

export function sanitizePortableChat(chat: PersistedChat): PersistedChat {
  const {
    sessionGeneration: _sessionGeneration,
    serverRunTurnIds: _serverRunTurnIds,
    ...portableChat
  } = chat;
  const changeLog = parseAgentChangeLog(chat.changeLog).map((session) => ({
    ...session,
    beforeDoc: sanitizePortableProjectDoc(session.beforeDoc),
  }));
  return {
    ...portableChat,
    ...(chat.changeLog === undefined ? {} : { changeLog }),
  };
}

export async function persistImportedChat(
  projectId: string,
  chat: PersistedChat,
): Promise<void> {
  await saveChat(projectId, chat);
  const stored = await loadChat(projectId);
  if (!stored || JSON.stringify({ ...stored, sessionGeneration: undefined })
    !== JSON.stringify({ ...chat, sessionGeneration: undefined })) {
    throw new Error('Imported Agent-linked chat could not be persisted.');
  }
}

export async function initializeImportedAgentSession(projectId: string): Promise<void> {
  const generation = await currentAgentSessionGeneration(projectId);
  if (generation === 'legacy') {
    await rotateAgentSessionGeneration(projectId);
  } else {
    adoptAgentSessionWriteGeneration(projectId, generation);
  }
}
