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
    execute: async (_id, args, signal, _update, context) => {
      await scopes.prepare(sessionId, signal);
      const cwd = workspace.workspacePath(sessionId);
      const runId = runs.info(sessionId)?.id;
      const approval = () => approvals.request(sessionId, runId, args.command, signal, JSON.stringify([cwd, options]));
      if (context?.waitForApproval) await context.waitForApproval(approval);
      else await approval();
      const execution = scopes.require(sessionId, 'harnessProcess');
      try {
        const output = await execution.run({ command: args.command, cwd, ...options, signal, sessionId });
        return { content: [{ type: 'text', text: JSON.stringify(output) }], details: { ...output, exitCode: output.code } };
      } finally {
        const workspaceId = workspace.get(sessionId)?.workspaceId;
        if (workspaceId) ctx.harnessChanges.dispatchEvent(new CustomEvent('change', { detail: { domain: 'files', workspaceId } }));
      }
    }
  });
  ctx.effect(() => ctx.harnessTools.register('sandbox_shell', tool));
}
