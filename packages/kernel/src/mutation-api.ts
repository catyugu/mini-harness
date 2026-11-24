import type {} from 'cordis';

export interface MutationPort {
  protect(scopes?: ReadonlySet<string>): () => void;
  admit(scopeKeys: readonly string[]): void;
  run<T>(operation: () => Promise<T> | T): Promise<T>;
}


declare module 'cordis' {
  interface Context { harnessMutations: MutationPort }
}
