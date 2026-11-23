import { defineTool } from '@mini-harness/contracts/tools';
import type { Context } from 'cordis';
import { Type } from 'typebox';
import type { PluginApi } from '@mini-harness/contracts/plugins';

export function setup(ctx: Context, { config }: PluginApi) {
  const { harnessApprovals: approvals, harnessRegistry: workspace, harnessRuns: runs, harnessScopes: scopes } = ctx;
  const options = config as { mode: 'isolated' | 'host'; timeoutSeconds: number };
  const tool = (sessionId: string) => defineTool({
    name: 'sandbox_shell', label: 'Shell',
    description: 'Run a shell command in the workspace after the user approves it in the Web interface.',
    parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16000 }) }),
    execute: async (_id, args, signal) => {
      await scopes.prepare(sessionId, signal);
      const cwd = workspace.workspacePath(sessionId);
      await approvals.request(sessionId, runs.info(sessionId)?.id, args.command, signal);
      const execution = scopes.require(sessionId, 'harnessProcess');
      const output = await execution.run({ command: args.command, cwd, ...options, signal, sessionId });
      return { content: [{ type: 'text', text: JSON.stringify(output) }], details: { ...output, exitCode: output.code } };
    }
  });
  ctx.effect(() => ctx.harnessTools.register('sandbox_shell', tool));
}
