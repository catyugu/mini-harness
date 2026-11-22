import { join } from 'node:path';
import { readJson, writeJson } from './config.js';
import type { MiniHarnessRuntime } from './agent.js';
export function providerSettings(runtime: MiniHarnessRuntime) {
  const config = readJson<any>(join(runtime.paths.home, 'models.json'), { providers: {} });
  return runtime.models.getProviders().map((provider) => ({
    id: provider.id, name: provider.name ?? provider.id,
    configured: runtime.models.getProviderAuthStatus(provider.id).configured,
    custom: Boolean(config.providers?.[provider.id]),
    baseUrl: config.providers?.[provider.id]?.baseUrl ?? '', api: config.providers?.[provider.id]?.api ?? 'openai-completions',
    models: runtime.models.getModels(provider.id).map(({ id, name, input, contextWindow, maxTokens, reasoning }) => ({ id, name, input, contextWindow, maxTokens, reasoning }))
  }));
}
export async function saveProvider(runtime: MiniHarnessRuntime, input: any, remove = false) {
  if (runtime.hasActiveWork) throw new Error('Stop active conversations before changing providers');
  if (!input || typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id)) throw new Error('Invalid provider ID');
  const path = join(runtime.paths.home, 'models.json');
  const previous = readJson<any>(path, { providers: {} });
  const next = structuredClone(previous); next.providers ??= {};
  if (remove) {
    if (!next.providers[input.id]) throw new Error('Only custom provider configurations can be removed');
    if ([runtime.settings.model.provider, runtime.settings.subagents.provider].includes(input.id)) throw new Error('Select a different model before removing this provider');
    delete next.providers[input.id];
  } else {
    if (!['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(input.api)) throw new Error('Unsupported API type');
    let url: URL;
    try { url = new URL(input.baseUrl); } catch { throw new Error('Invalid API endpoint'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid API endpoint');
    if (!Array.isArray(input.models) || !input.models.length || input.models.length > 50) throw new Error('Provide 1–50 models');
    const ids = new Set<string>();
    const models = input.models.map((model) => {
      if (typeof model.id !== 'string' || !model.id.trim() || model.id.length > 160 || ids.has(model.id)) throw new Error('Invalid or duplicate model ID');
      ids.add(model.id);
      for (const [name, fallback] of [['contextWindow', 128000], ['maxTokens', 8192]] as const) {
        if (!Number.isSafeInteger(model[name] ?? fallback) || (model[name] ?? fallback) < 1 || (model[name] ?? fallback) > 10000000) throw new Error('Invalid ' + name);
      }
      return { id: model.id.trim(), name: String(model.name ?? model.id).slice(0, 160), reasoning: Boolean(model.reasoning),
        input: model.input?.includes('image') ? ['text', 'image'] : ['text'], contextWindow: model.contextWindow ?? 128000, maxTokens: model.maxTokens ?? 8192 };
    });
    // Retain existing per-model capabilities and key references when editing an endpoint.
    next.providers[input.id] = { ...next.providers[input.id], api: input.api, baseUrl: url.href.replace(/\/$/, ''),
      models: models.map((model) => ({ ...next.providers[input.id]?.models?.find((old) => old.id === model.id), ...model })) };
  }
  writeJson(path, next);
  try {
    await runtime.models.refresh({ allowNetwork: false });
    if (runtime.models.getError()) throw new Error(runtime.models.getError());
    // Existing sessions read the same model runtime and must resolve their choice on the next send.
  } catch (error) { writeJson(path, previous); await runtime.models.refresh({ allowNetwork: false }); throw error; }
  return providerSettings(runtime);
}
