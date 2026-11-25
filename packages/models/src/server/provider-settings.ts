import { DomainError } from '@mini-harness/platform/errors';
import { join } from 'node:path';
import { readJson, writeJson } from '@mini-harness/platform/json';
import { parseProvider } from './store.ts';

import type { ProviderAdministration } from './store-api.ts';

type ProviderHost = {
  paths: { home: string };
  admin: ProviderAdministration;
};
export async function saveProvider(runtime: ProviderHost, input: any, remove = false) {
  if (!input || typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id))
    throw new DomainError('invalid_input', 'Invalid provider ID');
  const path = join(runtime.paths.home, 'models.json');
  const previous = readJson<any>(path, { providers: {} });
  const next = { ...previous, providers: { ...previous.providers } };
  if (remove) {
    if (!Object.hasOwn(next.providers, input.id))
      throw new DomainError('invalid_input', 'Only custom provider configurations can be removed');
    delete next.providers[input.id];
  } else {
    if (input.create && (runtime.admin.hasProvider(input.id) || Object.hasOwn(next.providers, input.id)))
      throw new DomainError('conflict', 'A provider with this ID already exists');
    if (input.key !== undefined && typeof input.key !== 'string')
      throw new DomainError('invalid_input', 'Invalid credential');
    if (!Array.isArray(input.models) || !input.models.length || input.models.length > 50)
      throw new DomainError('invalid_input', 'Provide 1–50 models');
    const previousProvider = next.providers[input.id];
    const candidate = {
      ...previousProvider,
      api: input.api,
      baseUrl: input.baseUrl,
      models: input.models.map(
        (model: {
          id?: unknown;
          name?: unknown;
          reasoning?: unknown;
          input?: unknown;
          contextWindow?: number;
          maxTokens?: number;
        }) => {
          const id = typeof model?.id === 'string' ? model.id.trim() : '';
          return {
            ...previousProvider?.models?.find((previous: { id: string }) => previous.id === id),
            id,
            name: String(model?.name ?? id).slice(0, 160),
            reasoning: Boolean(model?.reasoning),
            input: Array.isArray(model?.input)
              ? model.input.includes('image')
                ? ['text', 'image']
                : ['text']
              : (model?.input ?? ['text']),
            contextWindow: model?.contextWindow ?? 128000,
            maxTokens: model?.maxTokens ?? 8192,
          };
        },
      ),
    };
    try {
      candidate.baseUrl = parseProvider(input.id, candidate).models[0].baseUrl;
    } catch (error) {
      throw new DomainError('invalid_input', error instanceof Error ? error.message : String(error));
    }
    next.providers[input.id] = candidate;
  }
  writeJson(path, next);
  try {
    await runtime.admin.refresh();
    if (remove && !runtime.admin.hasProvider(input.id)) await runtime.admin.removeCredential(input.id);
    else if (!remove && input.key?.trim()) await runtime.admin.storeCredential(input.id, input.key.trim());
  } catch (error) {
    writeJson(path, previous);
    await runtime.admin.refresh();
    throw error;
  }
  return runtime.admin.providers();
}
