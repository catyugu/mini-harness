import { Type } from 'typebox';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Theme',
  description: 'Application theme',
  configChanges: 'live',
  configSchema: Type.Object(
    {
      appearance: Type.Union([Type.Literal('system'), Type.Literal('light'), Type.Literal('dark')], {
        default: 'system',
      }),
    },
    { additionalProperties: false },
  ),
  browserStyles: ['/packages/ui-theme/src/browser/style.css'],
  browser: '/packages/ui-theme/src/browser/setup.js',
};
