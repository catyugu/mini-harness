import type { PluginDescriptor } from '../contracts/plugins.js';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  protocol: 2, scope: 'application',
  id: 'core:ui', title: 'Browser transport', description: 'Browser startup and projections', required: true,
  optional: ['harnessTransportSignal'],
  inject: ['harnessPluginCatalog', 'harnessRoutes', 'harnessRegistry', 'harnessRuns', 'harnessWorkspaces',
    'harnessChanges', 'harnessApprovals'], setup
};
