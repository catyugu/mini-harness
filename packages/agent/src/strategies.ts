import type { Context } from 'mini-harness/cordis';
import { defineConfig } from '@mini-harness/plugin-api/configuration';
import { Type } from 'typebox';
import { executeTools, type ToolExecutorPort } from '@mini-harness/tools/execution';
import { basicCompaction } from './compaction.ts';

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
  Config: defineConfig(
    Type.Object(
      { autoCompact: Type.Boolean({ default: true, title: 'Automatically compact long conversations' }) },
      { additionalProperties: false },
    ),
  ),
  provide: ['harnessCompaction'],
  apply(ctx: Context) {
    ctx.provide('harnessCompaction', {
      ...basicCompaction,
      shouldCompact(messages, limits) {
        return (
          (ctx.fiber.effectiveConfig as { autoCompact: boolean }).autoCompact &&
          basicCompaction.shouldCompact(messages, limits)
        );
      },
    });
  },
};
