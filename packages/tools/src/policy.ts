import type {} from 'cordis';

/** Evaluated when advertising a tool and again before invocation. */
export type ToolPolicy = (sessionId: string) => {
  readOnly: boolean;
  disabledTools: string[];
  readOnlyTools?: Readonly<Record<string, string[]>>;
};

declare module 'cordis' {
  interface Context { harnessToolPolicy: ToolPolicy }
}
