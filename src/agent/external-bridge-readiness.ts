export interface ExternalBridgeReadinessToken {
  projectId: string;
  editorInstanceId: string;
  runtimeIdentity: object;
}

export function externalBridgeReadinessMatches(
  readiness: ExternalBridgeReadinessToken,
  slot: ExternalBridgeReadinessToken,
  projectId: string,
): boolean {
  return readiness.projectId === projectId
    && slot.projectId === projectId
    && readiness.editorInstanceId === slot.editorInstanceId
    && readiness.runtimeIdentity === slot.runtimeIdentity;
}

export function externalBridgeCanStart(
  readiness: ExternalBridgeReadinessToken,
  slot: ExternalBridgeReadinessToken,
  projectId: string,
  transportAvailable: boolean,
): boolean {
  return transportAvailable && externalBridgeReadinessMatches(readiness, slot, projectId);
}
