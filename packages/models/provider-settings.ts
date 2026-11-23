import { HttpError } from '@mini-harness/contracts/routes';
import { join } from 'node:path';
import { readJson, writeJson } from '@mini-harness/platform/config';
import type { Settings, SettingsPatch } from '@mini-harness/contracts/config';
import type { ModelAdminPort, ModelCatalogPort } from '@mini-harness/contracts/models';

type ProviderHost = {
  paths: { home: string };
  settings: Pick<Settings, 'model'>;
  catalog: ModelCatalogPort;
  admin: ModelAdminPort;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
};
export function providerSettings(runtime: ProviderHost) {
  const config = readJson<any>(join(runtime.paths.home, 'models.json'), { providers: {} });
  return runtime.admin.providers().map((provider) => {
    const auth = runtime.admin.authStatus(provider.id);
    return {
      id: provider.id, name: provider.name ?? provider.id,
      configured: auth.configured, storedCredential: auth.source === 'stored',
      canSetKey: provider.canSetKey,
      custom: Boolean(config.providers?.[provider.id]),
      baseUrl: config.providers?.[provider.id]?.baseUrl ?? '', api: config.providers?.[provider.id]?.api ?? 'openai-completions',
      models: provider.models
    };
  });
}
export async function saveProvider(runtime: ProviderHost, input: any, remove = false) {
  if (!input || typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id)) throw new HttpError('invalid_input', 'Invalid provider ID');
  const path = join(runtime.paths.home, 'models.json');
  const previous = readJson<any>(path, { providers: {} });
  const next = structuredClone(previous); next.providers ??= {};
  if (remove) {
    if (!Object.hasOwn(next.providers, input.id)) throw new HttpError('invalid_input', 'Only custom provider configurations can be removed');
    delete next.providers[input.id];
  } else {
    if (input.create && (runtime.admin.hasProvider(input.id) || Object.hasOwn(next.providers, input.id))) throw new HttpError('conflict', 'A provider with this ID already exists');
    if (input.key !== undefined && typeof input.key !== 'string') throw new HttpError('invalid_input', 'Invalid credential');
    if (!['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(input.api)) throw new HttpError('invalid_input', 'Unsupported API type');
    let url: URL;
    try { url = new URL(input.baseUrl); } catch { throw new HttpError('invalid_input', 'Invalid API endpoint'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new HttpError('invalid_input', 'Invalid API endpoint');
    if (!Array.isArray(input.models) || !input.models.length || input.models.length > 50) throw new HttpError('invalid_input', 'Provide 1–50 models');
    const ids = new Set<string>();
    const models = input.models.map((model: { id?: unknown; name?: unknown; reasoning?: unknown; input?: string[]; contextWindow?: number; maxTokens?: number }) => {
      const id = typeof model?.id === 'string' ? model.id.trim() : '';
      if (!id || id.length > 160 || ids.has(id)) throw new HttpError('invalid_input', 'Invalid or duplicate model ID');
      ids.add(id);
      for (const [name, fallback] of [['contextWindow', 128000], ['maxTokens', 8192]] as const) {
        if (!Number.isSafeInteger(model[name] ?? fallback) || (model[name] ?? fallback) < 1 || (model[name] ?? fallback) > 10000000) throw new HttpError('invalid_input', 'Invalid ' + name);
      }
      if (model.input !== undefined && !Array.isArray(model.input)) throw new HttpError('invalid_input', 'Invalid model input');
      return { id, name: String(model.name ?? id).slice(0, 160), reasoning: Boolean(model.reasoning),
        input: model.input?.includes('image') ? ['text', 'image'] : ['text'], contextWindow: model.contextWindow ?? 128000, maxTokens: model.maxTokens ?? 8192 };
    });
    // Retain existing per-model capabilities and key references when editing an endpoint.
    next.providers[input.id] = { ...next.providers[input.id], api: input.api, baseUrl: url.href.replace(/\/$/, ''),
      models: models.map((model: { id: string }) => ({ ...next.providers[input.id]?.models?.find((old: { id: string }) => old.id === model.id), ...model })) };
  }
  const recent = runtime.settings.model;
  writeJson(path, next);
  let clearedRecent = false;
  try {
    await runtime.admin.refresh();
    if (recent.provider === input.id) {
      if (!runtime.catalog.resolve(recent)) {
        await runtime.updateSettings({ model: { provider: '', id: '' } });
        clearedRecent = true;
      }
    }
    if (remove && !runtime.admin.hasProvider(input.id)) await runtime.admin.removeCredential(input.id);
    else if (!remove && input.key?.trim()) await runtime.admin.storeCredential(input.id, input.key.trim());
  } catch (error) {
    writeJson(path, previous);
    await runtime.admin.refresh();
    if (clearedRecent) await runtime.updateSettings({ model: recent });
    throw error;
  }
  return providerSettings(runtime);
}
