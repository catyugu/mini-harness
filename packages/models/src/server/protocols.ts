import type { ProviderStreams } from '@earendil-works/pi-ai';
import { DomainError } from '@mini-harness/platform/errors';
import { modelDefaults, type ProviderModel } from '../shared/catalog.ts';
import { invalid, modelCapacity, record, type ProviderConnection } from './provider-settings.ts';

type Listing = { rows: unknown[]; next?: string };

type ListingRequest = {
  url: URL;
  headers: Headers;
  cursor?: string;
  read(body: ReturnType<typeof record>): Listing | undefined;
};
type Protocol = {
  label: string;
  load(): Promise<ProviderStreams>;
  listing(baseUrl: string, key: string): ListingRequest;
  parse(raw: unknown): ProviderModel | undefined;
};

function request(baseUrl: string) {
  const url = new URL(baseUrl);
  return { url, headers: new Headers({ accept: 'application/json' }) };
}

function openaiListing(baseUrl: string, key: string): ListingRequest {
  const { url, headers } = request(baseUrl);
  url.pathname = url.pathname.replace(/\/$/, '') + '/models';
  if (key) headers.set('authorization', 'Bearer ' + key);
  return { url, headers, read: (body) => Array.isArray(body?.data) ? { rows: body.data } : undefined };
}

function anthropicListing(baseUrl: string, key: string): ListingRequest {
  const { url, headers } = request(baseUrl);
  url.pathname = url.pathname.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1/models';
  url.searchParams.set('limit', '1000');
  headers.set('anthropic-version', '2023-06-01');
  if (key) headers.set('x-api-key', key);
  return {
    url, headers, cursor: 'after_id',
    read: (body) => Array.isArray(body?.data)
      ? { rows: body.data, next: body.has_more ? label(body.last_id) : undefined }
      : undefined,
  };
}

function geminiListing(baseUrl: string, key: string): ListingRequest {
  const { url, headers } = request(baseUrl);
  url.pathname = url.pathname.replace(/\/$/, '') + '/models';
  url.searchParams.set('pageSize', '1000');
  if (key) headers.set('x-goog-api-key', key);
  return {
    url, headers, cursor: 'pageToken',
    read: (body) => Array.isArray(body?.models) ? { rows: body.models, next: label(body.nextPageToken) } : undefined,
  };
}

export const protocols = new Map<string, Protocol>([
  ['openai-completions', {
    label: 'OpenAI Chat Completions',
    load: () => import('@earendil-works/pi-ai/api/openai-completions'),
    listing: openaiListing,
    parse: (raw) => parseModel(raw, false),
  }],
  ['openai-responses', {
    label: 'OpenAI Responses',
    load: () => import('@earendil-works/pi-ai/api/openai-responses'),
    listing: openaiListing,
    parse: (raw) => parseModel(raw, false),
  }],
  ['anthropic-messages', {
    label: 'Anthropic Messages',
    load: () => import('@earendil-works/pi-ai/api/anthropic-messages'),
    listing: anthropicListing,
    parse: (raw) => parseModel(raw, false),
  }],
  ['google-generative-ai', {
    label: 'Google Generative AI',
    load: () => import('@earendil-works/pi-ai/api/google-generative-ai'),
    listing: geminiListing,
    parse: (raw) => parseModel(raw, true),
  }],
]);

export function protocolOptions() {
  return [...protocols].map(([api, { label }]) => ({ api, label, discovery: true }));
}

function label(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && !!value.trim())?.trim();
}

function parseModel(raw: unknown, gemini: boolean): ProviderModel | undefined {
  const entry = record(raw);
  if (!entry) return;
  if (
    gemini &&
    Array.isArray(entry.supportedGenerationMethods) &&
    !entry.supportedGenerationMethods.includes('generateContent')
  )
    return;
  const id = gemini ? label(entry.name)?.replace(/^models\//, '') : label(entry.id);
  if (!id || id.length > 160) return;
  const architecture = record(entry.architecture);
  const limits = record(entry.limit);
  const provider = record(entry.top_provider);
  const input = entry.input ?? entry.input_modalities ?? architecture?.input_modalities;
  const modalities = Array.isArray(input)
    ? (['text', 'image'] as const).filter((modality) => input.includes(modality))
    : [];
  return {
    id,
    name: (label(entry.display_name, entry.displayName, gemini ? undefined : entry.name) ?? id).slice(0, 160),
    contextWindow:
      [
        entry.contextWindow,
        entry.context_window,
        entry.context_length,
        entry.inputTokenLimit,
        entry.max_input_tokens,
        limits?.context,
        provider?.context_length,
      ].find(modelCapacity) ?? modelDefaults.contextWindow,
    maxTokens:
      [
        entry.maxTokens,
        entry.max_tokens,
        entry.max_output_tokens,
        entry.outputTokenLimit,
        entry.maxOutputTokens,
        entry.max_completion_tokens,
        limits?.output,
        provider?.max_completion_tokens,
      ].find(modelCapacity) ?? modelDefaults.maxTokens,
    input: modalities.length ? modalities : ['text'],
    reasoning: entry.reasoning === true || entry.supports_reasoning === true || entry.thinking === true,
  };
}

async function readBody(response: Response): Promise<unknown> {
  if (!response.body) return;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 8 * 1024 * 1024)
        throw new DomainError('unavailable', 'The model list exceeds the response limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function discover(connection: ProviderConnection, key: string, caller: AbortSignal) {
  const protocol = protocols.get(connection.api);
  if (!protocol) throw invalid('Model discovery is unavailable for this API protocol');
  const { url, headers, cursor, read } = protocol.listing(connection.baseUrl, key);
  const signal = AbortSignal.any([caller, AbortSignal.timeout(20000)]);
  const models = new Map<string, ProviderModel>();
  const pages = new Set<string>();
  for (;;) {
    let response: Response;
    try {
      response = await fetch(url, { headers, signal, redirect: 'error' });
    } catch {
      caller.throwIfAborted();
      throw new DomainError(
        'unavailable',
        signal.aborted
          ? 'Fetching available models timed out'
          : 'Could not connect to the model listing endpoint',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DomainError('unavailable', 'Model listing request failed (HTTP ' + response.status + ')');
    }
    let page: Listing | undefined;
    try {
      page = read(record(await readBody(response)));
    } catch (error) {
      caller.throwIfAborted();
      if (error instanceof DomainError) throw error;
      throw new DomainError('unavailable', 'The model listing endpoint returned an invalid response');
    }
    if (!page) throw new DomainError('unavailable', 'No model list was found in the endpoint response');
    for (const raw of page.rows) {
      const model = protocol.parse(raw);
      if (model && !models.has(model.id)) models.set(model.id, model);
    }
    if (!cursor || !page.next) return [...models.values()];
    if (pages.has(page.next)) throw new DomainError('unavailable', 'The endpoint repeated a model list page');
    pages.add(page.next);
    url.searchParams.set(cursor, page.next);
  }
}
