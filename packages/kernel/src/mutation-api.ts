import type {} from 'cordis';

export interface MutationPort {
  guard(isBusy: (scopes?: ReadonlySet<string>) => boolean): () => void;
  protect(scopes?: ReadonlySet<string>): () => void;
  admit(scopeKeys: readonly string[]): void;
  run<T>(operation: () => Promise<T> | T): Promise<T>;
}


declare module 'cordis' {
  interface Context { harnessMutations: MutationPort }
  interface Events {
    'harness/ready'(): void | Promise<void>;
    'harness/quiesce'(): void | Promise<void>;
  }
}
