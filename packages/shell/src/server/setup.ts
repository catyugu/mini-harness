import { approvalExtensions } from '@mini-harness/approvals/api';
import { sessionExtensions } from '@mini-harness/sessions/records';
import type {} from '@mini-harness/kernel/scopes';
import type {} from '@mini-harness/process-execution/api';
import type {} from '@mini-harness/transport/projection-api';
import { toolExtensions } from '@mini-harness/tools/extensions';
import { defineTool } from '@mini-harness/tools/api';
import type { Context } from 'cordis';
import { Type } from 'typebox';
import type { PluginApi } from '@mini-harness/plugin-api/descriptor';

export function setup(ctx: Context, api: PluginApi) {
  const { harnessScopes: scopes } = ctx;
  const approvals = api.contribute(approvalExtensions.access);
  const workspace = api.contribute(sessionExtensions.access);
  const options = api.config as { mode: 'isolated' | 'host'; timeoutSeconds: number };
  const tool = (sessionId: string) => defineTool({
    name: 'sandbox_shell', label: 'Shell',
    description: 'Run a shell command in the workspace. Standard requires approval; Full access skips the approval prompt.',
    parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16000 }) }),
    execute: async (_id, args, signal, _update, context) => {
      await scopes.prepare(sessionId, signal);
      const cwd = workspace.workspacePath(sessionId);
       // A pending Standard approval may be released when the user selects Full access.
      // If the permission is reduced again before resuming, request approval anew.
      let automaticallyApproved = false;
      const approval = async () => {
        automaticallyApproved = await approvals.request(sessionId, { title: 'Shell approval', message: args.command, signal,
          context: JSON.stringify([cwd, options]), allowFullAccess: true });
      };
      while (workspace.get(sessionId)?.permission !== 'fullAccess') {
        if (context?.waitForApproval) await context.waitForApproval(approval);
        else await approval();
        if (!automaticallyApproved) break;
      }
      // Permission changes also apply while a Shell command is awaiting approval.
      context?.assertAuthorized?.();
      const execution = scopes.require(sessionId, 'harnessProcess');
      try {
        const output = await execution.run({ command: args.command, cwd, ...options, signal, sessionId });
        return { content: [{ type: 'text', text: JSON.stringify(output) }], details: { ...output, exitCode: output.code } };
      } finally {
        const workspaceId = workspace.get(sessionId)?.workspaceId;
        if (workspaceId) ctx.harnessChanges.invalidate('files', { workspaceId });
      }
    }
  });
  api.contribute(toolExtensions.register, { name: 'sandbox_shell', bind: tool });
}
