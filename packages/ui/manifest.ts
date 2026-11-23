/** The only built-in browser roster. Entries contain URLs, not imports of feature implementations.
 * This graph is served by the Host and assembled by the generic browser boot.
 */
export interface BrowserEntry {
  id: string;
  browser: string;
  requires?: string[];
}

export const browserEntries: BrowserEntry[] = [
  { id: 'core:theme', browser: '/packages/ui-theme/browser.js' },
  { id: 'core:primitives', browser: '/packages/ui-primitives/browser.js', requires: ['core:theme'] },
  { id: 'core:layout', browser: '/packages/ui-layout/browser.js', requires: ['core:primitives'] },
  { id: 'core:workspace', browser: '/packages/workspaces/browser.js', requires: ['core:layout'] },
  { id: 'core:navigation', browser: '/packages/sessions/browser/navigation-plugin.js', requires: ['core:workspace'] },
  { id: 'core:conversation', browser: '/packages/sessions/browser/conversation/plugin.js', requires: ['core:workspace'] },
  { id: 'core:settings', browser: '/packages/settings/browser.js', requires: ['core:layout'] },
  { id: 'core:models', browser: '/packages/models/browser.js', requires: ['core:settings'] },
  { id: 'core:plugins', browser: '/packages/plugins/browser.js', requires: ['core:layout'] }
];
