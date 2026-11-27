import * as fs from 'node:fs/promises';
import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import type { FileAccessPort } from './api.ts';

export const metadata: PluginInfo = {
  title: 'File access',
  description: 'Use native file operations or open a directory view',
};

const plugin: Plugin.Object = {
  provide: ['harnessFileAccess'],
  apply(ctx) {
    const files: FileAccessPort = fs;
    ctx.provide('harnessFileAccess', files);
  },
};

export default plugin;
