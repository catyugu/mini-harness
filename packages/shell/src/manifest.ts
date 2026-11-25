import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';
import { Type } from 'typebox';
import { supportsIsolation } from '@mini-harness/platform/isolation';

export const defaultShellMode = supportsIsolation() ? 'isolated' : 'host';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Shell',
  description: 'Run commands using the configured execution policy.',
  icon: 'terminal',
  browser: '/packages/shell/src/browser/setup.js',
  configHint:
    'Isolated mode requires Linux bubblewrap. Host mode executes with your permissions; Full access conversations skip Shell approval.',
  configSchema: {
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
  },
};

const plugin: Plugin.Object = {
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
