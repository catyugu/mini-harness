import type { BuiltinPlugin } from '../../src/contracts/plugins.js';
import { Type } from 'typebox';

export const manifest: Omit<BuiltinPlugin, 'setup'> = {
  id: 'shell', title: 'Shell', description: 'Run commands using the configured execution policy.',
  icon: 'terminal', browser: '/features/shell/client.js',
  configHint: 'Isolated mode requires a supported Linux host. Trusted host mode runs with your user permissions.',
  configSchema: { ...Type.Object({
    mode: Type.String({ title: 'Shell policy', enum: ['isolated', 'host'], default: 'isolated' }),
    timeoutSeconds: Type.Integer({ title: 'Timeout (seconds)', minimum: 1, maximum: 300, default: 60 })
  }, { additionalProperties: false }) },
  inject: ['harnessState', 'harnessWorkspace', 'harnessSettings', 'harnessSessionChanged', 'harnessTools', 'harnessRoutes']
};
