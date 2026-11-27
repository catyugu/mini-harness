import { defineConfig } from '@mini-harness/plugin-api/configuration';
import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import type { AgentPort } from '../api.ts';
import { AgentLoop } from '../agent.ts';
import { reasoningRecords } from '../reasoning.ts';
import { Type } from 'typebox';

const Config = defineConfig(
  Type.Object(
    {
      maxTurns: Type.Integer({ minimum: 1, maximum: 1024, default: 128, title: 'Maximum turns per run' }),
    },
    { additionalProperties: false },
  ),
);

export const metadata: PluginInfo = {
  title: 'Agent',
  description: 'Model and tool execution loop',
  browser: 'packages/agent/src/browser/setup.js',
  browserStyles: ['packages/agent/src/browser/style.css'],
};

const plugin: Plugin.Object = {
  Config,
  inject: ['harnessLlm'],
  provide: ['harnessAgent'],
  apply(ctx) {
    ctx.on('agent/records', reasoningRecords());
    const agent = new AgentLoop(() => (ctx.fiber.effectiveConfig as { maxTurns: number }).maxTurns);
    ctx.provide('harnessAgent', {
      run(context, input) {
        return ctx.fiber.run((signal) => agent.run(context, { ...input, signal }), input.signal);
      },
    } satisfies AgentPort);
  },
};

export default plugin;
