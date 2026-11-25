import { AsyncLocalStorage } from 'node:async_hooks';
import type { ScopeAddress } from './configuration.ts';

// The marker follows only work initiated inside a graph transaction; unrelated requests may wait.
const mountTransaction = new AsyncLocalStorage<{ active: boolean }>();

export async function withMountTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const transaction = { active: true };
  try {
    return await mountTransaction.run(transaction, operation);
  } finally {
    transaction.active = false;
  }
}

export function assertOutsideMountTransaction() {
  if (mountTransaction.getStore()?.active)
    throw new Error('Operation is unavailable during plugin setup, configuration or teardown');
}

const pluginRequest = new AsyncLocalStorage<{ signal: AbortSignal; active: boolean }>();

export async function withPluginRequest<T>(signal: AbortSignal, work: () => T | Promise<T>): Promise<T> {
  const request = { signal, active: true };
  try {
    return await pluginRequest.run(request, work);
  } finally {
    request.active = false;
  }
}

export function pluginRequestSignal() {
  const request = pluginRequest.getStore();
  return request?.active ? request.signal : undefined;
}

export function assertOutsidePluginRequest() {
  if (pluginRequestSignal()) throw new Error('Structural settings cannot be changed during a plugin request');
}

export interface MutationPort {
  guard(check: (scopes?: ReadonlySet<ScopeAddress>) => void): () => void;
  protect(scopes?: ReadonlySet<ScopeAddress>): () => void;
  admit(scopeAddresses: readonly ScopeAddress[]): void;
  run<T>(operation: () => Promise<T> | T): Promise<T>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessMutations: MutationPort;
  }
  interface Events {
    'harness/ready'(): void | Promise<void>;
    'harness/quiesce'(): void | Promise<void>;
  }
}
