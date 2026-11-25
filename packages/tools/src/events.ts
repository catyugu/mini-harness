export interface ToolInvocation {
  sessionId: string;
  tool: string;
  callId: string;
  arguments: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export type ToolPreparation = 'deny' | { arguments: Record<string, unknown> } | undefined;
export type ToolPreparationHandler = (request: ToolInvocation) => ToolPreparation | Promise<ToolPreparation>;

declare module 'mini-harness/cordis' {
  interface Events {
    'tools/pre-execute': ToolPreparationHandler;
  }
}
