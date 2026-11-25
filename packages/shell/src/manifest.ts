import { defineConfig } from '@mini-harness/plugin-api/configuration';
import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';
import { Type } from 'typebox';
import { supportsIsolation } from '@mini-harness/platform/isolation';

export const defaultShellMode = supportsIsolation() ? 'isolated' : 'host';

const Config = defineConfig({
  ...Type.Object(
    {
      mode: Type.String({
        title: 'Shell policy',
        enum: ['isolated', 'host'],
        default: defaultShellMode,
        'x-enumLabels': ['Isolated (Linux)', 'Host (conversation approval policy)'],
      }),
      timeoutSeconds: Type.Integer({ title: 'Timeout (seconds)', minimum: 1, maximum: 300, default: 60 }),
    },
    { additionalProperties: false },
  ),
});

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Shell',
  description: 'Run commands using the configured execution policy.',
  icon: 'terminal',
  browser: './browser/setup.ts',
  configHint:
    'Isolated mode requires Linux bubblewrap. Host mode executes with your permissions; Full access conversations skip Shell approval.',
};

const plugin: Plugin.Object = {
  Config,
  inject: [
    'harnessSessions',
    'harnessApprovalRequests',
    'harnessProcess',
    'harnessTools',
    'harnessChanges',
    'harnessScopes',
  ],
  apply: setup,
};

export default plugin;
