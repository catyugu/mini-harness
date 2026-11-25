import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.js';
import { Type } from 'typebox';
import { supportsIsolation } from '@mini-harness/platform/isolation';

export const defaultShellMode = supportsIsolation() ? 'isolated' : 'host';

export const manifest: PluginDescriptor = {
  scope: 'application',
  plugin: {
    inject: [
      'harnessSessions',
      'harnessApprovalRequests',
      'harnessProcess',
      'harnessTools',
      'harnessChanges',
      'harnessScopes',
    ],
    apply: setup,
  },
  defaultEnabled: false,
  id: 'shell',
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
