export interface ToolAccess {
  name: string;
  readOnly: boolean;
}

/** Optional business policy for selecting tools and checking model-requested calls. */
export type ToolPolicy = (sessionId: string, tool: Readonly<ToolAccess>) => boolean;

declare module 'mini-harness/cordis' {
  interface Context {
    harnessToolPolicy: ToolPolicy;
  }
}
