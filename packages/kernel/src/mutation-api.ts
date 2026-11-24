import type {} from 'cordis';

export interface MutationPort {
  /** Resource owners veto structural changes while their affected work is live. */
  registerGuard(busy: (scopes?: ReadonlySet<string>) => boolean): () => void;
  protect(scopes?: ReadonlySet<string>): () => void;
  admit(scopeKeys: readonly string[]): void;
  run<T>(operation: () => Promise<T> | T): Promise<T>;
}


declare module 'cordis' {
  interface Context { harnessMutations: MutationPort }
}
