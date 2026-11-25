export interface ToolAccess {
  name: string;
  pluginId?: string;
  readOnly: boolean;
  instanceId?: string;
  module?: string;
}

/** The host checks the selected registration when advertising a tool and before invocation. */
export type ToolPolicy = (sessionId: string, tool: Readonly<ToolAccess>) => boolean;

declare module 'mini-harness/cordis' {
  interface Context {
    harnessToolPolicy: ToolPolicy;
  }
}
