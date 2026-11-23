import type { BuiltinPlugin } from '../contracts/plugins.js';

export const manifest: BuiltinPlugin = {
  id: 'core:theme', title: 'Theme', description: 'Application theme', required: true,
  browser: '/packages/ui-theme/browser.js', browserRequires: [],
};
