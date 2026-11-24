export interface ToolDecision {
  sessionId: string;
  tool: string;
  callId: string;
  arguments: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export type ToolDecisionHandler = (request: ToolDecision) => 'deny' | undefined | Promise<'deny' | undefined>;

declare module 'mini-harness/cordis' {
  interface Events {
    'tools/decide': ToolDecisionHandler;
  }
}
