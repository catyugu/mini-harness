import { Type } from 'typebox';
import type { PluginDescriptor } from '@mini-harness/contracts/plugins';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:theme', title: 'Theme', description: 'Application theme', required: true,
  configChanges: 'live',
  configSchema: Type.Object({
    appearance: Type.Union([Type.Literal('system'), Type.Literal('light'), Type.Literal('dark')], { default: 'system' }),
  }, { additionalProperties: false }),
  browser: '/packages/ui-theme/browser.js', browserRequires: [],
};
