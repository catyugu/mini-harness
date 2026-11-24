import { AsyncLocalStorage } from 'node:async_hooks';
import type {} from 'cordis';

// The marker follows only work initiated inside a graph transaction; unrelated requests may wait.
const mountTransaction = new AsyncLocalStorage<{ active: boolean }>();

export async function withMountTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const transaction = { active: true };
  try { return await mountTransaction.run(transaction, operation); }
  finally { transaction.active = false; }
}

export function assertOutsideMountTransaction() {
  if (mountTransaction.getStore()?.active)
    throw new Error('Operation is unavailable during plugin setup, configuration or teardown');
}

export interface MutationPort {
  guard(check: (scopes?: ReadonlySet<string>) => void): () => void;
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
