import type {} from 'cordis';
import type { ModelChoice } from './conversation.js';

export interface ModelSummary extends ModelChoice {
  name: string;
  configured: boolean;
  thinkingLevels: string[];
}

export interface ProviderModel {
  id: string;
  name: string;
  input: readonly ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevels?: string[];
}

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
  }
}
