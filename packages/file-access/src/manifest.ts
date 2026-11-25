import { resolve } from 'node:path';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import type { FileAccessPort } from './api.ts';
import { RootedFiles } from './root.ts';

export const metadata: PluginInfo = {
  title: 'File access',
  description: 'Use native file operations or open a directory view',
};

const plugin: Plugin.Object = {
  provide: ['harnessFileAccess'],
  apply(ctx) {
    const files: FileAccessPort = {
      native: { ...fs, createReadStream },
      open(root, options) {
        return new RootedFiles(resolve(root), options?.exclude);
      },
    };
    ctx.provide('harnessFileAccess', files);
  },
};

export default plugin;
