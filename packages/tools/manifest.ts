import type { PluginDescriptor } from '@mini-harness/contracts/plugins';
import { ToolRegistry } from './registry.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:tools', title: 'Tools', description: 'Tool registration and execution leases', required: true,
  inject: ['harnessScopes'], provides: ['harnessTools'],
  setup(ctx) {
    ctx.provide('harnessTools', new ToolRegistry((id) => ctx.harnessScopes.address(id),
      (request) => ctx.serial('harness/tool-decision', request), (id) => ctx.harnessScopes.toolRestrictions(id)));
  }
};
