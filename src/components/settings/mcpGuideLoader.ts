// The MCP guide is reachable from two top bars — the dashboard's and the
// editor's — so its import thunk lives beside the dialog rather than inside
// either caller's loader module. Both sites must go through this one thunk: a
// single static import of McpGuide anywhere pulls it into an eager chunk and
// silently defeats every lazy() built on it, which is exactly what TopBar.tsx
// did (rolldown reported INEFFECTIVE_DYNAMIC_IMPORT and the module shipped in
// the entry chunk regardless of the dashboard's lazy wrapper).
export const loadMcpGuideDialog = () => import('./McpGuide');
