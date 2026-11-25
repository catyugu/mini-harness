import type { Context } from 'mini-harness/cordis';
import { executeTools } from './tool-pipeline.ts';
import { basicCompaction } from './compaction.ts';
import type { ToolExecutorPort } from './api.ts';

export const nativeExecutor: ToolExecutorPort = {
  present: (content, tools) => ({ ...content, tools: [...tools] }),
  interpret: (message) => message,
  execute: executeTools,
};

export const executor = {
  provide: ['harnessToolExecutor'],
  apply(ctx: Context) {
    ctx.provide('harnessToolExecutor', nativeExecutor);
  },
};

export const compaction = {
  provide: ['harnessCompaction'],
  apply(ctx: Context) {
    ctx.provide('harnessCompaction', basicCompaction);
  },
};
