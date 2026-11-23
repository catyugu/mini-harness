export const projectionDomains = ['sessions', 'workspaces', 'settings', 'models', 'plugins', 'approvals', 'files', 'queue'] as const;
export type ProjectionDomain = typeof projectionDomains[number] | `plugin:\${string}`;

export type ProjectionNotice =
  | { type: 'snapshot'; revisions: Partial<Record<ProjectionDomain, number>> }
  | { type: 'change'; domain: ProjectionDomain; revision: number; sessionId?: string; workspaceId?: string };
