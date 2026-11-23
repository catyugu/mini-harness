import type { BuiltinPlugin } from '../contracts/plugins.js';
import { setup } from './host.js';

export const manifest: BuiltinPlugin = {
  id: 'core:agent', title: 'Pi Agent', description: 'Official Pi SDK adapter', required: true,
  optional: ['harnessSkills'],
  inject: ['harnessState', 'harnessRoutes', 'harnessRegistry', 'harnessSettings', 'harnessSettingsStore', 'harnessTools'], provides: ['harnessPi', 'harnessModels'], setup,
};
