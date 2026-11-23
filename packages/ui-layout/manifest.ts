import type { BuiltinPlugin } from '../contracts/plugins.js';

export const manifest: BuiltinPlugin = {
  id: 'core:layout', title: 'Layout', description: 'Application layout', required: true,
  browser: '/packages/ui-layout/browser.js', browserRequires: ['core:primitives'],
};
