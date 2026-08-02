export type AssetDestination = 'timeline' | 'chat';

export interface AssetDestinationActions {
  timeline: () => void;
  chat: () => void;
}

export function runAssetDestinationAction(
  destination: AssetDestination,
  actions: AssetDestinationActions,
): void {
  actions[destination]();
}
