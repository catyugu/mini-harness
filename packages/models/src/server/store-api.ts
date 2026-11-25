import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ModelCatalogPort } from './api.ts';
import type { ProviderInfo, ProviderModel } from '../shared/catalog.ts';
import type { ModelStore } from './store.ts';

export type Credential =
  | { type: 'api_key'; key?: string; env?: Record<string, string> }
  | { type: 'oauth'; refresh: string; access: string; expires: number; [key: string]: unknown };

export type AuthStatus = { configured: boolean; source?: string };
export type CatalogModel = ProviderModel & { api: string; baseUrl: string };
export interface CatalogProvider {
  id: string;
  name: string;
  canSetKey: boolean;
  models: readonly CatalogModel[];
  key?: string;
  headers?: Record<string, string | null>;
  authStatus?(): Promise<boolean | string>;
  apiKey?(choice: ModelChoice): Promise<string | undefined>;
}

export interface ProviderAdministration {
  providers(): ProviderInfo[];
  authStatus(id: string): AuthStatus;
  hasProvider(id: string): boolean;
  refresh(): Promise<void>;
  storeCredential(id: string, key: string): Promise<void>;
  removeCredential(id: string): Promise<void>;
}

export interface ModelStorePort extends ModelCatalogPort, ProviderAdministration {
  readonly credentials: ModelStore['credentials'];
  configuredProvider(id: string): CatalogProvider | undefined;
  registerDefaults(providers: readonly CatalogProvider[]): Promise<() => Promise<void>>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessModelStore: ModelStorePort;
  }
}
