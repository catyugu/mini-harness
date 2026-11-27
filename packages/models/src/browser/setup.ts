import { browserPluginId, browserPluginSettings } from '@mini-harness/ui-runtime/plugin-settings';
import { browserRequest } from '@mini-harness/ui-runtime/http';
import { providerManager } from './provider-manager.ts';
import type { Context } from 'mini-harness/cordis';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ModelCatalog, ProtocolInfo } from '../shared/catalog.ts';
import { RemoteStore } from '@mini-harness/ui-runtime/remote-store';
import { createModelPicker } from './model-picker.ts';
import { mountModelControls } from './composer.ts';

const setup = async (ctx: Context) => {
  const { miniSettings: settings } = ctx;
  const state = new RemoteStore(async () => {
    const [{ models, recent, canManageProviders, protocols }, providers] = await Promise.all([
      browserRequest<
        Pick<ModelCatalog, 'models'> & {
          recent: ModelChoice;
          canManageProviders: boolean;
          protocols: ProtocolInfo[];
        }
      >(ctx, '/models'),
      browserRequest<ModelCatalog['providers']>(ctx, '/providers'),
    ]);
    return { models, providers, recent, canManageProviders, protocols };
  });
  await state.refresh();
  ctx.effect(() => ctx.miniProjections.register('models', state));
  ctx.provide('miniModels', {
    get: state.get,
    subscribe: state.subscribe,
    createPicker: (onSelect, signal, options) => createModelPicker(state, onSelect, signal, options),
  });
  ctx.inject(['miniComposer', 'miniConversation', 'miniSlots'], (composer) => {
    composer.effect(() =>
      composer.miniSlots.register(
        'conversation.composer-primary',
        (signal) => mountModelControls(composer, signal),
        { key: 'primary' },
      ),
    );
  });
  ctx.on('settings/options', (schema, value) => {
    if (!schema['x-modelChoice']) return;
    const current = value as ModelChoice | null | undefined;
    const { models, providers } = state.get();
    const options: { label: string; value: ModelChoice | null; disabled?: boolean }[] = [
      { label: 'Inherit parent model', value: null },
      ...models
        .filter(({ configured }) => configured)
        .map((model) => ({
          label:
            model.name + ' · ' + (providers.find(({ id }) => id === model.provider)?.name ?? model.provider),
          value: { provider: model.provider, id: model.id },
        })),
    ];
    if (
      current &&
      !options.some(({ value }) => value?.provider === current.provider && value?.id === current.id)
    )
      options.push({
        label: current.provider + '/' + current.id + ' (unavailable)',
        value: current,
        disabled: true,
      });
    return options;
  });
  ctx.miniSettingsRegistry.registerSection(
    { id: 'model', title: 'Model', icon: 'model', order: 20 },
    ctx.fiber.signal,
  );
  ctx.effect(() =>
    ctx.miniSettingsRegistry.register(
      browserPluginId(ctx),
      {
        id: 'providers',
        sectionId: 'model',
        render({ signal }) {
          if (!state.get().canManageProviders) {
            const hint = document.createElement('p');
            hint.className = 'hint';
            hint.textContent = 'Models are provided by plugins.';
            return hint;
          }
          const manager = providerManager(
            ctx,
            () => state.get().providers,
            () => state.get().protocols,
            signal,
          );
          settings.onClose(manager.reset, signal);
          state.subscribe(manager.render, signal);
          return manager.content;
        },
      },
      browserPluginSettings(ctx),
    ),
  );
  if (!state.get().models.some((model) => model.configured)) settings.open('model');
};

export default {
  inject: ['miniSettings', 'miniProjections', 'miniSettingsRegistry'],
  provide: ['miniModels'],
  apply: setup,
};
