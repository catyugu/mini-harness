import type { Api, Credential, CredentialStore, Model } from '@earendil-works/pi-ai';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ModelSource } from './api.ts';
import type { ModelSummary } from '../shared/catalog.ts';
import type { ProtocolInfo, ProviderInfo, ProviderModelDefinition } from '../shared/pi-provider.ts';
import type { ProviderConnection } from './provider-settings.ts';

export type AuthStatus = { configured: boolean; source?: string };
export type CatalogModel = Model<Api>;
export interface CatalogProvider extends ProviderConnection {
  id: string;
  name: string;
  canSetKey: boolean;
  models: readonly CatalogModel[];
  key?: string;
  headers?: Record<string, string | null>;
  /** Must settle on abort, including the store's authentication deadline. */
  authStatus?(signal: AbortSignal): Promise<boolean | string>;
  endpointOverride?: string;
  discoveryKey?(credential: Credential | undefined, signal: AbortSignal): Promise<string | undefined>;
}

/** Administration is available only while its adapter provides this capability. */
export interface ProviderAdministrationPort {
  available(): Promise<ModelSummary[]>;
  protocols(): ProtocolInfo[];
  providers(): ProviderInfo[];
  defaultModels(id: string): ProviderModelDefinition[];
  saveProvider(input: unknown): Promise<string>;
  removeProvider(input: unknown): Promise<string>;
  discoverModels(input: unknown, signal: AbortSignal): Promise<ProviderModelDefinition[]>;
}

export interface ModelStorePort extends ModelSource, ProviderAdministrationPort {
  available(): Promise<ModelSummary[]>;
  requestModel(choice: ModelChoice): { provider: CatalogProvider; model: CatalogModel } | undefined;
  readonly credentials: CredentialStore;
  apiKey(provider: CatalogProvider): Promise<string | undefined>;
  registerDefaults(providers: readonly CatalogProvider[]): Promise<() => Promise<void>>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessModelStore: ModelStorePort;
    harnessProviderAdministration: ProviderAdministrationPort;
  }
}
