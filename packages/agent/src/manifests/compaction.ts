import type { Context } from 'mini-harness/cordis';
import { defineConfig } from '@mini-harness/plugin-api/configuration';
import { Type } from 'typebox';
import { basicCompaction } from '../compaction.ts';

export default {
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

export const metadata = { title: 'Context Compaction' };
