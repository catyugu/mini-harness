import type { BuiltinPlugin } from '../../src/kernel/plugin-api.js';
import { Type } from 'typebox';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: Omit<BuiltinPlugin, 'setup'> = {
  id: 'shell', title: 'Shell', description: 'Run commands using the configured execution policy.',
  preferences: { key: 'sandbox', schema: { ...Type.Object({
    mode: Type.String({ title: 'Shell policy', enum: ['isolated', 'host'] }),
    timeoutSeconds: Type.Integer({ title: 'Timeout (seconds)', minimum: 1, maximum: 300 })
  }) } },
  icon: 'terminal', browser: '/features/shell/client.js', inject: ['harnessState', 'harnessWorkspace', 'harnessSettings', 'harnessSessionChanged', 'harnessTools', 'harnessRoutes'],
};
