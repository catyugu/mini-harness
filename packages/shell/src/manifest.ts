import { defineConfig } from '@mini-harness/plugin-api/configuration';
import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';
import { Type } from 'typebox';

const Config = defineConfig({
  ...Type.Object(
    {
      timeoutMs: Type.Integer({
        title: 'Command timeout (ms)',
        description: 'Default command timeout. Agents may override it for individual commands.',
        minimum: 1,
        maximum: 86400000,
        default: 120000,
      }),
      maxOutputBytes: Type.Integer({
        title: 'Output limit per stream (bytes)',
        description: 'Additional output is saved to a temporary file.',
        minimum: 1,
        maximum: 1048576,
        default: 64000,
      }),
    },
    { additionalProperties: false },
  ),
});

export const metadata: PluginInfo = {
  title: 'Shell',
  description: 'Run commands with the host user’s permissions through the configured process provider.',
  icon: 'terminal',
  browser: 'packages/shell/src/browser/setup.js',
  configHint:
    'Enabling Shell authorizes commands to run with your user permissions without per-command confirmation. Use only trusted workspaces.',
};

const plugin: Plugin.Object = {
  Config,
  inject: [
    'harnessSessions',
    'harnessProcess',
    'harnessTools',
    'harnessChanges',
  ],
  apply: setup,
};

export default plugin;
