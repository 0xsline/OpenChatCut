export const runtimeSidecar = (
  owner: string,
  revision: number,
  updatedAt: number,
  marker: string,
) => ({
  version: 1,
  revision,
  projectId: owner,
  durability: 'local-sidecar',
  updatedAt,
  runs: [{ projectId: owner, runId: marker, updatedAt }],
  approvals: [],
  checkpoints: [],
  artifacts: [],
});
