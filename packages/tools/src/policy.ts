import type {} from 'cordis';

export interface ToolAccess {
  name: string;
  pluginId?: string;
  readOnly: boolean;
  trusted: boolean;
}

/** The host checks the selected registration when advertising a tool and before invocation. */
export type ToolPolicy = (sessionId: string, tool: Readonly<ToolAccess>) => boolean;

declare module 'cordis' {
  interface Context { harnessToolPolicy: ToolPolicy }
}
