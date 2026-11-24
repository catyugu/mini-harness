import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:slots', title: 'UI slots', description: 'Own and dispose browser contributions',
  required: true, browserProvides: ['miniSlots'], browser: '/packages/ui-slots/src/browser/setup.js'
};
