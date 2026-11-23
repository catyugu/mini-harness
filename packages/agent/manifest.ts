import type { PluginDescriptor } from '../contracts/plugins.js';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:agent', title: 'Pi Agent', description: 'Official Pi SDK adapter', required: true,
  optional: ['harnessSkills'],
  inject: ['harnessScopes', 'harnessState', 'harnessRoutes', 'harnessRegistry', 'harnessSettings', 'harnessSettingsStore', 'harnessTools'], provides: ['harnessPi', 'harnessModels', 'harnessModelAdmin'], setup,
};
