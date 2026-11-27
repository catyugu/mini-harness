import { DomainError } from '@mini-harness/platform/errors';
import { thinkingLevels } from '@mini-harness/llm/vocabulary';
import {
  modelCapacity,
  providerIdPattern,
  type ProviderModelDefinition,
} from '../shared/catalog.ts';
import type { CatalogModel } from './store-api.ts';
import { protocols } from './protocols.ts';

export interface ProviderConnection {
  api: string;
  baseUrl: string;
}

type RecordValue = Record<string, unknown>;
type ModelConfig = Omit<ProviderModelDefinition, 'templateId'>;

export interface ProviderOverride {
  baseUrl?: string;
  models?: ProviderModelDefinition[];
}
export interface CustomConfig extends ProviderConnection {
  name: string;
  models: ModelConfig[];
  apiKey?: string;
  headers?: Record<string, string | null>;
}
export interface ProviderConfiguration {
  providers: Record<string, CustomConfig>;
  builtins: Record<string, ProviderOverride>;
}

export const invalid = (message: string) => new DomainError('invalid_input', message);

export function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

export function providerId(value: unknown) {
  if (typeof value !== 'string' || !providerIdPattern.test(value)) throw invalid('Invalid provider ID');
  return value;
}

export function endpoint(value: unknown) {
  const url = typeof value === 'string' ? URL.parse(value.trim()) : null;
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw invalid('Invalid API endpoint');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href.replace(/\/$/, '');
}

export function protocol(value: unknown) {
  if (typeof value !== 'string' || !protocols.has(value)) throw invalid('Unsupported API protocol');
  return value;
}

export function credential(value: unknown) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 65536) throw invalid('Invalid credential');
  return value.trim();
}

function modelId(value: unknown) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > 160) throw invalid('Enter a Model ID of up to 160 characters');
  return id;
}

function modelName(value: unknown, id: string) {
  if (value === undefined || value === '') return id;
  if (typeof value !== 'string' || value.length > 160) throw invalid('Invalid display name for ' + id);
  return value.trim() || id;
}

/** HTTP edits and persisted definitions share one complete metadata contract. */
function parseModel(entry: RecordValue): ModelConfig {
  const { id: rawId, name, input, reasoning, contextWindow, maxTokens, ...extra } = entry;
  const id = modelId(rawId);
  if (Object.keys(extra).length) throw invalid('Unsupported model fields for ' + id);
  if (typeof name !== 'string' || !name.trim()) throw invalid('Missing model display name for ' + id);
  if (!modelCapacity(contextWindow) || !modelCapacity(maxTokens))
    throw invalid('Invalid model token limits for ' + id);
  if (
    !Array.isArray(input) ||
    !input.length ||
    new Set(input).size !== input.length ||
    input.some((value: unknown) => value !== 'text' && value !== 'image')
  )
    throw invalid('Invalid model input modalities for ' + id);
  if (typeof reasoning !== 'boolean') throw invalid('Invalid reasoning capability for ' + id);
  return { id, name: modelName(name, id), input, reasoning, contextWindow, maxTokens };
}

function parseModels<T extends ModelConfig>(value: unknown, parse: (entry: RecordValue) => T): T[] {
  if (!Array.isArray(value)) throw invalid('Invalid model catalog');
  const models = value.map((raw) => {
    const entry = record(raw);
    if (!entry) throw invalid('Invalid model configuration');
    return parse(entry);
  });
  if (new Set(models.map(({ id }) => id)).size !== models.length) throw invalid('Duplicate Model ID');
  return models;
}

export function parseCustom(id: string, value: unknown): CustomConfig {
  const entry = record(value);
  if (!entry) throw invalid('Invalid provider configuration: ' + id);
  if (entry.apiKey !== undefined && (typeof entry.apiKey !== 'string' || entry.apiKey.startsWith('!')))
    throw invalid('Provider API keys must be literal values or environment variable names: ' + id);
  const headers = record(entry.headers);
  if (
    entry.headers !== undefined &&
    (!headers || Object.values(headers).some((value) => value !== null && typeof value !== 'string'))
  )
    throw invalid('Invalid provider headers: ' + id);
  return {
    name: modelName(entry.name, id),
    api: protocol(entry.api),
    baseUrl: endpoint(entry.baseUrl),
    models: parseModels(entry.models, parseModel),
    apiKey: entry.apiKey,
    headers: headers as CustomConfig['headers'],
  };
}

export function parseOverride(value: unknown): ProviderOverride {
  const entry = record(value);
  if (!entry) throw invalid('Invalid built-in provider override');
  return {
    baseUrl: entry.baseUrl === undefined || entry.baseUrl === '' ? undefined : endpoint(entry.baseUrl),
    models: entry.models === undefined
      ? undefined
      : parseModels(entry.models, ({ templateId, ...model }): ProviderModelDefinition => ({
          ...parseModel(model),
          ...(templateId === undefined ? {} : { templateId: modelId(templateId) }),
        })),
  };
}

export function parseConfiguration(value: unknown): ProviderConfiguration {
  const configuration = record(value);
  const custom = record(configuration?.providers ?? {});
  const overrides = record(configuration?.builtins ?? {});
  if (!configuration || !custom || !overrides) throw invalid('Invalid model provider configuration');
  return {
    providers: Object.fromEntries(
      Object.entries(custom).map(([id, item]) => [providerId(id), parseCustom(id, item)]),
    ),
    builtins: Object.fromEntries(
      Object.entries(overrides).map(([id, item]) => [providerId(id), parseOverride(item)]),
    ),
  };
}

/** Independent models use the provider connection; native derivatives retain the adapter definition. */
export function resolveModel(
  model: ModelConfig,
  connection: ProviderConnection,
  baseline?: CatalogModel,
): CatalogModel {
  return {
    ...connection,
    ...baseline,
    ...model,
    thinkingLevels: model.reasoning
      ? ((baseline?.reasoning ? baseline.thinkingLevels : undefined) ??
        thinkingLevels.filter((level) => level !== 'xhigh' && level !== 'max'))
      : ['off'],
  };
}
