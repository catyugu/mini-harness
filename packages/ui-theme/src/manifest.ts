import { Type } from 'typebox';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:theme',
  title: 'Theme',
  description: 'Application theme',
  defaultEnabled: true,
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
