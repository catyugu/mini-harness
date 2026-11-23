import type { PluginDescriptor } from '../contracts/plugins.js';
import { setup } from './host.js';
import { Type } from 'typebox';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserInject: ['miniApprovals', 'harnessBrowser'],
  setup, defaultEnabled: false, browserRequires: ['core:conversation'],
  id: 'shell', title: 'Shell', description: 'Run commands using the configured execution policy.',
  icon: 'terminal', browser: '/packages/shell/client.js',
  configHint: 'Isolated mode requires a supported Linux host. Trusted host mode runs with your user permissions.',
  configSchema: { ...Type.Object({
    mode: Type.String({ title: 'Shell policy', enum: ['isolated', 'host'], default: 'isolated' }),
    timeoutSeconds: Type.Integer({ title: 'Timeout (seconds)', minimum: 1, maximum: 300, default: 60 })
  }, { additionalProperties: false }) },
  inject: ['harnessRegistry', 'harnessApprovals', 'harnessRuns', 'harnessProcess', 'harnessTools', 'harnessScopes']
};
