import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import server from './server/setup.ts';
export { panel } from './server/setup.ts';

export const metadata: PluginInfo = {
  title: 'Background tasks',
  description: 'Run and control independent background tools',
};
export default server;

export const panelMetadata: PluginInfo = {
  title: 'Background tasks panel',
  description: 'Inspect independent work for this conversation',
  browser: 'packages/task-control/src/browser/setup.js',
  browserStyles: ['packages/task-control/src/browser/style.css'],
};
