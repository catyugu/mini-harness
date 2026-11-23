import type { BuiltinPlugin } from '../contracts/plugins.js';
import { ToolRegistry } from './registry.js';

export const manifest: BuiltinPlugin = {
  id: 'core:tools', title: 'Tools', description: 'Tool registration and execution leases', required: true,
  provides: ['harnessTools'],
  setup(ctx) { ctx.provide('harnessTools', new ToolRegistry()); }
};
