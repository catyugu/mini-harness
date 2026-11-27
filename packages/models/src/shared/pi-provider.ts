import type { Api, Model } from '@earendil-works/pi-ai';
import type { ProviderModel } from './catalog.ts';

export const providerIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ProtocolInfo {
  api: string;
  label: string;
}

export const modelDefaults = { contextWindow: 128000, maxTokens: 8192 } as const;
export const maxModelTokens = 10000000;

export function modelCapacity(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maxModelTokens;
}

/** Editable metadata with an explicit native template; absent means an independent definition. */
export type ProviderModelDefinition = Omit<ProviderModel, 'thinkingLevels'> &
  Partial<Pick<Model<Api>, 'thinkingLevelMap' | 'compat' | 'cost'>> & { templateId?: string };

export interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  storedCredential: boolean;
  canSetKey: boolean;
  custom: boolean;
  baseUrl: string;
  api: string;
  models: ProviderModelDefinition[];
  defaultBaseUrl: string;
  endpointCustomized: boolean;
  modelsCustomized: boolean;
}
