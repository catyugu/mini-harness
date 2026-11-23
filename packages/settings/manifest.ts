import type { BuiltinPlugin } from '../contracts/plugins.js';
import { setup } from './host.js';

export const manifest: BuiltinPlugin = {
  id: 'core:settings', title: 'Settings', description: 'Application settings', required: true,
  inject: ['harnessSettings', 'harnessUpdateSettings', 'harnessRoutes', 'harnessMutations'], provides: [], setup,
  browser: '/packages/settings/browser.js', browserRequires: ['core:layout'],
};
