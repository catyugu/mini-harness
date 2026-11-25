import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { Model, MutableModels, Api } from '@earendil-works/pi-ai';
import type { ModelCatalogPort } from './api.ts';
import type { ProviderInfo } from '../shared/catalog.ts';

export interface ProviderAdministration {
  providers(): Pick<ProviderInfo, 'id' | 'name' | 'canSetKey' | 'models'>[];
  authStatus(id: string): { configured: boolean; source?: string };
  hasProvider(id: string): boolean;
  refresh(): Promise<void>;
  storeCredential(id: string, key: string): Promise<void>;
  removeCredential(id: string): Promise<void>;
}

export interface ModelStorePort extends ModelCatalogPort, ProviderAdministration {
  piConnection(choice: ModelChoice): { model: Model<Api>; runtime: MutableModels } | undefined;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessModelStore: ModelStorePort;
  }
}
