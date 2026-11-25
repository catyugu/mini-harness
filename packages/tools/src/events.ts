export interface ToolDecision {
  sessionId: string;
  tool: string;
  callId: string;
  arguments: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export type ToolDecisionResult = 'allow' | 'deny' | 'ask' | undefined;
export type ToolDecisionHandler = (request: ToolDecision) => ToolDecisionResult | Promise<ToolDecisionResult>;

declare module 'mini-harness/cordis' {
  interface Events {
    'tools/decide': ToolDecisionHandler;
  }
}
