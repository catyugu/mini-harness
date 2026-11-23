import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Context } from 'cordis';
import { Type } from 'typebox';
import type { PluginApi } from '../contracts/plugins.js';

export function setup(ctx: Context, { config }: PluginApi) {
  const { harnessApprovals: approvals, harnessProcess: process, harnessWorkspace: workspace, harnessRuns: runs } = ctx;
  const options = config as { mode: 'isolated' | 'host'; timeoutSeconds: number };
  const tool = (sessionId: string) => defineTool({
    name: 'sandbox_shell', label: 'Shell',
    description: 'Run a shell command in the workspace after the user approves it in the Web interface.',
    parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16000 }) }),
    execute: async (_id, args, signal) => {
      const cwd = workspace.resolve(sessionId);
      await approvals.request(sessionId, runs.info(sessionId)?.id, args.command, signal);
      const output = await process.run({ command: args.command, cwd, ...options, signal });
      return { content: [{ type: 'text', text: JSON.stringify(output) }], details: { ...output, exitCode: output.code } };
    }
  });
  ctx.effect(() => ctx.harnessTools.register('sandbox_shell', tool));
}
