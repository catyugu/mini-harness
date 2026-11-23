import type { PluginDescriptor } from '../contracts/plugins.js';

export const manifest: PluginDescriptor = {
  protocol: 2, scope: 'application',
  id: 'core:slots', title: 'UI slots', description: 'Own and dispose browser contributions',
  required: true, browserProvides: ['miniSlots'], browser: '/packages/ui-slots/browser.js'
};
