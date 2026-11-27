import { browserPluginId, browserPluginSettings } from '@mini-harness/ui-runtime/plugin-settings';
import { browserRequest } from '@mini-harness/ui-runtime/http';
import { providerManager } from './provider-manager.ts';
import type { Context } from 'mini-harness/cordis';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ModelSummary } from '../shared/catalog.ts';
import type { ProviderInfo, ProtocolInfo } from '../shared/pi-provider.ts';
import { RemoteStore } from '@mini-harness/ui-runtime/remote-store';
import { createModelPicker } from './model-picker.ts';
import { mountModelControls } from './composer.ts';

const setup = async (ctx: Context) => {
  const { miniSettings: settings } = ctx;
  const state = new RemoteStore(() =>
    browserRequest<{
      models: ModelSummary[];
      providers: ProviderInfo[];
      recent: ModelChoice | null;
      canManageProviders: boolean;
      protocols: ProtocolInfo[];
    }>(ctx, '/models'),
  );
  ctx.effect(() => ctx.miniProjections.register('models', state));
  await state.refresh();
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
          const manager = providerManager(ctx, state.get, state.refresh, signal);
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
