import type { BuiltinPlugin } from '../contracts/plugins.js';
import { setup } from './host.js';

export const manifest: BuiltinPlugin = {
  id: 'core:ui', title: 'Browser transport', description: 'Browser startup and projections', required: true,
  optional: ['harnessTransportSignal'],
  inject: ['harnessPluginCatalog', 'harnessRoutes', 'harnessRegistry', 'harnessRuns', 'harnessWorkspaces',
    'harnessChanges', 'harnessApprovals'], setup
};
