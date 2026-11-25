export type ProjectionNotice =
  | { type: 'snapshot'; revisions: Readonly<Record<string, number | undefined>> }
  | { type: 'change'; domain: string; revision: number; resourceId?: string };
