import type { Context } from 'mini-harness/cordis';
import { scheduleTools } from './tool-pipeline.js';
import { basicCompaction } from './compaction.js';

export const executor = {
  provide: ['harnessToolExecutor'],
  apply(ctx: Context) {
    ctx.provide('harnessToolExecutor', { schedule: scheduleTools });
  },
};

export const compaction = {
  provide: ['harnessCompaction'],
  apply(ctx: Context) {
    ctx.provide('harnessCompaction', basicCompaction);
  },
};
