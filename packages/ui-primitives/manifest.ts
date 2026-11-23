import type { BuiltinPlugin } from '../contracts/plugins.js';

export const manifest: BuiltinPlugin = {
  id: 'core:primitives', title: 'Controls', description: 'Shared interface controls', required: true,
  browser: '/packages/ui-primitives/browser.js', browserRequires: ['core:theme'],
};
