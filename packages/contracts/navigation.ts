export const projectionDomains = ['sessions', 'workspaces', 'settings', 'models', 'plugins', 'approvals'] as const;
export type ProjectionDomain = typeof projectionDomains[number];

export type ProjectionNotice =
  | { type: 'snapshot'; revisions: Record<ProjectionDomain, number> }
  | { type: 'change'; domain: ProjectionDomain; revision: number; sessionId?: string };
