import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ModelSource } from './api.ts';
import type { ProviderInfo, ProviderModel } from '../shared/catalog.ts';
import type { ModelStore } from './store.ts';
import type { ProviderConnection } from './provider-settings.ts';

export type Credential =
  | { type: 'api_key'; key?: string; env?: Record<string, string> }
  | { type: 'oauth'; refresh: string; access: string; expires: number; [key: string]: unknown };

export type AuthStatus = { configured: boolean; source?: string };
export type CatalogModel = ProviderModel & ProviderConnection;
export interface CatalogProvider extends ProviderConnection {
  id: string;
  name: string;
  canSetKey: boolean;
  models: readonly CatalogModel[];
  key?: string;
  headers?: Record<string, string | null>;
  authStatus?(): Promise<boolean | string>;
  endpointOverride?: string;
  discoveryKey?(credential: Credential | undefined, signal: AbortSignal): Promise<string | undefined>;
}

export interface ModelStorePort extends ModelSource {
  providers(): ProviderInfo[];
  defaultModels(id: string): ProviderModel[];
  saveProvider(input: unknown): Promise<string>;
  removeProvider(input: unknown): Promise<string>;
  discoverModels(input: unknown, signal: AbortSignal): Promise<ProviderModel[]>;
  requestModel(choice: ModelChoice): { provider: CatalogProvider; model: CatalogModel } | undefined;
  apiKey(provider: CatalogProvider): Promise<string | undefined>;
  readonly credentials: ModelStore['credentials'];
  registerDefaults(providers: readonly CatalogProvider[]): Promise<() => Promise<void>>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessModelStore: ModelStorePort;
  }
}
