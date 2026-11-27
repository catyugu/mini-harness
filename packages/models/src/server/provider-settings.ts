import { DomainError } from '@mini-harness/platform/errors';
import { thinkingLevels } from '@mini-harness/llm/vocabulary';
import {
  maxModelTokens,
  modelDefaults,
  providerApiPattern,
  providerIdPattern,
} from '../shared/catalog.ts';
import type { CatalogModel, CatalogProvider } from './store-api.ts';

export interface ProviderConnection {
  api: string;
  baseUrl: string;
}

type RecordValue = Record<string, unknown>;
type ModelConfig = Partial<Omit<CatalogModel, 'id' | 'thinkingLevels'>> & { id: string; templateId?: string };

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

/** Interpret persisted model fields at the configuration boundary. */
function parseModel(raw: unknown): ModelConfig {
  const entry = record(raw);
  if (!entry) throw invalid('Invalid model configuration');
  const id = modelId(entry.id);
  const result: ModelConfig = { id };
  if (entry.templateId !== undefined) result.templateId = modelId(entry.templateId);
  if (entry.name !== undefined) result.name = modelName(entry.name, id);
  for (const field of ['contextWindow', 'maxTokens'] as const) {
    const value = entry[field];
    if (value === undefined) continue;
    if (!modelCapacity(value)) throw invalid('Invalid model token limits for ' + id);
    result[field] = value;
  }
  if (entry.input !== undefined) {
    if (
      !Array.isArray(entry.input) ||
      !entry.input.length ||
      new Set(entry.input).size !== entry.input.length ||
      entry.input.some((value: unknown) => value !== 'text' && value !== 'image')
    )
      throw invalid('Invalid model input modalities for ' + id);
    result.input = entry.input;
  }
  if (entry.reasoning !== undefined) {
    if (typeof entry.reasoning !== 'boolean') throw invalid('Invalid reasoning capability for ' + id);
    result.reasoning = entry.reasoning;
  }
  if (entry.api !== undefined) result.api = protocol(entry.api);
  if (entry.baseUrl !== undefined) result.baseUrl = endpoint(entry.baseUrl);
  // Pi owns the nested protocol-specific options. Only those fields cross this boundary.
  const { cost, headers, compat, thinkingLevelMap } = entry;
  for (const [name, value] of Object.entries({ cost, headers, compat, thinkingLevelMap })) {
    if (value === undefined) continue;
    if (!record(value)) throw invalid('Invalid model ' + name + ' for ' + id);
    Object.assign(result, { [name]: value });
  }
  return result;
}

function parseModels(value: unknown, parse = parseModel): ModelConfig[] {
  if (!Array.isArray(value)) throw invalid('Invalid model catalog');
  const models = value.map(parse);
  if (new Set(models.map(({ id }) => id)).size !== models.length) throw invalid('Duplicate Model ID');
  return models;
}

/** A draft edits visible attributes; sourceId is a reference to an existing definition, not a persisted field. */
export function editModels(value: unknown, previous: readonly ModelConfig[], builtin?: CatalogProvider) {
  return parseModels(value, (raw) => {
    const row = record(raw);
    if (!row) throw invalid('Invalid model configuration');
    const edited = parseModel({
      id: row.id,
      name: row.name,
      input: row.input,
      contextWindow: row.contextWindow,
      maxTokens: row.maxTokens,
      reasoning: row.reasoning,
    });
    const source = row.sourceId === undefined ? undefined : modelId(row.sourceId);
    const existing = previous.find(({ id }) => id === source);
    if (existing) return { ...existing, ...edited };
    const template = builtin?.models.find(({ id }) => id === source);
    return template ? { ...edited, templateId: template.id } : edited;
  });
}

export function parseCustom(id: string, value: unknown, models = parseModels(record(value)?.models)): CustomConfig {
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
    models: models.map(({ templateId: _templateId, ...model }) => model),
    apiKey: entry.apiKey,
    headers: headers as CustomConfig['headers'],
  };
}

export function parseOverride(value: unknown, models?: ModelConfig[]): ProviderOverride {
  const entry = record(value);
  if (!entry) throw invalid('Invalid built-in provider override');
  return {
    baseUrl: entry.baseUrl === undefined || entry.baseUrl === '' ? undefined : endpoint(entry.baseUrl),
    models: models ?? (entry.models === undefined ? undefined : parseModels(entry.models)),
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

/** Resolve the saved definition once, retaining native adapter attributes from an explicit template. */
export function resolveModel(
  entry: ModelConfig,
  connection: ProviderConnection,
  baseline?: CatalogModel,
  overrideUrl?: string,
): CatalogModel {
  const { templateId: _templateId, id, ...values } = entry;
  const reasoning = values.reasoning ?? baseline?.reasoning ?? false;
  const map = record(record(values)?.thinkingLevelMap ?? record(baseline)?.thinkingLevelMap);
  return {
    ...baseline,
    ...values,
    id,
    name: values.name ?? baseline?.name ?? id,
    api: values.api ?? baseline?.api ?? connection.api,
    baseUrl: overrideUrl ?? values.baseUrl ?? (baseline?.baseUrl || connection.baseUrl),
    reasoning,
    input: values.input ?? baseline?.input ?? ['text'],
    contextWindow: values.contextWindow ?? baseline?.contextWindow ?? modelDefaults.contextWindow,
    maxTokens: values.maxTokens ?? baseline?.maxTokens ?? modelDefaults.maxTokens,
    thinkingLevels: reasoning
      ? ((baseline?.reasoning && record(values)?.thinkingLevelMap === undefined
          ? baseline.thinkingLevels
          : undefined) ??
        thinkingLevels.filter((level) => {
          const mapped = map?.[level];
          return mapped !== null && (mapped !== undefined || (level !== 'xhigh' && level !== 'max'));
        }))
      : ['off'],
  };
}
