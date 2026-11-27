import { DomainError } from '@mini-harness/platform/errors';
import { thinkingLevels } from '@mini-harness/llm/vocabulary';
import { maxModelTokens, modelDefaults, providerApiPattern, providerIdPattern } from '../shared/catalog.ts';
import type { CatalogModel, CatalogProvider } from './store-api.ts';

export interface ProviderConnection {
  api: string;
  baseUrl: string;
}

type RecordValue = Record<string, unknown>;
export type ModelConfig = RecordValue & { id: string; templateId?: string };

export interface ProviderOverride {
  baseUrl?: string;
  models?: ModelConfig[];
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
  if (typeof value !== 'string' || !providerApiPattern.test(value)) throw invalid('Invalid API protocol');
  return value;
}

export function credential(value: unknown) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 65536) throw invalid('Invalid credential');
  return value.trim();
}

export function modelCapacity(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maxModelTokens;
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

/** Retain model attributes outside the editor by using the row's original identity. */
export function editModels(value: unknown, previous: ModelConfig[], builtin?: CatalogProvider) {
  if (!Array.isArray(value)) throw invalid('Invalid model catalog');
  return value.map((raw: unknown): ModelConfig => {
    const row = record(raw);
    if (!row) throw invalid('Invalid model configuration');
    const id = modelId(row.id);
    const sourceId = row.sourceId ?? id;
    const existing = previous.find((model) => model.id === sourceId);
    const templateId =
      existing?.templateId ??
      (sourceId !== id && builtin?.models.some((model) => model.id === sourceId)
        ? String(sourceId)
        : undefined);
    return {
      ...existing,
      id,
      templateId,
      name: row.name,
      input: row.input,
      contextWindow: row.contextWindow,
      maxTokens: row.maxTokens,
      reasoning: row.reasoning,
    };
  });
}

function parseModels(value: unknown): ModelConfig[] {
  if (!Array.isArray(value)) throw invalid('Invalid model catalog');
  const seen = new Set<string>();
  return value.map((raw: unknown) => {
    const entry = record(raw);
    if (!entry) throw invalid('Invalid model configuration');
    const id = modelId(entry.id);
    if (seen.has(id)) throw invalid('Duplicate Model ID: ' + id);
    seen.add(id);
    if (entry.templateId !== undefined) modelId(entry.templateId);
    for (const value of [entry.contextWindow, entry.maxTokens])
      if (value !== undefined && !modelCapacity(value)) throw invalid('Invalid model token limits for ' + id);
    if (
      entry.input !== undefined &&
      (!Array.isArray(entry.input) ||
        !entry.input.length ||
        new Set(entry.input).size !== entry.input.length ||
        entry.input.some((value: unknown) => value !== 'text' && value !== 'image'))
    )
      throw invalid('Invalid model input modalities for ' + id);
    if (entry.reasoning !== undefined && typeof entry.reasoning !== 'boolean')
      throw invalid('Invalid reasoning capability for ' + id);
    return { ...entry, id, name: modelName(entry.name, id) } as ModelConfig;
  });
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
    models: parseModels(entry.models),
    apiKey: entry.apiKey,
    headers: headers as CustomConfig['headers'],
  };
}

export function parseOverride(value: unknown): ProviderOverride {
  const entry = record(value);
  if (!entry) throw invalid('Invalid built-in provider override');
  return {
    baseUrl: entry.baseUrl === undefined || entry.baseUrl === '' ? undefined : endpoint(entry.baseUrl),
    models: entry.models === undefined ? undefined : parseModels(entry.models),
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

export function configuredModel(
  entry: ModelConfig,
  connection: ProviderConnection,
  baseline?: CatalogModel,
  overrideUrl?: string,
): CatalogModel {
  const { templateId: _templateId, id, ...values } = entry;
  const reasoning = (values.reasoning as boolean | undefined) ?? baseline?.reasoning ?? false;
  const map = record(values.thinkingLevelMap ?? record(baseline)?.thinkingLevelMap);
  return {
    ...baseline,
    ...values,
    id,
    name: values.name as string,
    api: baseline?.api ?? connection.api,
    baseUrl: overrideUrl ?? (baseline?.baseUrl || connection.baseUrl),
    reasoning,
    input: (values.input as ProviderModelInput | undefined) ?? baseline?.input ?? ['text'],
    contextWindow:
      (values.contextWindow as number | undefined) ?? baseline?.contextWindow ?? modelDefaults.contextWindow,
    maxTokens: (values.maxTokens as number | undefined) ?? baseline?.maxTokens ?? modelDefaults.maxTokens,
    thinkingLevels: reasoning
      ? ((baseline?.reasoning && values.thinkingLevelMap === undefined
          ? baseline.thinkingLevels
          : undefined) ??
        thinkingLevels.filter((level) => {
          const mapped = map?.[level];
          return mapped !== null && (mapped !== undefined || (level !== 'xhigh' && level !== 'max'));
        }))
      : ['off'],
  };
}

type ProviderModelInput = CatalogModel['input'];
