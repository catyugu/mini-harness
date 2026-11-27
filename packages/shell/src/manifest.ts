import { defineConfig } from '@mini-harness/plugin-api/configuration';
import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';
import { Type } from 'typebox';
import { shellLimits } from './shared/limits.ts';

const Config = defineConfig({
  ...Type.Object(
    {
      timeoutMs: Type.Integer(shellLimits.timeoutMs),
      maxOutputBytes: Type.Integer(shellLimits.maxOutputBytes),
    },
    { additionalProperties: false },
  ),
});

export const metadata: PluginInfo = {
  title: 'Shell',
  description: 'Run commands with the host user’s permissions through the configured process provider.',
  icon: 'terminal',
  browser: 'packages/shell/src/browser/setup.js',
  browserStyles: ['packages/shell/src/browser/style.css'],
};

const plugin: Plugin.Object = {
  Config,
  inject: ['harnessSessions', 'harnessProcess', 'harnessTools', 'harnessChanges'],
  apply: setup,
};

export default plugin;
