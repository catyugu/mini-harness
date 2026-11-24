import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './setup.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:ui', title: 'Browser transport', description: 'Browser startup and projections', defaultEnabled: true,
   plugin: {
                                                                         inject: ['harnessPluginCatalog', 'harnessRoutes', 'harnessChanges'],
                                                                         apply: setup
                                                                       }
};
