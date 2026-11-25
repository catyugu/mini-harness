import { defineConfig } from '@mini-harness/plugin-api/configuration';
import { Type } from 'typebox';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const Config = defineConfig(
  Type.Object(
    {
      appearance: Type.Union([Type.Literal('system'), Type.Literal('light'), Type.Literal('dark')], {
        default: 'system',
      }),
    },
    { additionalProperties: false },
  ),
);

export const metadata: PluginInfo = {
  title: 'Theme',
  description: 'Application theme',

  browserStyles: ['packages/ui-theme/src/browser/style.css'],
  browser: 'packages/ui-theme/src/browser/setup.js',
};
