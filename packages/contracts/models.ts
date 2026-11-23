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
}

export interface ModelCatalogPort {
  list(): ModelSummary[];
  available(): Promise<ModelSummary[]>;
  resolve(choice: ModelChoice): ModelChoice | undefined;
}

export interface ModelAdminPort {
  providers(): { id: string; name: string; canSetKey: boolean; models: ProviderModel[] }[];
  authStatus(id: string): { configured: boolean; source?: string };
  hasProvider(id: string): boolean;
  refresh(): Promise<void>;
  storeCredential(id: string, key: string): Promise<void>;
  removeCredential(id: string): Promise<void>;
  invalidate(id: string): void;
}

declare module 'cordis' {
  interface Context {
    harnessModels: ModelCatalogPort;
    harnessModelAdmin: ModelAdminPort;
  }
}
