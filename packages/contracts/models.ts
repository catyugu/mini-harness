import type {} from 'cordis';
import type { ThinkingLevel } from './agent.js';
import type { ModelChoice } from './conversation.js';

export interface ModelSummary extends ModelChoice {
  name: string;
  configured: boolean;
  thinkingLevels: ThinkingLevel[];
  input: readonly ('text' | 'image')[];
}

export interface ProviderModel {
  id: string;
  name: string;
  input: readonly ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevels?: ThinkingLevel[];
}

export interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  storedCredential: boolean;
  canSetKey: boolean;
  custom: boolean;
  baseUrl: string;
  api: string;
  models: ProviderModel[];
}

export interface ModelCatalog { models: ModelSummary[]; providers: ProviderInfo[] }

export interface ModelCatalogPort {
  list(): ModelSummary[];
  available(): Promise<ModelSummary[]>;
  /** Returns undefined when the choice is absent from this catalog. */
  resolve(choice: ModelChoice): ModelChoice | undefined;
  capabilities(choice: ModelChoice): ProviderModel | undefined;
}

export interface ModelAdminPort {
  providers(): { id: string; name: string; canSetKey: boolean; models: ProviderModel[] }[];
  authStatus(id: string): { configured: boolean; source?: string };
  hasProvider(id: string): boolean;
  refresh(): Promise<void>;
  storeCredential(id: string, key: string): Promise<void>;
  removeCredential(id: string): Promise<void>;
}

declare module 'cordis' {
  interface Context {
    harnessModels: ModelCatalogPort;
    harnessModelAdmin: ModelAdminPort;
    harnessModelPreference: {
      recent(): ModelChoice;
      remember(model: ModelChoice): Promise<void>;
    };
  }
}
